#!/usr/bin/env node
"use strict";

// Windows N-API addon 第一垂直切片的冒烟测试：
// 原生自建命名管道 -> Node net 客户端 -> 原生线程回调 JS -> JS 回一行 -> 客户端收到 -> stop 后管道释放。
// 用法：node packages/zcode-cua/test/windows-native-smoke.cjs

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const net = require("node:net");
const path = require("node:path");

if (process.platform !== "win32") {
  console.log("[skip] windows-native-smoke 需要 Windows；当前平台 " + process.platform);
  process.exit(0);
}

const addonPath =
  process.env.ZCODE_CUA_NATIVE_ADDON || path.join(__dirname, "..", "dist", "win", "ax_native.node");
const addon = require(addonPath);

const recorded = [];
const waiters = [];
addon.setEventHandler((event) => {
  recorded.push(event);
  for (let index = 0; index < waiters.length; index += 1) {
    if (waiters[index].match(event)) {
      const waiter = waiters.splice(index, 1)[0];
      clearTimeout(waiter.timer);
      waiter.resolve(event);
      return;
    }
  }
});

function waitFor(match, label, timeoutMs = 10000) {
  const existing = recorded.find(match);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const waiter = { match, resolve };
    waiter.timer = setTimeout(() => {
      const index = waiters.indexOf(waiter);
      if (index >= 0) waiters.splice(index, 1);
      reject(new Error("等待事件超时：" + label));
    }, timeoutMs);
    waiters.push(waiter);
  });
}

function pipeName() {
  return "\\\\.\\pipe\\zcode-cua-helper-" + crypto.randomBytes(16).toString("hex");
}

function connect(name) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: name });
    const chunks = [];
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.once("connect", () =>
      resolve({
        socket,
        text: () => chunks.join(""),
        close: () =>
          new Promise((done) => {
            socket.end(() => done());
          }),
      }),
    );
    socket.once("error", reject);
  });
}

/** 轮询客户端 socket 累积文本，直到包含期望内容。 */
function waitForClientText(client, expected, timeoutMs = 5000) {
  if (client.text().includes(expected)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      if (client.text().includes(expected)) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        clearInterval(timer);
        reject(
          new Error(
            "客户端未在 " + timeoutMs + "ms 内收到响应；已收到：" + JSON.stringify(client.text()),
          ),
        );
      }
    }, 25);
  });
}

function expectPipeGone(name) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: name });
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error("stop 之后管道仍然可连接：" + name));
    });
    socket.once("error", (error) => {
      const acceptable = ["ENOENT", "ECONNREFUSED"];
      if (!acceptable.includes(error.code)) {
        reject(new Error("stop 之后连接失败码异常：" + error.code));
        return;
      }
      resolve(error.code);
    });
  });
}

async function checkHostInfo() {
  const info = addon.hostInfo();
  assert.equal(info.platform, "win32");
  assert.equal(info.arch, "x64");
  assert.equal(info.napiVersion, 8);
  assert.equal(info.os.api, "RtlGetVersion");
  assert.ok(info.os.build >= 22000, "build 应为 Windows 11 级别：" + info.os.build);
  assert.equal(info.os.isWorkstation, true);
  assert.ok(info.session.idAvailable, "会话 id 不可用");
  assert.equal(info.user.sidAvailable, true, "用户 SID 不可用");
  assert.ok(info.user.sid.startsWith("S-1-"), "SID 形态异常：" + info.user.sid);
  assert.ok(info.user.integrityLevel !== "unknown", "完整性级别未知");
  assert.ok(
    ["unaware", "system_aware", "per_monitor_aware", "per_monitor_aware_v2"].includes(
      info.dpi.threadAwareness,
    ),
  );
  assert.equal(info.uia.probe, "CoCreateInstance(CLSID_CUIAutomation)");
  assert.equal(typeof info.uia.available, "boolean");
  assert.equal(info.wgc.api, "GraphicsCaptureSession::IsSupported");
  assert.equal(typeof info.wgc.isSupported, "boolean");
  // 本切片明确不实现抓帧与输入，报告必须为 false。
  assert.equal(info.captureImplemented, false);
  assert.equal(info.inputImplemented, false);
  console.log(
    "[hostInfo] Windows " +
      info.os.build +
      "." +
      info.os.updateBuildRevision +
      " " +
      info.os.displayVersion +
      " arch=" +
      info.arch +
      " session=" +
      info.session.id +
      " interactive=" +
      info.session.interactive +
      " user=" +
      info.user.name +
      " (" +
      info.user.sid +
      ")",
  );
  console.log(
    "[hostInfo] integrity=" +
      info.user.integrityLevel +
      " elevated=" +
      info.user.elevated +
      "/" +
      info.user.elevationType +
      " dpi=" +
      info.dpi.threadAwareness +
      "@" +
      info.dpi.systemDpi +
      " uia=" +
      info.uia.available +
      " wgc=" +
      info.wgc.isSupported,
  );
}

