/**
 * Helper 入口（win/entry.cjs）与 protocol/ 方法表的一致性测试。
 *
 * 两处各自维护方法信息：JS producer 侧在 protocol/method-table.js（含每方法的 Windows 结论），
 * Helper 侧在 win/entry.cjs（含本切片的实现状态）。任何一侧漂移都会让「方法存在但未实现」
 * 或「协议说未实现、Helper 却声称可用」，所以这里做交叉断言。
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

import {
  BROKER_METHODS as PROTOCOL_METHODS,
  isBrokerMethod,
  isReadOnlyBrokerMethod,
} from "../protocol/method-table.js";

const require = createRequire(import.meta.url);
const entry = require("../win/entry.cjs");

const protocolNames = PROTOCOL_METHODS.map((method) => method.name);
const protocolByName = new Map(PROTOCOL_METHODS.map((method) => [method.name, method]));

test("Helper 入口的方法表与 protocol 方法表逐项一致（42 业务 + authenticate + ping）", () => {
  const entryMethods = new Set(entry.BROKER_METHODS);
  assert.equal(protocolNames.length, 42, "protocol 侧固定 42 个业务方法");
  assert.equal(entry.BROKER_METHODS.length, 44, "44 = 42 业务方法 + authenticate + ping");
  assert.equal(entryMethods.size, 44, "方法表不得重复");

  const missing = protocolNames.filter((name) => !entryMethods.has(name));
  const extra = [...entryMethods].filter(
    (name) => !protocolByName.has(name) && name !== "authenticate" && name !== "ping",
  );
  assert.deepEqual(missing, [], "Helper 缺少 protocol 声明的方法");
  assert.deepEqual(extra, [], "Helper 多出 protocol 未声明的方法");

  for (const name of protocolNames) {
    assert.equal(isBrokerMethod(name), true, `${name} 必须在方法表里`);
  }
  assert.equal(isBrokerMethod("definitely_not_a_method"), false);
  assert.equal(isBrokerMethod("authenticate"), false, "authenticate 不计入 42 业务方法");
  assert.equal(isBrokerMethod("ping"), false, "ping 不计入 42 业务方法");
});

test("read-only 判定两侧一致", () => {
  for (const name of protocolNames) {
    assert.equal(
      entry.READ_ONLY_METHODS.has(name),
      isReadOnlyBrokerMethod(name),
      `${name} 的 read-only 判定必须两侧一致`,
    );
  }
});

test("协议标记 Windows 未实现的方法，Helper 绝不能声称已实现", () => {
  const implemented = entry.IMPLEMENTED_METHODS;
  const pending = entry.PENDING_METHODS;
  const unsupported = entry.UNSUPPORTED_METHODS;
  const notImplemented = new Set([...pending, ...unsupported]);

  for (const name of protocolNames) {
    const verdict = protocolByName.get(name).windows;
    if (verdict === "unimplemented") {
      assert.equal(
        implemented.has(name),
        false,
        `${name} 协议标记 unimplemented，Helper 不得声称已实现`,
      );
      assert.equal(notImplemented.has(name), true, `${name} 必须落在 pending/unsupported`);
    }
  }
  for (const name of implemented) {
    if (name === "authenticate" || name === "ping") continue;
    assert.equal(
      protocolByName.get(name).windows === "unimplemented",
      false,
      `${name} 已实现但协议标记 unimplemented`,
    );
  }
  for (const name of pending) {
    assert.equal(unsupported.has(name), false, `${name} 不能同时算 pending 与 unsupported`);
  }
});

test("Helper 只在 Windows 上启动，控制协议与上限来自规格", () => {
  assert.equal(entry.PIPE_PREFIX, "\\\\.\\pipe\\");
  assert.equal(entry.SERVER_API_VERSION, 2);
  assert.equal(entry.PROTOCOL, "zcode-cua-windows-dev/v1");
  assert.equal(entry.MAX_CONNECTIONS, 8, "原生硬上限 8");
  assert.equal(entry.MAX_LINE_BYTES, 16 * 1024 * 1024);
  assert.equal(entry.MAX_QUEUED_REQUESTS, 64);
  assert.equal(entry.HANDSHAKE_TIMEOUT_MS, 5000);
});

test("错误码集合包含本切片会用到的全部码", () => {
  for (const code of [
    "invalid_request",
    "not_authorized",
    "version_mismatch",
    "unimplemented",
    "internal",
  ]) {
    assert.equal(entry.ERROR_CODES.has(code), true, `${code} 必须在内置错误码集合里`);
  }
});
