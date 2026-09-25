/**
 * JS producer runtime。
 *
 * 进程内唯一的 runtime 对象：按 sessionKey 分区 state / frame / kill switch /
 * hold / 待决效果基线，按需建立已认证的 NDJSON 连接，并输出与 node_repl
 * `ComputerUseRuntime` 契约一致的 execute / closeSession / dispose。
 *
 * 事件顺序：
 *
 *   execute → 校验 tool 与 scope → 取 session → stop 熔断 → strict 校验参数
 *          → broker(port) 认证 → handler 预检 → 方法帧 → receipt → CallToolResult
 *
 * 失败一律不重放：未越过管道的失败是 not_sent，越过管道后是 possibly_sent。
 */

import { CuaProtocolError } from "../protocol/errors.js";
import { MAX_BROKER_CONNECTIONS } from "../protocol/limits.js";
import { STOP_EXEMPT_TOOLS } from "../protocol/tool-schemas.js";
import { BrokerCallError, createBrokerConnection } from "../broker/connection.js";
import { receiptForFailure } from "./receipt.js";
import { createSessionRegistry } from "./session-registry.js";
import { resolveTool } from "../tools/registry.js";

/** receipt 在结果元数据里的固定键；与 action receipt schema 版本对齐。 */
export const CUA_ACTION_RECEIPT_META_KEY = "zcode.cua/action-receipt-v1";
/** subagent 看不到 Computer Use：模型作用域由 node_repl 声明，这里不自行推断。 */
export const CUA_SUBAGENT_DENIED_MESSAGE = "Computer Use is not available in subagent";

/**
 * @param {{
 *   brokerSocketPath?: string,
 *   connect?: (path: string) => unknown,
 *   now?: () => number,
 *   role?: string,
 *   clientInfo?: Record<string, unknown>,
 *   requestTimeoutMs?: number,
 * }} [options]
 */
