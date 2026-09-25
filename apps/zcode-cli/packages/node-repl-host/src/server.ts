/* eslint-disable max-lines -- shared node_repl host 的 worker、CUA bridge 和生命周期必须保持同一边界。 */
import { resolve } from "node:path";
import {
  isMainThread,
  MessageChannel,
  parentPort,
  Worker,
  workerData,
  type MessagePort,
} from "node:worker_threads";
import { INVALID_PARAMS, Server, type Tool } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { JsInputJsonSchema } from "@zcode/contracts/tools/node-repl";
// 值导入必须走 @zcode/core/repl 这条深路径：barrel 会把 core 的整张图拖进 bundle
// （tool handlers → @zcode/dynamic-workflow → typescript，实测 21.7MB 且求值即崩
// ERR_AMBIGUOUS_MODULE_SYNTAX）。宿主只需要 REPL 会话本身。
// 类型也一并从 /repl 取：总入口的顶层副作用会把 Agent、Bash 注册表和工作流编译器
// 打入每个 REPL Worker，Worker 会重复承担这份开销。
import {
  NodeReplSession,
  type NodeReplRequestMeta,
  type NodeReplRunResult,
} from "@zcode/core/repl";
import { createComputerUseRuntime, type ComputerUseRuntime } from "@zcode/zcode-cua";
import { z } from "zod";
import { createBrowserBridgeGlobals, type ActiveNodeReplCall } from "./browser-bridge.js";
import {
  createComputerUseBridgeGlobals,
  createNodeReplCuaCapabilityClient,
  NODE_REPL_CUA_CAPABILITY_PORT,
  NODE_REPL_CUA_CAPABILITY_READY,
  type ActiveCuaNodeReplCall,
  type NodeReplCuaCapabilityClient,
  type NodeReplCuaBrokerConnection,
} from "./cua-bridge.js";
import { serveNodeReplCuaCapabilityPort } from "./cua-broker.js";
import {
  isDirectMcpEntrypoint,
  installNodeReplProcessGuards,
  installNodeReplShutdownTriggers,
} from "./process-lifecycle.js";
import { toMcpRunResult } from "./result.js";
import {
  JS_TOOL_DESCRIPTION,
  NODE_REPL_DEFAULT_TIMEOUT_MS,
  NODE_REPL_SERVER_INSTRUCTIONS,
  NODE_REPL_SERVER_VERSION,
} from "./tool-contract.js";

const MAX_SYNC_TIMEOUT_MS = 120_000;
const UNTRUSTED_SESSION_KEY = "__unscoped__";
const WORKER_KIND = "zcode-node-repl-call";
/**
 * Worker 环境里必须剔除的 CUA broker 凭据，来源见 packages/shared/src/runtimeEnv.ts。
 * Browser bridge 仍需要自己的 broker 凭据，因此这里只删 CUA 凭据键，不清空整个环境。
 * `ZCODE_CUA_PLUGIN_ROOT` 是 CUA 文档根路径（不是凭据），故意保留。
 */
const CUA_WORKER_ENV_DENYLIST = [
  "ZCODE_CUA_PERMISSION_BROKER_SOCKET",
  "ZCODE_CUA_PERMISSION_BROKER_TOKEN",
  "ZCODE_CUA_PERMISSION_BROKER_REFRESH_MARKER",
  "ZCODE_CUA_PLUGIN_AUTHORITY",
  "ZCODE_CUA_HELPER_ADDON",
  "ZCODE_CUA_HELPER_INSTALL_VARIANT",
  "ZCODE_CUA_LAUNCHER_PID",
  "ZCODE_CUA_LAUNCHER_BUNDLE_ID",
  "ZCODE_CUA_HELPER_TEAM_ID",
  "ZCODE_CUA_HELPER_BUILD_ID",
  "ZCODE_CUA_PERMISSION_BROKER_UNAVAILABLE",
] as const;

function createWorkerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of CUA_WORKER_ENV_DENYLIST) delete env[key];
  return env;
}

export const NODE_REPL_MCP_PROCESS_TITLE = "zcode-node-repl-mcp";
const pluginRoot = process.env.ZCODE_PLUGIN_ROOT ?? process.cwd();
// CUA 与 Browser Use 共用 node_repl host，但文档和 native 依赖必须按领域隔离；
// 否则 CUA skill 会因为 host root 恰好来自 Browser Use 而再次产生隐式依赖。
const browserDocumentationRoot = resolve(pluginRoot, "docs");
const cuaDocumentationRoot = resolve(
  process.env.ZCODE_CUA_PLUGIN_ROOT ?? pluginRoot,
  "docs",
);
const jsInputSchema = z
  .object({
    code: z.string(),
    timeout_ms: z.number().int().min(1).max(MAX_SYNC_TIMEOUT_MS).optional(),
    // tools/list 对新调用强制 title，但执行层必须继续接受旧 provider 和历史回放的 code-only 输入。
    title: z.string().min(1).max(120).optional(),
  })
  .strict();
const requestContextSchema = z
  .object({
    parent_span_id: z.string().optional(),
    runtime_scope: z.enum(["main", "subagent"]).default("main"),
    session_id: z.string().trim().min(1).optional(),
    span_id: z.string().optional(),
    trace_id: z.string().optional(),
    turn_id: z.string().optional(),
    workspace_identity: z.string().optional(),
    workspace_key: z.string().optional(),
    workspace_path: z.string().optional(),
    remote_session_id: z.string().optional(),
    client_mode: z.string().optional(),
    delivery_kind: z.string().optional(),
  })
  .passthrough();

const tools: Tool[] = [
  {
    name: "js",
    description: JS_TOOL_DESCRIPTION,
    // host MCP 曾手写出 title optional 的模型合同，和 built-in 合同分叉后 UI 只能显示固定完成文案。
    inputSchema: JsInputJsonSchema as Tool["inputSchema"],
  },
];

export interface NodeReplExecuteInput {
  code: string;
  requestMeta: NodeReplRequestMeta;
  signal: AbortSignal;
  syncTimeoutMs: number;
  /**
   * private capability 通道。生产 Worker 路径只走它，Worker 内拿不到 broker 凭据。
   * Worker executor 自己的 bridge 端点由它建立。
   */
  cuaCapability?: NodeReplCuaCapabilityClient;
  /** 同进程嵌入与旧 bundle 的兼容通道；生产 Worker 路径不再传。 */
  cuaBroker?: NodeReplCuaBrokerConnection;
}

export type NodeReplExecutor = (input: NodeReplExecuteInput) => Promise<NodeReplRunResult>;

export interface NodeReplMcpRuntime {
  dispose(): void;
  server: Server;
}

interface WorkerCallData {
  code: string;
  kind: typeof WORKER_KIND;
  requestMeta: NodeReplRequestMeta;
  syncTimeoutMs: number;
}

export function setNodeReplMcpProcessTitle(target: { title: string } = process): void {
  target.title = NODE_REPL_MCP_PROCESS_TITLE;
}

/**
 * 测试与同进程嵌入入口使用同一条执行逻辑；生产 stdio 默认在一次性 Worker 中调用它，
 * 从而连 Node 的模块缓存也随调用一起销毁。
 */
