/**
 * 输入保持（hold key / hold button）注册表。
 *
 * 单次保持的硬上限是 30 秒，与 `key.hold_seconds` 的上限一致；进程被硬杀时
 * 桌面最多残留这个有界时长，不会留下无界的 modifier。stop、session 关闭与
 * dispose 都必须走 `releaseSession` 释放。
 */

import { CuaProtocolError } from "../protocol/errors.js";
import { MAX_HOLD_SECONDS } from "../protocol/limits.js";

/** @param {{now?: () => number, maxSeconds?: number, release?: (hold: {id: string, sessionKey: string}) => void | Promise<void>}} [options] */
export function createInputHoldRegistry(options = {}) {
  const now = options.now ?? Date.now;
  const maxSeconds = options.maxSeconds ?? MAX_HOLD_SECONDS;
  const release = options.release ?? (() => {});
  /** @type {Map<string, {id: string, sessionKey: string, kind: string, keys: string[], seconds: number, startedAt: number, expiresAt: number}>} */
  const holds = new Map();
  let counter = 0;

  /**
   * @param {{sessionKey: string, kind?: "key"|"button", keys?: string[], seconds?: number}} input
   */
  const hold = (input) => {
    const seconds = input.seconds ?? 0;
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
      throw new CuaProtocolError("invalid_request", "hold seconds must be a non-negative number");
    }
    if (seconds > maxSeconds) {
      throw new CuaProtocolError("invalid_request", `hold seconds must not exceed ${maxSeconds}`, {
        details: { limit: maxSeconds },
      });
    }
    counter += 1;
    const startedAt = now();
    /** @type {{id: string, sessionKey: string, kind: string, keys: string[], seconds: number, startedAt: number, expiresAt: number}} */
    const record = {
      id: `h-${counter}`,
      sessionKey: input.sessionKey,
      kind: input.kind ?? "key",
      keys: input.keys ?? [],
      seconds,
      startedAt,
      expiresAt: startedAt + seconds * 1000,
    };
    holds.set(record.id, record);
    return record;
  };

  const get = (holdId) => holds.get(holdId);

  /**
   * 释放单个 hold。
   * @param {string} holdId
   */
  const releaseHold = (holdId) => {
    const record = holds.get(holdId);
    if (!record) return undefined;
    holds.delete(holdId);
    void release(record);
    return record;
  };

  /**
   * 释放一个 session 的全部 hold（stop / closeSession / dispose 路径）。
   * @param {string} sessionKey
   */
  const releaseSession = (sessionKey) => {
    /** @type {Array<{id: string, sessionKey: string}>} */
    const released = [];
    for (const [holdId, record] of holds) {
      if (record.sessionKey !== sessionKey) continue;
      holds.delete(holdId);
      released.push(record);
    }
    for (const record of released) void release(record);
    return released;
  };

  /** 扫掉已到期但没人显式释放的 hold。 */
  const sweep = () => {
    const at = now();
    /** @type {string[]} */
    const expired = [];
    for (const [holdId, record] of holds) {
      if (record.expiresAt <= at) {
        holds.delete(holdId);
        expired.push(holdId);
        void release(record);
      }
    }
    return expired;
  };

  const list = () => [...holds.values()];

  const countForSession = (sessionKey) =>
    list().filter((record) => record.sessionKey === sessionKey).length;

  return { hold, get, releaseHold, releaseSession, sweep, list, countForSession, maxSeconds };
}
