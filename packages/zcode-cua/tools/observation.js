/**
 * 观察管线：把 `capture_app` 的结构事实转成 producer 自己的 state / frame 事实。
 *
 * Helper 不维护 diff 状态，full / delta / no_change 全部由这里根据本地
 * state LRU 计算；native element token 在投影前被裁掉，模型只能看到观察下标。
 */

import { CuaProtocolError } from "../protocol/errors.js";
import { MAX_ELEMENT_TREE_ENTRIES, MODEL_TEXT_MAX_CHARS } from "../protocol/limits.js";
import { effectFingerprint } from "../runtime/state-store.js";
import { resolveEffectEvidence } from "../runtime/receipt.js";

/** 允许投影给模型的元素字段；其余字段（含 native token）一律裁掉。 */
export const MODEL_VISIBLE_ELEMENT_FIELDS = Object.freeze([
  "index",
  "role",
  "title",
  "value",
  "enabled",
  "focused",
  "frame",
  "actions",
  "rect",
  "help",
]);

const isPlainObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * @param {unknown} raw
 * @returns {Record<string, unknown>[]}
 */
export function projectElements(raw) {
  if (!Array.isArray(raw)) return [];
  if (raw.length > MAX_ELEMENT_TREE_ENTRIES) {
    throw new CuaProtocolError("invalid_request", "element tree exceeds the producer entry cap");
  }
  return raw.map((entry) => {
    const element = isPlainObject(entry) ? entry : {};
    /** @type {Record<string, unknown>} */
    const projected = {};
    for (const field of MODEL_VISIBLE_ELEMENT_FIELDS) {
      if (element[field] !== undefined) projected[field] = element[field];
    }
    if (projected.actions !== undefined && !Array.isArray(projected.actions))
      projected.actions = [];
    return projected;
  });
}

/**
 * 模型可见文本：只渲染 role / title / value，不含 token，也不含整棵树的原样拷贝。
 *
 * @param {Record<string, unknown>[]} elements
 * @param {string} header
 */
export function renderElementsText(elements, header) {
  const lines = [header];
  for (const element of elements) {
    const parts = [
      String(element.index ?? "?"),
      String(element.role ?? "element"),
      typeof element.title === "string" && element.title ? `"${element.title}"` : "",
      typeof element.value === "string" && element.value ? `= ${element.value}` : "",
    ].filter(Boolean);
    lines.push(parts.join(" "));
    if (lines.join("\n").length > MODEL_TEXT_MAX_CHARS) {
      lines.push(`[truncated at ${MODEL_TEXT_MAX_CHARS} characters]`);
      break;
    }
  }
  return lines.join("\n");
}

/**
 * 把 Helper 的 capture 结果提交为一次 producer 观察。
 *
 * @param {{
 *   session: Record<string, any>,
 *   raw: unknown,
 *   treeShownToModel: boolean,
 *   disableDiffing: boolean,
 *   now: number,
 * }} input
 */
export function commitObservation(input) {
  const { session, raw, treeShownToModel, disableDiffing, now } = input;
  if (!isPlainObject(raw)) {
    throw new CuaProtocolError("internal", "capture_app returned a non-object result");
  }
  const elements = projectElements(raw.elements);
  const { stateId, state, evicted } = session.states.commit({
    elements,
    epoch: raw.epoch,
    app: raw.app,
  });
  // 第一次真正投影给模型的树强制 full；隐藏 bind capture 不推进这个标记。
  const firstShow = treeShownToModel && session.hasShownModelTree !== true;
  const classified =
    disableDiffing || firstShow
      ? { kind: /** @type {"full"} */ ("full") }
      : session.states.classify(state, {});
  if (treeShownToModel) session.hasShownModelTree = true;

  let frame = null;
  if (isPlainObject(raw.frame)) {
    try {
      const record = session.frames.register({
        handle: /** @type {string} */ (raw.frame.handle),
        width: /** @type {number} */ (raw.frame.width),
        height: /** @type {number} */ (raw.frame.height),
      });
      frame = {
        frame_id: record.frameId,
        width: record.width,
        height: record.height,
        expires_at: record.expiresAt,
        digest: typeof raw.frame.digest === "string" ? raw.frame.digest : undefined,
        format: typeof raw.frame.format === "string" ? raw.frame.format : undefined,
        actionable: true,
      };
    } catch (error) {
      // blank / 几何不可信的 raster 不交付图片，AX 树仍然可用。
      frame = {
        frame_id: null,
        actionable: false,
        reason: error instanceof CuaProtocolError ? error.code : "element_unavailable",
      };
    }
  }

  const fingerprint = effectFingerprint(elements);
  const effect = resolveEffectEvidence(session.effectBaseline, fingerprint);
  if (session.effectBaseline) session.effectBaseline = undefined;

  return {
    schema_version: "zcode-cua-observation-v1",
    state_id: stateId,
    epoch: state.epoch ?? null,
    kind: classified.kind,
    app: state.app ?? null,
    element_count: elements.length,
    elements,
    frame,
    effect_evidence: effect.evidence,
    evicted_states: evicted,
    captured_at: now,
  };
}
