import { Server } from "@modelcontextprotocol/server";
import { type NodeReplRequestMeta, type NodeReplRunResult } from "@zcode/core/repl";
import { type ComputerUseRuntime } from "@zcode/zcode-cua";
import { type NodeReplCuaCapabilityClient, type NodeReplCuaBrokerConnection } from "./cua-bridge.js";
import { installNodeReplProcessGuards, installNodeReplShutdownTriggers } from "./process-lifecycle.js";
export declare const NODE_REPL_MCP_PROCESS_TITLE = "zcode-node-repl-mcp";
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
export declare function setNodeReplMcpProcessTitle(target?: {
    title: string;
}): void;
/**
 * 测试与同进程嵌入入口使用同一条执行逻辑；生产 stdio 默认在一次性 Worker 中调用它，
 * 从而连 Node 的模块缓存也随调用一起销毁。
 */
export declare function createInProcessNodeReplExecutor(): NodeReplExecutor;
export declare function createNodeReplMcpRuntime(input?: {
    executeJs?: NodeReplExecutor;
    cuaRuntime?: ComputerUseRuntime;
}): NodeReplMcpRuntime;
/**
 * 生产 Worker 执行路径。
 *
 * `runtime` 留在 main：Worker 用剔除 CUA 凭据后的环境启动，workerData 里没有 socket/token，能力通道是
 * 启动后经 parentPort 转移的 MessagePort。同进程嵌入与测试可直接用
 * `createInProcessNodeReplExecutor` 注入。
 */
export declare function executeJsInWorker(input: NodeReplExecuteInput, runtime?: ComputerUseRuntime): Promise<NodeReplRunResult>;
export { installNodeReplProcessGuards, installNodeReplShutdownTriggers };
export declare function main(): Promise<void>;
export declare function captureComputerUseRuntimeFromEnvironment(env?: NodeJS.ProcessEnv): ComputerUseRuntime | undefined;
//# sourceMappingURL=server.d.ts.map