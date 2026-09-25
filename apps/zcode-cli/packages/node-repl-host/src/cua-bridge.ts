import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import type { MessagePort } from "node:worker_threads";
import type { NodeReplCuaAppIdentity, NodeReplRequestMeta, NodeReplSession } from "@zcode/core";
import { CUA_APP_ASSOCIATIONS_META_KEY } from "@zcode/zcode-cua/host-display-contract";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const NODE_REPL_CUA_BRIDGE_SYMBOL = Symbol.for("zcode.node-repl.computer-use-bridge");
/** main→Worker 私有 capability 通道的端口名；只在 worker 启动后经 parentPort 投递。 */
export const NODE_REPL_CUA_CAPABILITY_PORT = "zcode.node-repl.computer-use-capability-port";
/** 本次 cell 没有 CUA runtime 时 main 发的那条空投递，给 Worker 一个确定的启动信号。 */
export const NODE_REPL_CUA_CAPABILITY_READY = "zcode.node-repl.computer-use-capability-ready";
export const CUA_UNAVAILABLE_IN_SUBAGENT_MESSAGE = "Computer Use is not available in subagent";
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

export interface ActiveCuaNodeReplCall {
  generation: number;
  requestMeta: NodeReplRequestMeta;
  signal: AbortSignal;
}

/**
 * 旧的本进程 broker 凭据连接。
 *
 * 生产 Worker 路径已不再使用它（见 `specs/computer-use/windows-runtime.md` 的
 * migration boundary #1）：Worker 只拿 MessagePort，runtime 调用留在 main。这里保留类型只是为了
 * 不打断同进程嵌入与旧 bundle 的 source 兼容。
 */
export interface NodeReplCuaBrokerConnection {
  socketPath: string;
  token: string;
}

/** Worker 侧发往 main 的 capability 请求：不含任何 socket/token，只带方法与参数。 */
export interface NodeReplCuaCapabilityRequest {
  id: string;
  method: string;
  input: unknown;
  context: Record<string, unknown>;
}

/** main 侧回给 Worker 的应答；`responseMeta` 仍由 Worker 内的 bridge 合入宿主 sink。 */
export type NodeReplCuaCapabilityResponse =
  | { id: string; ok: true; result: CallToolResult; responseMeta?: Record<string, unknown> }
  | { id: string; ok: false; error: string };

/** Worker 侧 bridge 依赖的最小能力面，便于测试注入假端口。 */
export interface NodeReplCuaCapabilityClient {
  call(
    request: NodeReplCuaCapabilityRequest,
    signal: AbortSignal,
  ): Promise<NodeReplCuaCapabilityResponse>;
}

export interface ComputerUseRuntimeBridge {
  /** 私有 capability 请求；这里不是 MCP tool 调用，MCP 只承载外层 node_repl。 */
  call(method: string, input: unknown): Promise<CallToolResult>;
  assertAvailable(): void;
  documentationRoot: string;
}

export function createComputerUseBridgeGlobals(input: {
  capability?: NodeReplCuaCapabilityClient;
  /** 同进程嵌入/旧 bundle 的兼容通道；生产 Worker 路径只传 capability。 */
  broker?: NodeReplCuaBrokerConnection;
  generation: number;
  getActiveCall: () => ActiveCuaNodeReplCall | undefined;
  session: () => NodeReplSession;
  documentationRoot: string;
}): Record<PropertyKey, unknown> {
  const assertActive = (): ActiveCuaNodeReplCall => {
    const active = input.getActiveCall();
    if (!active || active.generation !== input.generation) {
      throw new Error("Computer Use runtime binding is stale after kernel reset");
    }
    return active;
  };
  const assertAvailable = (): ActiveCuaNodeReplCall => {
    const active = assertActive();
    if (active.requestMeta.runtime_scope === "subagent") {
      throw new Error(CUA_UNAVAILABLE_IN_SUBAGENT_MESSAGE);
    }
    if (!input.capability && !input.broker) {
      throw new Error("Computer Use is unavailable for this node_repl session");
    }
    return active;
  };

  const bridge: ComputerUseRuntimeBridge = {
    documentationRoot: input.documentationRoot,
    assertAvailable: () => {
      assertAvailable();
    },
    call: async (method, methodInput) => {
      const active = assertAvailable();
      const context = requestContext(active.requestMeta);
      const response = input.capability
        ? await input.capability.call(
            { id: randomUUID(), method, input: methodInput, context },
            active.signal,
          )
        : await sendCuaBrokerRequest(
            input.broker!,
            { method, input: methodInput, context },
            active.signal,
          );
      assertActive();
      if (!response.ok) throw new Error(response.error);
      const result = response.result;
      if (response.responseMeta) input.session().mergeResponseMeta(response.responseMeta);
      // 目标应用身份必须在这里取：broker 响应是模型看不见也改不了的一跳。等到
      // `projectToHost` 把 `_meta` 交给 `nodeRepl.emitStructuredResult` 就已经落在模型可写的
      // sandbox 通道上，无法再区分「producer 给的」和「cell 里自己写的」。
      const app = readPrimaryAppIdentity(result);
      if (app) input.session().recordCuaAppIdentity(app);
      return result;
    },
  };

  return { [NODE_REPL_CUA_BRIDGE_SYMBOL]: bridge };
}

