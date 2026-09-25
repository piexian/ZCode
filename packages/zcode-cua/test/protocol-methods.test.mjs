import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ALL_BROKER_METHODS,
  BROKER_METHODS,
  BROKER_ROLES,
  HANDSHAKE_METHODS,
  describeBrokerMethod,
  isBrokerMethod,
  isHandshakeMethod,
  isMethodAllowedForRole,
  isReadOnlyBrokerMethod,
  isWindowsUnimplementedMethod,
} from "../protocol/method-table.js";
import {
  PRODUCER_ERROR_CODES,
  RESERVED_SERVER_ERROR_CODES,
  RETRY_ALLOWED,
  RETRY_NEVER,
  RETRY_REOBSERVE,
  SERVER_ERROR_CODES,
  classifyRetry,
  isKnownErrorCode,
  isProducerErrorCode,
  isServerErrorCode,
} from "../protocol/errors.js";
import {
  BROKER_PROTOCOL_VERSION,
  CLIENT_REQUEST_MAX_BYTES,
  CLIENT_RESPONSE_MAX_BYTES,
  FRAME_TTL_MS,
  MAX_FRAMES_PER_SESSION,
  MAX_HOLD_SECONDS,
  MAX_SESSION_ENTRIES,
  MAX_STATES_PER_SESSION,
  MIN_BROKER_PROTOCOL_VERSION,
  SERVER_LINE_MAX_BYTES,
} from "../protocol/limits.js";

test("方法表保留 42 个业务方法，authenticate/ping 单独计数", () => {
  assert.equal(BROKER_METHODS.length, 42);
  assert.deepEqual([...HANDSHAKE_METHODS], ["authenticate", "ping"]);
  assert.equal(ALL_BROKER_METHODS.length, 44);
  assert.equal(new Set(ALL_BROKER_METHODS).size, 44, "方法名不得重复");
  assert.ok(ALL_BROKER_METHODS.includes("broker_info"));
  assert.ok(ALL_BROKER_METHODS.includes("pip_session_event"));
});

test("tier 覆盖每个方法，read-only 判定与 tier 一致", () => {
  const byTier = new Map();
  for (const method of BROKER_METHODS) {
    assert.equal(typeof method.tier, "string");
    assert.ok(method.tier.length > 0, `${method.name} 缺 tier`);
    assert.equal(isBrokerMethod(method.name), true);
    assert.equal(isWindowsUnimplementedMethod(method.name), method.windows === "unimplemented");
    byTier.set(method.tier, (byTier.get(method.tier) ?? 0) + 1);
  }
  assert.equal(byTier.get("input"), 10);
  assert.equal(byTier.get("pip"), 6);
  assert.equal(BROKER_METHODS.filter((m) => m.readOnly).length > 0, true);
  assert.equal(isReadOnlyBrokerMethod("capture_app"), true);
  assert.equal(isReadOnlyBrokerMethod("click"), false);
  assert.equal(describeBrokerMethod("paste").tier, "clipboard");
});

test("PiP 方法只允许 presentation role，controller 方法只允许 host role", () => {
  assert.equal(isMethodAllowedForRole("pip_start", "presentation"), true);
  assert.equal(isMethodAllowedForRole("pip_start", "tool"), false);
  assert.equal(isMethodAllowedForRole("controller_takeover", "tool"), false);
  assert.equal(isMethodAllowedForRole("controller_takeover", "host"), true);
  for (const role of BROKER_ROLES) assert.equal(typeof role, "string");
  assert.equal(isBrokerMethod("authenticate"), false, "握手方法不计入 42");
  assert.equal(isHandshakeMethod("authenticate"), true);
});

test("Windows 上 focus/PiP 方法显式标记为 unimplemented", () => {
  for (const name of [
    "prevent_activation",
    "reenable_activation",
    "is_focus_steal_prevented",
    "pip_start",
    "pip_stop",
    "pip_is_running",
    "pip_clear_dismissed",
    "pip_session_handshake",
    "pip_session_event",
  ]) {
    assert.equal(
      isWindowsUnimplementedMethod(name),
      true,
      `${name} 应在 Windows 显式 unimplemented`,
    );
  }
  assert.equal(isWindowsUnimplementedMethod("capture_app"), false);
});

test("错误码表稳定：服务端码、producer 码与保留码互不重叠", () => {
  assert.equal(SERVER_ERROR_CODES.length, 19);
  assert.deepEqual([...RESERVED_SERVER_ERROR_CODES], ["launch_failed"]);
  for (const code of SERVER_ERROR_CODES) {
    assert.equal(isServerErrorCode(code), true);
    assert.equal(isKnownErrorCode(code), true);
    assert.equal(isProducerErrorCode(code), false);
  }
  for (const code of PRODUCER_ERROR_CODES) {
    assert.equal(isProducerErrorCode(code), true);
    assert.equal(isKnownErrorCode(code), true);
    assert.equal(isServerErrorCode(code), false);
  }
  assert.equal(isKnownErrorCode("broker_unavailable"), true);
  assert.equal(
    SERVER_ERROR_CODES.includes("broker_unavailable"),
    false,
    "broker_unavailable 不是服务端码",
  );
  assert.equal(SERVER_ERROR_CODES.includes("launch_failed"), true, "launch_failed 只保留不发出");
});

test("重试分类：前台/权限/版本/不支持永不重试，possibly_sent 只观察", () => {
  for (const code of [
    "foreground_required",
    "permission_denied",
    "not_authorized",
    "version_mismatch",
    "unimplemented",
    "method_not_found",
    "invalid_request",
    "app_not_found",
    "ambiguous_app",
    "screen_locked",
    "control_stopped",
  ]) {
    assert.equal(classifyRetry(code), RETRY_NEVER, `${code} 不应自动重试`);
  }
  assert.equal(classifyRetry("timeout"), RETRY_REOBSERVE);
  assert.equal(classifyRetry("internal"), RETRY_REOBSERVE);
  assert.equal(classifyRetry("broker_unavailable"), RETRY_ALLOWED);
  assert.equal(classifyRetry("controller_busy"), RETRY_ALLOWED);
  // dispatch_status 优先于码表：任何越过管道的失败都只能先观察。
  assert.equal(
    classifyRetry("invalid_request", { dispatchStatus: "possibly_sent" }),
    RETRY_REOBSERVE,
  );
  assert.equal(
    classifyRetry("broker_unavailable", { dispatchStatus: "accepted" }),
    RETRY_REOBSERVE,
  );
});

test("上限常量与规格一致", () => {
  assert.equal(BROKER_PROTOCOL_VERSION, 2);
  assert.equal(MIN_BROKER_PROTOCOL_VERSION, 2);
  assert.equal(CLIENT_REQUEST_MAX_BYTES, 1024 * 1024);
  assert.equal(CLIENT_RESPONSE_MAX_BYTES, 16 * 1024 * 1024);
  assert.equal(SERVER_LINE_MAX_BYTES, 16 * 1024 * 1024);
  assert.equal(MAX_SESSION_ENTRIES, 128);
  assert.equal(MAX_STATES_PER_SESSION, 8);
  assert.equal(MAX_FRAMES_PER_SESSION, 16);
  assert.equal(FRAME_TTL_MS, 10 * 60 * 1000);
  assert.equal(MAX_HOLD_SECONDS, 30);
});
