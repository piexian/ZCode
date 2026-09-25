/**
 * 稳定错误码与重试分类。
 *
 * 分三层：`SERVER_ERROR_CODES` 是 Helper 契约里的服务端码；`PRODUCER_ERROR_CODES`
 * 是只存在于 JS producer 的分类码（例如 broker 不可用、frame 过期）；
 * `classifyRetry` 把两者映射为 never / reobserve / retry，任何自动重放都必须先过这一关。
 */

export const SERVER_ERROR_CODES = Object.freeze([
  "invalid_request",
  "not_authorized",
  "permission_denied",
  "controller_busy",
  "element_unavailable",
  "not_settable",
  "not_selectable",
  "action_unavailable",
  "foreground_required",
  "app_not_found",
  "ambiguous_app",
  "screen_locked",
  "control_stopped",
  "launch_failed",
  "timeout",
  "version_mismatch",
  "unimplemented",
  "method_not_found",
  "internal",
]);

/** producer 独有分类码，不出现在 Helper 方法响应里。 */
export const PRODUCER_ERROR_CODES = Object.freeze([
  "broker_unavailable",
  "frame_expired",
  "frame_out_of_bounds",
  "target_not_observed",
  "unknown_tool",
  "subagent_forbidden",
  "session_closed",
  "response_corrupted",
  "response_id_mismatch",
  "request_timeout",
]);

/** `launch_failed` 只为未来 launch 契约保留，本切片不产生。 */
export const RESERVED_SERVER_ERROR_CODES = Object.freeze(["launch_failed"]);

const ALL_ERROR_CODES = new Set([...SERVER_ERROR_CODES, ...PRODUCER_ERROR_CODES]);

/** 重试策略：never = 明确不重试，reobserve = 可能已生效只能先观察，retry = 允许 bounded backoff。 */
export const RETRY_NEVER = "never";
export const RETRY_REOBSERVE = "reobserve";
export const RETRY_ALLOWED = "retry";

/**
 * 明确不自动重试的码：前台、权限、版本、不支持、请求本身非法，以及业务前置条件失败。
 */
const NEVER_RETRY_CODES = new Set([
  "invalid_request",
  "not_authorized",
  "permission_denied",
  "element_unavailable",
  "not_settable",
  "not_selectable",
  "action_unavailable",
  "foreground_required",
  "app_not_found",
  "ambiguous_app",
  "screen_locked",
  "control_stopped",
  "version_mismatch",
  "unimplemented",
  "method_not_found",
  "frame_expired",
  "frame_out_of_bounds",
  "target_not_observed",
  "unknown_tool",
  "subagent_forbidden",
  "session_closed",
  "response_corrupted",
  "response_id_mismatch",
]);

/** 已越过管道且结果未知：只能先重新观察，禁止自动重放。 */
const REOBSERVE_CODES = new Set(["timeout", "request_timeout", "internal", "response_corrupted"]);

export function isServerErrorCode(code) {
  return SERVER_ERROR_CODES.includes(code);
}

export function isProducerErrorCode(code) {
  return PRODUCER_ERROR_CODES.includes(code);
}

export function isKnownErrorCode(code) {
  return ALL_ERROR_CODES.has(code);
}

export class CuaProtocolError extends Error {
  /**
   * @param {string} code 稳定错误码
   * @param {string} [message] 模型可见说明
   * @param {{details?: unknown, dispatchStatus?: string}} [options]
   */
  constructor(code, message, options = {}) {
    super(message ?? code);
    this.name = "CuaProtocolError";
    this.code = code;
    this.dispatchStatus = options.dispatchStatus ?? "not_sent";
    if (options.details !== undefined) this.details = options.details;
  }
}

/**
 * 把错误码映射为重试策略。`dispatchStatus` 优先于码表：任何已越过管道的失败都是
 * possibly_sent，只能 reobserve。
 *
 * @param {string} code
 * @param {{dispatchStatus?: string}} [options]
 * @returns {"never"|"reobserve"|"retry"}
 */
export function classifyRetry(code, options = {}) {
  const dispatchStatus = options.dispatchStatus;
  if (dispatchStatus === "possibly_sent" || dispatchStatus === "accepted") return RETRY_REOBSERVE;
  if (NEVER_RETRY_CODES.has(code)) return RETRY_NEVER;
  if (REOBSERVE_CODES.has(code)) return RETRY_REOBSERVE;
  // broker_unavailable / controller_busy 属于未越过管道的瞬时失败，允许 bounded backoff。
  return RETRY_ALLOWED;
}
