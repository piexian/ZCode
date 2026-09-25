/**
 * 9 个动作类工具的 handler。
 *
 * 本切片不做真实桌面动作：所有工具共用同一条链路——strict 校验（已在上游完成）、
 * target/frame 预检、effect 基线、receipt 分类，再把方法帧交给注入的 broker。
 * 预检失败一律 not_sent，请求不会越过管道。
 */

import { CuaProtocolError } from "../protocol/errors.js";
import { acceptedReceipt, notSentReceipt } from "../runtime/receipt.js";
import { effectFingerprint } from "../runtime/state-store.js";
import { commitObservation } from "./observation.js";

/**
 * target 预检。element 下标必须落在最近一次观察里；坐标必须落在仍然 actionable 的
 * raster 内。两者都不成立时抛 not_sent 类错误。
 *
 * @param {Record<string, any>} session
 * @param {{type: string, index?: number, x?: number, y?: number, frame_id?: string}|undefined} target
 * @returns {{verification: "matched"|"unavailable", element?: Record<string, unknown>, frame?: Record<string, any>}}
 */
export function precheckTarget(session, target) {
  if (!target) return { verification: /** @type {const} */ ("unavailable") };
  if (target.type === "element") {
    const state = session.states.latest();
    const element = (state?.elements ?? []).find((entry) => entry?.index === target.index);
    if (!element) {
      throw new CuaProtocolError(
        "target_not_observed",
        `element index ${target.index} is not part of the latest observation; observe the app again`,
        { details: { index: target.index } },
      );
    }
    return { verification: /** @type {const} */ ("matched"), element };
  }
  const latest = session.frames.latestActionable();
  const frameId = target.frame_id ?? latest?.frameId;
  if (!frameId) {
    throw new CuaProtocolError("frame_expired", "no actionable frame; observe the app again");
  }
  const frame = session.frames.requireActionable(frameId, { x: target.x ?? 0, y: target.y ?? 0 });
  return { verification: /** @type {const} */ ("matched"), frame };
}

/**
 * 坐标目标投影成 Helper 侧的 point + native frame handle。producer 不重签 handle，
 * Helper 收到 handle 后重新投影并复核拓扑。
 *
 * @param {{frame?: Record<string, any>}} resolved
 * @param {{x?: number, y?: number}|undefined} target
 */
function pointFor(resolved, target) {
  if (!resolved.frame) return undefined;
  return { x: target?.x, y: target?.y, frame_handle: resolved.frame.handle };
}

/** 动作前记录效果指纹，供 return_state=none 的下一次观察比较。 */
function captureBaseline(session) {
  const state = session.states.latest();
  return state ? effectFingerprint(state.elements) : undefined;
}

/**
 * 动作后的观察：只有 return_state != none 才做，effect 证据同时在这里结算。
 *
 * @param {Record<string, any>} session
 * @param {unknown} appRef
 * @param {{call: (m: string, p?: unknown) => Promise<any>}} broker
 * @param {number} now
 */
async function observeAfterAction(session, appRef, broker, now) {
  const raw = await broker.call("capture_app", {
    app: appRef,
    include_screenshot: false,
    force_full: false,
  });
  return commitObservation({ session, raw, treeShownToModel: true, disableDiffing: false, now });
}

/**
 * 统一动作执行器。
 *
 * @param {{
 *   name: string,
 *   isNoOp?: (args: Record<string, any>) => string | undefined,
 *   precheck?: (args: Record<string, any>, session: Record<string, any>) => void,
 *   buildRequest: (
 *     args: Record<string, any>,
 *     context: {element?: Record<string, unknown>, elementIndex?: number, point?: any, extra?: Record<string, unknown>},
 *   ) => {method: string, params: Record<string, unknown>},
 *   hold?: (args: Record<string, any>, session: Record<string, any>) => Record<string, any>,
 * }} spec
 */
function createActionHandler(spec) {
  return async (input) => {
    const { args, session, broker, now } = input;
    const primary = precheckTarget(session, args.target ?? args.from_target);
    const extra = spec.precheck?.(args, session) ?? {};

    const noOpReason = spec.isNoOp?.(args);
    if (noOpReason) {
      return {
        text: `${spec.name} is a no-op: ${noOpReason}`,
        structuredContent: {
          schema_version: "zcode-cua-action-v1",
          no_op: true,
          reason: noOpReason,
          action_receipt: notSentReceipt({ code: "action_unavailable", message: noOpReason }),
        },
      };
    }

    const baseline = captureBaseline(session);
    const hold = spec.hold?.(args, session);
    const request = spec.buildRequest(args, {
      element: primary.element,
      elementIndex: primary.element?.index,
      point: pointFor(primary, args.target ?? args.from_target),
      extra,
    });

    let dispatched;
    try {
      dispatched = await broker.call(request.method, request.params);
    } catch (error) {
      // 请求没被 Helper 接受时本地 hold 立即释放，不留悬挂状态。
      if (hold) session.holds.releaseHold(hold.id);
      throw error;
    }

    let observation;
    let receipt = acceptedReceipt({ targetVerificationStatus: primary.verification });
    if (args.return_state !== "none") {
      observation = await observeAfterAction(session, args.app_ref ?? dispatched?.app, broker, now);
      receipt = acceptedReceipt({
        targetVerificationStatus: primary.verification,
        effectEvidence: observation.effect_evidence,
      });
    } else if (baseline !== undefined) {
      // 动作后不观察：把基线留给下一次 get_app_state 结算 effect 证据。
      session.effectBaseline = { fingerprint: baseline, resolved: false };
    }

    return {
      text: [
        `${spec.name} dispatched: ${receipt.dispatch_status}`,
        `action_sent=${receipt.action_sent} effect_evidence=${receipt.effect_evidence}`,
        observation
          ? `state ${observation.state_id} (${observation.kind})`
          : "effect evidence pending next observation",
      ].join("\n"),
      structuredContent: {
        schema_version: "zcode-cua-action-v1",
        no_op: false,
        action_receipt: receipt,
        ...(observation ? { observation } : {}),
      },
    };
  };
}

