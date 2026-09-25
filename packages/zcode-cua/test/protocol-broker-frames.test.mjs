import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { BrokerCallError, createBrokerConnection } from "../broker/connection.js";
import {
  assertResponseId,
  byteLength,
  decodeErrorPayload,
  decodeResponseFrame,
  encodeErrorFrame,
  encodeOkFrame,
  encodeRequestFrame,
  splitNdjsonLines,
} from "../broker/ndjson.js";
import { CuaProtocolError } from "../protocol/errors.js";
import { CLIENT_REQUEST_MAX_BYTES } from "../protocol/limits.js";

/** 测试用的注入式 socket：不需要真的命名管道。 */
class FakeSocket extends EventEmitter {
  constructor(onFrame) {
    super();
    this.onFrame = onFrame;
    this.written = [];
    this.connecting = true;
    this.ended = false;
    // setImmediate：真实 socket 的 connect 事件一定发生在调用方挂上监听器之后。
    // queueMicrotask 会在 await 之前触发，连接层就永远等不到 connect。
    setImmediate(() => this.emit("connect"));
  }

  write(line) {
    this.written.push(line);
    queueMicrotask(() => this.onFrame?.(JSON.parse(line), this));
    return true;
  }

  end() {
    this.ended = true;
  }

  destroy() {
    this.ended = true;
  }
}

const fakeConnect = (onFrame) => {
  /** @type {FakeSocket[]} */
  const sockets = [];
  const connect = (path) => {
    const socket = new FakeSocket(onFrame);
    sockets.push(socket);
    socket.path = path;
    return socket;
  };
  return { connect, sockets };
};

test("请求行按 UTF-8 字节上限收敛，且拒绝未知字段与非表方法", () => {
  const line = encodeRequestFrame({ id: "r1", method: "capture_app", params: { app: "a" } });
  assert.ok(line.endsWith("\n"));
  assert.deepEqual(JSON.parse(line), { id: "r1", method: "capture_app", params: { app: "a" } });
  assert.throws(
    () => encodeRequestFrame({ id: "r1", method: "launch_app" }),
    /unknown broker method/,
  );
  assert.throws(() => encodeRequestFrame({ id: "", method: "ping" }), /non-empty string/);
  assert.throws(
    () => encodeRequestFrame({ id: "r1", method: "ping", extra: 1 }),
    /unknown request field/,
  );
  assert.throws(
    () => encodeRequestFrame({ id: "r1", method: "ping", params: 1 }),
    /params must be an object/,
  );
  // 多字节字符按字节而不是 UTF-16 码元计。
  const multibyte = encodeRequestFrame(
    { id: "r1", method: "type_text", params: { text: "中" } },
    { maxBytes: 80 },
  );
  assert.ok(byteLength(multibyte) > multibyte.length);
  assert.throws(
    () =>
      encodeRequestFrame(
        { id: "r1", method: "type_text", params: { text: "字".repeat(64) } },
        { maxBytes: 64 },
      ),
    (error) =>
      error instanceof CuaProtocolError &&
      error.code === "invalid_request" &&
      error.dispatchStatus === "not_sent",
  );
  assert.ok(CLIENT_REQUEST_MAX_BYTES >= 1024 * 1024);
});

test("响应解码拒绝重复键、未知字段、截断与 id 不关联", () => {
  assert.deepEqual(decodeResponseFrame('{"id":"r1","ok":true,"result":{"n":1}}'), {
    id: "r1",
    ok: true,
    result: { n: 1 },
  });
  assert.deepEqual(decodeResponseFrame(encodeOkFrame("r1", { a: 1 })), {
    id: "r1",
    ok: true,
    result: { a: 1 },
  });
  const failures = [
    ['{"id":"r1","ok":true,"result":1,"result":2}', "重复 key"],
    ['{"id":"r1","ok":true,"extra":1}', "未知字段"],
    ['{"id":"r1","ok":true,"result":', "截断"],
    ['{"id":"r1","ok":true} trailing', "尾随内容"],
    ['{"id":"r1","ok":"yes"}', "ok 非布尔"],
    ['{"id":"r1","ok":false,"result":1}', "失败响应带 result"],
    ['{"id":"r1","ok":true,"error":{"code":"x","message":"y"}}', "成功响应带 error"],
    ['{"id":"r1","ok":false,"error":{"code":"x","message":"y","surprise":1}}', "错误字段未知"],
    ['{"ok":true}', "缺 id"],
  ];
  for (const [line, label] of failures) {
    assert.throws(
      () => decodeResponseFrame(line),
      (error) => error instanceof CuaProtocolError && error.code === "response_corrupted",
      `${label} 必须失败`,
    );
  }
  assert.throws(
    () => decodeResponseFrame('{"id":"r1","ok":true,"result":"中"}', { maxBytes: 8 }),
    /exceeds 8 bytes/,
  );
  assert.throws(() => decodeErrorPayload("boom"), /error payload must be an object/);
});

