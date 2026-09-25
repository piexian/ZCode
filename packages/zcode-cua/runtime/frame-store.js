/**
 * 每个 session 的 actionable frame 注册表。
 *
 * 坐标动作必须引用一张仍然 actionable 的 frame：frame 过期、被 LRU 淘汰、
 * 窗口移动/缩放或非 PMv2 raster 都写 tombstone，动作返回 not_sent 并要求重新观察。
 * producer 只保存 native 签发的 opaque handle，绝不重签。
 */

import { CuaProtocolError } from "../protocol/errors.js";
import { FRAME_TTL_MS, MAX_FRAMES_PER_SESSION } from "../protocol/limits.js";

/** @typedef {{frameId: string, handle: string, width: number, height: number, expiresAt: number, createdAt: number}} FrameRecord */

const isPlainObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * @param {{now?: () => number, maxEntries?: number, ttlMs?: number}} [options]
 */
export function createFrameStore(options = {}) {
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? MAX_FRAMES_PER_SESSION;
  const ttlMs = options.ttlMs ?? FRAME_TTL_MS;
  /** @type {Map<string, FrameRecord>} */
  const frames = new Map();
  /** @type {Map<string, {frameId: string, reason: "evicted"|"expired", at: number}>} */
  const tombstones = new Map();
  let counter = 0;

  const tombstone = (frameId, reason) => {
    tombstones.set(frameId, { frameId, reason, at: now() });
    while (tombstones.size > maxEntries) {
      const oldest = tombstones.keys().next();
      if (oldest.done) break;
      tombstones.delete(oldest.value);
    }
  };

  /** 把过期 frame 转成 tombstone。返回本次新 tombstone 的 id 列表。 */
  const prune = () => {
    const at = now();
    /** @type {string[]} */
    const expired = [];
    for (const [frameId, frame] of frames) {
      if (frame.expiresAt <= at) {
        frames.delete(frameId);
        tombstone(frameId, "expired");
        expired.push(frameId);
      }
    }
    return expired;
  };

  /**
   * 登记一张已交付给模型的 raster。
   *
   * @param {{handle: string, width: number, height: number, expiresAt?: number}} input
   * @returns {FrameRecord}
   */
  const register = (input) => {
    if (!isPlainObject(input) || typeof input.handle !== "string" || input.handle.length === 0) {
      throw new CuaProtocolError("invalid_request", "frame requires an opaque native handle");
    }
    if (
      !Number.isInteger(input.width) ||
      !Number.isInteger(input.height) ||
      input.width <= 0 ||
      input.height <= 0
    ) {
      // blank / zero-size raster 不可行动：不登记，也没有 frame_id 可引用。
      throw new CuaProtocolError("element_unavailable", "frame geometry is not actionable");
    }
    prune();
    counter += 1;
    const createdAt = now();
    /** @type {FrameRecord} */
    const frame = {
      frameId: `f-${counter}`,
      handle: input.handle,
      width: input.width,
      height: input.height,
      createdAt,
      expiresAt: input.expiresAt ?? createdAt + ttlMs,
    };
    frames.set(frame.frameId, frame);
    /** @type {string[]} */
    const evicted = [];
    while (frames.size > maxEntries) {
      const oldest = frames.keys().next();
      if (oldest.done) break;
      const frameId = oldest.value;
      if (frameId === frame.frameId) break;
      frames.delete(frameId);
      tombstone(frameId, "evicted");
      evicted.push(frameId);
    }
    return frame;
  };

  /**
   * 查询 frame。已淘汰/过期时返回 tombstone 记录而不是 undefined，这样动作
   * 可以明确区分「从未见过」与「见过但已失效」。
   *
   * @param {string} frameId
   * @returns {FrameRecord | {frameId: string, reason: string, at: number} | undefined}
   */
  const get = (frameId) => {
    prune();
    const frame = frames.get(frameId);
    if (frame) {
      frames.delete(frameId);
      frames.set(frameId, frame);
      return frame;
    }
    return tombstones.get(frameId);
  };

  /**
   * 坐标动作的 frame 预检。失败一律 not_sent，Helper 侧看不到这次尝试。
   *
   * @param {string} frameId
   * @param {{x: number, y: number}} point
   * @returns {FrameRecord}
   */
  const requireActionable = (frameId, point) => {
    const record = get(frameId);
    if (!record) {
      throw new CuaProtocolError("frame_expired", `frame ${frameId} is unknown to this session`, {
        details: { frameId },
      });
    }
    if (!("handle" in record)) {
      throw new CuaProtocolError(
        "frame_expired",
        `frame ${frameId} was ${/** @type {{reason: string}} */ (record).reason}`,
        {
          details: { frameId, reason: /** @type {{reason: string}} */ (record).reason },
        },
      );
    }
    if (point.x >= record.width || point.y >= record.height) {
      throw new CuaProtocolError(
        "frame_out_of_bounds",
        "coordinate is outside the delivered raster",
        {
          details: { frameId, width: record.width, height: record.height },
        },
      );
    }
    return record;
  };

  /** 最近一张仍然 actionable 的 frame，用于默认坐标绑定。 */
  const latestActionable = () => {
    prune();
    let last;
    for (const frame of frames.values()) last = frame;
    return last;
  };

  const list = () => {
    prune();
    return [...frames.values()];
  };

  const listTombstones = () => [...tombstones.values()];

  const clear = () => {
    for (const frameId of frames.keys()) tombstone(frameId, "evicted");
    frames.clear();
  };

  return {
    register,
    get,
    requireActionable,
    latestActionable,
    list,
    listTombstones,
    prune,
    clear,
    get size() {
      return frames.size;
    },
  };
}