const appScoped = (args) => args.app_ref !== undefined && args.app_ref !== null;

const leftClick = createActionHandler({
  name: "left_click",
  buildRequest: (args, context) =>
    context.elementIndex !== undefined
      ? {
          method: "element_perform_action",
          params: { app: args.app_ref, element_index: context.elementIndex, action: "press" },
        }
      : {
          method: "click",
          params: {
            app: args.app_ref,
            point: context.point,
            mouse_button: args.mouse_button,
            click_count: args.click_count,
            modifiers: args.modifiers,
          },
        },
});

const scroll = createActionHandler({
  name: "scroll",
  isNoOp: (args) => (args.scroll_amount === 0 ? "scroll_amount is 0" : undefined),
  buildRequest: (args, context) => ({
    method: "scroll",
    params: {
      app: args.app_ref,
      element_index: context.elementIndex,
      point: context.point,
      scroll_direction: args.scroll_direction,
      scroll_amount: args.scroll_amount,
    },
  }),
});

const leftClickDrag = createActionHandler({
  name: "left_click_drag",
  precheck: (args, session) => {
    const to = precheckTarget(session, args.to);
    return { to: { point: pointFor(to, args.to), elementIndex: to.element?.index } };
  },
  buildRequest: (args, context) => ({
    method: "drag",
    params: {
      app: args.app_ref,
      from: { element_index: context.elementIndex, point: context.point },
      to: context.extra.to,
      modifiers: args.modifiers,
    },
  }),
});

const typeText = createActionHandler({
  name: "type",
  isNoOp: (args) => (args.text.length === 0 ? "text is empty" : undefined),
  buildRequest: (args, context) =>
    context.elementIndex !== undefined
      ? {
          method: "element_set_value",
          params: { app: args.app_ref, element_index: context.elementIndex, value: args.text },
        }
      : {
          method: appScoped(args) ? "type_text_to_app" : "type_text",
          params: { app: args.app_ref, text: args.text },
        },
});

const setValue = createActionHandler({
  name: "set_value",
  buildRequest: (args, context) => ({
    method: "element_set_value",
    params: { app: args.app_ref, element_index: context.elementIndex, value: args.value },
  }),
});

const selectText = createActionHandler({
  name: "select_text",
  buildRequest: (args, context) => ({
    method: "element_select_text",
    params: {
      app: args.app_ref,
      element_index: context.elementIndex,
      ...(args.text_range ? { text_range: args.text_range } : {}),
    },
  }),
});

const key = createActionHandler({
  name: "key",
  isNoOp: (args) => (args.repeat === 0 ? "repeat is 0" : undefined),
  buildRequest: (args) => {
    const scoped = appScoped(args);
    const method =
      args.hold_seconds > 0
        ? scoped
          ? "hold_key_to_app"
          : "hold_key"
        : scoped
          ? "press_key_to_app"
          : "press_key";
    return {
      method,
      params:
        args.hold_seconds > 0
          ? {
              app: args.app_ref,
              key: args.text,
              hold_seconds: args.hold_seconds,
              repeat: args.repeat,
            }
          : { app: args.app_ref, key: args.text, repeat: args.repeat },
    };
  },
  hold: (args, session) =>
    args.hold_seconds > 0
      ? session.holds.hold({
          sessionKey: session.sessionKey,
          kind: "key",
          keys: [args.text],
          seconds: args.hold_seconds,
        })
      : undefined,
});

const performAction = createActionHandler({
  name: "perform_action",
  // action 必须来自目标元素当前的 actions 列表；这不是 no-op，是明确的拒绝。
  precheck: (args, session) => {
    const element = precheckTarget(session, args.target).element;
    const actions = Array.isArray(element?.actions) ? element.actions : [];
    if (!actions.includes(args.action)) {
      throw new CuaProtocolError(
        "action_unavailable",
        `action ${args.action} is not advertised by the target`,
        {
          details: { available: actions },
        },
      );
    }
    return {};
  },
  buildRequest: (args, context) => ({
    method: "element_perform_action",
    params: { app: args.app_ref, element_index: context.elementIndex, action: args.action },
  }),
});

const paste = createActionHandler({
  name: "paste",
  buildRequest: (args) => ({
    method: "paste",
    params: { app: args.app_ref, text: args.text, format: args.format },
  }),
});

export const actionToolHandlers = Object.freeze({
  left_click: leftClick,
  scroll,
  left_click_drag: leftClickDrag,
  type: typeText,
  set_value: setValue,
  select_text: selectText,
  key,
  perform_action: performAction,
  paste,
});

export { createActionHandler, captureBaseline, observeAfterAction };
