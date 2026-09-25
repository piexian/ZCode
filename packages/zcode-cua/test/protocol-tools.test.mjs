import assert from "node:assert/strict";
import { test } from "node:test";

import { parseAppRef, parseTarget } from "../protocol/app-ref.js";
import { parseStrictJson, StrictJsonError } from "../protocol/strict-json.js";
import {
  FAIL,
  arrayOf,
  integer,
  strictObject,
  string,
  union,
  validate,
} from "../protocol/validator.js";
import {
  STOP_EXEMPT_TOOLS,
  TOOL_NAMES,
  getToolDefinition,
  isKnownTool,
  listToolSchemas,
  summarizeToolTiers,
} from "../protocol/tool-schemas.js";
import { TOOL_HANDLERS, describeTools, resolveTool } from "../tools/registry.js";

const parse = (tool, args) => getToolDefinition(tool).parse(args);
const ok = (tool, args) => {
  const result = parse(tool, args);
  assert.equal(result.ok, true, `${tool} 应通过校验: ${JSON.stringify(result.issues)}`);
  return result.value;
};
const rejected = (tool, args) => {
  const result = parse(tool, args);
  assert.equal(result.ok, false, `${tool} 应被拒绝: ${JSON.stringify(args)}`);
  return result.issues;
};

test("14 个工具全部注册，tier 分布为 4 只读 / 9 动作 / 1 安全控制", () => {
  assert.equal(TOOL_NAMES.length, 14);
  assert.equal(new Set(TOOL_NAMES).size, 14);
  const tiers = summarizeToolTiers();
  assert.equal(tiers.read_only.length, 4);
  assert.equal(tiers.t1_input.length, 9);
  assert.equal(tiers.safety_control.length, 1);
  for (const name of TOOL_NAMES) {
    assert.equal(isKnownTool(name), true);
    assert.equal(typeof TOOL_HANDLERS[name], "function", `${name} 缺 handler`);
  }
  assert.deepEqual([...STOP_EXEMPT_TOOLS], ["request_access", "stop_computer_control"]);
});

test("未知 tool fail closed", () => {
  assert.equal(isKnownTool("open_application"), false, "open_application 已整体移除");
  assert.throws(() => resolveTool("open_application"), /unknown Computer Use tool/);
  assert.throws(() => resolveTool(""), /tool name must be a non-empty string/);
});

test("顶层对象 strict：未知键一律拒绝", () => {
  for (const tool of TOOL_NAMES) {
    const issues = rejected(tool, { definitely_not_a_field: 1 });
    assert.ok(
      issues.some((issue) => issue.message === "unknown field"),
      `${tool} 未拒绝未知顶层键`,
    );
  }
  assert.deepEqual(ok("list_apps", {}), {});
  assert.deepEqual(ok("list_apps", undefined), {});
});

test("对外 JSON Schema 关闭 additionalProperties 且标注默认值", () => {
  const schemas = listToolSchemas();
  assert.equal(schemas.length, 14);
  for (const schema of schemas) {
    assert.equal(schema.inputSchema.type, "object");
    assert.equal(schema.inputSchema.additionalProperties, false);
  }
  const click = getToolDefinition("left_click").jsonSchema;
  assert.equal(click.properties.mouse_button.default, "left");
  assert.equal(click.properties.click_count.minimum, 1);
  assert.equal(click.properties.click_count.maximum, 3);
  assert.equal(
    getToolDefinition("get_app_state").jsonSchema.properties.tree_shown_to_model.default,
    true,
  );
  const descriptions = describeTools();
  assert.equal(descriptions.find((d) => d.name === "get_app_state").readOnlyHint, true);
  assert.equal(descriptions.find((d) => d.name === "paste").destructiveHint, true);
  assert.equal(descriptions.find((d) => d.name === "stop_computer_control").destructiveHint, false);
});

