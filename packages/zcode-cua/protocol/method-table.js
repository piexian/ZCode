/**
 * Helper broker 方法表。
 *
 * 42 个业务方法是版本协商契约的一部分，producer 不增不减地按名字调用；`authenticate`
 * 与 `ping` 是握手方法，不计入 42。tier 决定 fail closed 时的行为与提示，read-only
 * 决定该方法是否可以绕过 stop 后的熔断（实际豁免仍以 stop_computer_control 为准）。
 */

export const BROKER_ROLES = Object.freeze(["host", "tool", "presentation"]);
export const HANDSHAKE_METHODS = Object.freeze(["authenticate", "ping"]);

export const METHOD_TIERS = Object.freeze({
  INFO: "info",
  CONTROL: "control",
  PERMISSION: "permission",
  OBSERVE: "observe",
  ELEMENT: "element",
  INPUT: "input",
  CLIPBOARD: "clipboard",
  FOCUS: "focus",
  PIP: "pip",
});

/** @type {readonly {name: string, tier: string, readOnly: boolean, roles: readonly string[], windows: string}[]} */
const METHODS = Object.freeze([
  // info / diagnostics
  {
    name: "broker_info",
    tier: METHOD_TIERS.INFO,
    readOnly: true,
    roles: ["host", "tool", "presentation"],
    windows: "supported",
  },
  {
    name: "controller_status",
    tier: METHOD_TIERS.CONTROL,
    readOnly: true,
    roles: ["host"],
    windows: "supported",
  },
  {
    name: "controller_takeover",
    tier: METHOD_TIERS.CONTROL,
    readOnly: false,
    roles: ["host"],
    windows: "supported",
  },
  {
    name: "controller_stop",
    tier: METHOD_TIERS.CONTROL,
    readOnly: false,
    roles: ["host"],
    windows: "supported",
  },
  // permission：Windows 只读报告，不弹窗、不改授权
  {
    name: "request_access",
    tier: METHOD_TIERS.PERMISSION,
    readOnly: true,
    roles: ["host", "tool"],
    windows: "read_only_report",
  },
  {
    name: "permission_status",
    tier: METHOD_TIERS.PERMISSION,
    readOnly: true,
    roles: ["host", "tool"],
    windows: "read_only_report",
  },
  {
    name: "input_permission_status",
    tier: METHOD_TIERS.PERMISSION,
    readOnly: true,
    roles: ["host", "tool"],
    windows: "read_only_report",
  },
  {
    name: "screen_capture_status",
    tier: METHOD_TIERS.PERMISSION,
    readOnly: true,
    roles: ["host", "tool"],
    windows: "probe_required",
  },
  {
    name: "screen_capture_probe",
    tier: METHOD_TIERS.PERMISSION,
    readOnly: true,
    roles: ["host", "tool"],
    windows: "probe_required",
  },
  {
    name: "supports_accessibility",
    tier: METHOD_TIERS.PERMISSION,
    readOnly: true,
    roles: ["host", "tool"],
    windows: "probe_required",
  },
  // observation
  {
    name: "list_applications",
    tier: METHOD_TIERS.OBSERVE,
    readOnly: true,
    roles: ["host", "tool"],
    windows: "supported",
  },
  {
    name: "application_info",
    tier: METHOD_TIERS.OBSERVE,
    readOnly: true,
    roles: ["host", "tool"],
    windows: "supported",
  },
  {
    name: "list_windows",
    tier: METHOD_TIERS.OBSERVE,
    readOnly: true,
    roles: ["host", "tool"],
    windows: "supported",
  },
  {
    name: "capture_app",
    tier: METHOD_TIERS.OBSERVE,
    readOnly: true,
    roles: ["host", "tool"],
    windows: "supported",
  },
  {
    name: "element_at_point",
    tier: METHOD_TIERS.OBSERVE,
    readOnly: true,
    roles: ["host", "tool"],
    windows: "supported",
  },
  {
    name: "read_element",
    tier: METHOD_TIERS.OBSERVE,
    readOnly: true,
    roles: ["host", "tool"],
    windows: "supported",
  },
  // element action
  {
    name: "element_press",
    tier: METHOD_TIERS.ELEMENT,
    readOnly: false,
    roles: ["host", "tool"],
    windows: "supported",
  },
  {
    name: "element_show_menu",
    tier: METHOD_TIERS.ELEMENT,
    readOnly: false,
    roles: ["host", "tool"],
    windows: "supported",
  },
  {
    name: "element_focus",
    tier: METHOD_TIERS.ELEMENT,
    readOnly: false,
    roles: ["host", "tool"],
    windows: "supported",
  },
  {
    name: "element_set_value",
    tier: METHOD_TIERS.ELEMENT,
    readOnly: false,
    roles: ["host", "tool"],
    windows: "supported",
  },
  {
    name: "element_perform_action",
    tier: METHOD_TIERS.ELEMENT,
    readOnly: false,
    roles: ["host", "tool"],
    windows: "supported",
  },
  {
    name: "element_select_text",
    tier: METHOD_TIERS.ELEMENT,
    readOnly: false,
    roles: ["host", "tool"],
    windows: "supported",
  },
  // pointer / keyboard
  {
    name: "click",
    tier: METHOD_TIERS.INPUT,
    readOnly: false,
    roles: ["host", "tool"],
    windows: "foreground_required",
  },
  {
    name: "scroll",
    tier: METHOD_TIERS.INPUT,
    readOnly: false,
    roles: ["host", "tool"],
    windows: "foreground_required",
  },
  {
    name: "drag",
    tier: METHOD_TIERS.INPUT,
    readOnly: false,
    roles: ["host", "tool"],
    windows: "foreground_required",
  },
  {
    name: "type_text",
    tier: METHOD_TIERS.INPUT,
    readOnly: false,
    roles: ["host", "tool"],
    windows: "foreground_required",
  },
  {
    name: "type_text_to_app",
    tier: METHOD_TIERS.INPUT,
    readOnly: false,
    roles: ["host", "tool"],
    windows: "foreground_required",
  },
  {
    name: "press_key",
    tier: METHOD_TIERS.INPUT,
    readOnly: false,
    roles: ["host", "tool"],
    windows: "foreground_required",
  },
  {
    name: "press_key_to_app",
    tier: METHOD_TIERS.INPUT,
    readOnly: false,
    roles: ["host", "tool"],
    windows: "foreground_required",
  },
  {
    name: "hold_key",
    tier: METHOD_TIERS.INPUT,
    readOnly: false,
    roles: ["host", "tool"],
    windows: "foreground_required",
  },
  {
    name: "hold_key_to_app",
    tier: METHOD_TIERS.INPUT,
    readOnly: false,
    roles: ["host", "tool"],
    windows: "foreground_required",
  },
  {
    name: "cancel_input_holds",
    tier: METHOD_TIERS.INPUT,
    readOnly: true,
    roles: ["host", "tool"],
    windows: "supported",
  },
  // clipboard
  {
    name: "paste",
    tier: METHOD_TIERS.CLIPBOARD,
    readOnly: false,
    roles: ["host", "tool"],
    windows: "supported",
  },
  // focus steal prevention：macOS 专属
  {
    name: "prevent_activation",
    tier: METHOD_TIERS.FOCUS,
    readOnly: true,
    roles: ["host", "tool"],
    windows: "unimplemented",
  },
  {
    name: "reenable_activation",
    tier: METHOD_TIERS.FOCUS,
    readOnly: true,
    roles: ["host", "tool"],
    windows: "unimplemented",
  },
  {
    name: "is_focus_steal_prevented",
    tier: METHOD_TIERS.FOCUS,
    readOnly: true,
    roles: ["host", "tool"],
    windows: "unimplemented",
  },
  // PiP：presentation role 专属，Windows 全部 unimplemented
  {
    name: "pip_start",
    tier: METHOD_TIERS.PIP,
    readOnly: false,
    roles: ["presentation"],
    windows: "unimplemented",
  },
  {
    name: "pip_stop",
    tier: METHOD_TIERS.PIP,
    readOnly: false,
    roles: ["presentation"],
    windows: "unimplemented",
  },
  {
    name: "pip_is_running",
    tier: METHOD_TIERS.PIP,
    readOnly: true,
    roles: ["presentation"],
    windows: "unimplemented",
  },
  {
    name: "pip_clear_dismissed",
    tier: METHOD_TIERS.PIP,
    readOnly: false,
    roles: ["presentation"],
    windows: "unimplemented",
  },
  {
    name: "pip_session_handshake",
    tier: METHOD_TIERS.PIP,
    readOnly: false,
    roles: ["presentation"],
    windows: "unimplemented",
  },
  {
    name: "pip_session_event",
    tier: METHOD_TIERS.PIP,
    readOnly: false,
    roles: ["presentation"],
    windows: "unimplemented",
  },
]);

