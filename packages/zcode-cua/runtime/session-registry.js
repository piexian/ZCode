/**
 * 进程级 session 分区。
 *
 * 一个 node_repl host 进程只有一个 runtime 对象；state、frame、kill switch、
 * hold 与待决效果基线都按 sessionKey 隔离。上限 128，淘汰即调用 `closeSession`，
 * 不能让一个长会话的桌面状态泄漏到下一个 workspace。
 */

import { CuaProtocolError } from "../protocol/errors.js";
import { MAX_SESSION_ENTRIES } from "../protocol/limits.js";
import { createFrameStore } from "./frame-store.js";
import { createInputHoldRegistry } from "./input-holds.js";
import { createKillSwitch } from "./kill-switch.js";
import { createStateStore } from "./state-store.js";

/**
 * sessionKey = workspaceKey + remoteSessionId + sessionId。
 *
 * workspaceKey 优先取 node_repl 已归一的 workspaceKey，回退到
 * `workspaceIdentity?.trim() || workspacePath`，与仓库其它地方的 identity 规则一致。
 *
 * @param {{workspaceKey?: string, workspaceIdentity?: string, workspacePath?: string, remoteSessionId?: string, sessionId?: string}} context
 * @returns {string}
 */
export function createSessionKey(context) {
  const workspaceKey = (
    context.workspaceKey ??
    context.workspaceIdentity?.trim() ??
    context.workspacePath ??
    ""
  ).trim();
  const sessionId = (context.sessionId ?? "").trim();
  if (!workspaceKey)
    throw new CuaProtocolError("invalid_request", "runtime context is missing workspaceKey");
  if (!sessionId)
    throw new CuaProtocolError("invalid_request", "runtime context is missing sessionId");
  const remoteSessionId = (context.remoteSessionId ?? "").trim();
  return [workspaceKey, remoteSessionId, sessionId]
    .map((part) => encodeURIComponent(part))
    .join("|");
}

/**
 * @param {{
 *   now?: () => number,
 *   maxEntries?: number,
 *   createSession?: (sessionKey: string) => Record<string, unknown>,
 *   closeSession?: (session: Record<string, unknown>) => void | Promise<void>,
 * }} [options]
 */
export function createSessionRegistry(options = {}) {
  const maxEntries = options.maxEntries ?? MAX_SESSION_ENTRIES;
  const now = options.now ?? Date.now;
  const build = options.createSession ?? ((sessionKey) => defaultSessionFactory(sessionKey, now));
  const close = options.closeSession ?? (() => {});
  /** @type {Map<string, {sessionKey: string, session: Record<string, unknown>, lastUsedAt: number}>} */
  const entries = new Map();
  /** @type {string[]} */
  const evicted = [];

  const evictIfNeeded = () => {
    while (entries.size > maxEntries) {
      const oldestKey = entries.keys().next();
      if (oldestKey.done) break;
      const entry = entries.get(oldestKey.value);
      entries.delete(oldestKey.value);
      if (entry) {
        evicted.push(entry.sessionKey);
        while (evicted.length > 32) evicted.shift();
        void close(entry.session);
      }
    }
  };

  /**
   * 取（必要时创建）一个 session，并刷新它的 LRU 位置。
   * @param {{workspaceKey?: string, workspaceIdentity?: string, workspacePath?: string, remoteSessionId?: string, sessionId?: string}} context
   */
  const acquire = (context) => {
    const sessionKey = createSessionKey(context);
    const existing = entries.get(sessionKey);
    if (existing) {
      existing.lastUsedAt = now();
      entries.delete(sessionKey);
      entries.set(sessionKey, existing);
      return existing.session;
    }
    const session = { sessionKey, ...build(sessionKey) };
    entries.set(sessionKey, { sessionKey, session, lastUsedAt: now() });
    evictIfNeeded();
    return session;
  };

  /**
   * 显式关闭一个 session 的桌面状态。
   * @param {{workspaceKey?: string, workspaceIdentity?: string, workspacePath?: string, remoteSessionId?: string, sessionId?: string}} context
   */
  const closeByContext = (context) => {
    const sessionKey = createSessionKey(context);
    const entry = entries.get(sessionKey);
    if (!entry) return false;
    entries.delete(sessionKey);
    void close(entry.session);
    return true;
  };

  const dispose = async () => {
    const all = [...entries.values()];
    entries.clear();
    for (const entry of all) await close(entry.session);
  };

  return {
    acquire,
    closeByContext,
    dispose,
    peek: (context) => {
      try {
        return entries.get(createSessionKey(context))?.session;
      } catch {
        return undefined;
      }
    },
    has: (context) => {
      try {
        return entries.has(createSessionKey(context));
      } catch {
        return false;
      }
    },
    size: () => entries.size,
    keys: () => [...entries.keys()],
    /** 调试与测试用：最近被 LRU 淘汰的 session key。 */
    evictedKeys: () => [...evicted],
  };
}

/**
 * session 私有的运行时状态；broker 连接由 runtime 单独挂载。
 *
 * @param {string} sessionKey
 * @param {() => number} [now]
 */
export function defaultSessionFactory(sessionKey, now = Date.now) {
  return {
    sessionKey,
    states: createStateStore({ now }),
    frames: createFrameStore({ now }),
    killSwitch: createKillSwitch({ now }),
    holds: createInputHoldRegistry({ now }),
    /** @type {{fingerprint: string, resolved: boolean} | undefined} */
    effectBaseline: undefined,
    broker: undefined,
  };
}