test("app_ref 是严格联合：字符串按 bundle id，对象要求 pid/bundle_id/name", () => {
  assert.deepEqual(ok("list_windows", { app_ref: "com.example.app" }).app_ref, {
    kind: "bundle_id",
    bundle_id: "com.example.app",
  });
  const object = ok("list_windows", {
    app_ref: { pid: 42, bundle_id: "com.example.app", name: "Example", window_id: "w-1" },
  });
  assert.equal(object.app_ref.window_id, "w-1");
  assert.ok(
    rejected("list_windows", { app_ref: { pid: 1, bundle_id: "b", name: "n", extra: true } })
      .length > 0,
  );
  assert.ok(rejected("list_windows", { app_ref: { pid: 1, bundle_id: "b" } }).length > 0);
  assert.ok(
    rejected("list_windows", { app_ref: { pid: 1, bundle_id: "b", name: "n", pid_alias: 2 } })
      .length > 0,
  );
  assert.ok(rejected("list_windows", { app_ref: "" }).length > 0);
  assert.ok(rejected("list_windows", { app_ref: 3 }).length > 0);
  assert.deepEqual(parseAppRef("com.example.app"), {
    ok: true,
    value: { kind: "bundle_id", bundle_id: "com.example.app" },
  });
});

test("target 是严格联合：element 不接受 frame_id，coordinate 坐标必须是非负整数", () => {
  assert.deepEqual(ok("left_click", { target: { type: "element", index: 0 } }).target, {
    type: "element",
    index: 0,
  });
  assert.deepEqual(
    ok("left_click", { target: { type: "coordinate", x: 3, y: 4, frame_id: "f-2" } }).target,
    { type: "coordinate", x: 3, y: 4, frame_id: "f-2" },
  );
  assert.ok(
    rejected("left_click", { target: { type: "element", index: 0, frame_id: "f-1" } }).length > 0,
  );
  assert.ok(rejected("left_click", { target: { type: "element", index: -1 } }).length > 0);
  assert.ok(rejected("left_click", { target: { type: "element", index: 1.5 } }).length > 0);
  assert.ok(
    rejected("left_click", { target: { type: "coordinate", x: 1, y: 2, z: 3 } }).length > 0,
  );
  assert.ok(
    rejected("left_click", { target: { type: "element", index: 0, token: "secret" } }).length > 0,
  );
  const mismatched = parseTarget({ type: "coordinate", index: 1 });
  assert.equal(mismatched.ok, false, "coordinate 分支不接受 index 键");
  assert.equal(parseTarget({ type: "element", index: 0, x: 1 }).ok, false);
});

test("click / scroll / key 的默认值与边界", () => {
  const click = ok("left_click", { target: { type: "element", index: 1 } });
  assert.equal(click.mouse_button, "left");
  assert.equal(click.click_count, 1);
  assert.deepEqual(click.modifiers, []);
  assert.equal(click.strategy, "auto");
  assert.equal(click.return_state, "none");
  assert.ok(
    rejected("left_click", { target: { type: "element", index: 1 }, click_count: 4 }).length > 0,
  );
  assert.ok(
    rejected("left_click", { target: { type: "element", index: 1 }, click_count: 0 }).length > 0,
  );
  assert.ok(
    rejected("left_click", { target: { type: "element", index: 1 }, modifiers: ["hyper"] }).length >
      0,
  );

  const scrolled = ok("scroll", {
    target: { type: "coordinate", x: 1, y: 1 },
    scroll_direction: "up",
    scroll_amount: 900,
  });
  assert.equal(scrolled.scroll_amount, 100, "scroll amount clamp 到 100");
  assert.ok(
    rejected("scroll", {
      target: { type: "element", index: 0 },
      scroll_direction: "sideways",
      scroll_amount: 1,
    }).length > 0,
  );
  assert.ok(
    rejected("scroll", { target: { type: "element", index: 0 }, scroll_amount: 1 }).length > 0,
  );

  const keyArgs = ok("key", { text: "a", repeat: 5000 });
  assert.equal(keyArgs.repeat, 100, "repeat clamp 到 100");
  assert.equal(keyArgs.hold_seconds, 0);
  assert.ok(rejected("key", { text: "a", hold_seconds: -1 }).length > 0);
  assert.ok(rejected("key", { text: "a", hold_seconds: 31 }).length > 0);
  assert.ok(rejected("key", { text: "a", repeat: -1 }).length > 0);
  assert.ok(rejected("key", { text: "" }).length > 0);
});

