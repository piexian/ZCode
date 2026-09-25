/**
 * 14 个模型可见工具的 strict schema。
 *
 * 单一来源是字段描述符：同一份描述符既生成运行时校验器，也生成对外的 JSON Schema，
 * 避免两处漂移（官方 producer 的 click_count 就没有 min/max）。
 */

import { appRefSchema, normalizedAppRefSchema, targetSchema } from "./app-ref.js";
import { MAX_CLICK_COUNT, MAX_HOLD_SECONDS, MAX_KEY_REPEAT, SCROLL_AMOUNT_MAX } from "./limits.js";
import {
  arrayOf,
  boolean,
  enumOf,
  integer,
  number,
  strictObject,
  string,
  validate,
} from "./validator.js";
export const TOOL_TIERS = Object.freeze({
  READ_ONLY: "read_only",
  T1_INPUT: "t1_input",
  SAFETY_CONTROL: "safety_control",
});

/** stop_computer_control 之后仍可调用的工具；其余一律被 latched kill switch 拒绝。 */
export const STOP_EXEMPT_TOOLS = Object.freeze(["request_access", "stop_computer_control"]);

export const RETURN_STATES = Object.freeze(["none", "compact", "full"]);
export const SCROLL_DIRECTIONS = Object.freeze(["up", "down", "left", "right"]);
export const MOUSE_BUTTONS = Object.freeze(["left", "right", "middle"]);
export const STRATEGIES = Object.freeze(["auto", "semantic", "coordinate"]);
export const MODIFIERS = Object.freeze(["alt", "ctrl", "shift", "win"]);
export const PASTE_FORMATS = Object.freeze(["text", "md", "html"]);
export const REQUEST_ACCESS_CAPABILITIES = Object.freeze([
  "observe",
  "input",
  "clipboard",
  "capture",
]);

/** 工具文本的硬上限，防止把整棵树塞进模型可见文本。 */
export const TOOL_TEXT_MAX_LENGTH = 100_000;
/** reason / 自由文本类字段上限。 */
export const TOOL_REASON_MAX_LENGTH = 512;

/**
 * @typedef {{
 *   type: "string"|"boolean"|"integer"|"number"|"enum"|"array"|"ref",
 *   required?: boolean,
 *   default?: unknown,
 *   values?: readonly string[],
 *   ref?: "app_ref"|"target",
 *   min?: number,
 *   max?: number,
 *   clamp?: boolean|"max",
 *   minLength?: number,
 *   maxLength?: number,
 *   exactItems?: number,
 *   item?: {type: "string"|"integer", min?: number, max?: number, values?: readonly string[]},
 *   description?: string,
 * }} FieldDescriptor
 */

/** @param {FieldDescriptor} field */
function schemaForField(field) {
  // 数组元素与枚举一样按 values 收紧；没有 values 的字符串/整数只做类型与边界检查。
  if (field.values && (field.type === "string" || field.type === "integer")) {
    return enumOf(field.values);
  }
  switch (field.type) {
    case "string":
      return string({ minLength: field.minLength, maxLength: field.maxLength });
    case "boolean":
      return boolean();
    case "integer":
      return integer({ min: field.min, max: field.max, clamp: field.clamp });
    case "number":
      return number({ min: field.min, max: field.max, clamp: field.clamp });
    case "enum":
      return enumOf(field.values ?? []);
    case "array":
      return arrayOf(schemaForField(/** @type {FieldDescriptor} */ (field.item)), {
        exactItems: field.exactItems,
        maxItems: field.exactItems ?? field.item?.values?.length,
        minItems: field.exactItems,
      });
    case "ref":
      return field.ref === "target" ? targetSchema : normalizedAppRefSchema;
    default:
      return () => field.default;
  }
}

