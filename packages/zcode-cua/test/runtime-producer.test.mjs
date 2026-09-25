/**
 * producer runtime 端到端（假 Helper）测试。
 *
 * `connect` 是注入的假 socket：不打开真实命名管道，不触碰桌面，也不加载 native addon。
 * 覆盖门控顺序、stop 熔断、session 隔离、预检 not_sent 与 possibly_sent 不重放。
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { encodeErrorFrame, encodeOkFrame } from "../broker/ndjson.js";
import { createProducerRuntime } from "../runtime/producer-runtime.js";

/** 假 Helper：按 method 分派；`crashOn` 里的方法写完就断开连接。 */
function createFakeHelper() {
  /** 真正被 handler 处理的帧。 */
  const calls = [];
  /** 所有写进管道的帧（含崩溃/拒绝路径，用于断言没有自动重放）。 */
  const writes = [];
  const sockets = [];
  const state = { elements: [{ index: 0, role: "button", title: "Save", value: "" }], frame: 0 };
  const handler = (frame, socket) => {
    calls.push({ method: frame.method, params: frame.params });
    if (frame.method === "authenticate") {
      socket.emit("data", encodeOkFrame(frame.id, { platform: "win32", version: 2 }));
      return;
    }
    switch (frame.method) {
      case "list_applications":
        socket.emit(
          "data",
          encodeOkFrame(frame.id, {
            apps: [{ pid: 42, bundle_id: "com.example.editor", name: "Editor" }],
          }),
        );
        return;
      case "list_windows":
        socket.emit(
          "data",
          encodeOkFrame(frame.id, { windows: [{ window_id: "w-1", title: "main" }] }),
        );
        return;
      case "capture_app":
        socket.emit(
          "data",
          encodeOkFrame(frame.id, {
            app: { bundle_id: "com.example.editor" },
            epoch: state.frame,
            elements: state.elements,
            frame: { handle: "native-frame-1", width: 1280, height: 800 },
          }),
        );
        return;
      case "permission_status":
      case "input_permission_status":
        socket.emit("data", encodeOkFrame(frame.id, { state: "not_required" }));
        return;
      case "cancel_input_holds":
        socket.emit("data", encodeOkFrame(frame.id, { released: 0 }));
        return;
      case "foreground_required":
        socket.emit(
          "data",
          encodeErrorFrame(frame.id, "foreground_required", "target is not foreground"),
        );
        return;
      default:
        socket.emit(
          "data",
          encodeOkFrame(frame.id, { dispatched: true, app: { bundle_id: "com.example.editor" } }),
        );
    }
  };
  const connect = () => {
    const socket = new (class extends EventEmitter {
      constructor() {
        super();
        this.connecting = true;
        this.written = [];
        setImmediate(() => this.emit("connect"));
      }
      write(line) {
        this.written.push(line);
        const frame = JSON.parse(line);
        writes.push({ method: frame.method, params: frame.params });
        // app_ref 会被归一化成 {kind,bundle_id}：用 bundle_id 模拟「写入后 Helper 崩溃」
        // 与「Helper 明确在执行前拒绝」两条路径。
        const targetApp = frame.params?.app?.bundle_id;
        if (targetApp === "com.example.crash") {
          queueMicrotask(() => this.emit("close"));
          return true;
        }
        if (targetApp === "com.example.blocked") {
          queueMicrotask(() =>
            this.emit(
              "data",
              encodeErrorFrame(frame.id, "foreground_required", "target is not foreground"),
            ),
          );
          return true;
        }
        queueMicrotask(() => handler(frame, this));
        return true;
      }
      end() {}
      destroy() {
        this.ended = true;
      }
    })();
    sockets.push(socket);
    return socket;
  };
  return { connect, calls, writes, sockets, state };
}

const context = (overrides = {}) => ({
  runtimeScope: "main",
  sessionId: "session-1",
  workspaceKey: "ws",
  workspacePath: "/ws",
  turnId: "turn-1",
  ...overrides,
});

const textOf = (result) => result.content.map((block) => block.text).join("\n");
const receiptOf = (result) =>
  result.structuredContent?.action_receipt ?? result._meta?.["zcode.cua/action-receipt-v1"];

test("observe 路径：authenticate 先行，list_apps/get_app_state 产出 state 与 frame", async () => {
  const helper = createFakeHelper();
  const runtime = createProducerRuntime({ brokerSocketPath: "pipe", connect: helper.connect });

  const apps = await runtime.execute({ toolName: "list_apps", context: context() });
  assert.equal(apps.isError, undefined);
  assert.equal(apps.structuredContent.count, 1);
  assert.deepEqual(
    helper.calls.map((call) => call.method),
    ["authenticate", "list_applications"],
  );

  const state = await runtime.execute({
    toolName: "get_app_state",
    arguments: { app_ref: "com.example.editor", include_screenshot: true },
    context: context(),
  });
  assert.equal(state.structuredContent.state_id, "s-1");
  assert.equal(state.structuredContent.kind, "full", "第一次给模型看的树必须是 full");
  assert.equal(state.structuredContent.frame.actionable, true);
  assert.equal(state.structuredContent.frame.width, 1280);

  // 第二次观察结构相同 → no_change，但仍签发新 state id。
  const again = await runtime.execute({
    toolName: "get_app_state",
    arguments: { app_ref: "com.example.editor" },
    context: context(),
  });
  assert.equal(again.structuredContent.state_id, "s-2");
  assert.equal(again.structuredContent.kind, "no_change");
  assert.equal(again.structuredContent.base_state_id, undefined);

  await runtime.dispose();
});

