/**
 * 工具注册表：协议 schema 与 handler 的唯一装配点。
 *
 * 注册表是 tool 名称、tier、strict schema 与 handler 的唯一所有者；
 * runtime 只通过 `resolveTool` 拿 handler，未知工具在这里 fail closed。
 */

import { CuaProtocolError } from "../protocol/errors.js";
import { TOOL_DEFINITIONS, TOOL_TIERS, getToolDefinition } from "../protocol/tool-schemas.js";
import { actionToolHandlers } from "./action-tools.js";
import { readToolHandlers } from "./read-tools.js";

/** 14 个工具的 handler 表。 */
export const TOOL_HANDLERS = Object.freeze({ ...readToolHandlers, ...actionToolHandlers });

/**
 * 解析工具。未知工具、`tier` 与实现不匹配、或缺 handler 都在这里 fail closed，
 * 不会走到任何桌面路径。
 *
 * @param {string} name
 * @returns {{name: string, tier: string, definition: Record<string, any>, handler: (input: any) => Promise<{text: string, structuredContent?: unknown}>}}
 */
export function resolveTool(name) {
  if (typeof name !== "string" || name.length === 0) {
    throw new CuaProtocolError("unknown_tool", "tool name must be a non-empty string");
  }
  const definition = getToolDefinition(name);
  if (!definition) {
    throw new CuaProtocolError("unknown_tool", `unknown Computer Use tool: ${name}`);
  }
  const handler = TOOL_HANDLERS[name];
  if (typeof handler !== "function") {
    throw new CuaProtocolError("unknown_tool", `tool ${name} has no handler in this build`);
  }
  const expectedMutating = definition.tier === TOOL_TIERS.T1_INPUT;
  if (expectedMutating !== definition.mutating) {
    throw new CuaProtocolError("internal", `tool ${name} tier metadata is inconsistent`);
  }
  return { name, tier: definition.tier, definition, handler };
}

/** 工具名清单，注册表与协议层必须一致。 */
export function listToolNames() {
  return TOOL_DEFINITIONS.map((tool) => tool.name);
}

/** 对外发布的工具描述（schema + annotation），不含 handler。 */
export function describeTools() {
  return TOOL_DEFINITIONS.map((tool) => ({
    name: tool.name,
    tier: tool.tier,
    description: tool.description,
    stopExempt: tool.stopExempt,
    readOnlyHint: tool.tier === TOOL_TIERS.READ_ONLY || tool.tier === TOOL_TIERS.SAFETY_CONTROL,
    destructiveHint: tool.mutating,
    inputSchema: tool.jsonSchema,
  }));
}