test("行拆分保留半行；id 关联失败按 possibly_sent 记账", () => {
  assert.deepEqual(splitNdjsonLines('{"a":1}\n{"b":2}\n'), {
    lines: ['{"a":1}', '{"b":2}'],
    rest: "",
  });
  assert.deepEqual(splitNdjsonLines('{"a":1}\n{"b":'), { lines: ['{"a":1}'], rest: '{"b":' });
  assert.doesNotThrow(() => assertResponseId({ id: "r1" }, "r1"));
  assert.throws(
    () => assertResponseId({ id: "r2" }, "r1"),
    (error) => error.code === "response_id_mismatch" && error.dispatchStatus === "possibly_sent",
  );
});

test("版本矩阵：2 通过；缺失/非法/低于下限本地 fail closed；Helper 更高版本毒化连接", async () => {
  const { connect, sockets } = fakeConnect((frame, socket) => {
    if (frame.method === "authenticate") {
      const version = frame.params?.version;
      if (version === 2) socket.emit("data", encodeOkFrame(frame.id, { platform: "win32" }));
      else
        socket.emit(
          "data",
          encodeErrorFrame(frame.id, "version_mismatch", `server requires 3, got ${version}`),
        );
      return;
    }
    socket.emit("data", encodeOkFrame(frame.id, { ok: true }));
  });
  const connection = createBrokerConnection({ path: "pipe", connect });
  const result = await connection.authenticate({ version: 2 });
  assert.deepEqual(result, { platform: "win32" });
  assert.equal(connection.authenticated, true);
  assert.equal(connection.version, 2);
  assert.equal(sockets[0].written[0].includes('"version":2'), true);
  assert.equal(JSON.parse(sockets[0].written[0]).method, "authenticate");
  connection.close();

  for (const bad of [1, 0, -2]) {
    const fresh = createBrokerConnection({ path: "pipe", connect });
    await assert.rejects(
      () => fresh.authenticate({ version: bad }),
      (error) => error instanceof CuaProtocolError && error.code === "version_mismatch",
      `version=${String(bad)} 应在本地 fail closed`,
    );
    // 本地 fail closed 必须发生在建管道之前：整轮只有第一次成功认证建立过连接。
    assert.equal(sockets.length, 1, `version=${String(bad)} 不应新建连接`);
  }

  for (const bad of [1.5, "2", null, Number.NaN]) {
    const fresh = createBrokerConnection({ path: "pipe", connect });
    await assert.rejects(
      () => fresh.authenticate({ version: bad }),
      (error) => error instanceof CuaProtocolError && error.code === "invalid_request",
      `version=${String(bad)} 是非法输入而不是版本不兼容`,
    );
    assert.equal(sockets.length, 1, `version=${String(bad)} 不应新建连接`);
  }

  const higher = createBrokerConnection({
    path: "pipe",
    connect: fakeConnect((frame, socket) => {
      socket.emit("data", encodeErrorFrame(frame.id, "version_mismatch", "server requires 3"));
    }).connect,
  });
  await assert.rejects(
    () => higher.authenticate({ version: 2 }),
    (error) => error instanceof BrokerCallError && error.code === "version_mismatch",
  );
  // 版本协商不兼容后连接被毒化：不会再发业务帧。
  const poisonedSockets = [];
  await assert.rejects(
    () => higher.call("list_applications", {}),
    (error) => error instanceof BrokerCallError && error.code === "broker_unavailable",
  );
  assert.equal(poisonedSockets.length, 0);
  assert.equal(higher.authenticated, false);
});

test("业务方法在 authenticate 之前不写管道", async () => {
  const { connect, sockets } = fakeConnect((frame, socket) => {
    socket.emit("data", encodeOkFrame(frame.id, {}));
  });
  const connection = createBrokerConnection({ path: "pipe", connect });
  for (const method of ["ping", "list_applications", "capture_app"]) {
    await assert.rejects(
      () => connection.call(method),
      (error) =>
        error instanceof CuaProtocolError &&
        error.code === "invalid_request" &&
        error.dispatchStatus === "not_sent",
    );
  }
  assert.equal(sockets.length, 0, "认证前不应建立连接");
  await assert.rejects(
    () => connection.call("authenticate", { version: 2 }),
    (error) => error.code === "invalid_request",
  );
  connection.close();
});