test("门控顺序：subagent、未知工具、strict 参数、已中止信号都在建管道前失败", async () => {
  const helper = createFakeHelper();
  const runtime = createProducerRuntime({ brokerSocketPath: "pipe", connect: helper.connect });

  const subagent = await runtime.execute({
    toolName: "list_apps",
    context: context({ runtimeScope: "subagent" }),
  });
  assert.equal(subagent.isError, true);
  assert.match(textOf(subagent), /subagent_forbidden/);

  const unknown = await runtime.execute({ toolName: "take_over_everything", context: context() });
  assert.equal(unknown.isError, true);
  assert.match(textOf(unknown), /unknown_tool/);

  const badArgs = await runtime.execute({
    toolName: "left_click",
    arguments: { target: { type: "element", index: 0 }, surprise: true },
    context: context(),
  });
  assert.equal(badArgs.isError, true);
  assert.match(textOf(badArgs), /invalid_request/);

  const controller = new AbortController();
  controller.abort(new Error("cell aborted"));
  const aborted = await runtime.execute({
    toolName: "list_apps",
    context: context(),
    signal: controller.signal,
  });
  assert.equal(aborted.isError, true);
  assert.equal(helper.calls.length, 0, "所有门控失败都不得触碰管道");
  assert.equal(helper.sockets.length, 0, "门控失败不得建立连接");

  await runtime.dispose();
});

test("动作预检：未观察的元素与过期 frame 一律 not_sent，Helper 看不到请求", async () => {
  const helper = createFakeHelper();
  const runtime = createProducerRuntime({ brokerSocketPath: "pipe", connect: helper.connect });

  const unobserved = await runtime.execute({
    toolName: "left_click",
    arguments: { target: { type: "element", index: 7 } },
    context: context(),
  });
  assert.equal(unobserved.isError, true);
  assert.equal(receiptOf(unobserved).dispatch_status, "not_sent");
  assert.equal(receiptOf(unobserved).action_sent, false);
  assert.match(textOf(unobserved), /target_not_observed/);

  // 观察一次之后，坐标动作才能成立；越界仍然 not_sent。
  await runtime.execute({
    toolName: "get_app_state",
    arguments: { app_ref: "com.example.editor", include_screenshot: true },
    context: context(),
  });
  const before = helper.writes.length;
  const outOfBounds = await runtime.execute({
    toolName: "left_click",
    arguments: { target: { type: "coordinate", x: 5000, y: 0 } },
    context: context(),
  });
  assert.equal(outOfBounds.isError, true);
  assert.equal(receiptOf(outOfBounds).dispatch_status, "not_sent");
  assert.equal(helper.writes.length, before, "预检失败不得写出方法帧");

  const click = await runtime.execute({
    toolName: "left_click",
    arguments: { target: { type: "coordinate", x: 100, y: 120 } },
    context: context(),
  });
  assert.equal(click.isError, undefined);
  assert.equal(receiptOf(click).dispatch_status, "accepted");
  assert.equal(receiptOf(click).target_verification_status, "matched");
  const clickCall = helper.calls.at(-1);
  assert.equal(clickCall.method, "click");
  assert.deepEqual(clickCall.params.point, { x: 100, y: 120, frame_handle: "native-frame-1" });

  // 元素目标走语义动作，不走坐标。
  const elementClick = await runtime.execute({
    toolName: "left_click",
    arguments: { target: { type: "element", index: 0 } },
    context: context(),
  });
  assert.equal(helper.calls.at(-1).method, "element_perform_action");
  assert.equal(receiptOf(elementClick).target_verification_status, "matched");

  await runtime.dispose();
});

test("effect 证据：动作后不观察，下一次观察结算 unchanged/changed", async () => {
  const helper = createFakeHelper();
  const runtime = createProducerRuntime({
    brokerSocketPath: "pipe",
    connect: context() ? helper.connect : helper.connect,
  });

  await runtime.execute({
    toolName: "get_app_state",
    arguments: { app_ref: "com.example.editor" },
    context: context(),
  });
  const click = await runtime.execute({
    toolName: "left_click",
    arguments: { target: { type: "element", index: 0 } },
    context: context(),
  });
  assert.equal(receiptOf(click).effect_evidence, "unknown");
  assert.match(textOf(click), /effect evidence pending next observation/);

  const unchanged = await runtime.execute({
    toolName: "get_app_state",
    arguments: { app_ref: "com.example.editor" },
    context: context(),
  });
  assert.equal(
    unchanged.structuredContent.effect_evidence,
    "unchanged",
    "桌面没变化时必须报 unchanged",
  );

  helper.state.elements = [{ index: 0, role: "button", title: "Save", value: "saved" }];
  const changed = await runtime.execute({
    toolName: "get_app_state",
    arguments: { app_ref: "com.example.editor" },
    context: context(),
  });
  assert.equal(changed.structuredContent.effect_evidence, "unknown", "基线只结算一次");

  await runtime.dispose();
});

