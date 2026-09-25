/**
 * 每个 session 的 observation state 存储。
 *
 * state id 是单调的 `s-N`；缓存上限 8，淘汰即失效。producer 自己算
 * full / delta / no_change，Helper 只返回结构事实，不维护第二份 diff 状态。
 */

import { createHash } from "node:crypto";

import { CuaProtocolError } from "../protocol/errors.js";
import { MAX_ELEMENT_TREE_ENTRIES, MAX_STATES_PER_SESSION } from "../protocol/limits.js";

/** 只有这些结构字段参与 digest：element token 之类的 native 句柄永不进入摘要。 */
const DIGEST_FIELDS = Object.freeze(["index", "role", "title", "value", "enabled", "frame"]);

const isPlainObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * 稳定的结构摘要。字段顺序固定，未知字段不参与，因此 Helper 扩展字段不会
 * 伪造出一次假的 state 变化。
 *
 * @param {unknown[]} elements
 * @returns {string}
 */
export function structureDigest(elements) {
  const hash = createHash("sha256");
  for (const raw of elements) {
    const element = isPlainObject(raw) ? raw : {};
    const parts = DIGEST_FIELDS.map((field) => {
      const value = element[field];
      return `${field}=${typeof value === "string" ? value : JSON.stringify(value ?? null)}`;
    });
    hash.update(`${parts.join("")}`);
  }
  return hash.digest("hex").slice(0, 32);
}

/**
 * 效果指纹只覆盖用户可见内容（role / title / value），结构变化但内容不变时
 * 仍然报 unchanged，避免把重排误报成动作生效。
 *
 * @param {unknown[]} elements
 * @returns {string}
 */
export function effectFingerprint(elements) {
  const hash = createHash("sha256");
  for (const raw of elements) {
    const element = isPlainObject(raw) ? raw : {};
    hash.update(
      [element.index ?? null, element.role ?? null, element.title ?? null, element.value ?? null]
        .map((part) => JSON.stringify(part ?? null))
        .join("") + "",
    );
  }
  return hash.digest("hex").slice(0, 32);
}

/**
 * @param {unknown[]} elements
 */
function assertBoundedElements(elements) {
  if (elements.length > MAX_ELEMENT_TREE_ENTRIES) {
    throw new CuaProtocolError(
      "invalid_request",
      `element tree exceeds ${MAX_ELEMENT_TREE_ENTRIES} entries`,
      { details: { count: elements.length } },
    );
  }
}

/**
 * @param {{now?: () => number, maxEntries?: number}} [options]
 */
export function createStateStore(options = {}) {
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? MAX_STATES_PER_SESSION;
  /** @type {Map<string, Record<string, unknown>>} */
  const states = new Map();
  let counter = 0;

  const touch = (stateId) => {
    const state = states.get(stateId);
    if (state) {
      states.delete(stateId);
      states.set(stateId, state);
    }
    return state;
  };

  /**
   * 提交一次观察。返回新 state 以及被 LRU 淘汰的 state id。
   *
   * @param {{elements?: unknown[], epoch?: unknown, app?: unknown, structure_digest?: unknown}} snapshot
   */
  const commit = (snapshot) => {
    if (!isPlainObject(snapshot)) {
      throw new CuaProtocolError("invalid_request", "observation snapshot must be an object");
    }
    const elements = Array.isArray(snapshot.elements) ? snapshot.elements : [];
    assertBoundedElements(elements);
    counter += 1;
    const stateId = `s-${counter}`;
    const state = {
      stateId,
      app: snapshot.app ?? null,
      epoch: snapshot.epoch ?? null,
      elements,
      structureDigest: structureDigest(elements),
      capturedAt: now(),
    };
    states.set(stateId, state);
    /** @type {string[]} */
    const evicted = [];
    while (states.size > maxEntries) {
      const oldest = states.keys().next();
      if (oldest.done) break;
      states.delete(oldest.value);
      evicted.push(oldest.value);
    }
    return { stateId, state, evicted };
  };

  /**
   * 相对上一个 state 的变化分类。`disable_diffing` 或没有前一个 state 时强制 full。
   *
   * @param {{elements: unknown[]}} state
   * @param {{disableDiffing?: boolean}} [options]
   */
  const classify = (state, options = {}) => {
    // 基线必须是「这个 state 之前的那一个」，不是最新 state：classify 的入参就是刚提交
    // 的那次观察，用 latest() 会自己跟自己比，永远得到 full。
    const previous = stateBefore(state.stateId);
    if (options.disableDiffing || !previous) {
      return { kind: /** @type {"full"} */ ("full"), added: [], removed: [], changed: [] };
    }
    const diff = diffElements(previous.elements, state.elements);
    return diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0
      ? { kind: /** @type {"no_change"} */ ("no_change"), added: [], removed: [], changed: [] }
      : { kind: /** @type {"delta"} */ ("delta"), ...diff };
  };

  /**
   * @param {string} [stateId]
   * @returns {Record<string, unknown> | undefined}
   */
  const get = (stateId) => (stateId ? touch(stateId) : undefined);

  /** LRU 顺序里紧挨在给定 state 之前的那个 state；没有则返回 undefined。 */
  const stateBefore = (stateId) => {
    let previous;
    for (const [candidateId, candidate] of states) {
      if (candidateId === stateId) return previous;
      previous = candidate;
    }
    return previous;
  };

  const latest = () => {
    let last;
    for (const state of states.values()) last = state;
    return last;
  };

  const list = () => [...states.values()];

  /** 按 LRU 顺序取当前最旧的 state id（测试与诊断用）。 */
  const oldestId = () => states.keys().next().value;

  const clear = () => states.clear();

  return {
    commit,
    classify,
    get,
    latest,
    list,
    oldestId,
    clear,
    get size() {
      return states.size;
    },
  };
}

/**
 * 元素差集。身份键用 index + role（不含 native token，也不含 value）；value/title 的变化
 * 归为 changed，文本变化不会被投影成「删一条加一条」。
 *
 * @param {unknown[]} before
 * @param {unknown[]} after
 */
export function diffElements(before, after) {
  const keyOf = (raw) => {
    const element = isPlainObject(raw) ? raw : {};
    // 身份键只用 index + role：value/title 变化属于 changed，不能退化成 added+removed，
    // 否则任何文本变化都会让模型看到「删一条又加一条」。
    return JSON.stringify([element.index ?? null, element.role ?? null]);
  };
  const beforeKeys = new Map(before.map((element) => [keyOf(element), element]));
  const afterKeys = new Map(after.map((element) => [keyOf(element), element]));
  const added = [];
  const changed = [];
  for (const [key, element] of afterKeys) {
    if (!beforeKeys.has(key)) added.push(element);
    else if (structureDigest([beforeKeys.get(key)]) !== structureDigest([element]))
      changed.push(element);
  }
  const removed = [...beforeKeys.values()].filter((element) => !afterKeys.has(keyOf(element)));
  return { added, removed, changed };
}