async function checkRoundTrip() {
  const name = pipeName();
  const started = addon.startServer(name, {
    parentPid: process.pid,
    handshakeTimeoutMs: 5000,
    maxConnections: 8,
    maxLineBytes: 16 * 1024 * 1024,
    maxQueuedRequests: 64,
  });
  assert.equal(started.pipeName, name);
  assert.equal(started.serverPid, process.pid);
  assert.equal(started.firstPipeInstance, true);
  assert.equal(started.dacl, "current_user+system");
  assert.equal(started.signatureVerification, "not_implemented");
  console.log(
    "[startServer] " +
      name +
      " maxConnections=" +
      started.maxConnections +
      " maxLineBytes=" +
      started.maxLineBytes,
  );

  const client = await connect(name);
  const connection = await waitFor((event) => event.type === "connection", "connection 事件");
  assert.equal(
    connection.accepted,
    true,
    "peer 取证未通过：" + JSON.stringify(connection.peer.failures),
  );
  assert.equal(connection.peer.clientPid, process.pid);
  assert.equal(connection.peer.ancestryVerified, true);
  assert.equal(connection.peer.sameUser, true);
  assert.equal(connection.peer.sameSession, true);
  assert.equal(connection.peer.integrityCompatible, true);
  assert.equal(connection.peer.elevationCompatible, true);
  assert.equal(connection.peer.signatureStatus, "not_verified");
  assert.equal(connection.peer.signatureReason, "authenticode_verification_not_implemented");
  assert.ok(connection.peer.ancestorChain.length >= 1, "祖先链为空");
  console.log(
    "[peer] pid=" +
      connection.peer.clientPid +
      " image=" +
      connection.peer.clientImageName +
      " sid=" +
      connection.peer.clientUserSid +
      " integrity=" +
      connection.peer.clientIntegritySid +
      " ancestors=" +
      connection.peer.ancestorChain.map((item) => item.imageName + ":" + item.pid).join(" <- "),
  );

  const request = JSON.stringify({ id: "smoke-1", method: "ping" });
  client.socket.write(request + "\n");
  const line = await waitFor(
    (event) => event.type === "line" && event.connectionId === connection.connectionId,
    "line 事件",
  );
  assert.equal(line.text, request);
  const response = JSON.stringify({ id: "smoke-1", result: "pong" });
  assert.equal(addon.sendResponse(line.connectionId, response), true, "响应未入队");
  // 客户端是否收到响应是 socket 侧条件，不能用只匹配原生事件的 waitFor。
  await waitForClientText(client, response, 5000);
  console.log(
    "[roundtrip] 请求 " + request + " -> 原生回调 -> 响应 " + response + " -> 客户端收到",
  );

  // 没有待响应请求时不能再发响应。
  assert.equal(addon.sendResponse(line.connectionId, response), false);
  assert.equal(addon.sendResponse(99999, response), false);

  const status = addon.serverStatus();
  assert.equal(status.running, true);
  assert.equal(status.acceptedConnections, 1);
  assert.equal(status.emittedLines, 1);
  assert.equal(status.sentResponses, 1);

  await client.close();
  const stopped = addon.stopServer(3000);
  assert.equal(stopped.stopped, true, "stopServer 未在预算内完成");
  assert.equal(stopped.remainingConnections, 0);
  const goneCode = await expectPipeGone(name);
  console.log("[stop] stopped=true 管道已释放，重连失败码=" + goneCode);
  assert.equal(addon.serverStatus().running, false);
}

async function checkHandshakeTimeout() {
  const name = pipeName();
  addon.startServer(name, { parentPid: process.pid, handshakeTimeoutMs: 600 });
  const client = await connect(name);
  const failure = await waitFor(
    (event) => event.type === "error" && event.reason === "handshake_timeout",
    "handshake_timeout 事件",
  );
  assert.ok(failure.connectionId > 0);
  await client.close();
  const stopped = addon.stopServer(3000);
  assert.equal(stopped.stopped, true);
  console.log("[handshake] 未发首帧的连接在 600ms 内被拒绝");
}

async function checkLineLimit() {
  const name = pipeName();
  const maxLineBytes = 1024 * 1024;
  addon.startServer(name, { parentPid: process.pid, handshakeTimeoutMs: 5000, maxLineBytes });
  const client = await connect(name);
  await waitFor((event) => event.type === "connection" && event.accepted, "connection 事件");
  const oversized = "x".repeat(maxLineBytes + 1024);
  client.socket.on("error", () => {
    // 服务端按上限主动断开时客户端写入会 EPIPE，属预期。
  });
  client.socket.write(oversized);
  const failure = await waitFor(
    (event) => event.type === "error" && event.reason === "line_too_long",
    "line_too_long 事件",
  );
  assert.ok(failure.message.includes(String(maxLineBytes)));
  await client.close();
  const stopped = addon.stopServer(3000);
  assert.equal(stopped.stopped, true);
  console.log("[line-limit] 超过 " + maxLineBytes + " 字节的无换行缓冲被拒绝");
}

async function main() {
  await checkHostInfo();
  await checkRoundTrip();
  await checkHandshakeTimeout();
  await checkLineLimit();
  addon.setEventHandler(null);
  console.log("windows-native-smoke: OK");
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error("windows-native-smoke: FAIL");
    console.error(error);
    addon.setEventHandler(null);
    process.exit(1);
  },
);