test("stop 熔断：latch 后只保留 request_access 与再次 stop，且只影响本 session", async () => {
  const helper = createFakeHelper();
  const runtime = createProducerRuntime({ brokerSocketPath: "pipe", connect: helper.connect });

  const stopped = await runtime.execute({
    toolName: "stop_computer_control",
    arguments: { reason: "user asked" },
    context: context(),
  });
  assert.equal(stopped.isError, undefined);
  assert.equal(stopped.structuredContent.already_stopped, false);
  assert.equal(stopped.structuredContent.reason, "user asked");

  const blocked = await runtime.execute({ toolName: "list_apps", context: context() });
  assert.equal(blocked.isError, true);
  assert.match(textOf(blocked), /control_stopped/);
  assert.match(textOf(blocked), /user asked/);

  const stillAllowed = await runtime.execute({ toolName: "request_access", context: context() });
  assert.equal(stillAllowed.isError, undefined, "request_access 是 stop 后的豁免工具");
  const repeat = await runtime.execute({
    toolName: "stop_computer_control",
    arguments: { reason: "other" },
    context: context(),
  });
  assert.equal(repeat.structuredContent.already_stopped, true);
  assert.equal(repeat.structuredContent.reason, "user asked", "首个 reason 必须保留");

  const otherSession = await runtime.execute({
    toolName: "list_apps",
    context: context({ sessionId: "session-2" }),
  });
  assert.equal(otherSession.isError, undefined, "stop 不得影响另一个 session");

  await runtime.dispose();
});

test("Helper 崩溃：越过管道的失败是 possibly_sent，并且不会自动重放", async () => {
  const helper = createFakeHelper();
  const runtime = createProducerRuntime({ brokerSocketPath: "pipe", connect: helper.connect });

  await runtime.execute({
    toolName: "get_app_state",
    arguments: { app_ref: "com.example.editor", include_screenshot: true },
    context: context(),
  });
  const before = helper.writes.length;
  // 让这次 click 在写入后立刻断开：Helper 可能已经执行。
  const failed = await runtime.execute({
    toolName: "left_click",
    arguments: { target: { type: "coordinate", x: 10, y: 10 }, app_ref: "com.example.crash" },
    context: context(),
  });
  assert.equal(failed.isError, true);
  const receipt = receiptOf(failed);
  assert.equal(receipt.dispatch_status, "possibly_sent");
  assert.equal(receipt.action_sent, true);
  assert.match(textOf(failed), /may already have reached the desktop/);
  assert.equal(failed._meta["zcode.cua/retry-policy"], "reobserve");

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(helper.writes.length, before + 1, "possibly_sent 不得自动重放");

  await runtime.dispose();
});

test("Helper 明确未执行：foreground_required 是 not_sent 且永不重试", async () => {
  const helper = createFakeHelper();
  const runtime = createProducerRuntime({ brokerSocketPath: "pipe", connect: helper.connect });
  await runtime.execute({
    toolName: "get_app_state",
    arguments: { app_ref: "com.example.editor" },
    context: context(),
  });
  const before = helper.writes.length;
  const result = await runtime.execute({
    toolName: "left_click",
    arguments: { target: { type: "element", index: 0 }, app_ref: "com.example.blocked" },
    context: context(),
  });
  assert.equal(result.isError, true);
  assert.equal(receiptOf(result).dispatch_status, "not_sent");
  assert.equal(receiptOf(result).action_sent, false);
  assert.equal(result._meta["zcode.cua/retry-policy"], "never", "前台要求永不重试");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(helper.writes.length, before + 1, "not_sent 也不得自动重放");
  await runtime.dispose();
});

test("dispose 之后 runtime 全部 fail closed", async () => {
  const helper = createFakeHelper();
  const runtime = createProducerRuntime({ brokerSocketPath: "pipe", connect: helper.connect });
  await runtime.execute({ toolName: "list_apps", context: context() });
  await runtime.dispose();
  const after = await runtime.execute({ toolName: "list_apps", context: context() });
  assert.equal(after.isError, true);
  assert.match(textOf(after), /session_closed/);
});

test("缺少 broker 配置时 report 可用但任何方法都 fail closed", async () => {
  const runtime = createProducerRuntime({});
  const result = await runtime.execute({ toolName: "list_apps", context: context() });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /broker_unavailable/);
  assert.equal(runtime.inspect().connections, 0, "失败的调用不得留下 broker 连接");
  await runtime.dispose();
});
