/**
 * Windows Helper 端到端集成测试（仅在 win32 运行）。
 *
 * 用真实的 entry.cjs + 真实 native addon + 真实命名管道，只把父进程换成测试自己：
 * 验证 control 协议、authenticate-first、broker_info、未实现方法与优雅停机。
 * 不触碰桌面：UIA/抓帧/输入都不在本切片，测试也不调用它们。
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { fork } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { createBrokerConnection } from "../broker/connection.js";
import { createNetConnector } from "../broker/net-connector.js";

const skip = process.platform !== "win32" ? "只在 Windows 上运行" : false;
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const entryPath = join(packageRoot, "dist", "win", "entry.cjs");
const addonPath = join(packageRoot, "dist", "win", "ax_native.node");

/** 启动 Helper 并等到 transport_ready/ready，同时收集后续 control 消息。 */
function startHelper() {
  const pipe = `\\\\.\\pipe\\zcode-cua-test-${randomBytes(8).toString("hex")}`;
  const child = fork(entryPath, ["--socket", pipe, "--parent-pid", String(process.pid)], {
    cwd: dirname(entryPath),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const control = [];
  const waiters = [];
  const stderr = [];
  child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
  child.on("message", (message) => {
    control.push(message);
    for (const waiter of [...waiters]) {
      if (waiter.match(message)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    }
  });
  const waitFor = (match, label, timeoutMs = 15000) => {
    const existing = control.find(match);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve };
      waiter.timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1);
        reject(
          new Error(`${label} 超时；已收到 ${JSON.stringify(control)} stderr=${stderr.join("")}`),
        );
      }, timeoutMs);
      waiters.push(waiter);
    });
  };
  return {
    pipe,
    child,
    control,
    stderr,
    waitFor,
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        child.once("exit", () => resolve());
        child.send({ protocol: "zcode-cua-windows-dev/v1", type: "shutdown", reason: "test" });
        setTimeout(() => child.kill(), 5000).unref();
      }),
  };
}

test("Helper 入口在 dist/win 缺失时明确报错（防止测试假绿）", { skip }, () => {
  assert.equal(existsSync(entryPath), true, `缺少 ${entryPath}，先跑 build:win`);
  assert.equal(existsSync(addonPath), true, `缺少 ${addonPath}，先编译 native addon`);
  const manifest = join(dirname(entryPath), "runtime-manifest.json");
  assert.equal(existsSync(manifest), true, "缺少 runtime-manifest.json");
});

test(
  "Helper：control 协议、authenticate-first、broker_info、未实现方法、优雅停机",
  { skip },
  async (t) => {
    const helper = startHelper();
    t.after(async () => {
      await helper.stop();
    });

    const transport = await helper.waitFor(
      (message) => message.type === "transport_ready",
      "transport_ready",
    );
    assert.equal(transport.protocol, "zcode-cua-windows-dev/v1");
    assert.equal(transport.socketPath, helper.pipe, "control 回报的 pipe 必须与请求一致");
    assert.equal(typeof transport.pid, "number");
    await helper.waitFor((message) => message.type === "ready", "ready");

    // 认证前发业务帧必须被拒。
    const early = createBrokerConnection({ path: helper.pipe, connect: createNetConnector() });
    await assert.rejects(
      () => early.call("broker_info", {}),
      (error) => error.code === "invalid_request" && error.dispatchStatus === "not_sent",
    );
    early.close();

    const connection = createBrokerConnection({ path: helper.pipe, connect: createNetConnector() });
    t.after(() => connection.close());
    const auth = await connection.authenticate({ version: 2 });
    assert.equal(auth.authenticated, true);
    assert.equal(auth.role, "tool");
    assert.equal(auth.serverApiVersion, 2);
    assert.equal(typeof auth.boot_nonce, "string");

    const info = await connection.call("broker_info", {});
    assert.equal(info.api_version, "ZCodeComputerUseIPC-1");
    assert.equal(info.framing, "ndjson");
    assert.equal(info.serverApiVersion, 2);
    assert.equal(info.pid, helper.child.pid, "broker_info.pid 必须是 Helper 自己的 pid");
    assert.equal(info.host.interactive, true);
    assert.equal(info.capabilities.slice, "transport-identity-diagnostics");
    // 本切片不得声称桌面能力可用。
    for (const key of [
      "uia_observation",
      "element_actions",
      "screen_capture",
      "input",
      "clipboard",
      "pip",
    ]) {
      assert.equal(info.capabilities[key], false, `${key} 在本切片必须为 false`);
    }
    // peer 证据必须真的做了取证。
    assert.equal(info.peer.verified, true);
    assert.equal(info.peer.clientPid, process.pid);
    assert.equal(info.peer.sameUser, true);
    assert.equal(info.peer.sameSession, true);
    assert.equal(info.peer.ancestryVerified, true);
    assert.equal(info.peer.signatureStatus, "not_verified", "Authenticode 未实现时不得报通过");

    const permission = await connection.call("permission_status", {});
    assert.equal(permission.interactive_session, true);
    assert.equal(permission.accessibility, "not_required", "Windows 没有 TCC 授权面");

    // 桌面动作必须显式 unimplemented，不能静默成功。
    await assert.rejects(
      () => connection.call("list_applications", {}),
      (error) => error.code === "unimplemented",
    );
    await assert.rejects(
      () => connection.call("pip_start", { window_id: "w-1" }),
      (error) => error.code === "unimplemented" && error.details?.reason === "windows_slice_scope",
    );

    await helper.stop();
    const stopped = await helper.waitFor((message) => message.type === "stopped", "stopped", 10000);
    assert.equal(stopped.clean, true, "正常停机必须报告 clean");
  },
);
