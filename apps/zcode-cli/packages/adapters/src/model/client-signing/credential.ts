/**
 * 客户端请求签名 V4 的凭据与密钥缓存。
 *
 * 凭据解析、握手 URL 与签名头清洗是无状态规则；key cache 是跨 signer
 * 共享已解密私钥的唯一所有者（按 apiKey+handshakeUrl 索引）。
 */

import { HANDSHAKE_PATH, SIGNING_HEADERS, signingError } from "./shared.js";

export interface ClientSigningCredential {
  readonly apiKeyId: string;
  readonly apiKeySecret: string;
  readonly credential: string;
}

/** 恰好一个 `.` 且两侧非空才算合法凭据；其余一律不参与签名。 */
export function parseClientSigningCredential(
  apiKey: string | undefined,
): ClientSigningCredential | undefined {
  if (!apiKey) return undefined;
  const separator = apiKey.indexOf(".");
  if (separator <= 0 || separator !== apiKey.lastIndexOf(".")) return undefined;
  const apiKeyId = apiKey.slice(0, separator);
  const apiKeySecret = apiKey.slice(separator + 1);
  if (!apiKeyId.trim() || !apiKeySecret.trim()) return undefined;
  return { apiKeyId, apiKeySecret, credential: apiKey };
}

export function resolveHandshakeUrl(baseURL: string, allowInsecureHttp = false): string {
  let parsed: URL;
  try {
    parsed = new URL(baseURL);
  } catch (cause) {
    throw signingError("invalid-config", "Client signing requires a valid baseURL.", { cause });
  }
  if (parsed.protocol !== "https:" && !(allowInsecureHttp && parsed.protocol === "http:")) {
    throw signingError("invalid-config", "Client signing handshake requires HTTPS.");
  }
  return new URL(HANDSHAKE_PATH, parsed.origin).toString();
}

export function sanitizeClientSigningHeaders(headers: Headers): Headers {
  const sanitized = new Headers(headers);
  for (const name of SIGNING_HEADERS) sanitized.delete(name);
  return sanitized;
}

export interface ClientSigningKeyCache {
  resolve(apiKey: string, handshakeUrl: string): ClientSigningKeyState;
}

export interface ClientSigningKeyState {
  epoch: number;
  privateKey: CryptoKey | undefined;
  handshakePromise: Promise<CryptoKey> | undefined;
}

export function createClientSigningKeyCache(): ClientSigningKeyCache {
  const states = new Map<string, ClientSigningKeyState>();
  return {
    resolve(apiKey, handshakeUrl) {
      const key = `${handshakeUrl}\n${apiKey}`;
      let state = states.get(key);
      if (!state) {
        state = { epoch: 0, privateKey: undefined, handshakePromise: undefined };
        states.set(key, state);
      }
      return state;
    },
  };
}
