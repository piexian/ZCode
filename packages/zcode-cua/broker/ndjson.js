/**
 * NDJSON 行编解码。
 *
 * 上限按 UTF-8 字节计（不是 `string.length` 的 UTF-16 码元），重复键、未知字段、
 * 截断帧与 id 不关联都必须失败——任何一种情况都不能当作成功响应。
 */

import { CuaProtocolError } from "../protocol/errors.js";
import { ALL_BROKER_METHODS } from "../protocol/method-table.js";
import {
  CLIENT_REQUEST_MAX_BYTES,
  CLIENT_RESPONSE_MAX_BYTES,
  SERVER_LINE_MAX_BYTES,
} from "../protocol/limits.js";
import { StrictJsonError, parseStrictJson } from "../protocol/strict-json.js";

const ALLOWED_METHODS = new Set(ALL_BROKER_METHODS);
const REQUEST_FIELDS = new Set(["id", "method", "params"]);
const RESPONSE_FIELDS = new Set(["id", "ok", "result", "error"]);
const ERROR_FIELDS = new Set(["code", "message", "details"]);
const isPlainObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * @param {unknown} value
 * @returns {number} UTF-8 字节数
 */
export const byteLength = (value) => Buffer.byteLength(String(value), "utf8");

/**
 * 编码一行请求（含结尾换行）。超限时抛 `invalid_request`，调用方据此判定 not_sent。
 *
 * @param {{id: string, method: string, params?: unknown}} request
 * @param {{maxBytes?: number}} [options]
 * @returns {string}
 */
export function encodeRequestFrame(request, options = {}) {
  if (!isPlainObject(request))
    throw new CuaProtocolError("invalid_request", "request must be an object");
  for (const key of Object.keys(request)) {
    if (!REQUEST_FIELDS.has(key)) {
      throw new CuaProtocolError("invalid_request", `unknown request field: ${key}`);
    }
  }
  if (typeof request.id !== "string" || request.id.length === 0) {
    throw new CuaProtocolError("invalid_request", "request id must be a non-empty string");
  }
  if (typeof request.method !== "string" || !ALLOWED_METHODS.has(request.method)) {
    throw new CuaProtocolError(
      "method_not_found",
      `unknown broker method: ${String(request.method)}`,
    );
  }
  if (request.params !== undefined && !isPlainObject(request.params)) {
    throw new CuaProtocolError("invalid_request", "request params must be an object");
  }
  const line = `${JSON.stringify(request)}\n`;
  const maxBytes = options.maxBytes ?? CLIENT_REQUEST_MAX_BYTES;
  if (byteLength(line) > maxBytes) {
    throw new CuaProtocolError("invalid_request", `request exceeds ${maxBytes} bytes`, {
      details: { limit: maxBytes },
    });
  }
  return line;
}

/**
 * 解码一行响应。
 *
 * @param {string} line 不含换行；含换行也接受但会先剥掉
 * @param {{maxBytes?: number, serverLineLimitBytes?: number}} [options]
 * @returns {{id: string, ok: boolean, result?: unknown, error?: {code: string, message: string, details?: unknown}}}
 */
