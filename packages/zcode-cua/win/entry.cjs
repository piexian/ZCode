/* eslint-disable max-lines -- runtime-manifest 只哈希 entry + addon 两个文件，Helper 入口必须自包含。 */
"use strict";

/**
 * Windows CUA Helper 入口（第一垂直切片）。
 *
 * 职责：加载 native addon、自建命名管道、在管道上跑 broker NDJSON 协议、
 * 与父进程（desktop services 的 WindowsCuaHelperHost）讲控制协议、看门狗与优雅停机。
 *
 * 本切片只实现「传输 + 身份 + 诊断」：
 * - 42 个 broker 方法全部在方法表里，未实现的能力显式回 `unimplemented`，不假装可用；
 * - UIA 树、WGC 抓帧、SendInput、剪贴板属于后续切片，未实现前桌面动作一律 fail closed。
 *
 * 启动：node entry.cjs --socket \\.\pipe\zcode-cua-helper-<hex> --parent-pid <pid>
 * addon：默认与本文件同目录的 ax_native.node，可用 ZCODE_CUA_HELPER_ADDON 覆盖。
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const PROTOCOL = "zcode-cua-windows-dev/v1";
const SERVER_API_VERSION = 2;
const API_VERSION = "ZCodeComputerUseIPC-1";
const PIPE_PREFIX = "\\\\.\\pipe\\";
const HANDSHAKE_TIMEOUT_MS = 5000;
const MAX_CONNECTIONS = 8;
const MAX_LINE_BYTES = 16 * 1024 * 1024;
const MAX_QUEUED_REQUESTS = 64;
const PARENT_WATCHDOG_INTERVAL_MS = 5000;
const STOP_BUDGET_MS = 3000;

/** 本切片真正实现的方法；其余方法在方法表里但显式 unimplemented。 */
const IMPLEMENTED_METHODS = new Set([
  "authenticate",
  "ping",
  "broker_info",
  "controller_status",
  "request_access",
  "permission_status",
  "input_permission_status",
  "screen_capture_status",
  "screen_capture_probe",
  "supports_accessibility",
]);

/** 后续切片实现；现在必须显式回 unimplemented，不能静默无响应。 */
const PENDING_METHODS = new Set([
  "application_info",
  "list_applications",
  "list_windows",
  "capture_app",
  "element_at_point",
  "read_element",
  "element_press",
  "element_show_menu",
  "element_focus",
  "element_set_value",
  "element_perform_action",
  "element_select_text",
  "click",
  "scroll",
  "drag",
  "type_text",
  "type_text_to_app",
  "press_key",
  "press_key_to_app",
  "hold_key",
  "hold_key_to_app",
  "cancel_input_holds",
  "paste",
  "prevent_activation",
  "reenable_activation",
  "is_focus_steal_prevented",
]);

/** 本切片明确不支持的方法（macOS 语义或未实现的后端）。 */
const UNSUPPORTED_METHODS = new Set([
  "controller_takeover",
  "controller_stop",
  "pip_start",
  "pip_stop",
  "pip_is_running",
  "pip_clear_dismissed",
  "pip_session_handshake",
  "pip_session_event",
]);

const BROKER_METHODS = Object.freeze([
  ...IMPLEMENTED_METHODS,
  ...PENDING_METHODS,
  ...UNSUPPORTED_METHODS,
]);

const READ_ONLY_METHODS = new Set([
  "broker_info",
  "controller_status",
  "request_access",
  "permission_status",
  "input_permission_status",
  "screen_capture_status",
  "screen_capture_probe",
  "supports_accessibility",
  "list_applications",
  "application_info",
  "list_windows",
  "capture_app",
  "element_at_point",
  "read_element",
  "cancel_input_holds",
  "prevent_activation",
  "reenable_activation",
  "is_focus_steal_prevented",
  "pip_is_running",
]);

const ERROR_CODES = new Set([
  "invalid_request",
  "not_authorized",
  "permission_denied",
  "controller_busy",
  "element_unavailable",
  "not_settable",
  "not_selectable",
  "action_unavailable",
  "foreground_required",
  "launch_failed",
  "timeout",
  "version_mismatch",
  "unimplemented",
  "method_not_found",
  "internal",
  "broker_unavailable",
]);

