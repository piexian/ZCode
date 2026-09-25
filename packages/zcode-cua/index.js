import { createNetConnector } from "./broker/net-connector.js";
import { createProducerRuntime } from "./runtime/producer-runtime.js";

const UNAVAILABLE_TEXT = "Computer Use is not available in this build.";

/**
 * Computer Use runtime 门面。
 *
 * runtime 本体在 `runtime/producer-runtime.js`：14 个工具的 strict 校验、session 分区、
 * state/frame 注册表、kill switch、receipt 与重试语义都在那里。这里的职责只有三件：
 * 解析选项、把传输实现注入、把内部 runtime 适配成 node_repl 需要的 execute/closeSession/dispose。
 *
 * 没有配置 broker socket 时仍然 fail closed：调用方拿到的是带 unavailable 文案的
 * isError 结果，而不是抛异常，这样 UI 与协议投影不需要额外分支。
 *
 * @param {import("./index.d.ts").ComputerUseRuntimeOptions} [options]
 * @returns {import("./index.d.ts").ComputerUseRuntime}
 */
export function createComputerUseRuntime(options = {}) {
  const brokerSocketPath =
    typeof options.brokerSocketPath === "string" && options.brokerSocketPath.trim()
      ? options.brokerSocketPath
      : undefined;
  if (brokerSocketPath === undefined) {
    return {
      async execute() {
        return { content: [{ type: "text", text: UNAVAILABLE_TEXT }], isError: true };
      },
      async closeSession() {},
      async dispose() {},
    };
  }

  const runtime = createProducerRuntime({
    brokerSocketPath,
    connect: createNetConnector(),
    ...(options.env === undefined
      ? {}
      : { clientInfo: { env_keys: Object.keys(options.env).length } }),
  });

  return {
    execute: (input) => runtime.execute(input),
    closeSession: (context) => runtime.closeSession(context),
    dispose: () => runtime.dispose(),
  };
}

export { createProducerRuntime } from "./runtime/producer-runtime.js";
