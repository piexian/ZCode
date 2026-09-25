/**
 * 4 个只读工具 + 1 个安全控制工具的 handler。
 *
 * 这 5 个是本切片完整实现的路径：观察、只读权限报告、latched stop。
 * 桌面动作类工具在 `action-tools.js` 里共用同一套预检与 receipt。
 */

import { CuaProtocolError } from "../protocol/errors.js";
import { commitObservation, renderElementsText } from "./observation.js";

/**
 * `list_apps` → `list_applications`。
 * @param {{args: Record<string, unknown>, broker: {call: (m: string, p?: unknown) => Promise<any>}, now: number}} input
 */
async function listApps(input) {
  const raw = await input.broker.call("list_applications", {});
  const items = Array.isArray(raw?.apps) ? raw.apps : Array.isArray(raw?.items) ? raw.items : [];
  const text = items.length
    ? items
        .map((app) =>
          typeof app === "string"
            ? app
            : [app?.display_name ?? app?.name ?? app?.bundle_id ?? "?", `pid=${app?.pid ?? "?"}`]
                .filter(Boolean)
                .join(" "),
        )
        .join("\n")
    : "No applications reported.";
  return {
    text: `Applications (${items.length}):\n${text}`,
    structuredContent: {
      schema_version: "zcode-cua-app-list-v1",
      count: items.length,
      apps: items,
    },
  };
}

/**
 * `list_windows` → `list_windows`。
 * @param {{args: Record<string, any>, broker: {call: (m: string, p?: unknown) => Promise<any>}}} input
 */
async function listWindows(input) {
  const raw = await input.broker.call("list_windows", { app: input.args.app_ref });
  const windows = Array.isArray(raw?.windows) ? raw.windows : [];
  return {
    text: `Windows (${windows.length}):\n${windows
      .map((entry) =>
        `${entry?.window_id ?? "?"} ${entry?.title ?? ""} ${entry?.frame ?? ""}`.trim(),
      )
      .join("\n")}`,
    structuredContent: {
      schema_version: "zcode-cua-window-list-v1",
      count: windows.length,
      windows,
    },
  };
}

/**
 * `get_app_state` → `capture_app`，并把结果提交进本地 state / frame。
 * @param {{args: Record<string, any>, session: Record<string, any>, broker: {call: (m: string, p?: unknown) => Promise<any>}, now: number}} input
 */
async function getAppState(input) {
  const raw = await input.broker.call("capture_app", {
    app: input.args.app_ref,
    include_screenshot: input.args.include_screenshot,
    // disable_diffing 对 Helper 表达为 force_full；diff 状态始终由 producer 计算。
    force_full: input.args.disable_diffing,
  });
  const observation = commitObservation({
    session: input.session,
    raw,
    treeShownToModel: input.args.tree_shown_to_model,
    disableDiffing: input.args.disable_diffing,
    now: input.now,
  });
  return {
    text: [
      renderElementsText(
        observation.elements,
        `state ${observation.state_id} (${observation.kind})`,
      ),
      observation.frame
        ? observation.frame.actionable
          ? `frame ${observation.frame.frame_id} ${observation.frame.width}x${observation.frame.height}`
          : `frame not actionable (${observation.frame.reason})`
        : "no frame",
      `effect_evidence=${observation.effect_evidence}`,
    ].join("\n"),
    structuredContent: observation,
  };
}

/**
 * `request_access`：Windows 上是只读报告，永不弹窗、永不改授权。
 * @param {{args: Record<string, any>, broker: {call: (m: string, p?: unknown) => Promise<any>}}} input
 */
async function requestAccess(input) {
  const capabilities = Array.isArray(input.args.capabilities) ? input.args.capabilities : undefined;
  const [permission, inputPermission] = await Promise.all([
    input.broker.call("permission_status", capabilities ? { capabilities } : {}),
    input.broker.call("input_permission_status", capabilities ? { capabilities } : {}),
  ]);
  return {
    text: [
      "Computer Use access report (read-only; this never prompts and never changes authorization).",
      `permission_status: ${JSON.stringify(permission ?? {})}`,
      `input_permission_status: ${JSON.stringify(inputPermission ?? {})}`,
    ].join("\n"),
    structuredContent: {
      schema_version: "zcode-cua-access-report-v1",
      platform_report: "windows_read_only",
      permission: permission ?? null,
      input_permission: inputPermission ?? null,
    },
  };
}

/**
 * `stop_computer_control`：latch 本 session，释放输入保持，并尽力通知 Helper 取消 hold。
 * 幂等：首次 reason 保留，重复调用不改状态。
 *
 * @param {{args: Record<string, any>, session: Record<string, any>, broker: {call: (m: string, p?: unknown) => Promise<any>}, now: number}} input
 */
async function stopComputerControl(input) {
  const outcome = input.session.killSwitch.stop(input.args.reason);
  const released = input.session.holds.releaseSession(input.session.sessionKey);
  /** @type {string | undefined} */
  let brokerNote;
  try {
    const result = await input.broker.call("cancel_input_holds", {});
    brokerNote = typeof result?.released === "number" ? String(result.released) : "ok";
  } catch (error) {
    // stop 必须成功：Helper 不可用时只报告 producer 侧已释放的数量。
    brokerNote = error instanceof Error ? `unavailable: ${error.message}` : "unavailable";
  }
  return {
    text: [
      outcome.alreadyStopped
        ? `Computer Use already stopped for this session (first reason: ${outcome.reason ?? "none"}).`
        : `Computer Use stopped for this session${outcome.reason ? `: ${outcome.reason}` : "."}`,
      `producer released ${released.length} input hold(s); helper cancel_input_holds: ${brokerNote}`,
    ].join("\n"),
    structuredContent: {
      schema_version: "zcode-cua-stop-v1",
      already_stopped: outcome.alreadyStopped,
      reason: outcome.reason ?? null,
      released_holds: released.map((hold) => hold.id),
      helper_cancel_input_holds: brokerNote,
    },
  };
}

/** 观察类工具的 `capture_app` 参数构造，供动作后的 post-action capture 复用。 */
export function captureArgs(appRef, options = {}) {
  if (appRef === undefined || appRef === null) {
    throw new CuaProtocolError("invalid_request", "an observation requires app_ref");
  }
  return { app: appRef, include_screenshot: options.includeScreenshot === true, force_full: false };
}

export const readToolHandlers = Object.freeze({
  list_apps: listApps,
  list_windows: listWindows,
  get_app_state: getAppState,
  request_access: requestAccess,
  stop_computer_control: stopComputerControl,
});

export { listApps, listWindows, getAppState, requestAccess, stopComputerControl };