function fail(code, message, details) {
  const error = { code, message };
  if (details !== undefined) error.details = details;
  return error;
}

function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    return { help: true };
  }
  const args = argv.slice(2);
  if (args.length !== 4 || args[0] !== "--socket" || args[2] !== "--parent-pid") {
    return {
      error: "usage: entry.cjs --socket \\\\.\\pipe\\<name> --parent-pid <pid>（参数必须恰好四个）",
    };
  }
  const socketPath = args[1];
  const parentPid = Number(args[3]);
  if (!socketPath.startsWith(PIPE_PREFIX)) {
    return { error: `socket 必须以 ${PIPE_PREFIX} 开头` };
  }
  if (!Number.isInteger(parentPid) || parentPid <= 0) {
    return { error: "parent-pid 必须是正整数" };
  }
  return { socketPath, parentPid };
}

function resolveAddonPath() {
  const override = process.env.ZCODE_CUA_HELPER_ADDON?.trim();
  if (override) return override;
  return path.join(__dirname, "ax_native.node");
}

function sendControl(message) {
  const payload = { protocol: PROTOCOL, ...message };
  if (typeof process.send === "function") {
    try {
      process.send(payload);
      return;
    } catch {
      // 退到 stdout NDJSON。
    }
  }
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function diagnostic(method, hostInfo) {
  switch (method) {
    case "permission_status":
    case "input_permission_status":
      return {
        accessibility: "not_required",
        screen_recording: "not_required",
        interactive_session: hostInfo.session.interactive,
        elevation: hostInfo.user.elevationType,
        integrity_level: hostInfo.user.integrityLevel,
      };
    case "request_access":
      // 只读报告：Windows 没有 TCC 授权面，绝不弹窗、绝不改授权。
      return {
        platform_report: "windows_read_only",
        interactive_session: hostInfo.session.interactive,
        note: "Windows Computer Use has no per-app permission prompt; this call never changes authorization.",
      };
    case "screen_capture_status":
      return {
        supported: hostInfo.wgc.isSupported,
        probe: hostInfo.wgc.api,
        capture_implemented: hostInfo.captureImplemented,
      };
    case "screen_capture_probe":
      return {
        performed: false,
        reason:
          "capture is not implemented in this slice; readiness is reported by screen_capture_status",
      };
    case "supports_accessibility":
      return { available: hostInfo.uia.available, probe: hostInfo.uia.probe };
    case "controller_status":
      return { controller: null, note: "controller lease is not implemented in this slice" };
    default:
      return {};
  }
}

function main() {
  const parsed = parseArgs(process.argv);
  if (parsed.help) {
    process.stdout.write("usage: entry.cjs --socket \\\\.\\pipe\\<name> --parent-pid <pid>\n");
    return;
  }
  if (parsed.error) {
    sendControl({ type: "error", message: parsed.error });
    process.exit(2);
  }

  const addonPath = resolveAddonPath();
  if (!fs.existsSync(addonPath)) {
    sendControl({ type: "error", message: `native addon not found: ${addonPath}` });
    process.exit(3);
  }

  let addon;
  try {
    addon = require(addonPath);
  } catch (error) {
    sendControl({ type: "error", message: `failed to load native addon: ${String(error)}` });
    process.exit(3);
  }

  const hostInfo = addon.hostInfo();
  if (hostInfo.platform !== "win32" || hostInfo.arch !== "x64") {
    sendControl({
      type: "error",
      message: `unsupported host: ${hostInfo.platform}/${hostInfo.arch}`,
    });
    process.exit(4);
  }
  if (hostInfo.session.interactive !== true || hostInfo.user.isSystemAccount === true) {
    sendControl({
      type: "error",
      message: "Computer Use requires an interactive, non-system desktop session",
    });
    process.exit(5);
  }

  const bootNonce = crypto.randomBytes(16).toString("hex");
  const startedAt = Date.now();
  /** @type {Map<number, {role: string, authenticated: boolean, claims: Record<string, unknown>}>} */
  const connections = new Map();
  let stopping = false;

  const server = addon.startServer(parsed.socketPath, {
    parentPid: parsed.parentPid,
    handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
    maxConnections: MAX_CONNECTIONS,
    maxLineBytes: MAX_LINE_BYTES,
    maxQueuedRequests: MAX_QUEUED_REQUESTS,
  });
  if (!server || server.pipeName !== parsed.socketPath) {
    sendControl({ type: "error", message: "native pipe server did not bind the requested pipe" });
    process.exit(6);
  }

  const respond = (connectionId, id, ok, payload) => {
    const frame = ok ? { id, ok: true, result: payload } : { id, ok: false, error: payload };
    addon.sendResponse(connectionId, JSON.stringify(frame));
  };

  const capabilities = Object.freeze({
    transport: "named_pipe",
    protocol: "ndjson",
    server_api_version: SERVER_API_VERSION,
    peer_identity: "pid_token_ancestry",
    peer_signature: "not_implemented",
    uia_observation: false,
    element_actions: false,
    screen_capture: false,
    input: false,
    clipboard: false,
    pip: false,
    slice: "transport-identity-diagnostics",
  });

  const brokerInfo = (state) => ({
    api_version: API_VERSION,
    framing: "ndjson",
    serverApiVersion: SERVER_API_VERSION,
    protocol: PROTOCOL,
    pid: process.pid,
    boot_nonce: bootNonce,
    started_at: startedAt,
    capabilities,
    implemented_methods: [...IMPLEMENTED_METHODS],
    peer: state ? state.peer : null,
    limits: {
      max_connections: MAX_CONNECTIONS,
      max_line_bytes: MAX_LINE_BYTES,
      max_queued_requests: MAX_QUEUED_REQUESTS,
      handshake_timeout_ms: HANDSHAKE_TIMEOUT_MS,
    },
    host: {
      os_build: hostInfo.os.build,
      session_id: hostInfo.session.id,
      interactive: hostInfo.session.interactive,
      integrity_level: hostInfo.user.integrityLevel,
      elevation: hostInfo.user.elevationType,
      dpi_awareness: hostInfo.dpi.threadAwareness,
      uia_available: hostInfo.uia.available,
      wgc_supported: hostInfo.wgc.isSupported,
    },
  });

  const dispatch = (method, params, state) => {
    if (method === "broker_info") return { ok: true, result: brokerInfo(state) };
    if (method === "ping") return { ok: true, result: { pong: true, pid: process.pid } };
    if (IMPLEMENTED_METHODS.has(method)) {
      return { ok: true, result: diagnostic(method, hostInfo) };
    }
    if (UNSUPPORTED_METHODS.has(method)) {
      return {
        ok: false,
        error: fail("unimplemented", `${method} is not available on Windows`, {
          method,
          reason: "windows_slice_scope",
        }),
      };
    }
    return {
      ok: false,
      error: fail("unimplemented", `${method} is not implemented in this slice`, {
        method,
        reason: "pending_slice",
      }),
    };
  };

  const handleFrame = (event) => {
    const state = connections.get(event.connectionId);
    let frame;
    try {
      frame = JSON.parse(event.text);
    } catch (error) {
      respond(
        event.connectionId,
        "",
        false,
        fail("invalid_request", `malformed request frame: ${String(error)}`),
      );
      return;
    }
    if (frame === null || typeof frame !== "object" || Array.isArray(frame)) {
      respond(
        event.connectionId,
        "",
        false,
        fail("invalid_request", "request frame must be an object"),
      );
      return;
    }
    // id 必须是字符串：与 broker/ndjson.js 的出站校验同规则，避免两侧解释不一致。
    const id = typeof frame.id === "string" && frame.id.length > 0 ? frame.id : "";
    if (!id) {
      respond(
        event.connectionId,
        "",
        false,
        fail("invalid_request", "id must be a non-empty string"),
      );
      return;
    }
    const method = typeof frame.method === "string" ? frame.method : "";
    if (!method) {
      respond(
        event.connectionId,
        id,
        false,
        fail("invalid_request", "method must be a non-empty string"),
      );
      return;
    }
    const params = frame.params === undefined ? {} : frame.params;
    if (params === null || typeof params !== "object" || Array.isArray(params)) {
      respond(event.connectionId, id, false, fail("invalid_request", "params must be an object"));
      return;
    }

    if (!state.authenticated && method !== "authenticate") {
      respond(
        event.connectionId,
        id,
        false,
        fail("not_authorized", "the first frame on a connection must be authenticate"),
      );
      return;
    }

    if (method === "authenticate") {
      const version = params.version;
      if (!Number.isInteger(version) || version !== SERVER_API_VERSION) {
        respond(
          event.connectionId,
          id,
          false,
          fail("version_mismatch", `this Helper speaks protocol version ${SERVER_API_VERSION}`, {
            server: SERVER_API_VERSION,
            client: version ?? null,
          }),
        );
        return;
      }
      state.authenticated = true;
      state.role = params.role === "presentation" ? "presentation" : "tool";
      state.claims = { client_type: params.metadata?.client_type ?? null };
      respond(event.connectionId, id, true, {
        authenticated: true,
        role: state.role,
        serverApiVersion: SERVER_API_VERSION,
        boot_nonce: bootNonce,
      });
      return;
    }

    if (state.role === "presentation") {
      // presentation 只允许 PiP 会话方法，而 PiP 在 Windows 全部未实现。
      respond(
        event.connectionId,
        id,
        false,
        fail("not_authorized", "the presentation role cannot call broker methods on Windows"),
      );
      return;
    }

    const outcome = dispatch(method, params, state);
    respond(event.connectionId, id, outcome.ok, outcome.ok ? outcome.result : outcome.error);
  };

  addon.setEventHandler((event) => {
    switch (event.type) {
      case "connection": {
        if (stopping) {
          addon.closeConnection(event.connectionId, "helper_stopping");
          return;
        }
        if (!event.accepted) {
          connections.delete(event.connectionId);
          return;
        }
        connections.set(event.connectionId, {
          role: "tool",
          authenticated: false,
          claims: {},
          peer: event.peer,
        });
        return;
      }
      case "line": {
        try {
          handleFrame(event);
        } catch (error) {
          respond(event.connectionId, "", false, fail("internal", String(error)));
        }
        return;
      }
      case "error": {
        sendControl({ type: "error", message: `${event.reason}: ${event.message}` });
        return;
      }
      case "disconnect": {
        connections.delete(event.connectionId);
        return;
      }
      default:
    }
  });

  sendControl({ type: "transport_ready", socketPath: server.pipeName, pid: process.pid });
  sendControl({ type: "ready", socketPath: server.pipeName, pid: process.pid });

  const watchdog = setInterval(() => {
    try {
      process.kill(parsed.parentPid, 0);
    } catch (error) {
      // ESRCH 之外的错误按「父进程可能已死」处理：与官方 Helper 的 fail-closed 策略一致。
      if (error && error.code === "EPERM") return;
      clearInterval(watchdog);
      shutdown("parent_exited");
    }
  }, PARENT_WATCHDOG_INTERVAL_MS);
  watchdog.unref?.();

  let shutdownStarted = false;
  function shutdown(reason) {
    if (shutdownStarted) return;
    shutdownStarted = true;
    stopping = true;
    clearInterval(watchdog);
    addon.setEventHandler(null);
    const result = addon.stopServer(STOP_BUDGET_MS);
    // 正常停机不是错误：控制通道用 stopped 报告，Host 侧只关心 clean。
    sendControl({ type: "stopped", reason, clean: Boolean(result.stopped) });
    process.exit(0);
  }

  if (typeof process.on === "function") {
    process.on("message", (message) => {
      if (message && message.protocol === PROTOCOL && message.type === "shutdown") {
        shutdown(typeof message.reason === "string" ? message.reason : "host_shutdown");
      }
    });
    process.on("SIGTERM", () => shutdown("sigterm"));
    process.on("SIGINT", () => shutdown("sigint"));
  }
}

// 只有被直接执行时才启动：契约测试会 require 本文件读取方法表。
if (require.main === module) main();

// 供契约测试读取：方法表与角色规则必须与 protocol/ 侧一致。
module.exports = {
  PROTOCOL,
  SERVER_API_VERSION,
  API_VERSION,
  PIPE_PREFIX,
  HANDSHAKE_TIMEOUT_MS,
  MAX_CONNECTIONS,
  MAX_LINE_BYTES,
  MAX_QUEUED_REQUESTS,
  STOP_BUDGET_MS,
  PARENT_WATCHDOG_INTERVAL_MS,
  BROKER_METHODS,
  READ_ONLY_METHODS,
  ERROR_CODES,
  IMPLEMENTED_METHODS,
  PENDING_METHODS,
  UNSUPPORTED_METHODS,
};