/**
 * Worker 侧的 MessagePort capability 客户端。
 *
 * 端口由 main 在 Worker 启动后经 parentPort 转移过来，模型既拿不到 socket/token，也无法自己
 * `new Worker` 重建；abort 立即关闭端口并拒绝在途请求，端口随之从 Worker 的消息循环里摘除。
 */
export function createNodeReplCuaCapabilityClient(
  port: MessagePort,
): NodeReplCuaCapabilityClient & { close(): void } {
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    port.close();
  };
  return {
    close,
    call: async (request, signal) =>
      await new Promise<NodeReplCuaCapabilityResponse>((resolve, reject) => {
        if (closed) {
          reject(new Error("Computer Use capability channel is closed"));
          return;
        }
        let settled = false;
        const cleanup = () => {
          signal.removeEventListener("abort", onAbort);
          port.off("message", onMessage);
          port.off("messageerror", onMessageError);
          port.off("close", onClose);
        };
        const settle = (fn: () => void) => {
          if (settled) return;
          settled = true;
          cleanup();
          fn();
        };
        const onMessage = (message: unknown) => {
          const response = readCapabilityResponse(message);
          if (!response || response.id !== request.id) return;
          settle(() => (response.ok ? resolve(response) : reject(new Error(response.error))));
        };
        const onMessageError = (error: Error) => settle(() => reject(error));
        const onClose = () =>
          settle(() => reject(new Error("Computer Use capability channel closed")));
        const onAbort = () =>
          settle(() => {
            close();
            reject(signal.reason ?? new DOMException("aborted", "AbortError"));
          });
        port.on("message", onMessage);
        port.once("messageerror", onMessageError);
        port.once("close", onClose);
        signal.addEventListener("abort", onAbort, { once: true });
        port.postMessage(request);
        if (signal.aborted) onAbort();
      }),
  };
}

function readCapabilityResponse(value: unknown): NodeReplCuaCapabilityResponse | undefined {
  if (!value || typeof value !== "object") return undefined;
  const payload = value as {
    id?: unknown;
    ok?: unknown;
    result?: unknown;
    error?: unknown;
    responseMeta?: unknown;
  };
  if (typeof payload.id !== "string") return undefined;
  if (payload.ok === false) {
    return {
      id: payload.id,
      ok: false,
      error: typeof payload.error === "string" ? payload.error : "Computer Use request failed",
    };
  }
  if (payload.ok !== true || typeof payload.result !== "object" || !payload.result) return undefined;
  const responseMeta = readResponseMeta(payload.responseMeta);
  return {
    id: payload.id,
    ok: true,
    result: payload.result as CallToolResult,
    ...(responseMeta ? { responseMeta } : {}),
  };
}