/** @param {FieldDescriptor} field */
function jsonSchemaForField(field) {
  const base = {
    description: field.description ?? field.type,
    ...(field.default === undefined ? {} : { default: field.default }),
  };
  if (field.type === "ref") {
    return { ...base, $ref: field.ref === "target" ? "#/$defs/target" : "#/$defs/app_ref" };
  }
  if (field.type === "array") {
    return {
      ...base,
      type: "array",
      items: jsonSchemaForField(/** @type {FieldDescriptor} */ (field.item)),
    };
  }
  if (field.type === "enum") return { ...base, type: "string", enum: [...(field.values ?? [])] };
  if (field.type === "integer") {
    return {
      ...base,
      type: "integer",
      ...(field.min === undefined ? {} : { minimum: field.min }),
      ...(field.max === undefined ? {} : { maximum: field.max }),
    };
  }
  if (field.type === "number") {
    return {
      ...base,
      type: "number",
      ...(field.min === undefined ? {} : { minimum: field.min }),
      ...(field.max === undefined ? {} : { maximum: field.max }),
    };
  }
  if (field.type === "boolean") return { ...base, type: "boolean" };
  return {
    ...base,
    type: "string",
    ...(field.maxLength === undefined ? {} : { maxLength: field.maxLength }),
  };
}

/**
 * @param {Record<string, FieldDescriptor>} fields
 */
