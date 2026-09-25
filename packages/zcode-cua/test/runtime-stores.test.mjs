/**
 * runtime 层单元测试：state / frame / kill switch / input hold / receipt / session 分区。
 *
 * 这些都是纯内存模块，测试不连接任何 Helper，也不触碰桌面。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { CuaProtocolError } from "../protocol/errors.js";
import {
  FRAME_TTL_MS,
  MAX_FRAMES_PER_SESSION,
  MAX_HOLD_SECONDS,
  MAX_STATES_PER_SESSION,
} from "../protocol/limits.js";
import { createFrameStore } from "../runtime/frame-store.js";
import { createInputHoldRegistry } from "../runtime/input-holds.js";
import { createKillSwitch } from "../runtime/kill-switch.js";
import {
  ACTION_RECEIPT_SCHEMA_VERSION,
  acceptedReceipt,
  notSentReceipt,
  receiptForFailure,
  recordEffectBaseline,
  resolveEffectEvidence,
} from "../runtime/receipt.js";
import {
  createSessionKey,
  createSessionRegistry,
  defaultSessionFactory,
} from "../runtime/session-registry.js";
import { createStateStore, diffElements, effectFingerprint } from "../runtime/state-store.js";

test("state store: s-N 单调、LRU 8、full/delta/no_change 分类", () => {
  const states = createStateStore({ now: () => 1000 });
  const first = states.commit({ elements: [{ index: 0, role: "button", value: "ok" }] });
  assert.equal(first.stateId, "s-1");
  const second = states.commit({ elements: [{ index: 0, role: "button", value: "ok" }] });
  assert.equal(second.stateId, "s-2");
  assert.equal(states.classify(second.state, {}).kind, "no_change");
  const third = states.commit({ elements: [{ index: 0, role: "button", value: "changed" }] });
  assert.equal(states.classify(third.state, {}).kind, "delta");
  assert.equal(states.classify(third.state, { disableDiffing: true }).kind, "full");

  for (let index = 0; index < MAX_STATES_PER_SESSION; index += 1) {
    states.commit({ elements: [{ index, role: "edit" }] });
  }
  assert.equal(states.size, MAX_STATES_PER_SESSION);
  assert.equal(states.get("s-1"), undefined, "最早的 state 必须被 LRU 淘汰");
});

test("state store: 元素上下界与 diff 键不含 native token", () => {
  const before = [
    { index: 0, role: "button", value: "a", native: "ax-1-0" },
    { index: 1, role: "text", value: "b" },
  ];
  const after = [
    { index: 0, role: "button", value: "a", native: "ax-2-0" },
    { index: 1, role: "text", value: "b2" },
  ];
  const diff = diffElements(before, after);
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, []);
  assert.equal(diff.changed.length, 1, "只有 value 变化才算 changed");
  // 只差 native token 的两棵树必须得到同一效果指纹：token 每次观察都会重新签发。
  const sameShapeNewToken = [
    { index: 0, role: "button", value: "a", native: "ax-9-0" },
    { index: 1, role: "text", value: "b", native: "ax-9-1" },
  ];
  assert.equal(
    effectFingerprint(before),
    effectFingerprint(sameShapeNewToken),
    "native token 变化不得影响效果指纹",
  );
  assert.notEqual(
    effectFingerprint(before),
    effectFingerprint(after),
    "value 变化必须改变效果指纹",
  );

  const states = createStateStore();
  assert.throws(
    () => states.commit({ elements: new Array(6001).fill({ index: 0, role: "x" }) }),
    (error) => error instanceof CuaProtocolError && error.code === "invalid_request",
  );
});

test("frame store: TTL 过期、LRU tombstone、越界与 blank 全部 not_sent", () => {
  let clock = 0;
  const frames = createFrameStore({ now: () => clock });
  const frame = frames.register({ handle: "opaque-1", width: 1280, height: 800 });
  assert.equal(frame.frameId, "f-1");
  assert.equal(frame.expiresAt, FRAME_TTL_MS);
  assert.equal(frames.requireActionable("f-1", { x: 0, y: 0 }).handle, "opaque-1");

  assert.throws(
    () => frames.requireActionable("f-1", { x: 1280, y: 0 }),
    (error) => error.code === "frame_out_of_bounds" && error.dispatchStatus === "not_sent",
  );
  assert.throws(
    () => frames.requireActionable("f-9", { x: 0, y: 0 }),
    (error) => error.code === "frame_expired" && error.dispatchStatus === "not_sent",
  );
  assert.throws(
    () => frames.register({ handle: "blank", width: 0, height: 0 }),
    (error) => error.code === "element_unavailable",
  );

  // 过期后必须留下 tombstone：动作要能区分「从未见过」与「见过但失效」。
  clock = FRAME_TTL_MS + 1;
  assert.equal(frames.get("f-1").reason, "expired");
  assert.throws(
    () => frames.requireActionable("f-1", { x: 0, y: 0 }),
    (error) => error.code === "frame_expired" && error.details?.reason === "expired",
  );

  // 淘汰路径同样写 tombstone。
  const bounded = createFrameStore({ now: () => 0, maxEntries: 2 });
  bounded.register({ handle: "a", width: 10, height: 10 });
  bounded.register({ handle: "b", width: 10, height: 10 });
  bounded.register({ handle: "c", width: 10, height: 10 });
  assert.equal(bounded.size, 2);
  assert.equal(bounded.get("f-1").reason, "evicted");
  assert.ok(MAX_FRAMES_PER_SESSION >= 2);
});

test("kill switch: latch 幂等、首个 reason 生效、可 reset", () => {
  const kill = createKillSwitch({ now: () => 42 });
  assert.equal(kill.isStopped(), false);
  const first = kill.stop("user requested");
  assert.deepEqual(first, { alreadyStopped: false, reason: "user requested", stoppedAt: 42 });
  const second = kill.stop("another reason");
  assert.equal(second.alreadyStopped, true);
  assert.equal(kill.snapshot().reason, "user requested", "首个 reason 必须保留");
  kill.reset();
  assert.equal(kill.isStopped(), false);
});

test("input holds: 30 秒上限、按 session 批量释放、到期清扫", () => {
  const released = [];
  let clock = 0;
  const holds = createInputHoldRegistry({
    now: () => clock,
    release: (hold) => released.push(hold.id),
  });
  const hold = holds.hold({ sessionKey: "s1", keys: ["shift"], seconds: MAX_HOLD_SECONDS });
  assert.equal(hold.expiresAt, MAX_HOLD_SECONDS * 1000);
  holds.hold({ sessionKey: "s2", keys: ["ctrl"], seconds: 1 });
  assert.throws(
    () => holds.hold({ sessionKey: "s1", seconds: MAX_HOLD_SECONDS + 1 }),
    (error) => error.code === "invalid_request",
  );
  assert.deepEqual(
    holds.releaseSession("s1").map((entry) => entry.id),
    [hold.id],
  );
  assert.deepEqual(released, [hold.id]);
  assert.equal(holds.countForSession("s1"), 0);
  clock = 2000;
  assert.deepEqual(holds.sweep(), ["h-2"], "到期 hold 必须由 sweep 释放");
  assert.deepEqual(released, [hold.id, "h-2"]);
});

test("receipt: 固定 schema、not_sent/possibly_sent 分类与 effect 基线", () => {
  const receipt = notSentReceipt({ code: "invalid_request", message: "bad target" });
  assert.equal(receipt.schema_version, ACTION_RECEIPT_SCHEMA_VERSION);
  assert.equal(receipt.action_sent, false);
  assert.equal(receipt.dispatch_status, "not_sent");
  assert.equal(receipt.retry_action, false);
  assert.equal(receipt.ax_error.code, "invalid_request");

  const accepted = acceptedReceipt({ effectEvidence: "changed" });
  assert.equal(accepted.dispatch_status, "accepted");
  assert.equal(accepted.action_sent, true);
  assert.equal(accepted.effect_evidence, "changed");

  const possibly = receiptForFailure({
    code: "timeout",
    message: "stalled",
    dispatchStatus: "possibly_sent",
  });
  assert.equal(possibly.dispatchStatus, "possibly_sent");
  assert.equal(possibly.receipt.action_sent, true);
  assert.equal(possibly.retry, "reobserve");
  const notSent = receiptForFailure(new CuaProtocolError("not_settable", "read only"));
  assert.equal(notSent.dispatchStatus, "not_sent");
  assert.equal(notSent.retry, "never");

  assert.equal(resolveEffectEvidence(undefined, "fp").evidence, "unknown");
  assert.equal(resolveEffectEvidence(recordEffectBaseline("fp"), "fp").evidence, "unchanged");
  assert.equal(resolveEffectEvidence(recordEffectBaseline("fp"), "other").evidence, "changed");
});

test("session 分区: identity 回退规则、LRU 128、dispose 关闭全部", () => {
  assert.equal(createSessionKey({ workspaceKey: "ws", sessionId: "s1" }), "ws||s1");
  assert.equal(
    createSessionKey({ workspaceIdentity: "  /repo  ", sessionId: "s1" }),
    "%2Frepo||s1",
  );
  assert.equal(
    createSessionKey({ workspacePath: "/fallback", sessionId: "s1", remoteSessionId: "r" }),
    "%2Ffallback|r|s1",
  );
  assert.throws(() => createSessionKey({ sessionId: "s1" }), /workspaceKey/);
  assert.throws(() => createSessionKey({ workspaceKey: "ws" }), /sessionId/);

  const closed = [];
  const registry = createSessionRegistry({
    maxEntries: 2,
    closeSession: (session) => closed.push(session.sessionKey),
  });
  registry.acquire({ workspaceKey: "ws", sessionId: "a" });
  registry.acquire({ workspaceKey: "ws", sessionId: "b" });
  registry.acquire({ workspaceKey: "ws", sessionId: "c" });
  assert.equal(registry.size(), 2);
  assert.equal(closed.length, 1, "超出上限的 session 必须被 close");
  assert.equal(registry.has({ workspaceKey: "ws", sessionId: "a" }), false);
  assert.equal(registry.evictedKeys().length, 1);

  // 同一 workspace 的不同 session 是两个分区，桌面状态互不泄漏。
  assert.notEqual(
    registry.acquire({ workspaceKey: "ws", sessionId: "b" }),
    registry.acquire({ workspaceKey: "ws", sessionId: "c" }),
  );
  registry.dispose();
  assert.equal(registry.size(), 0);
});

test("默认 session 工厂: state/frame/kill switch/hold 各自独立", () => {
  const session = defaultSessionFactory("ws||s1", () => 0);
  assert.equal(session.states.size, 0);
  assert.equal(session.frames.size, 0);
  assert.equal(session.killSwitch.isStopped(), false);
  session.holds.hold({ sessionKey: "ws||s1", keys: ["a"], seconds: 1 });
  assert.equal(session.holds.countForSession("ws||s1"), 1);
  assert.equal(session.broker, undefined);
});