/** responseMeta 只接受普通对象：数组与原始值不构成 host sink 的 meta 形状。 */
export function readResponseMeta(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/**
 * 从 producer 的 app-associations 元数据里取出单一目标应用。
 *
 * 只读 `primary`：`list_apps` 用的是 `items` 模式（按结果下标关联，node_repl 下没有逐条列表卡），
 * `request_access` / `stop_computer_control` 声明 `none`，这三者都不该覆盖同一 cell 里前面动作
 * 已经确立的身份。producer 自带的内联 icon PNG 刻意不取：会话协议不承载图标字节，UI 按
 * appKey 派生 locator 后交平台服务解析。
 */
function readPrimaryAppIdentity(result: CallToolResult): NodeReplCuaAppIdentity | undefined {
  const meta = result._meta;
  if (!meta || typeof meta !== "object") return undefined;
  const associations = (meta as Record<string, unknown>)[CUA_APP_ASSOCIATIONS_META_KEY];
  if (!associations || typeof associations !== "object" || Array.isArray(associations)) {
    return undefined;
  }
  const primary = (associations as { primary?: unknown }).primary;
  if (!primary || typeof primary !== "object" || Array.isArray(primary)) return undefined;
  const { appKey, displayName } = primary as { appKey?: unknown; displayName?: unknown };
  if (typeof appKey !== "string" || !appKey.trim()) return undefined;
  return {
    appKey: appKey.trim(),
    ...(typeof displayName === "string" && displayName.trim()
      ? { displayName: displayName.trim() }
      : {}),
  };
}

function requestContext(meta: NodeReplRequestMeta): Record<string, unknown> {
  const stringMeta = (key: string): string | undefined => {
    const value = meta[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  const sessionId = stringMeta("session_id");
  if (!sessionId) throw new Error("node_repl CUA request is missing session_id metadata");
  const workspacePath = stringMeta("workspace_path");
  const workspaceIdentity = stringMeta("workspace_identity");
  const workspaceKey = stringMeta("workspace_key") ?? workspaceIdentity ?? workspacePath;
  if (!workspaceKey) throw new Error("node_repl CUA request is missing workspaceKey metadata");
  const clientMode = stringMeta("client_mode") ?? "desktop-continuous";
  const deliveryKind = stringMeta("delivery_kind") ?? clientMode;
  return {
    runtimeScope: meta.runtime_scope === "subagent" ? "subagent" : "main",
    sessionId,
    ...(workspacePath ? { workspacePath } : {}),
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    workspaceKey,
    ...(stringMeta("remote_session_id")
      ? { remoteSessionId: stringMeta("remote_session_id") }
      : {}),
    ...(stringMeta("turn_id") ? { turnId: stringMeta("turn_id") } : {}),
    clientMode,
    deliveryKind,
    ...(stringMeta("trace_id")
      ? {
          trace: {
            traceId: stringMeta("trace_id"),
            ...(stringMeta("span_id") ? { spanId: stringMeta("span_id") } : {}),
            ...(stringMeta("parent_span_id")
              ? { parentSpanId: stringMeta("parent_span_id") }
              : {}),
          },
        }
      : {}),
  };
}

async function sendCuaBrokerRequest(
  broker: NodeReplCuaBrokerConnection,
  request: { method: string; input: unknown; context: Record<string, unknown> },
  signal: AbortSignal,
): Promise<NodeReplCuaCapabilityResponse> {
  const id = randomUUID();
  return await new Promise((resolve, reject) => {
    const socket = createConnection(broker.socketPath);
    let buffer = "";
    let settled = false;
    const finish = (error?: unknown, value?: NodeReplCuaCapabilityResponse) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      socket.destroy();
      if (error) reject(error);
      else if (value) resolve(value);
      else reject(new Error("Computer Use broker returned no response"));
    };
    const onAbort = () => finish(signal.reason ?? new DOMException("aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ id, token: broker.token, ...request })}\n`);
    });
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer) > MAX_RESPONSE_BYTES) {
        finish(new Error("Computer Use broker response exceeded the 32 MiB limit"));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const payload = JSON.parse(buffer.slice(0, newline)) as {
          id?: unknown;
          ok?: unknown;
          error?: unknown;
          result?: CallToolResult;
          responseMeta?: Record<string, unknown>;
        };
        if (payload.id !== id) throw new Error("Computer Use broker response id mismatch");
        if (payload.ok !== true) {
          const message =
            typeof payload.error === "string" ? payload.error : "Computer Use broker failed";
          finish(new Error(message));
          return;
        }
        if (!payload.result) throw new Error("Computer Use broker returned no result");
        finish(undefined, {
          id,
          ok: true,
          result: payload.result,
          responseMeta: readResponseMeta(payload.responseMeta),
        });
      } catch (error) {
        finish(error);
      }
    });
    socket.once("error", finish);
    socket.once("close", () => {
      if (!settled) finish(new Error("Computer Use broker closed before returning a response"));
    });
    if (signal.aborted) onAbort();
  });
}
