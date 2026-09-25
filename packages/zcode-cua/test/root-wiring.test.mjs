/**
 * 根导出接线测试：`@zcode/zcode-cua` 的公开面必须从占位实现切到真实模块。
 *
 * 这一层是 services / node_repl / UI 唯一依赖的入口，形状漂移会在编译期之外的地方炸掉。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import * as root from "../index.js";
import * as broker from "../broker.js";

const context = { runtimeScope: "main", sessionId: "s1", workspaceKey: "ws" };

test("createComputerUseRuntime 没有 broker 配置时仍然 fail closed", async () => {
  const runtime = root.createComputerUseRuntime({});
  const result = await runtime.execute({ toolName: "list_apps", context });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not available in this build/);
  await runtime.closeSession(context);
  await runtime.dispose();
});

test("配置了 socket 但 Helper 不存在时返回 broker_unavailable receipt，而不是抛异常", async () => {
  const runtime = root.createComputerUseRuntime({
    brokerSocketPath: "\\\\.\\pipe\\zcode-cua-helper-does-not-exist",
  });
  const result = await runtime.execute({ toolName: "list_apps", context });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /broker_unavailable/);
  const receipt = result.structuredContent?.action_receipt;
  assert.equal(receipt.dispatch_status, "not_sent", "没连上管道就不可能越过管道");
  assert.equal(receipt.action_sent, false);
  assert.equal(result._meta["zcode.cua/retry-policy"], "retry", "连接级失败可在越过管道前重试");
  await runtime.dispose();
});

test("broker 方法表与 read-only 判定已接线，不再恒为 false", () => {
  assert.equal(broker.isBrokerMethod("list_applications"), true);
  assert.equal(broker.isBrokerMethod("pip_start"), true);
  assert.equal(broker.isBrokerMethod("nope"), false);
  assert.equal(broker.isReadOnlyBrokerMethod("capture_app"), true);
  assert.equal(broker.isReadOnlyBrokerMethod("click"), false);
});

test("socket 路径按平台生成：Windows 是命名管道，其它是 unix socket", () => {
  const win = broker.mintBrokerSocketPath({ platform: "win32" });
  assert.match(win, /^\\\\\.\\pipe\\zcode-cua-helper-[0-9a-f]{32}$/);
  const unix = broker.mintBrokerSocketPath({ platform: "linux" });
  assert.match(unix, /zcode-cua-broker-[0-9a-f-]{36}\.sock$/);
  assert.equal(
    broker.resolveBrokerSocketPath({ env: { [broker.BROKER_SOCKET_ENV]: "given" } }),
    "given",
  );
});

test("parseRequestLine 解析合法帧、拒绝非法帧", () => {
  const parsed = broker.parseRequestLine('{"id":"r-1","method":"ping","params":{}}');
  assert.equal(parsed.method, "ping");
  assert.equal(broker.parseRequestLine("not json"), undefined);
  assert.equal(
    broker.parseRequestLine('{"id":"r-1","method":"ping","extra":1}'),
    undefined,
    "未知字段必须拒绝",
  );
  assert.equal(
    broker.parseRequestLine('{"id":"r-1","method":"not_a_method"}'),
    undefined,
    "非表方法必须拒绝",
  );
  assert.equal(broker.parseRequestLine('{"id":1,"method":"ping"}'), undefined, "id 必须是字符串");
  assert.equal(broker.parseRequestLine(""), undefined);
});

test("callBrokerMethod 缺少 socket 路径时报 broker_unavailable", async () => {
  await assert.rejects(
    () => broker.callBrokerMethod({ method: "broker_info" }),
    (error) => error instanceof broker.BrokerError && error.code === "broker_unavailable",
  );
});

test("Helper 服务端派发不留在本进程", async () => {
  await assert.rejects(() => broker.dispatchRequest({}, {}), /not available in this process/);
  await assert.rejects(() => broker.handleRequestLine({}, ""), /not available in this process/);
});
