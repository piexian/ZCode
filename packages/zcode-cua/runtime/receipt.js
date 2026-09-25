/**
 * action receipt、dispatch 分类与 effect 证据。
 *
 * 每次动作结果都带同一组字段，模型据此判断能否安全重试。本切片固定
 * `retry_action = false`：任何 receipt 都不授权自动重放。
 */

import { CuaProtocolError, classifyRetry } from "../protocol/errors.js";

export const ACTION_RECEIPT_SCHEMA_VERSION = "zcode-cua-action-receipt-v1";
export const DISPATCH_STATUS = Object.freeze({
  ACCEPTED: "accepted",
  POSSIBLY_SENT: "possibly_sent",
  NOT_SENT: "not_sent",
});
export const TARGET_VERIFICATION_STATUS = Object.freeze({
  MATCHED: "matched",
  MISMATCHED: "mismatched",
  UNAVAILABLE: "unavailable",
});
export const EFFECT_EVIDENCE = Object.freeze({
  CHANGED: "changed",
  UNCHANGED: "unchanged",
  UNKNOWN: "unknown",
});

/**
 * 构造 receipt。字段顺序固定，方便文本投影稳定。
 *
 * @param {{
 *   dispatchStatus: "accepted"|"possibly_sent"|"not_sent",
 *   actionSent?: boolean,
 *   targetVerificationStatus?: "matched"|"mismatched"|"unavailable",
 *   effectEvidence?: "changed"|"unchanged"|"unknown",
 *   error?: {code: string, message: string} | undefined,
 * }} input
 */
export function createReceipt(input) {
  const dispatchStatus = input.dispatchStatus ?? DISPATCH_STATUS.NOT_SENT;
  const actionSent = input.actionSent ?? dispatchStatus !== DISPATCH_STATUS.NOT_SENT;
  return {
    schema_version: ACTION_RECEIPT_SCHEMA_VERSION,
    action_sent: actionSent,
    dispatch_status: dispatchStatus,
    retry_action: false,
    target_verification_status:
      input.targetVerificationStatus ?? TARGET_VERIFICATION_STATUS.UNAVAILABLE,
    effect_evidence: input.effectEvidence ?? EFFECT_EVIDENCE.UNKNOWN,
    ...(input.error ? { ax_error: { code: input.error.code, message: input.error.message } } : {}),
  };
}

/**
 * 未越过管道的失败：校验、admission、预检与本地拒绝都属于这一类。
 *
 * @param {{code: string, message?: string, targetVerificationStatus?: "matched"|"mismatched"|"unavailable"}} error
 */
export function notSentReceipt(error) {
  return createReceipt({
    dispatchStatus: DISPATCH_STATUS.NOT_SENT,
    actionSent: false,
    targetVerificationStatus:
      error.targetVerificationStatus ?? TARGET_VERIFICATION_STATUS.UNAVAILABLE,
    error: { code: error.code, message: error.message ?? error.code },
  });
}

/**
 * 已接受：Helper 明确回报动作完成。
 * @param {{effectEvidence?: "changed"|"unchanged"|"unknown", targetVerificationStatus?: "matched"|"mismatched"|"unavailable"}} [input]
 */
export function acceptedReceipt(input = {}) {
  return createReceipt({
    dispatchStatus: DISPATCH_STATUS.ACCEPTED,
    actionSent: true,
    targetVerificationStatus: input.targetVerificationStatus ?? TARGET_VERIFICATION_STATUS.MATCHED,
    effectEvidence: input.effectEvidence ?? EFFECT_EVIDENCE.UNKNOWN,
  });
}

/**
 * 把失败分类成 receipt。只有 `not_sent` 允许在越过管道之前重试；其余一律
 * `possibly_sent`，必须先重新观察。
 *
 * @param {unknown} error
 * @param {{crossedPipe?: boolean}} [options]
 * @returns {{receipt: ReturnType<typeof createReceipt>, dispatchStatus: string, code: string, retry: string}}
 */
export function receiptForFailure(error, options = {}) {
  const code =
    error instanceof CuaProtocolError || isCodedError(error)
      ? /** @type {{code: string}} */ (error).code
      : "internal";
  const message = error instanceof Error ? error.message : String(error);
  const crossedPipe =
    options.crossedPipe ??
    (isCodedError(error)
      ? /** @type {{dispatchStatus?: string}} */ (error).dispatchStatus ===
        DISPATCH_STATUS.POSSIBLY_SENT
      : false);
  const dispatchStatus = crossedPipe ? DISPATCH_STATUS.POSSIBLY_SENT : DISPATCH_STATUS.NOT_SENT;
  return {
    code,
    dispatchStatus,
    retry: classifyRetry(code, { dispatchStatus }),
    receipt: createReceipt({
      dispatchStatus,
      actionSent: crossedPipe,
      effectEvidence: EFFECT_EVIDENCE.UNKNOWN,
      error: { code, message },
    }),
  };
}

/** @param {unknown} value */
function isCodedError(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (/** @type {{code?: unknown}} */ (value).code) === "string"
  );
}

/**
 * 效果基线：动作前记录指纹，下一次观察比较。
 *
 * @param {string} fingerprint
 */
export function recordEffectBaseline(fingerprint) {
  return { fingerprint, resolved: false };
}

/**
 * 用新观察解析基线。指纹相同即 `unchanged`，不同即 `changed`。
 *
 * @param {{fingerprint: string, resolved: boolean}|undefined} baseline
 * @param {string} fingerprint
 * @returns {{evidence: "changed"|"unchanged"|"unknown", baseline: {fingerprint: string, resolved: boolean}}}
 */
export function resolveEffectEvidence(baseline, fingerprint) {
  if (!baseline)
    return { evidence: EFFECT_EVIDENCE.UNKNOWN, baseline: { fingerprint, resolved: false } };
  return {
    evidence:
      baseline.fingerprint === fingerprint ? EFFECT_EVIDENCE.UNCHANGED : EFFECT_EVIDENCE.CHANGED,
    baseline: { fingerprint: baseline.fingerprint, resolved: true },
  };
}