function buildToolArgs(fields) {
  const properties = {};
  const required = [];
  /** @type {Record<string, unknown>} */
  const validators = {};
  for (const [name, field] of Object.entries(fields)) {
    properties[name] = jsonSchemaForField(field);
    validators[name] = {
      schema: schemaForField(field),
      required: field.required,
      default: field.default,
    };
    if (field.required) required.push(name);
  }
  const jsonSchema = {
    type: "object",
    additionalProperties: false,
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
  const parse = (value) => validate(strictObject(validators), value === undefined ? {} : value);
  return { parse, jsonSchema };
}

const APP_REF_FIELD = /** @type {FieldDescriptor} */ ({
  type: "ref",
  ref: "app_ref",
  required: true,
});
const TARGET_FIELD = /** @type {FieldDescriptor} */ ({
  type: "ref",
  ref: "target",
  required: true,
});
const RETURN_STATE_FIELD = /** @type {FieldDescriptor} */ ({
  type: "enum",
  values: RETURN_STATES,
  default: "none",
  description: "动作后是否返回新观察",
});
const OPTIONAL_APP_REF = /** @type {FieldDescriptor} */ ({ type: "ref", ref: "app_ref" });
const STRATEGY_FIELD = /** @type {FieldDescriptor} */ ({
  type: "enum",
  values: STRATEGIES,
  default: "auto",
});
const MODIFIERS_FIELD = /** @type {FieldDescriptor} */ ({
  type: "array",
  item: { type: "string", values: MODIFIERS },
  default: [],
});

/**
 * @param {{name: string, tier: string, description: string, fields: Record<string, FieldDescriptor>}} spec
 */
function defineTool(spec) {
  const args = buildToolArgs(spec.fields);
  return Object.freeze({
    name: spec.name,
    tier: spec.tier,
    description: spec.description,
    stopExempt: STOP_EXEMPT_TOOLS.includes(spec.name),
    mutating: spec.tier === TOOL_TIERS.T1_INPUT,
    parse: args.parse,
    jsonSchema: args.jsonSchema,
    fields: spec.fields,
  });
}

const listApps = defineTool({
  name: "list_apps",
  tier: TOOL_TIERS.READ_ONLY,
  description: "List applications available for Computer Use observation.",
  fields: {},
});

const listWindows = defineTool({
  name: "list_windows",
  tier: TOOL_TIERS.READ_ONLY,
  description: "List the observable windows of one application.",
  fields: { app_ref: APP_REF_FIELD },
});

const getAppState = defineTool({
  name: "get_app_state",
  tier: TOOL_TIERS.READ_ONLY,
  description:
    "Capture one application observation. Returns structural facts and, when include_screenshot is set, a frame usable for coordinate actions.",
  fields: {
    app_ref: APP_REF_FIELD,
    include_screenshot: { type: "boolean", default: false },
    disable_diffing: { type: "boolean", default: false },
    // 内部字段：node_repl 的隐藏 bind capture 用它避免把同一棵树重复投影给模型。
    tree_shown_to_model: { type: "boolean", default: true },
  },
});

const leftClick = defineTool({
  name: "left_click",
  tier: TOOL_TIERS.T1_INPUT,
  description: "Click an element index or an integer coordinate inside a delivered frame.",
  fields: {
    target: TARGET_FIELD,
    mouse_button: { type: "enum", values: MOUSE_BUTTONS, default: "left" },
    click_count: { type: "integer", min: 1, max: MAX_CLICK_COUNT, default: 1 },
    modifiers: MODIFIERS_FIELD,
    strategy: STRATEGY_FIELD,
    app_ref: OPTIONAL_APP_REF,
    return_state: RETURN_STATE_FIELD,
  },
});

const scroll = defineTool({
  name: "scroll",
  tier: TOOL_TIERS.T1_INPUT,
  description: "Scroll at an element or coordinate. A zero scroll amount is a no-op.",
  fields: {
    target: TARGET_FIELD,
    scroll_direction: { type: "enum", values: SCROLL_DIRECTIONS, required: true },
    scroll_amount: { type: "integer", min: 0, max: SCROLL_AMOUNT_MAX, clamp: true, required: true },
    strategy: STRATEGY_FIELD,
    app_ref: OPTIONAL_APP_REF,
    return_state: RETURN_STATE_FIELD,
  },
});

const leftClickDrag = defineTool({
  name: "left_click_drag",
  tier: TOOL_TIERS.T1_INPUT,
  description: "Drag from a target to a coordinate. There is no strategy field.",
  fields: {
    from_target: TARGET_FIELD,
    to: { type: "ref", ref: "target", required: true },
    modifiers: MODIFIERS_FIELD,
    app_ref: OPTIONAL_APP_REF,
    return_state: RETURN_STATE_FIELD,
  },
});

const typeText = defineTool({
  name: "type",
  tier: TOOL_TIERS.T1_INPUT,
  description: "Type text, optionally into a focused element. Empty text is a no-op.",
  fields: {
    text: { type: "string", required: true, maxLength: TOOL_TEXT_MAX_LENGTH },
    target: { type: "ref", ref: "target" },
    app_ref: OPTIONAL_APP_REF,
    strategy: STRATEGY_FIELD,
    return_state: RETURN_STATE_FIELD,
  },
});

const setValue = defineTool({
  name: "set_value",
  tier: TOOL_TIERS.T1_INPUT,
  description: "Set an element value. An empty value is legal.",
  fields: {
    target: TARGET_FIELD,
    value: { type: "string", required: true, maxLength: TOOL_TEXT_MAX_LENGTH },
    strategy: STRATEGY_FIELD,
    app_ref: OPTIONAL_APP_REF,
    return_state: RETURN_STATE_FIELD,
  },
});

const selectText = defineTool({
  name: "select_text",
  tier: TOOL_TIERS.T1_INPUT,
  description:
    "Select a text range inside an element. Omitting text_range leaves the caret in place.",
  fields: {
    target: TARGET_FIELD,
    text_range: { type: "array", item: { type: "integer", min: 0 }, exactItems: 2 },
    app_ref: OPTIONAL_APP_REF,
    return_state: RETURN_STATE_FIELD,
  },
});

const key = defineTool({
  name: "key",
  tier: TOOL_TIERS.T1_INPUT,
  description:
    "Send a key. repeat 0 is a no-op, positive repeats are clamped to 100, hold_seconds must not be negative and is capped at 30 seconds.",
  fields: {
    text: { type: "string", required: true, minLength: 1, maxLength: 256 },
    // repeat 低于 0 拒绝，高于上限 clamp：负重复没有语义，1..100 是 Helper 侧硬限。
    repeat: { type: "integer", min: 0, max: MAX_KEY_REPEAT, clamp: "max", default: 1 },
    hold_seconds: { type: "number", min: 0, max: MAX_HOLD_SECONDS, default: 0 },
    app_ref: OPTIONAL_APP_REF,
    strategy: STRATEGY_FIELD,
    return_state: RETURN_STATE_FIELD,
  },
});

const performAction = defineTool({
  name: "perform_action",
  tier: TOOL_TIERS.T1_INPUT,
  description: "Run one action advertised by the target element's current actions list.",
  fields: {
    target: TARGET_FIELD,
    action: { type: "string", required: true, minLength: 1, maxLength: 256 },
    app_ref: OPTIONAL_APP_REF,
    return_state: RETURN_STATE_FIELD,
  },
});

const paste = defineTool({
  name: "paste",
  tier: TOOL_TIERS.T1_INPUT,
  description:
    "Write text to the clipboard and paste it. Prior text is restored and the restore result is reported.",
  fields: {
    text: { type: "string", required: true, maxLength: TOOL_TEXT_MAX_LENGTH },
    format: { type: "enum", values: PASTE_FORMATS, default: "text" },
    app_ref: OPTIONAL_APP_REF,
    return_state: RETURN_STATE_FIELD,
  },
});

const requestAccess = defineTool({
  name: "request_access",
  tier: TOOL_TIERS.READ_ONLY,
  description: "Report Computer Use access. This never prompts and never changes authorization.",
  fields: {
    capabilities: { type: "array", item: { type: "string", values: REQUEST_ACCESS_CAPABILITIES } },
  },
});

const stopComputerControl = defineTool({
  name: "stop_computer_control",
  tier: TOOL_TIERS.SAFETY_CONTROL,
  description: "Stop Computer Use for this session. Idempotent; the first reason is retained.",
  fields: {
    reason: { type: "string", maxLength: TOOL_REASON_MAX_LENGTH },
  },
});

/** 工具注册顺序即模型可见顺序。 */
export const TOOL_DEFINITIONS = Object.freeze([
  listApps,
  listWindows,
  getAppState,
  leftClick,
  scroll,
  leftClickDrag,
  typeText,
  setValue,
  selectText,
  key,
  performAction,
  paste,
  requestAccess,
  stopComputerControl,
]);

const BY_NAME = new Map(TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));