export function createInProcessNodeReplExecutor(): NodeReplExecutor {
  return async (input) => {
    let activeCall: ActiveNodeReplCall | undefined;
    let activeCuaCall: ActiveCuaNodeReplCall | undefined;
    let session: NodeReplSession;
    const generation = 1;
    session = new NodeReplSession({
      injectedGlobals: () =>
        ({
          ...createBrowserBridgeGlobals({
            documentationRoot: browserDocumentationRoot,
            generation,
            getActiveCall: () => activeCall,
            session: () => session,
          }),
          ...createComputerUseBridgeGlobals({
            capability: input.cuaCapability,
            broker: input.cuaBroker,
            generation,
            getActiveCall: () => activeCuaCall,
            session: () => session,
            documentationRoot: cuaDocumentationRoot,
          }),
        }),
      restrictProcess: true,
    });
    activeCall = {
      generation,
      requestMeta: input.requestMeta,
      signal: input.signal,
    };
    activeCuaCall = {
      generation,
      requestMeta: input.requestMeta,
      signal: input.signal,
    };
    try {
      return await session.run(input.code, {
        requestMeta: input.requestMeta,
        signal: input.signal,
        syncTimeoutMs: input.syncTimeoutMs,
      });
    } finally {
      activeCall = undefined;
      activeCuaCall = undefined;
      session.dispose();
    }
  };
}

export function createNodeReplMcpRuntime(
  input: { executeJs?: NodeReplExecutor; cuaRuntime?: ComputerUseRuntime } = {},
): NodeReplMcpRuntime {
  const cuaRuntime = input.cuaRuntime ?? captureComputerUseRuntimeFromEnvironment();
  const executeJs =
    input.executeJs ??
    ((execInput: NodeReplExecuteInput) => executeJsInWorker(execInput, cuaRuntime));
  const queues = new Map<string, Promise<void>>();
  const activeCalls = new Set<AbortController>();
  let disposed = false;

  const serialized = async <T>(key: string, run: () => Promise<T>): Promise<T> => {
    const previous = queues.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const next = new Promise<void>((resolveQueue) => {
      release = resolveQueue;
    });
    queues.set(key, next);
    await previous;
    try {
      return await run();
    } finally {
      release();
      if (queues.get(key) === next) queues.delete(key);
    }
  };

  const server = new Server(
    { name: "node_repl", version: NODE_REPL_SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: NODE_REPL_SERVER_INSTRUCTIONS },
  );

  server.setRequestHandler("tools/list", async () => ({ tools }));
  server.setRequestHandler("tools/call", async (request, extra) => {
    if (disposed) throw new Error("node_repl runtime is disposed");
    const name = request.params.name;
    const requestMeta = buildRequestMeta(extra.mcpReq._meta);
    const sessionKey = requestSessionKey(requestMeta);
    if (name === "js") {
      const args = parseToolInput(jsInputSchema, request.params.arguments, name);
      return await serialized(sessionKey, async () => {
        if (!args.code) {
          return {
            content: [{ type: "text" as const, text: "js expects non-empty JavaScript source" }],
            isError: true,
          };
        }
        const callController = new AbortController();
        activeCalls.add(callController);
        const timeoutMs = args.timeout_ms ?? NODE_REPL_DEFAULT_TIMEOUT_MS;
        const callMeta = { ...requestMeta, ...(args.title ? { title: args.title } : {}) };
        try {
          const signal = AbortSignal.any([
            extra.mcpReq.signal,
            callController.signal,
            AbortSignal.timeout(timeoutMs),
          ]);
          const run = await executeJs({
            code: args.code,
            requestMeta: callMeta,
            signal,
            syncTimeoutMs: Math.min(timeoutMs, MAX_SYNC_TIMEOUT_MS),
          });
          return toMcpRunResult(run);
        } finally {
          activeCalls.delete(callController);
        }
      });
    }
    invalidParams(`Tool ${name} not found`);
  });

  return {
    server,
    dispose: () => {
      disposed = true;
      for (const controller of activeCalls) controller.abort();
      activeCalls.clear();
      queues.clear();
      void cuaRuntime?.dispose();
    },
  };
}

/**
 * 生产 Worker 执行路径。
 *
 * `runtime` 留在 main：Worker 用剔除 CUA 凭据后的环境启动，workerData 里没有 socket/token，能力通道是
 * 启动后经 parentPort 转移的 MessagePort。同进程嵌入与测试可直接用
 * `createInProcessNodeReplExecutor` 注入。
 */
