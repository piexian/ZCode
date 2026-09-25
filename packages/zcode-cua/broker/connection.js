/**
 * 已认证的 NDJSON 客户端连接。
 *
 * 连接实现通过注入的 `connect(path)` 打开传输，不直接绑定 `net`：Helper 服务端由
 * native 用 `CreateNamedPipeW` 创建，JS 侧只作为普通命名管道客户端。
 *
 * 关键不变量：
 * - 第一帧必须是 `authenticate`，版本缺失/非法/低于下限一律 fail closed；
 * - 每连接串行，同一时刻只有一个在途请求；
 * - 每个 pending 请求记录是否越过管道，越过后失败一律 possibly_sent，永不自动重放。
 */

import { CuaProtocolError, classifyRetry } from "../protocol/errors.js";
import {
  BROKER_PROTOCOL_VERSION,
  CLIENT_REQUEST_MAX_BYTES,
  CLIENT_RESPONSE_MAX_BYTES,
  MIN_BROKER_PROTOCOL_VERSION,
  REQUEST_TIMEOUT_MS,
} from "../protocol/limits.js";
import { decodeResponseFrame, encodeRequestFrame, splitNdjsonLines } from "./ndjson.js";

const isPlainRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

let idCounter = 0;

/** @returns {string} */
function nextRequestId() {
  idCounter += 1;
  return `cua-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

/**
 * 一次 broker 调用的失败。`dispatchStatus` 与 `actionSent` 是 receipt 的唯一输入，
 * 所以这里必须区分「未越过管道」与「可能已执行」。
 */
export class BrokerCallError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{dispatchStatus?: "accepted"|"possibly_sent"|"not_sent", details?: unknown}} [options]
   */
  constructor(code, message, options = {}) {
    super(message);
    this.name = "BrokerCallError";
    this.code = code;
    this.dispatchStatus = options.dispatchStatus ?? "not_sent";
    this.actionSent = this.dispatchStatus !== "not_sent";
    this.retry = classifyRetry(code, { dispatchStatus: this.dispatchStatus });
    if (options.details !== undefined) this.details = options.details;
  }
}

/**
 * @typedef {object} BrokerSocket
 * @property {(event: string, listener: (...args: unknown[]) => void) => unknown} on
 * @property {(chunk: string | Uint8Array) => unknown} write
 * @property {() => unknown} [end]
 * @property {() => unknown} [destroy]
 * @property {boolean} [connecting]
 */

/**
 * @param {{
 *   path: string,
 *   connect: (path: string) => BrokerSocket | Promise<BrokerSocket>,
 *   role?: string,
 *   clientInfo?: Record<string, unknown>,
 *   requestTimeoutMs?: number,
 *   maxRequestBytes?: number,
 *   maxResponseBytes?: number,
 * }} options
 */
export function createBrokerConnection(options) {
  const {
    path,
    connect,
    role = "tool",
    clientInfo = {},
    requestTimeoutMs = REQUEST_TIMEOUT_MS,
    maxRequestBytes = CLIENT_REQUEST_MAX_BYTES,
    maxResponseBytes = CLIENT_RESPONSE_MAX_BYTES,
  } = options;
  if (typeof path !== "string" || path.length === 0) {
    throw new TypeError("broker connection requires a socket path");
  }
  if (typeof connect !== "function") {
    throw new TypeError("broker connection requires an injected connect(path) function");
  }

  /** @type {BrokerSocket | undefined} */
  let socket;
  /** @type {{resolve: (value: any) => void, reject: (error: Error) => void, id: string, method: string, crossedPipe: boolean, timer: ReturnType<typeof setTimeout> | undefined} | undefined} */
  let inflight;
  /** @type {Array<() => void>} */
  const queue = [];
  let buffer = "";
  let authenticated = false;
  let closed = false;
  /** authenticate 失败后连接不可继续使用：版本协商不兼容时 fail closed。 */
  let poisoned = false;
  let negotiatedVersion;

  const fail = (error) => {
    if (!inflight) return;
    const pending = inflight;
    inflight = undefined;
    if (pending.timer) clearTimeout(pending.timer);
    pending.reject(error);
    drain();
  };

  const failByCode = (code, message, dispatchStatus = "not_sent") => {
    fail(new BrokerCallError(code, message, { dispatchStatus }));
  };

  const onData = (chunk) => {
    buffer +=
      typeof chunk === "string"
        ? chunk
        : Buffer.from(/** @type {Uint8Array} */ (chunk)).toString("utf8");
    if (Buffer.byteLength(buffer, "utf8") > maxResponseBytes) {
      failByCode(
        "response_corrupted",
        "broker response buffer exceeded the byte limit",
        "possibly_sent",
      );
      buffer = "";
      return;
    }
    const { lines, rest } = splitNdjsonLines(buffer);
    buffer = rest;
    const line = lines[0];
    if (line === undefined) return;
    if (lines.length > 1) {
      // 一个数据块里出现多帧：连接已经错位，不能把它当作当前请求的成功响应。
      failByCode(
        "response_id_mismatch",
        "broker sent multiple frames in one chunk",
        "possibly_sent",
      );
      buffer = "";
      return;
    }
    if (line.length === 0) return;
    let frame;
    try {
      frame = decodeResponseFrame(line, { maxBytes: maxResponseBytes });
    } catch (error) {
      // 帧级损坏：无法证明 Helper 没有执行，必须按 possibly_sent 处理。
      failByCode(
        "response_corrupted",
        error instanceof Error ? error.message : "corrupted frame",
        "possibly_sent",
      );
      return;
    }
    if (!inflight) {
      failByCode("response_id_mismatch", "unsolicited broker response", "possibly_sent");
      return;
    }
    const pending = inflight;
    if (frame.id !== pending.id) {
      inflight = undefined;
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(
        new BrokerCallError(
          "response_id_mismatch",
          `response id ${frame.id} does not match ${pending.id}`,
          {
            dispatchStatus: "possibly_sent",
          },
        ),
      );
      drain();
      return;
    }
    inflight = undefined;
    if (pending.timer) clearTimeout(pending.timer);
    if (frame.ok) {
      pending.resolve(frame.result);
    } else {
      const error = frame.error;
      const maybeExecuted =
        isPlainRecord(error?.details) &&
        /** @type {Record<string, unknown>} */ (error.details).possibly_executed === true;
      pending.reject(
        new BrokerCallError(error?.code ?? "internal", error?.message ?? "broker call failed", {
          // Helper 明确在执行前失败是 not_sent；自报可能已执行的是 possibly_sent。
          dispatchStatus: maybeExecuted ? "possibly_sent" : "not_sent",
          details: error?.details,
        }),
      );
    }
    drain();
  };

  const onClose = () => {
    closed = true;
    // 断开时未完成的请求：越过管道的就是 possibly_sent。
    const status = inflight && inflight.crossedPipe ? "possibly_sent" : "not_sent";
    failByCode(
      "broker_unavailable",
      "broker connection closed before the response arrived",
      status,
    );
    for (const task of queue.splice(0)) task();
  };

  const onError = (error) => {
    const status = inflight && inflight.crossedPipe ? "possibly_sent" : "not_sent";
    failByCode(
      "broker_unavailable",
      error instanceof Error ? error.message : "broker socket error",
      status,
    );
  };

  /** @param {() => void} task */
  const drain = () => {
    if (closed || poisoned || inflight) return;
    const next = queue.shift();
    if (!next) return;
    next();
  };

  /**
   * 打开传输并完成 authenticate。失败时抛 `BrokerCallError(broker_unavailable, not_sent)`。
   */
  const open = async () => {
    if (socket) return;
    let created;
    try {
      created = await connect(path);
    } catch (error) {
      throw new BrokerCallError(
        "broker_unavailable",
        error instanceof Error ? error.message : "broker connect failed",
      );
    }
    if (!created || typeof created.on !== "function" || typeof created.write !== "function") {
      throw new BrokerCallError(
        "broker_unavailable",
        "connect(path) did not return a usable socket",
      );
    }
    socket = created;
    socket.on("data", onData);
    socket.on("close", onClose);
    socket.on("error", onError);
    if (socket.connecting === true) {
      await new Promise((resolve, reject) => {
        const done = (error) => {
          socket?.off?.("connect", onConnect);
          socket?.off?.("error", onErrorOnce);
          if (error) reject(new BrokerCallError("broker_unavailable", "broker connect failed"));
          else resolve(undefined);
        };
        const onConnect = () => done(undefined);
        const onErrorOnce = (error) =>
          done(error instanceof Error ? error : new Error("connect failed"));
        socket?.once ? socket.once("connect", onConnect) : socket?.on("connect", onConnect);
        socket?.once ? socket.once("error", onErrorOnce) : socket?.on("error", onErrorOnce);
      });
    }
  };

  /**
   * 发一个方法帧。请求在连接内串行排队。
   *
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @returns {Promise<unknown>}
   */
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const run = () => {
        if (closed || poisoned || !socket) {
          reject(new BrokerCallError("broker_unavailable", "broker connection is not usable"));
          drain();
          return;
        }
        const id = nextRequestId();
        const pending = { resolve, reject, id, method, crossedPipe: false, timer: undefined };
        inflight = pending;
        pending.timer = setTimeout(() => {
          failByCode(
            "request_timeout",
            `broker method ${method} timed out`,
            pending.crossedPipe ? "possibly_sent" : "not_sent",
          );
        }, requestTimeoutMs);
        pending.timer.unref?.();
        let line;
        try {
          line = encodeRequestFrame(
            { id, method, ...(params === undefined ? {} : { params }) },
            {
              maxBytes: maxRequestBytes,
            },
          );
        } catch (error) {
          inflight = undefined;
          if (pending.timer) clearTimeout(pending.timer);
          reject(
            error instanceof CuaProtocolError
              ? new BrokerCallError(error.code, error.message)
              : error,
          );
          drain();
          return;
        }
        // 写入前是 not_sent 的最后边界；一旦 write 被调用就只能按 possibly_sent 记账。
        pending.crossedPipe = true;
        try {
          socket.write(line);
        } catch (error) {
          failByCode(
            "broker_unavailable",
            error instanceof Error ? error.message : "broker write failed",
            "possibly_sent",
          );
        }
      };
      queue.push(run);
      drain();
    });

  /**
   * 认证。必须是版本 2；`authenticate` 之前不接受任何业务帧。
   * @param {{version?: number, role?: string, metadata?: Record<string, unknown>}} [params]
   */
  const authenticate = async (params = {}) => {
    // 只把「缺失」当作默认值；显式传 null/字符串属于非法输入，必须 fail closed 而不是回落。
    const version = params.version === undefined ? BROKER_PROTOCOL_VERSION : params.version;
    if (!Number.isInteger(version)) {
      throw new CuaProtocolError("invalid_request", "authenticate version must be an integer");
    }
    if (version < MIN_BROKER_PROTOCOL_VERSION) {
      // 低于下限：客户端版本不被支持，直接 fail closed，不写帧。
      throw new CuaProtocolError(
        "version_mismatch",
        `protocol version ${version} is not supported`,
        {
          details: { minimum: MIN_BROKER_PROTOCOL_VERSION },
        },
      );
    }
    await open();
    try {
      const result = await send("authenticate", {
        version,
        role: params.role ?? role,
        metadata: { ...clientInfo, ...(params.metadata ?? {}) },
      });
      authenticated = true;
      negotiatedVersion = version;
      return result;
    } catch (error) {
      if (error instanceof BrokerCallError && error.code === "version_mismatch") {
        // Helper 能力高于或不同于本切片：连接不可再用。
        poisoned = true;
      }
      throw error;
    }
  };

  /**
   * 调用业务方法。`authenticate` 必须先成功；在此之前 `ping` 与业务帧都不写管道。
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   */
  const call = async (method, params) => {
    // 版本协商失败过的连接是 Helper 不可用，不是调用方参数错误：必须报 broker_unavailable，
    // 否则调用方会把可重试的连接问题误判成 invalid_request。
    if (poisoned || closed) {
      throw new BrokerCallError(
        "broker_unavailable",
        poisoned ? "broker protocol version is incompatible" : "broker connection is closed",
        { dispatchStatus: "not_sent" },
      );
    }
    if (!authenticated) {
      throw new CuaProtocolError(
        "invalid_request",
        method === "authenticate"
          ? "authenticate must be awaited explicitly"
          : `method ${method} requires an authenticated connection`,
      );
    }
    return send(method, params);
  };

  const close = () => {
    closed = true;
    try {
      socket?.end?.();
    } catch {
      // 关闭失败没有可恢复动作，Helper 侧以进程/管道生命周期为准。
    }
    try {
      socket?.destroy?.();
    } catch {
      // 同上。
    }
    socket = undefined;
    authenticated = false;
    queue.length = 0;
  };

  return {
    call,
    authenticate,
    close,
    get authenticated() {
      return authenticated;
    },
    get closed() {
      return closed;
    },
    get version() {
      return negotiatedVersion;
    },
    get pending() {
      return inflight ? inflight.method : undefined;
    },
  };
}
