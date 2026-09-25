/**
 * session 级 kill switch。
 *
 * `stop_computer_control` 是 latch：一旦触发，同一 session 的所有非豁免工具被拒绝，
 * 首次 reason 保留，重复调用保持幂等。豁免工具只有 `request_access` 与再次 stop。
 */

/** @param {{now?: () => number}} [options] */
export function createKillSwitch(options = {}) {
  const now = options.now ?? Date.now;
  let stopped = false;
  let reason;
  let stoppedAt;

  /**
   * @param {string} [nextReason]
   * @returns {{alreadyStopped: boolean, reason: string | undefined, stoppedAt: number | undefined}}
   */
  const stop = (nextReason) => {
    if (stopped) return { alreadyStopped: true, reason, stoppedAt };
    stopped = true;
    stoppedAt = now();
    reason = nextReason;
    return { alreadyStopped: false, reason, stoppedAt };
  };

  const isStopped = () => stopped;

  const reset = () => {
    stopped = false;
    reason = undefined;
    stoppedAt = undefined;
  };

  return { stop, isStopped, reset, snapshot: () => ({ stopped, reason, stoppedAt }) };
}