export async function executeJsInWorker(
  input: NodeReplExecuteInput,
  runtime?: ComputerUseRuntime,
): Promise<NodeReplRunResult> {
  if (input.signal.aborted) throw input.signal.reason;
  const data: WorkerCallData = {
    code: input.code,
    kind: WORKER_KIND,
    requestMeta: input.requestMeta,
    syncTimeoutMs: input.syncTimeoutMs,
  };
  const worker = new Worker(new URL(import.meta.url), {
    env: createWorkerEnv(),
    workerData: data,
  });
  // 端口不放在 workerData，必须在 Worker 起来后经 parentPort 转移；无论有没有 runtime 都发
  // 一条消息，让 Worker 有一个确定的「可以开始执行」信号，避免端口与首段代码的启动竞态。
  const channel = runtime ? new MessageChannel() : undefined;
  const capability =
    channel && runtime
      ? serveNodeReplCuaCapabilityPort({ port: channel.port1, runtime })
      : undefined;
  return await new Promise<NodeReplRunResult>((resolveRun, rejectRun) => {
    let settled = false;
    const cleanup = () => {
      input.signal.removeEventListener("abort", onAbort);
      worker.removeAllListeners();
      capability?.close();
      channel?.port1.close();
    };
    const finish = (error?: unknown, result?: NodeReplRunResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      void worker.terminate().catch(() => undefined);
      if (error !== undefined) rejectRun(error);
      else if (result) resolveRun(result);
      else rejectRun(new Error("node_repl worker returned no result"));
    };
    const onAbort = () => finish(input.signal.reason ?? new DOMException("aborted", "AbortError"));
    input.signal.addEventListener("abort", onAbort, { once: true });
    worker.once("message", (message: unknown) => finish(undefined, message as NodeReplRunResult));
    worker.once("error", finish);
    worker.once("exit", (code) => {
      if (!settled)
        finish(new Error(`node_repl worker exited before returning a result (${code})`));
    });
    if (channel) {
      // 端口必须在 Worker 起来后经 parentPort 转移：写进 workerData 等于把 capability
      // 重新变成模型能序列化读的 worker 数据。
      deliverCapability(worker, channel.port2, NODE_REPL_CUA_CAPABILITY_PORT);
    } else {
      deliverCapability(worker, null, NODE_REPL_CUA_CAPABILITY_READY);
    }
    if (input.signal.aborted) onAbort();
  });
}

/**
 * Worker 启动消息也是它的启动门：没有这条消息，Worker 不会执行首段代码。
 * 因此 postMessage 失败必须走 finish（Worker 不会回报结果，只能 terminate）。
 */
function deliverCapability(
  worker: Worker,
  port: MessagePort | null,
  kind: string,
): void {
  try {
    worker.postMessage({ kind, port }, port ? [port] : []);
  } catch (error) {
    worker.emit("error", error instanceof Error ? error : new Error(String(error)));
  }
}

function parseToolInput<T>(schema: z.ZodType<T>, input: unknown, toolName: string): T {
  const parsed = schema.safeParse(input ?? {});
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  invalidParams(`${toolName}: ${issue?.message ?? "invalid arguments"}`);
}

function invalidParams(message: string): never {
  throw Object.assign(new Error(message), { code: INVALID_PARAMS });
}

function buildRequestMeta(meta: Record<string, unknown> | undefined): NodeReplRequestMeta {
  const parsed = requestContextSchema.safeParse(meta?.["com.zcode/request-context"]);
  // 安全边界：顶层 MCP _meta 是第三方可扩展字段，不能成为 ZCode session 路由凭据。
  // 只有 host client 写入的命名空间会进入 Browser bridge；旧 client 的普通 JS 仍可执行。
  return parsed.success ? parsed.data : {};
}

function requestSessionKey(meta: NodeReplRequestMeta): string {
  const sessionId = meta.session_id;
  return typeof sessionId === "string" && sessionId.trim() ? sessionId : UNTRUSTED_SESSION_KEY;
}

