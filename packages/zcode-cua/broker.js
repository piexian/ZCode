import { randomUUID, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBrokerConnection } from "./broker/connection.js";
import { encodeRequestFrame, parseFrameJson } from "./broker/ndjson.js";
import {
  isBrokerMethod as isProtocolBrokerMethod,
  isReadOnlyBrokerMethod as isProtocolReadOnlyBrokerMethod,
} from "./protocol/method-table.js";
import { createNetConnector } from "./broker/net-connector.js";

export const BROKER_SOCKET_ENV = "ZCODE_CUA_PERMISSION_BROKER_SOCKET";
export const BROKER_UNAVAILABLE_ENV = "ZCODE_CUA_PERMISSION_BROKER_UNAVAILABLE";
/** Windows 上 broker 走命名管道；unix 仍用 socket 目录。 */
export const WINDOWS_PIPE_PREFIX = "\\\\.\\pipe\\";

export class BrokerError extends Error {
  constructor(message, options = {}) {
    super(message ?? "Computer Use broker is unavailable.");
    this.name = "BrokerError";
    this.code = options.code ?? "unavailable";
    if (options.details !== undefined) this.details = options.details;
  }
}

export class CuaHelperError extends Error {
  constructor(message, options = {}) {
    super(message ?? "Computer Use Helper is unavailable.");
    this.name = "CuaHelperError";
    this.code = options.code ?? "helper_unavailable";
  }
}

export function isCuaHelperError(value) {
  return value instanceof CuaHelperError;
}

const brokerErrorFactory = (code) => (message, details) =>
  new BrokerError(message ?? code, { code, details });

export const notAuthorized = brokerErrorFactory("not_authorized");
export const notSelectable = brokerErrorFactory("not_selectable");
export const notSettable = brokerErrorFactory("not_settable");
export const elementUnavailable = brokerErrorFactory("element_unavailable");
export const actionUnavailable = brokerErrorFactory("action_unavailable");
export const foregroundRequired = brokerErrorFactory("foreground_required");

/**
 * 一次性 broker 调用：每条请求走 authenticate-first 的独立连接。
 *
 * 语义与 `broker/connection.js` 一致：越过管道后的失败是 possibly_sent，调用方不得重放。
 * 错误保持 BrokerError 形状，services 现有调用方不需要改。
 *
 * @param {{socketPath: string, method: string, params?: Record<string, unknown>, timeoutMs?: number}} args
 * @returns {Promise<unknown>}
 */
export async function callBrokerMethod(args) {
  const socketPath = typeof args?.socketPath === "string" ? args.socketPath : "";
  if (!socketPath) {
    throw new BrokerError("Computer Use broker socket path is required", {
      code: "broker_unavailable",
    });
  }
  const connection = createBrokerConnection({
    path: socketPath,
    connect: createNetConnector(),
    ...(args.timeoutMs === undefined ? {} : { requestTimeoutMs: args.timeoutMs }),
  });
  try {
    await connection.authenticate();
    return await connection.call(args.method, args.params ?? {});
  } catch (error) {
    throw toBrokerError(error);
  } finally {
    connection.close();
  }
}

function toBrokerError(error) {
  if (error instanceof BrokerError) return error;
  const code = typeof error?.code === "string" ? error.code : "unavailable";
  const details =
    error?.dispatchStatus === undefined ? undefined : { dispatchStatus: error.dispatchStatus };
  return new BrokerError(error instanceof Error ? error.message : String(error), { code, details });
}

/**
 * 健康探针：Host 用它确认「这条 pipe 后面确实是我们的 Helper」。
 * 身份模式下没有 token/bundle id，只有 pid 与能力快照。
 *
 * @param {string} socketPath
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<{bundleId: string | null, pid: number | null, apiVersion?: string, protocol?: string, capabilities?: Record<string, unknown>}>}
 */
export async function probeHelperHealth(socketPath, options = {}) {
  const info = await callBrokerMethod({
    socketPath,
    method: "broker_info",
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  const record = info && typeof info === "object" ? info : {};
  return {
    bundleId: null,
    pid: typeof record.pid === "number" ? record.pid : null,
    apiVersion: typeof record.api_version === "string" ? record.api_version : undefined,
    protocol: typeof record.protocol === "string" ? record.protocol : undefined,
    capabilities:
      record.capabilities && typeof record.capabilities === "object"
        ? record.capabilities
        : undefined,
  };
}

export function mintBrokerSocketPath(options = {}) {
  if (options.platform === "win32" || process.platform === "win32") {
    // 命名管道没有目录可放：名字本身承载唯一性，用 16 字节随机后缀。
    return `${WINDOWS_PIPE_PREFIX}zcode-cua-helper-${randomBytes(16).toString("hex")}`;
  }
  const dir = typeof options.dir === "string" ? options.dir : tmpdir();
  return join(dir, `zcode-cua-broker-${randomUUID()}.sock`);
}

export function resolveBrokerSocketPath(options = {}) {
  const env = options.env ?? process.env;
  const fromEnv = env[BROKER_SOCKET_ENV];
  if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv;
  return mintBrokerSocketPath(options);
}

/**
 * 解析一行请求帧；格式非法返回 undefined（与旧契约一致，不抛）。
 *
 * 校验复用 encodeRequestFrame：同一套规则（未知字段、非表方法、params 非对象、行超限）
 * 必须在入站和出站两侧一致，否则 Helper 会拒掉自己刚发出的帧。
 */
export function parseRequestLine(line) {
  if (typeof line !== "string" || line.length === 0) return undefined;
  try {
    const request = parseFrameJson(line);
    encodeRequestFrame(request);
    return request;
  } catch {
    return undefined;
  }
}

export function okResponse(result) {
  return { ok: true, result };
}

export function errorResponse(message, options = {}) {
  return {
    ok: false,
    error: { message, ...(options.code ? { code: options.code } : {}) },
  };
}

export function errorResponseFromException(error) {
  return errorResponse(error instanceof Error ? error.message : String(error));
}

export function serializeResponse(response) {
  return `${JSON.stringify(response)}\n`;
}

/**
 * Helper 服务端派发不在本进程：broker 服务端由 native 自建命名管道，
 * 协议实现见 win/entry.cjs 与 native/windows。这里保留导出形状，调用即报错。
 */
export async function dispatchRequest(_backend, _request) {
  throw new CuaHelperError("Computer Use Helper dispatch is not available in this process.");
}

export async function handleRequestLine(_backend, _line) {
  throw new CuaHelperError("Computer Use Helper dispatch is not available in this process.");
}

export function isBrokerMethod(method) {
  return isProtocolBrokerMethod(method);
}

export function isReadOnlyBrokerMethod(method) {
  return isProtocolReadOnlyBrokerMethod(method);
}