test("drag 无 strategy 字段，type/set_value 空串合法，select_text 需要两个非负整数", () => {
  const drag = ok("left_click_drag", {
    from_target: { type: "element", index: 0 },
    to: { type: "coordinate", x: 5, y: 6 },
  });
  assert.equal(drag.strategy, undefined);
  assert.ok(
    rejected("left_click_drag", {
      from_target: { type: "element", index: 0 },
      to: { type: "coordinate", x: 5, y: 6 },
      strategy: "auto",
    }).length > 0,
  );

  assert.equal(ok("type", { text: "" }).text, "");
  assert.equal(ok("set_value", { target: { type: "element", index: 0 }, value: "" }).value, "");
  assert.equal(ok("select_text", { target: { type: "element", index: 0 } }).text_range, undefined);
  assert.deepEqual(
    ok("select_text", { target: { type: "element", index: 0 }, text_range: [2, 3] }).text_range,
    [2, 3],
  );
  assert.ok(
    rejected("select_text", { target: { type: "element", index: 0 }, text_range: [1] }).length > 0,
  );
  assert.ok(
    rejected("select_text", { target: { type: "element", index: 0 }, text_range: [-1, 2] }).length >
      0,
  );

  assert.equal(ok("paste", { text: "hi" }).format, "text");
  assert.ok(rejected("paste", { text: "hi", format: "rtf" }).length > 0);
  assert.ok(rejected("perform_action", { target: { type: "element", index: 0 } }).length > 0);
  assert.ok(rejected("request_access", { capabilities: ["teleport"] }).length > 0);
  assert.ok(rejected("stop_computer_control", { reason: 5 }).length > 0);
});

test("get_app_state 的三个布尔默认与内部字段", () => {
  const state = ok("get_app_state", { app_ref: "com.example.app" });
  assert.equal(state.include_screenshot, false);
  assert.equal(state.disable_diffing, false);
  assert.equal(state.tree_shown_to_model, true);
  assert.deepEqual(
    ok("get_app_state", {
      app_ref: "com.example.app",
      include_screenshot: true,
      disable_diffing: true,
      tree_shown_to_model: false,
    }),
    {
      app_ref: { kind: "bundle_id", bundle_id: "com.example.app" },
      include_screenshot: true,
      disable_diffing: true,
      tree_shown_to_model: false,
    },
    "handler 收到的 app_ref 已归一为对象形状",
  );
  assert.ok(
    rejected("get_app_state", { app_ref: "com.example.app", include_screenshot: "yes" }).length > 0,
  );
});

test("校验器组合子：strict object、整数 clamp、union 报错信息", () => {
  const schema = strictObject({
    count: { schema: integer({ min: 0, max: 10, clamp: true }), default: 0 },
    label: { schema: string({ minLength: 1 }), required: true },
    tags: arrayOf(string(), { maxItems: 2 }),
    either: union([string({ minLength: 2 }), integer({ min: 5 })]),
  });
  const good = validate(schema, { label: "ok", tags: ["a"], either: 6, count: 99 });
  assert.equal(good.ok, true);
  assert.equal(good.value.count, 10);
  const bad = validate(schema, { label: "", extra: 1, tags: ["a", "b", "c"], either: "x" });
  assert.equal(bad.ok, false);
  assert.ok(bad.issues.length >= 4);
  assert.equal(schema(undefined, "$", []), FAIL);
});

test("严格 JSON 解析器拒绝重复键、尾随内容与未转义换行", () => {
  assert.deepEqual(parseStrictJson('{"a":1,"b":[true,null,-2.5e3]}'), {
    a: 1,
    b: [true, null, -2500],
  });
  for (const bad of [
    '{"a":1,"a":2}',
    '{"a":1} trailing',
    '{"a":"line\nbreak"}',
    "{'a':1}",
    '{"a":01}',
    '{"a":}',
  ]) {
    assert.throws(() => parseStrictJson(bad), StrictJsonError, `${bad} 应被拒绝`);
  }
  assert.equal(parseStrictJson('{"a":"\\u0041"}').a, "A");
  assert.throws(() => parseStrictJson(""), StrictJsonError);
  assert.throws(() => parseStrictJson(undefined), StrictJsonError);
});