test("请求串行：第二个请求不早于第一个的响应写出", async () => {
  /** @type {string[]} */
  const written = [];
  const { connect } = fakeConnect((frame, socket) => {
    written.push(frame.method);
    queueMicrotask(() => {
      queueMicrotask(() => {
        if (frame.method === "authenticate") socket.emit("data", encodeOkFrame(frame.id, {}));
        else socket.emit("data", encodeOkFrame(frame.id, { method: frame.method }));
      });
    });
  });
  const connection = createBrokerConnection({ path: "pipe", connect });
  await connection.authenticate({ version: 2 });
  const results = await Promise.all([
    connection.call("list_applications", {}),
    connection.call("list_windows", { app: "a" }),
    connection.call("ping", {}),
  ]);
  assert.deepEqual(
    results.map((entry) => entry.method),
    ["list_applications", "list_windows", "ping"],
  );
  assert.deepEqual(written, ["authenticate", "list_applications", "list_windows", "ping"]);
  connection.close();
});

test("越过管道后的失败是 possibly_sent，且不会自动重放", async () => {
  let attempts = 0;
  const { connect } = fakeConnect((frame, socket) => {
    if (frame.method === "authenticate") {
      socket.emit("data", encodeOkFrame(frame.id, {}));
      return;
    }
    attempts += 1;
    // Helper 侧在写入后崩溃：没有响应，只有连接关闭。
    queueMicrotask(() => socket.emit("close"));
  });
  const connection = createBrokerConnection({ path: "pipe", connect });
  await connection.authenticate({ version: 2 });
  await assert.rejects(
    () => connection.call("click", { point: { x: 1, y: 1 } }),
    (error) =>
      error instanceof BrokerCallError &&
      error.code === "broker_unavailable" &&
      error.dispatchStatus === "possibly_sent" &&
      error.actionSent === true &&
      error.retry === "reobserve",
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(attempts, 1, "possibly_sent 不得自动重放");
  connection.close();
});

test("Helper 明确在执行前失败是 not_sent；自报可能已执行的是 possibly_sent", async () => {
  const { connect } = fakeConnect((frame, socket) => {
    if (frame.method === "authenticate") {
      socket.emit("data", encodeOkFrame(frame.id, {}));
      return;
    }
    if (frame.params?.mode === "before") {
      socket.emit(
        "data",
        encodeErrorFrame(frame.id, "foreground_required", "target is not foreground"),
      );
      return;
    }
    socket.emit(
      "data",
      encodeErrorFrame(frame.id, "timeout", "provider stalled", { possibly_executed: true }),
    );
  });
  const connection = createBrokerConnection({ path: "pipe", connect });
  await connection.authenticate({ version: 2 });
  await assert.rejects(
    () => connection.call("click", { mode: "before" }),
    (error) =>
      error.dispatchStatus === "not_sent" && error.actionSent === false && error.retry === "never",
  );
  await assert.rejects(
    () => connection.call("click", { mode: "after" }),
    (error) =>
      error.dispatchStatus === "possibly_sent" &&
      error.actionSent === true &&
      error.retry === "reobserve",
  );
  connection.close();
});

test("id 不匹配的响应帧不会被当作成功", async () => {
  const { connect } = fakeConnect((frame, socket) => {
    if (frame.method === "authenticate") {
      socket.emit("data", encodeOkFrame(frame.id, {}));
      return;
    }
    socket.emit("data", encodeOkFrame("someone-elses-id", { delivered: true }));
  });
  const connection = createBrokerConnection({ path: "pipe", connect });
  await connection.authenticate({ version: 2 });
  await assert.rejects(
    () => connection.call("click", {}),
    (error) => error instanceof BrokerCallError && error.code === "response_id_mismatch",
  );
  connection.close();
});

test("连接建立失败是 broker_unavailable / not_sent，可在越过管道前重试", async () => {
  const connection = createBrokerConnection({
    path: "pipe",
    connect: () => {
      throw new Error("ENOENT: no such pipe");
    },
  });
  await assert.rejects(
    () => connection.authenticate({ version: 2 }),
    (error) =>
      error instanceof BrokerCallError &&
      error.code === "broker_unavailable" &&
      error.dispatchStatus === "not_sent" &&
      error.retry === "retry",
  );
  assert.throws(
    () => createBrokerConnection({ path: "pipe" }),
    /injected connect\(path\) function/,
  );
  assert.throws(() => createBrokerConnection({ path: "", connect: () => null }), /socket path/);
});

test("响应字节上限：超限帧按 possibly_sent 失败", async () => {
  const { connect } = fakeConnect((frame, socket) => {
    if (frame.method === "authenticate") {
      socket.emit("data", encodeOkFrame(frame.id, {}));
      return;
    }
    // 认证帧必须留在上限内（id 由连接生成，约 44 字节），业务响应则远超上限。
    socket.emit("data", `${'{"id":"'}${frame.id}'","ok":true,"result":"'}${"y".repeat(200)}"}\n`);
  });
  const connection = createBrokerConnection({ path: "pipe", connect, maxResponseBytes: 128 });
  await connection.authenticate({ version: 2 });
  await assert.rejects(
    () => connection.call("capture_app", {}),
    (error) => error.code === "response_corrupted" && error.dispatchStatus === "possibly_sent",
  );
  connection.close();
});