export function decodeResponseFrame(line, options = {}) {
  const text = typeof line === "string" ? line.replace(/\r?\n$/, "") : line;
  if (typeof text !== "string")
    throw new CuaProtocolError("response_corrupted", "response line is not text");
  const maxBytes = options.maxBytes ?? CLIENT_RESPONSE_MAX_BYTES;
  if (byteLength(text) > maxBytes) {
    throw new CuaProtocolError("response_corrupted", `response exceeds ${maxBytes} bytes`, {
      details: { limit: maxBytes },
    });
  }
  const serverLimit = options.serverLineLimitBytes ?? SERVER_LINE_MAX_BYTES;
  if (byteLength(text) > serverLimit) {
    throw new CuaProtocolError(
      "response_corrupted",
      `response exceeds the server line limit ${serverLimit}`,
    );
  }
  const parsed = parseFrameJson(text);
  if (!isPlainObject(parsed))
    throw new CuaProtocolError("response_corrupted", "response must be an object");
  for (const key of Object.keys(parsed)) {
    if (!RESPONSE_FIELDS.has(key)) {
      throw new CuaProtocolError("response_corrupted", `unknown response field: ${key}`);
    }
  }
  if (typeof parsed.id !== "string" || parsed.id.length === 0) {
    throw new CuaProtocolError("response_corrupted", "response id must be a non-empty string");
  }
  if (typeof parsed.ok !== "boolean") {
    throw new CuaProtocolError("response_corrupted", "response ok must be a boolean");
  }
  if (parsed.ok) {
    if (parsed.error !== undefined) {
      throw new CuaProtocolError(
        "response_corrupted",
        "successful response must not carry an error",
      );
    }
    return { id: parsed.id, ok: true, result: parsed.result };
  }
  if (parsed.result !== undefined) {
    throw new CuaProtocolError("response_corrupted", "failed response must not carry a result");
  }
  return { id: parsed.id, ok: false, error: decodeErrorPayload(parsed.error) };
}

/**
 * @param {unknown} payload
 * @returns {{code: string, message: string, details?: unknown}}
 */
export function decodeErrorPayload(payload) {
  if (!isPlainObject(payload)) {
    throw new CuaProtocolError("response_corrupted", "error payload must be an object");
  }
  for (const key of Object.keys(payload)) {
    if (!ERROR_FIELDS.has(key)) {
      throw new CuaProtocolError("response_corrupted", `unknown error field: ${key}`);
    }
  }
  if (typeof payload.code !== "string" || payload.code.length === 0) {
    throw new CuaProtocolError("response_corrupted", "error code must be a non-empty string");
  }
  if (typeof payload.message !== "string") {
    throw new CuaProtocolError("response_corrupted", "error message must be a string");
  }
  return {
    code: payload.code,
    message: payload.message,
    ...(payload.details === undefined ? {} : { details: payload.details }),
  };
}

/**
 * 校验响应与请求的 id 关联。id 不匹配说明流已经错位，调用方按 possibly_sent 处理。
 *
 * @param {{id: string}} frame
 * @param {string} expectedId
 * @param {{crossedPipe?: boolean}} [options]
 */
export function assertResponseId(frame, expectedId, options = {}) {
  if (frame.id === expectedId) return;
  throw new CuaProtocolError(
    "response_id_mismatch",
    `response id ${frame.id} does not match request id ${expectedId}`,
    { dispatchStatus: options.crossedPipe === false ? "not_sent" : "possibly_sent" },
  );
}

/**
 * 把 NDJSON 数据块切成完整行。半行保留在 rest 中，调用方在 close 时必须把 rest 视为截断。
 *
 * @param {string} buffer
 * @returns {{lines: string[], rest: string}}
 */
export function splitNdjsonLines(buffer) {
  const lines = [];
  let start = 0;
  for (;;) {
    const newline = buffer.indexOf("\n", start);
    if (newline < 0) break;
    lines.push(buffer.slice(start, newline));
    start = newline + 1;
  }
  return { lines, rest: buffer.slice(start) };
}

/**
 * 严格解析一帧 JSON，把解析层错误统一成 `response_corrupted`。
 * @param {string} text
 */
export function parseFrameJson(text) {
  try {
    return parseStrictJson(text);
  } catch (error) {
    if (error instanceof StrictJsonError) {
      throw new CuaProtocolError("response_corrupted", `frame rejected: ${error.reason}`, {
        details: { reason: error.reason, offset: error.offset },
      });
    }
    throw error;
  }
}

/** 构造错误响应行，供测试与后续 Helper 侧复用。 */
export function encodeErrorFrame(id, code, message, details) {
  return `${JSON.stringify({
    id,
    ok: false,
    error: { code, message, ...(details === undefined ? {} : { details }) },
  })}\n`;
}

/** 构造成功响应行。 */
export function encodeOkFrame(id, result) {
  return `${JSON.stringify({ id, ok: true, result })}\n`;
}