export { installNodeReplProcessGuards, installNodeReplShutdownTriggers };

export async function main(): Promise<void> {
  setNodeReplMcpProcessTitle();
  const runtimes = new Set<NodeReplMcpRuntime>();
  // 官方 plugin host 在 main() 返回后会清除短暂恢复的 Helper 凭据，而
  // serveStdio 的 server factory 要到 MCP initialize 时才执行。过去在 factory 内读取
  // process.env，必然得到空值，导致 node_repl 永久把 Computer Use 判为 unavailable。
  // 这里在 main() 生命周期内先捕获 runtime；Worker 只收到二次 bridge token，
  // 不会接触 Helper 的原始 socket/token。
  const computerUseRuntime = captureComputerUseRuntimeFromEnvironment();
  const handle = serveStdio(
    () => {
      const runtime = createNodeReplMcpRuntime({ cuaRuntime: computerUseRuntime });
      runtimes.add(runtime);
      return runtime.server;
    },
    { legacy: "reject" },
  );
  let shutdownStarted = false;
  const shutdown = () => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    for (const runtime of runtimes) runtime.dispose();
    void handle
      .close()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };
  installNodeReplProcessGuards({
    onOutputClosed: shutdown,
    process,
    writeStderr: (text) => process.stderr.write(text),
  });
  installNodeReplShutdownTriggers({ process, shutdown, stdin: process.stdin });
}

if (!isMainThread && isWorkerCallData(workerData)) {
  const execute = createInProcessNodeReplExecutor();
  const controller = new AbortController();
  // capability 端口只在 Worker 启动后经 parentPort 收到；到达前 bridge 调用一律 unavailable。
  let capability: (NodeReplCuaCapabilityClient & { close(): void }) | undefined;
  const finish = (result: NodeReplRunResult) => {
    capability?.close();
    parentPort?.postMessage(result);
  };
  const run = (): void => {
    void execute({
      code: workerData.code,
      requestMeta: workerData.requestMeta,
      signal: controller.signal,
      syncTimeoutMs: workerData.syncTimeoutMs,
      cuaCapability: capability,
    }).then(finish, (error: unknown) => finish(toWorkerErrorResult(error)));
  };
  parentPort?.once("message", (message: unknown) => {
    const port = readTransferredCapabilityPort(message);
    if (port) capability = createNodeReplCuaCapabilityClient(port);
    run();
  });
}

/** 转移过来的端口不能被伪造成普通对象：只认真有 postMessage 的 MessagePort。 */
function readTransferredCapabilityPort(message: unknown): MessagePort | undefined {
  if (!message || typeof message !== "object") return undefined;
  const payload = message as { kind?: unknown; port?: unknown };
  if (payload.kind !== NODE_REPL_CUA_CAPABILITY_PORT) return undefined;
  const port = payload.port as MessagePort | undefined;
  return port && typeof port.postMessage === "function" ? port : undefined;
}

function toWorkerErrorResult(error: unknown): NodeReplRunResult {
  return {
    logs: "",
    error: {
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

export function captureComputerUseRuntimeFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): ComputerUseRuntime | undefined {
  const socketPath = env.ZCODE_CUA_PERMISSION_BROKER_SOCKET?.trim();
  if (!socketPath) return undefined;
  return createComputerUseRuntime({
    brokerSocketPath: socketPath,
    refreshMarkerPath: env.ZCODE_CUA_PERMISSION_BROKER_REFRESH_MARKER?.trim(),
  });
}

function isWorkerCallData(value: unknown): value is WorkerCallData {
  if (!value || typeof value !== "object") return false;
  return (value as { kind?: unknown }).kind === WORKER_KIND;
}

if (isMainThread && (await isDirectMcpEntrypoint(import.meta.url, process.argv[1]))) {
  void main().catch((error) => {
    process.stderr.write(
      `node_repl MCP server failed: ${error instanceof Error ? error.stack : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
