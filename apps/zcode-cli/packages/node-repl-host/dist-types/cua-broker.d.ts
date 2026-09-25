import type { MessagePort } from "node:worker_threads";
import type { ComputerUseRuntime } from "@zcode/zcode-cua";
import type { Logger } from "@zcode/contracts";
import type { NodeReplCuaBrokerConnection } from "./cua-bridge.js";
export interface NodeReplCuaBroker {
    connection: NodeReplCuaBrokerConnection;
    ready: Promise<void>;
    close(): Promise<void>;
}
export declare function createNodeReplCuaBroker(input: {
    runtime: ComputerUseRuntime;
    logger?: Logger;
    platform?: NodeJS.Platform | string;
}): NodeReplCuaBroker;
/**
 * main 侧的私有 capability 端口：Worker 只发 `{id, method, input, context}`，runtime 调用与
 * Helper 凭据都留在这里。端口随一次 cell 的生命周期存在，close() 后不再应答。
 */
export declare function serveNodeReplCuaCapabilityPort(input: {
    port: MessagePort;
    runtime: ComputerUseRuntime;
    logger?: Logger;
}): {
    close(): void;
};
//# sourceMappingURL=cua-broker.d.ts.map