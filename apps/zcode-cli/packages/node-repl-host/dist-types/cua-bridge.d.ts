import type { MessagePort } from "node:worker_threads";
import type { NodeReplRequestMeta, NodeReplSession } from "@zcode/core";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
export declare const NODE_REPL_CUA_BRIDGE_SYMBOL: unique symbol;
/** main→Worker 私有 capability 通道的端口名；只在 worker 启动后经 parentPort 投递。 */
export declare const NODE_REPL_CUA_CAPABILITY_PORT = "zcode.node-repl.computer-use-capability-port";
/** 本次 cell 没有 CUA runtime 时 main 发的那条空投递，给 Worker 一个确定的启动信号。 */
export declare const NODE_REPL_CUA_CAPABILITY_READY = "zcode.node-repl.computer-use-capability-ready";
export declare const CUA_UNAVAILABLE_IN_SUBAGENT_MESSAGE = "Computer Use is not available in subagent";
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
export type NodeReplCuaCapabilityResponse = {
    id: string;
    ok: true;
    result: CallToolResult;
    responseMeta?: Record<string, unknown>;
} | {
    id: string;
    ok: false;
    error: string;
};
/** Worker 侧 bridge 依赖的最小能力面，便于测试注入假端口。 */
export interface NodeReplCuaCapabilityClient {
    call(request: NodeReplCuaCapabilityRequest, signal: AbortSignal): Promise<NodeReplCuaCapabilityResponse>;
}
export interface ComputerUseRuntimeBridge {
    /** 私有 capability 请求；这里不是 MCP tool 调用，MCP 只承载外层 node_repl。 */
    call(method: string, input: unknown): Promise<CallToolResult>;
    assertAvailable(): void;
    documentationRoot: string;
}
export declare function createComputerUseBridgeGlobals(input: {
    capability?: NodeReplCuaCapabilityClient;
    /** 同进程嵌入/旧 bundle 的兼容通道；生产 Worker 路径只传 capability。 */
    broker?: NodeReplCuaBrokerConnection;
    generation: number;
    getActiveCall: () => ActiveCuaNodeReplCall | undefined;
    session: () => NodeReplSession;
    documentationRoot: string;
}): Record<PropertyKey, unknown>;
/**
 * Worker 侧的 MessagePort capability 客户端。
 *
 * 端口由 main 在 Worker 启动后经 parentPort 转移过来，模型既拿不到 socket/token，也无法自己
 * `new Worker` 重建；abort 立即关闭端口并拒绝在途请求，端口随之从 Worker 的消息循环里摘除。
 */
export declare function createNodeReplCuaCapabilityClient(port: MessagePort): NodeReplCuaCapabilityClient & {
    close(): void;
};
/** responseMeta 只接受普通对象：数组与原始值不构成 host sink 的 meta 形状。 */
export declare function readResponseMeta(value: unknown): Record<string, unknown> | undefined;
//# sourceMappingURL=cua-bridge.d.ts.map