/** 42 个业务方法的规格顺序表。 */
export const BROKER_METHODS = Object.freeze(METHODS.map((method) => Object.freeze({ ...method })));

/** 全部可调用方法名（含 authenticate / ping）。 */
export const ALL_BROKER_METHODS = Object.freeze([
  ...HANDSHAKE_METHODS,
  ...BROKER_METHODS.map((method) => method.name),
]);

const BY_NAME = new Map(METHODS.map((method) => [method.name, method]));

/** @param {string} name */
export function isBrokerMethod(name) {
  return BY_NAME.has(name);
}

/** @param {string} name */
export function isHandshakeMethod(name) {
  return HANDSHAKE_METHODS.includes(name);
}

/** @param {string} name */
export function describeBrokerMethod(name) {
  return BY_NAME.get(name);
}

/** 不改变桌面状态的方法。 */
export function isReadOnlyBrokerMethod(name) {
  return BY_NAME.get(name)?.readOnly === true;
}

/** @param {string} name @param {string} role */
export function isMethodAllowedForRole(name, role) {
  const method = BY_NAME.get(name);
  if (!method) return false;
  return method.roles.includes(role);
}

/** Windows 上按契约返回 unimplemented 的方法。 */
export function isWindowsUnimplementedMethod(name) {
  return BY_NAME.get(name)?.windows === "unimplemented";
}
