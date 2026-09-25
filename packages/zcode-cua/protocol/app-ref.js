/**
 * `app_ref` 与 `target` 的公共严格契约。
 *
 * 两者都是模型直接书写的 JSON，因此未知键一律拒绝：`app_ref` 对象的额外键与
 * `target` element 分支上的 `frame_id` 都不能被静默忽略，否则 producer 会把
 * 未经校验的字段透传到 Helper。
 */

import { FAIL, integer, nonEmptyString, strictObject, union, validate } from "./validator.js";

/** app_ref 字符串按 bundle id / AUMID 解释；对象形式要求 pid、bundle_id、name。 */
export const APP_REF_STRING_MAX_LENGTH = 512;

export const appRefSchema = union([
  nonEmptyString({ maxLength: APP_REF_STRING_MAX_LENGTH }),
  strictObject({
    pid: { schema: integer({ min: 1 }), required: true },
    bundle_id: { schema: nonEmptyString({ maxLength: APP_REF_STRING_MAX_LENGTH }), required: true },
    name: { schema: nonEmptyString({ maxLength: 256 }), required: true },
    window_id: nonEmptyString({ maxLength: 256 }),
  }),
]);

/** element 分支不允许 frame_id：元素下标属于当前 state，frame 属于坐标分支。 */
export const elementTargetSchema = strictObject({
  type: nonEmptyString(),
  index: integer({ min: 0 }),
});

export const coordinateTargetSchema = strictObject({
  type: nonEmptyString(),
  x: integer({ min: 0 }),
  y: integer({ min: 0 }),
  frame_id: nonEmptyString({ maxLength: 256 }),
});

export const targetSchema = union([elementTargetSchema, coordinateTargetSchema]);

/**
 * 归一化后的 `app_ref` schema：字符串统一成 `{kind:"bundle_id", bundle_id}`，
 * 让 handler 传给 Helper 的形状与模型书写的一致。
 */
export const normalizedAppRefSchema = (value, path, issues) => {
  const parsed = appRefSchema(value, path, issues);
  if (parsed === FAIL) return FAIL;
  return typeof parsed === "string" ? { kind: "bundle_id", bundle_id: parsed } : parsed;
};

/**
 * 解析 `app_ref`。字符串归一为 `{kind:"bundle_id", bundle_id}`，对象保留原样，
 * 由 Helper 依据 pid/bundle_id/name/window_id 解析目标应用。
 *
 * @param {unknown} value
 * @returns {{ok: true, value: Record<string, unknown>} | {ok: false, issues: Array<{path: string, message: string}>}}
 */
export function parseAppRef(value) {
  const parsed = validate(appRefSchema, value);
  if (!parsed.ok) return parsed;
  if (typeof parsed.value === "string") {
    return { ok: true, value: { kind: "bundle_id", bundle_id: parsed.value } };
  }
  return { ok: true, value: parsed.value };
}

/**
 * 解析 `target`，并按 `type` 收窄成 element / coordinate 两种判别联合。
 *
 * @param {unknown} value
 */
export function parseTarget(value) {
  const parsed = validate(targetSchema, value);
  if (!parsed.ok) return parsed;
  const record = /** @type {Record<string, unknown>} */ (parsed.value);
  if (record.index !== undefined) {
    if (record.type !== "element") {
      return { ok: false, issues: [{ path: "$.type", message: "expected element" }] };
    }
    return { ok: true, value: { type: "element", index: record.index } };
  }
  if (record.type !== "coordinate") {
    return { ok: false, issues: [{ path: "$.type", message: "expected coordinate" }] };
  }
  return {
    ok: true,
    value: {
      type: "coordinate",
      x: record.x,
      y: record.y,
      ...(record.frame_id === undefined ? {} : { frame_id: record.frame_id }),
    },
  };
}

/** target 解析结果里的 element 分支不含 frame_id，导出仅为文档与测试断言。 */
export const TARGET_ELEMENT_ALLOWED_KEYS = Object.freeze(["type", "index"]);
export const TARGET_COORDINATE_ALLOWED_KEYS = Object.freeze(["type", "x", "y", "frame_id"]);