export function createProducerRuntime(options = {}) {
  const now = options.now ?? Date.now;
  const registry = createSessionRegistry({
    now,
    // 淘汰与 dispose 走同一条释放路径：hold 先释放，再关连接。
    closeSession: (session) => closeSessionResources(session),
  });
  /** @type {Set<string>} 已建立连接的 sessionKey，受 native 并发连接预算约束。 */
  const connected = new Set();
  let disposed = false;

  /**
   * 建立（或复用）这个 session 的 broker port。连接是懒建立、authenticate-first 的。
   * @param {Record<string, any>} session
   */
  const ensureBroker = async (session) => {
    if (session.broker) return session.broker;
    if (typeof options.brokerSocketPath !== "string" || options.brokerSocketPath.length === 0) {
      throw new CuaProtocolError("broker_unavailable", "no broker socket path is configured");
    }
    if (typeof options.connect !== "function") {
      throw new CuaProtocolError("broker_unavailable", "no broker connect() is configured");
    }
    if (connected.size >= MAX_BROKER_CONNECTIONS) {
      throw new CuaProtocolError("controller_busy", "the broker connection budget is exhausted");
    }
    const connection = createBrokerConnection({
      path: options.brokerSocketPath,
      connect: options.connect,
      role: options.role ?? "tool",
      clientInfo: options.clientInfo ?? {},
      ...(options.requestTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: options.requestTimeoutMs }),
    });
    await connection.authenticate();
    connected.add(session.sessionKey);
    session.broker = {
      call: (method, params) => connection.call(method, params),
      connection,
    };
    return session.broker;
  };

  const closeSessionResources = (session) => {
    session.holds?.releaseSession(session.sessionKey);
    connected.delete(session.sessionKey);
    try {
      session.broker?.connection?.close?.();
    } catch {
      // 关闭失败没有本地可恢复动作，Helper 侧按管道生命周期回收。
    }
    session.broker = undefined;
  };

  /**
   * 把 handler 结果与失败统一投影成 CallToolResult。
   * @param {{text: string, structuredContent?: unknown, meta?: Record<string, unknown>}} result
   * @param {boolean} isError
   */
  const toCallToolResult = (result, isError) => {
    /** @type {Record<string, unknown>} */
    const meta = { ...(result.meta ?? {}) };
    if (isPlainRecord(result.structuredContent)) {
      const receipt = result.structuredContent.action_receipt;
      if (receipt) meta[CUA_ACTION_RECEIPT_META_KEY] = receipt;
    }
    return {
      content: [{ type: "text", text: result.text }],
      ...(result.structuredContent === undefined
        ? {}
        : { structuredContent: result.structuredContent }),
      ...(Object.keys(meta).length === 0 ? {} : { _meta: meta }),
      ...(isError ? { isError: true } : {}),
    };
  };

  /**
   * 执行一次工具调用。
   * @param {{toolName: string, arguments?: unknown, context: Record<string, any>, signal?: AbortSignal}} input
   */
  const execute = async (input) => {
    try {
      return await runTool(input);
    } catch (error) {
      return toCallToolResult(failureResult(input, error), true);
    }
  };

  const runTool = async (input) => {
    if (disposed) {
      throw new CuaProtocolError("session_closed", "the Computer Use runtime is disposed");
    }
    const context = input?.context;
    if (!isPlainRecord(context)) {
      throw new CuaProtocolError("invalid_request", "runtime context is required");
    }
    // subagent 作用域 fail closed：模型作用域由 node_repl 声明，runtime 不自行放宽。
    if (context.runtimeScope === "subagent") {
      throw new CuaProtocolError("subagent_forbidden", CUA_SUBAGENT_DENIED_MESSAGE);
    }
    if (input.signal?.aborted) {
      throw new CuaProtocolError("invalid_request", "the call was aborted before admission");
    }
    const tool = resolveTool(input.toolName);
    const session = registry.acquire(context);
    if (!tool.definition.stopExempt && session.killSwitch.isStopped()) {
      const reason = session.killSwitch.snapshot().reason;
      throw new CuaProtocolError(
        "control_stopped",
        `Computer Use was stopped for this session${reason ? `: ${reason}` : ""}; only request_access and stop_computer_control remain available`,
      );
    }
    const parsed = tool.definition.parse(input.arguments);
    if (!parsed.ok) {
      throw new CuaProtocolError(
        "invalid_request",
        `${tool.name} arguments rejected: ${parsed.issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`,
        { details: { issues: parsed.issues } },
      );
    }
    const broker = await ensureBroker(session);
    const result = await tool.handler({
      args: parsed.value,
      context,
      session,
      broker,
      now: now(),
      signal: input.signal,
    });
    return toCallToolResult(result, false);
  };

  /**
   * @param {{toolName?: string, context?: Record<string, any>}} input
   * @param {unknown} error
   */
  const failureResult = (input, error) => {
    const classified = receiptForFailure(error);
    const toolName = typeof input?.toolName === "string" ? input.toolName : "unknown";
    const code = classified.code;
    const message = error instanceof Error ? error.message : String(error);
    const text = [
      `${code}: ${message}`,
      classified.dispatchStatus === "possibly_sent"
        ? "The action may already have reached the desktop; observe again instead of retrying."
        : "The action was not sent.",
    ].join("\n");
    return {
      text,
      structuredContent: {
        schema_version: "zcode-cua-action-v1",
        tool: toolName,
        no_op: false,
        action_receipt: classified.receipt,
      },
      meta: {
        [CUA_ACTION_RECEIPT_META_KEY]: classified.receipt,
        "zcode.cua/retry-policy": classified.retry,
        ...(error instanceof BrokerCallError && error.details !== undefined
          ? { "zcode.cua/error-details": error.details }
          : {}),
      },
    };
  };

  const closeSession = async (context) => {
    const session = registry.peek(context);
    if (!session) return;
    closeSessionResources(session);
    registry.closeByContext(context);
  };

  const dispose = async () => {
    disposed = true;
    await registry.dispose();
    connected.clear();
  };

  return {
    execute,
    closeSession,
    dispose,
    /** 诊断用：当前 session 数量与连接预算。 */
    inspect: () => ({ sessions: registry.size(), connections: connected.size, disposed }),
  };
}

const isPlainRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export { STOP_EXEMPT_TOOLS };