export const TOOL_NAMES = Object.freeze(TOOL_DEFINITIONS.map((tool) => tool.name));

/** @param {string} name */
export function getToolDefinition(name) {
  return BY_NAME.get(name);
}

/** @param {string} name */
export function isKnownTool(name) {
  return BY_NAME.has(name);
}

/**
 * 工具 tier 汇总，供 UI annotation 与校验测试使用。
 * @returns {Record<string, string[]>}
 */
export function summarizeToolTiers() {
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const tool of TOOL_DEFINITIONS) {
    (out[tool.tier] ??= []).push(tool.name);
  }
  return out;
}

/** 对外可发布的工具 schema 列表（不含内部 handler 引用）。 */
export function listToolSchemas() {
  return TOOL_DEFINITIONS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    tier: tool.tier,
    inputSchema: tool.jsonSchema,
  }));
}

/** JSON Schema 片段：`app_ref` 与 `target` 的公共定义。 */
export const TOOL_SCHEMA_DEFS = Object.freeze({
  app_ref: {
    anyOf: [{ type: "string", minLength: 1 }, appRefObjectSchema()],
  },
  target: {
    anyOf: [
      {
        type: "object",
        additionalProperties: false,
        properties: { type: { const: "element" }, index: { type: "integer", minimum: 0 } },
        required: ["type", "index"],
      },
      {
        type: "object",
        additionalProperties: false,
        properties: {
          type: { const: "coordinate" },
          x: { type: "integer", minimum: 0 },
          y: { type: "integer", minimum: 0 },
          frame_id: { type: "string", minLength: 1 },
        },
        required: ["type", "x", "y"],
      },
    ],
  },
});

function appRefObjectSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      pid: { type: "integer", minimum: 1 },
      bundle_id: { type: "string", minLength: 1 },
      name: { type: "string", minLength: 1 },
      window_id: { type: "string", minLength: 1 },
    },
    required: ["pid", "bundle_id", "name"],
  };
}

/** 内部字段：不对模型展示，用于隐藏 bind capture。 */
export const INTERNAL_FIELD_NAMES = Object.freeze(["tree_shown_to_model"]);
