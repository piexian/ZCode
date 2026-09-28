/**
 * 客户端请求签名 V4 的共享事实：协议常量、错误类型、观察事件与字节工具。
 *
 * 契约见 specs/zcode-client-signing/client-request-signing-v4.md。
 * 本模块不承载状态，只放各阶段共同依赖的定义。
 */

export type ProviderFetch = typeof globalThis.fetch;

// 协议常量以官方 3.14.3 agent bundle 实证为准，勿随意调整。
export const KDF_SALT = "WD_CLIENT_SIGN_KDF_SALT";
export const HKDF_INFO_HANDSHAKE = "getSignKey_hmac";
export const HKDF_INFO_PRIVATE_KEY = "ed25519_priv";
export const APP_ID = "zcode";
export const HANDSHAKE_ACTION = "get_sign_key";
export const HANDSHAKE_PATH = "/api/paas/c1f3a7e2/v2/client";
export const HANDSHAKE_TIMEOUT_MS = 10_000;
export const NONCE_BYTES = 16;
export const POW_BITS = 8;
export const POW_COUNTER_MAX = 0xffff_ffff;
export const POW_RANDOM_BYTES = 12;
export const POW_COUNTER_HEX_DIGITS = 8;
export const FEATURE_GATE_PATH = "/api/v1/agent/configs";
export const FEATURE_GATE_CACHE_TTL_MS = 3_600_000;
export const FEATURE_GATE_TIMEOUT_MS = 15_000;
export const AES_GCM_IV_BYTES = 12;
export const AES_GCM_TAG_BITS = 128;

export const SIGNING_HEADERS = [
  "X-Client-Ts",
  "X-Client-Version",
  "X-Client-Sig",
  "X-Client-Nonce",
  "X-Client-Pow",
  "X-App-Id",
  "X-Client-Sign-Verified",
] as const;

export const SESSION_ID_HEADER = "X-Session-Id";
export const REFRESHABLE_REASONS = ["VERIFY_SIGNATURE_INVALID", "VERIFY_APIKEY_EXPIRED"] as const;

export type ClientSigningErrorKind =
  | "invalid-config"
  | "disposed"
  | "handshake-timeout"
  | "handshake-network"
  | "handshake-protocol"
  | "handshake-server"
  | "handshake-business"
  | "cryptography";

export class ClientRequestSigningV4Error extends Error {
  readonly kind: ClientSigningErrorKind;
  readonly failOpenEligible: boolean;
  readonly reason: string | undefined;
  readonly httpStatus: number | undefined;
  readonly businessCode: number | undefined;

  constructor(init: {
    kind: ClientSigningErrorKind;
    message: string;
    cause?: unknown;
    failOpenEligible?: boolean;
    reason?: string;
    httpStatus?: number;
    businessCode?: number;
  }) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "ClientRequestSigningV4Error";
    this.kind = init.kind;
    this.failOpenEligible = init.failOpenEligible ?? false;
    this.reason = init.reason;
    this.httpStatus = init.httpStatus;
    this.businessCode = init.businessCode;
  }
}

export function signingError(
  kind: ClientSigningErrorKind,
  message: string,
  options: {
    cause?: unknown;
    failOpenEligible?: boolean;
    reason?: string;
    httpStatus?: number;
    businessCode?: number;
  } = {},
): ClientRequestSigningV4Error {
  return new ClientRequestSigningV4Error({ kind, message, ...options });
}

export type ClientSigningObservationBody =
  | { readonly kind: "signed_sent"; readonly signedAttempt: number }
  | {
      readonly kind: "unsigned_sent";
      readonly reason:
        | "origin_mismatch"
        | "bypass"
        | "feature_gate_disabled"
        | "feature_gate_unavailable"
        | "handshake_failed"
        | "verify_refresh_exhausted";
    }
  | { readonly kind: "verify_rejected"; readonly reason: string; readonly signedAttempt: number }
  | { readonly kind: "bypass_entered" }
  | { readonly kind: "feature_gate"; readonly enabled: boolean; readonly failure?: string }
  | {
      readonly kind: "handshake_failed";
      readonly errorKind: ClientSigningErrorKind;
      readonly httpStatus?: number;
      readonly businessCode?: number;
      readonly reason?: string;
    }
  | { readonly kind: "request_failed_closed"; readonly errorKind: ClientSigningErrorKind };

/** 观察事件统一带 providerId：多 provider 共用进程时需要区分来源。 */
export type ClientSigningObservation = ClientSigningObservationBody & {
  readonly providerId: string;
};

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function randomHex(bytes: number): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(bytes) as Uint8Array<ArrayBuffer>));
}

export function bytesToHex(bytes: Uint8Array<ArrayBuffer>): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function bytesToBase64(bytes: Uint8Array<ArrayBuffer>): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error("invalid base64");
  }
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function encodeUtf8(value: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(value);
}

export function waitForPromiseOrAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(
      signal.reason ?? new DOMException("The operation was aborted.", "AbortError"),
    );
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (cause: unknown) => {
        cleanup();
        reject(cause);
      },
    );
  });
}

/**
 * 非 2xx 响应若不消费 body，undici 会一直占住连接；功能门失败不可缓存，
 * 反复重试会耗尽 HTTP 连接池，所以失败路径也必须释放（PR#1 审查 P2）。
 */
export async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // 释放失败只能交给 GC，不影响错误分类。
  }
}
