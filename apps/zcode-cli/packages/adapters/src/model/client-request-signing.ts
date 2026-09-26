/**
 * ZCode 客户端请求签名 V4。
 *
 * 官方 Coding Plan 端点按签名头判定调用方身份，缺签名时套餐权益静默失效。
 * 行为契约见 specs/zcode-client-signing/client-request-signing-v4.md。
 *
 * 关键约束：签名不绑定 URL（只绑 apiKeyId/ts/版本/session/nonce），因此官方端点经
 * ZCode 平台网关改写投递地址后签名依然成立；origin 只用于「是否参与签名」的策略判断。
 * 握手与功能门走最内层 transport，不复用网关改写，也不被业务错误检测包装。
 */

type ProviderFetch = typeof globalThis.fetch;

const KDF_SALT = "WD_CLIENT_SIGN_KDF_SALT";
const HKDF_INFO_HANDSHAKE = "getSignKey_hmac";
const HKDF_INFO_PRIVATE_KEY = "ed25519_priv";
const APP_ID = "zcode";
const HANDSHAKE_ACTION = "get_sign_key";
const HANDSHAKE_PATH = "/api/paas/c1f3a7e2/v2/client";
const HANDSHAKE_TIMEOUT_MS = 10_000;
const NONCE_BYTES = 16;
const POW_BITS = 8;
const POW_COUNTER_MAX = 0xffff_ffff;
const POW_RANDOM_BYTES = 12;
const POW_COUNTER_HEX_DIGITS = 8;
const FEATURE_GATE_PATH = "/api/v1/agent/configs";
const FEATURE_GATE_CACHE_TTL_MS = 3_600_000;
const FEATURE_GATE_TIMEOUT_MS = 15_000;
const AES_GCM_IV_BYTES = 12;
const AES_GCM_TAG_BITS = 128;

const SIGNING_HEADERS = [
  "X-Client-Ts",
  "X-Client-Version",
  "X-Client-Sig",
  "X-Client-Nonce",
  "X-Client-Pow",
  "X-App-Id",
  "X-Client-Sign-Verified",
] as const;

const SESSION_ID_HEADER = "X-Session-Id";
const REFRESHABLE_REASONS = ["VERIFY_SIGNATURE_INVALID", "VERIFY_APIKEY_EXPIRED"] as const;

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

export interface ClientSigningCredential {
  readonly apiKeyId: string;
  readonly apiKeySecret: string;
  readonly credential: string;
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

export interface ClientSigningKeyCache {
  resolve(apiKey: string, handshakeUrl: string): ClientSigningKeyState;
}

export interface ClientSigningKeyState {
  epoch: number;
  privateKey: CryptoKey | undefined;
  handshakePromise: Promise<CryptoKey> | undefined;
}

export interface CreateClientRequestSigningV4FetchOptions {
  readonly apiKey: string | undefined;
  readonly baseURL: string;
  readonly clientVersion: string;
  readonly providerId: string;
  /** 被包装的业务请求出口（官方端点可能再经平台网关改写）。 */
  readonly fetch: ProviderFetch;
  /** 握手与功能门使用的最内层出口，不经网关改写。 */
  readonly transport: ProviderFetch;
  readonly allowInsecureHttp?: boolean;
  readonly featureGateUrl: string;
  readonly keyCache?: ClientSigningKeyCache;
  readonly now?: () => number;
  readonly observer?: (event: ClientSigningObservation) => void;
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

export async function deriveSigningBytes(
  secret: string,
  info: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const material = await crypto.subtle.importKey("raw", encodeUtf8(secret), "HKDF", false, [
    "deriveBits",
  ]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { hash: "SHA-256", name: "HKDF", salt: encodeUtf8(KDF_SALT), info: encodeUtf8(info) },
      material,
      256,
    ),
  );
}

export async function createHandshakeSignature(
  secret: string,
  message: string,
): Promise<string> {
  const derived = await deriveSigningBytes(secret, HKDF_INFO_HANDSHAKE);
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      derived,
      { hash: "SHA-256", name: "HMAC" },
      false,
      ["sign"],
    );
    const signature = new Uint8Array<ArrayBuffer>(
      await crypto.subtle.sign("HMAC", key, encodeUtf8(message)),
    );
    return bytesToBase64(signature);
  } finally {
    derived.fill(0);
  }
}

export async function decryptSigningPrivateKey(
  apiKeyId: string,
  secret: string,
  privateCipher: string,
): Promise<CryptoKey> {
  const blob = base64ToBytes(privateCipher);
  if (blob.byteLength <= AES_GCM_IV_BYTES + AES_GCM_TAG_BITS / 8) {
    throw new Error("privateCipher is too short");
  }
  const derived = await deriveSigningBytes(secret, HKDF_INFO_PRIVATE_KEY);
  let plaintext: Uint8Array<ArrayBuffer> | undefined;
  try {
    const key = await crypto.subtle.importKey("raw", derived, "AES-GCM", false, ["decrypt"]);
    plaintext = new Uint8Array<ArrayBuffer>(
      await crypto.subtle.decrypt(
        {
          additionalData: encodeUtf8(apiKeyId),
          iv: blob.slice(0, AES_GCM_IV_BYTES),
          name: "AES-GCM",
          tagLength: AES_GCM_TAG_BITS,
        },
        key,
        blob.slice(AES_GCM_IV_BYTES),
      ),
    );
    const pkcs8 = base64ToBytes(new TextDecoder().decode(plaintext));
    return await crypto.subtle.importKey("pkcs8", pkcs8, "Ed25519", false, ["sign"]);
  } finally {
    derived.fill(0);
    plaintext?.fill(0);
  }
}

export async function signBusinessMessage(key: CryptoKey, message: string): Promise<string> {
  const signature = new Uint8Array<ArrayBuffer>(
    await crypto.subtle.sign("Ed25519", key, encodeUtf8(message)),
  );
  try {
    return bytesToBase64(signature);
  } finally {
    signature.fill(0);
  }
}

export function hasLeadingZeroBits(digest: Uint8Array<ArrayBuffer>, bits: number): boolean {
  const wholeBytes = Math.floor(bits / 8);
  for (let index = 0; index < wholeBytes; index += 1) {
    if (digest[index] !== 0) return false;
  }
  const remainingBits = bits % 8;
  if (remainingBits === 0) return true;
  const mask = (255 << (8 - remainingBits)) & 255;
  return ((digest[wholeBytes] ?? 255) & mask) === 0;
}

export async function createClientRequestProofOfWork(input: {
  apiKeyId: string;
  appId: string;
  sessionId: string;
  ts: string;
  powBits?: number;
  signal?: AbortSignal;
}): Promise<string> {
  const powBits = input.powBits ?? POW_BITS;
  if (!Number.isInteger(powBits) || powBits < 0 || powBits > 32) {
    throw new Error("powBits must be an integer between 0 and 32");
  }
  input.signal?.throwIfAborted();
  const seed = new Uint8Array<ArrayBuffer>(
    await crypto.subtle.digest(
      "SHA-256",
      encodeUtf8(`${input.apiKeyId}\n${input.appId}\n${input.sessionId}\n${input.ts}`),
    ),
  );
  const prefix = bytesToHex(seed).slice(0, 32);
  const random = randomHex(POW_RANDOM_BYTES);
  for (let counter = 0; counter <= POW_COUNTER_MAX; counter += 1) {
    input.signal?.throwIfAborted();
    const candidate = `${random}${counter.toString(16).padStart(POW_COUNTER_HEX_DIGITS, "0")}`;
    const digest = new Uint8Array<ArrayBuffer>(
      await crypto.subtle.digest("SHA-256", encodeUtf8(`${prefix}\n${candidate}`)),
    );
    if (hasLeadingZeroBits(digest, powBits)) return candidate;
  }
  throw new Error("Unable to solve client request proof of work");
}

interface FeatureGateResult {
  readonly cacheable: boolean;
  readonly enabled: boolean;
  readonly failure?: string;
  readonly httpStatus?: number;
}

class CodingPlanSignatureFeatureGate {
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly transport: ProviderFetch;
  private readonly url: string;
  private snapshot: { enabled: boolean; expiresAt: number } | undefined;
  private request: Promise<FeatureGateResult> | undefined;

  constructor(options: {
    transport: ProviderFetch;
    url: string;
    cacheTtlMs?: number;
    now?: () => number;
    timeoutMs?: number;
    onResult?: (result: FeatureGateResult) => void;
  }) {
    this.transport = options.transport;
    this.url = options.url;
    this.cacheTtlMs = options.cacheTtlMs ?? FEATURE_GATE_CACHE_TTL_MS;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? FEATURE_GATE_TIMEOUT_MS;
    this.onResult = options.onResult;
  }

  private readonly onResult: ((result: FeatureGateResult) => void) | undefined;

  async isEnabled(signal?: AbortSignal): Promise<boolean> {
    if (this.snapshot && this.snapshot.expiresAt > this.now()) return this.snapshot.enabled;
    if (!this.request) {
      const pending = this.fetchResult().then((result) => {
        this.report(result);
        return result;
      });
      this.request = pending;
      const clear = () => {
        if (this.request === pending) this.request = undefined;
      };
      pending.then(clear, clear);
    }
    const result = signal
      ? await waitForPromiseOrAbort(this.request, signal)
      : await this.request;
    if (result.cacheable) {
      this.snapshot = { enabled: result.enabled, expiresAt: this.now() + this.cacheTtlMs };
    }
    return result.enabled;
  }

  private report(result: FeatureGateResult): void {
    try {
      this.onResult?.(result);
    } catch {
      // 观察回调不参与请求结果。
    }
  }

  private async fetchResult(): Promise<FeatureGateResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.transport(this.url, {
          headers: { accept: "application/json" },
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
        });
      } catch (cause) {
        return controller.signal.aborted
          ? { cacheable: false, enabled: false, failure: "timeout" }
          : { cacheable: false, enabled: false, failure: "network" };
      }
      if (!response.ok) {
        return { cacheable: false, enabled: false, failure: "http_status", httpStatus: response.status };
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        return { cacheable: false, enabled: false, failure: "malformed", httpStatus: response.status };
      }
      const envelope = asRecord(payload);
      if (envelope?.code !== 0) {
        return {
          cacheable: false,
          enabled: false,
          failure: "business_code",
          httpStatus: response.status,
        };
      }
      const data = asRecord(envelope.data);
      if (!data || !Object.prototype.hasOwnProperty.call(data, "codingPlanSignature")) {
        return { cacheable: true, enabled: false, httpStatus: response.status };
      }
      return {
        cacheable: true,
        enabled: asRecord(data.codingPlanSignature)?.enable === true,
        httpStatus: response.status,
      };
    } finally {
      clearTimeout(timer);
    }
  }
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

export function createClientRequestSigningV4Fetch(
  options: CreateClientRequestSigningV4FetchOptions,
): ProviderFetch {
  const signer = new ClientRequestSigningV4Signer(options);
  return async (input, init) => signer.request(input as RequestInfo, init);
}

class ClientRequestSigningV4Signer {
  private readonly apiKey: string | undefined;
  private readonly clientVersion: string;
  private readonly handshakeUrl: string;
  private readonly businessOrigin: string;
  private readonly transport: ProviderFetch;
  private readonly innerFetch: ProviderFetch;
  private readonly keyState: ClientSigningKeyState;
  private readonly ownsKeyState: boolean;
  private readonly observer: ((event: ClientSigningObservation) => void) | undefined;
  private readonly providerId: string;
  private readonly featureGate: CodingPlanSignatureFeatureGate;
  private credential: ClientSigningCredential | undefined;
  private bypassSigning = false;
  private activeRequests = 0;
  private disposed = false;
  private disposeRequested = false;

  constructor(options: CreateClientRequestSigningV4FetchOptions) {
    this.apiKey = options.apiKey;
    this.clientVersion = options.clientVersion.trim() || "unknown";
    this.handshakeUrl = resolveHandshakeUrl(options.baseURL, options.allowInsecureHttp ?? false);
    this.businessOrigin = new URL(this.handshakeUrl).origin;
    this.innerFetch = options.fetch;
    this.transport = options.transport;
    this.observer = options.observer;
    this.providerId = options.providerId;
    this.keyState = options.keyCache
      ? options.keyCache.resolve(options.apiKey ?? "", this.handshakeUrl)
      : { epoch: 0, privateKey: undefined, handshakePromise: undefined };
    this.ownsKeyState = !options.keyCache;
    // 门快照归 signer 自己所有：跨 provider 共享会引入进程级可变状态，
    // 而多出的那点往返（每 provider 每小时一次）不构成代价。
    this.featureGate = new CodingPlanSignatureFeatureGate({
      transport: options.transport,
      url: options.featureGateUrl,
      now: options.now,
      onResult: (result) => this.observe({ kind: "feature_gate", ...result }),
    });
  }

  async request(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    if (this.disposeRequested || this.disposed) {
      throw signingError("disposed", "Client request signer has been disposed.");
    }
    this.activeRequests += 1;
    const request = await makeReplayableRequest(input, init);
    try {
      if (new URL(request.url).origin !== this.businessOrigin) {
        return this.sendUnsigned(request, "origin_mismatch");
      }
      if (this.bypassSigning) return this.sendUnsigned(request, "bypass");
      let enabled: boolean;
      try {
        enabled = await this.featureGate.isEnabled(request.signal);
      } catch (cause) {
        if (request.signal?.aborted) throw cause;
        return this.sendUnsigned(request, "feature_gate_unavailable");
      }
      if (!enabled) return this.sendUnsigned(request, "feature_gate_disabled");

      const firstAttempt = await this.getKeyOrSendUnsigned(request);
      if ("response" in firstAttempt) return firstAttempt.response;
      let response = await this.sendSigned(request, firstAttempt.key, 1);
      const rejected = await readRefreshableSignatureReason(response);
      if (!rejected) return response;

      this.observe({ kind: "verify_rejected", reason: rejected, signedAttempt: 1 });
      this.invalidatePrivateKey(firstAttempt.key);
      const secondAttempt = await this.getKeyOrSendUnsigned(request);
      if ("response" in secondAttempt) return secondAttempt.response;
      response = await this.sendSigned(request, secondAttempt.key, 2);
      const stillRejected = await readRefreshableSignatureReason(response);
      if (!stillRejected) return response;

      this.observe({ kind: "verify_rejected", reason: stillRejected, signedAttempt: 2 });
      this.invalidatePrivateKey(secondAttempt.key);
      this.bypassSigning = true;
      this.observe({ kind: "bypass_entered" });
      return this.sendUnsigned(request, "verify_refresh_exhausted");
    } catch (cause) {
      if (cause instanceof ClientRequestSigningV4Error && !request.signal?.aborted) {
        this.observe({ kind: "request_failed_closed", errorKind: cause.kind });
      }
      throw cause;
    } finally {
      this.activeRequests -= 1;
      if (this.activeRequests === 0 && this.disposeRequested) this.finalizeDispose();
    }
  }

  dispose(): void {
    if (this.disposeRequested || this.disposed) return;
    this.disposeRequested = true;
    if (this.activeRequests === 0) this.finalizeDispose();
  }

  private finalizeDispose(): void {
    this.disposed = true;
    if (!this.ownsKeyState) return;
    this.keyState.epoch += 1;
    this.keyState.privateKey = undefined;
    this.keyState.handshakePromise = undefined;
  }

  private observe(event: ClientSigningObservationBody): void {
    if (!this.observer) return;
    try {
      this.observer({ ...event, providerId: this.providerId });
    } catch {
      // 观察回调不参与请求结果。
    }
  }

  private resolveCredential(): ClientSigningCredential {
    if (this.credential) return this.credential;
    const credential = parseClientSigningCredential(this.apiKey);
    if (!credential) {
      throw signingError("invalid-config", "Client signing credential must contain one separator.");
    }
    this.credential = credential;
    return credential;
  }

  private async ensurePrivateKey(signal?: AbortSignal): Promise<CryptoKey> {
    if (this.disposed) {
      throw signingError("disposed", "Client request signer has been disposed.");
    }
    if (this.keyState.privateKey) return this.keyState.privateKey;
    this.resolveCredential();
    if (this.keyState.handshakePromise) {
      return signal
        ? waitForPromiseOrAbort(this.keyState.handshakePromise, signal)
        : this.keyState.handshakePromise;
    }
    const epoch = this.keyState.epoch;
    const pending = this.performHandshake()
      .catch((cause: unknown) => {
        if (cause instanceof ClientRequestSigningV4Error) {
          this.observe({
            kind: "handshake_failed",
            errorKind: cause.kind,
            ...(cause.httpStatus === undefined ? {} : { httpStatus: cause.httpStatus }),
            ...(cause.businessCode === undefined ? {} : { businessCode: cause.businessCode }),
            ...(cause.reason === undefined ? {} : { reason: cause.reason }),
          });
        }
        throw cause;
      })
      .then((key) => {
        if ((this.ownsKeyState && this.disposed) || this.keyState.epoch !== epoch) {
          throw signingError("disposed", "Client request signer changed during handshake.");
        }
        this.keyState.privateKey = key;
        return key;
      });
    this.keyState.handshakePromise = pending;
    const clear = () => {
      if (this.keyState.handshakePromise === pending) this.keyState.handshakePromise = undefined;
    };
    pending.then(clear, clear);
    return signal ? waitForPromiseOrAbort(pending, signal) : pending;
  }

  /**
   * 握手类错误是 fail-open 候选：私钥拿不到时退化为无签名请求，
   * 而不是把套餐故障放大成模型请求失败。
   */
  private async getKeyOrSendUnsigned(
    request: ReplayableRequest,
  ): Promise<{ key: CryptoKey } | { response: Response }> {
    try {
      return { key: await this.ensurePrivateKey(request.signal) };
    } catch (cause) {
      if (cause instanceof ClientRequestSigningV4Error && cause.failOpenEligible) {
        return { response: await this.sendUnsigned(request, "handshake_failed") };
      }
      throw cause;
    }
  }

  private invalidatePrivateKey(key: CryptoKey): void {
    if (this.keyState.privateKey !== key) return;
    this.keyState.epoch += 1;
    this.keyState.privateKey = undefined;
    this.keyState.handshakePromise = undefined;
  }

  private async performHandshake(): Promise<CryptoKey> {
    const credential = this.resolveCredential();
    const ts = String(Date.now());
    const nonce = randomHex(NONCE_BYTES);
    let signature: string;
    try {
      signature = await createHandshakeSignature(
        credential.apiKeySecret,
        `${HANDSHAKE_ACTION}\n${credential.apiKeyId}\n${ts}\n${nonce}`,
      );
    } catch (cause) {
      throw signingError("cryptography", "Client signing handshake signature failed.", {
        cause,
        failOpenEligible: true,
      });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HANDSHAKE_TIMEOUT_MS);
    try {
      let response: Response;
      try {
        response = await this.transport(this.handshakeUrl, {
          body: JSON.stringify({
            apiKey: credential.credential,
            nonce,
            sig: signature,
            ts,
          }),
          headers: {
            Authorization: credential.credential,
            "Content-Type": "application/json",
          },
          method: "POST",
          redirect: "manual",
          signal: controller.signal,
        });
      } catch (cause) {
        const timedOut = controller.signal.aborted;
        throw signingError(
          timedOut ? "handshake-timeout" : "handshake-network",
          timedOut
            ? "Client signing handshake timed out."
            : "Client signing handshake failed.",
          { cause, failOpenEligible: true },
        );
      }
      if (response.status !== 200) {
        throw signingError("handshake-protocol", "Client signing handshake HTTP status is invalid.", {
          failOpenEligible: true,
          httpStatus: response.status,
        });
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch (cause) {
        const timedOut = controller.signal.aborted;
        throw signingError(
          timedOut ? "handshake-timeout" : "handshake-protocol",
          timedOut ? "Client signing handshake timed out." : "Client signing handshake JSON is invalid.",
          { cause, failOpenEligible: true },
        );
      }
      const envelope = asRecord(payload);
      if (!envelope) {
        throw signingError("handshake-protocol", "Client signing handshake JSON is invalid.", {
          failOpenEligible: true,
        });
      }
      if (envelope.code === 500) {
        throw signingError("handshake-server", "Client signing handshake reported code 500.", {
          businessCode: 500,
          failOpenEligible: true,
        });
      }
      if (envelope.code !== 200) {
        const reason = readHandshakeReason(envelope.msg);
        throw signingError("handshake-business", "Client signing handshake was rejected.", {
          ...(typeof envelope.code === "number" ? { businessCode: envelope.code } : {}),
          failOpenEligible: true,
          ...(reason === undefined ? {} : { reason }),
        });
      }
      const privateCipher = asRecord(envelope.data)?.privateCipher;
      if (typeof privateCipher !== "string" || !privateCipher) {
        throw signingError("handshake-protocol", "Client signing handshake omitted privateCipher.", {
          failOpenEligible: true,
        });
      }
      try {
        return await decryptSigningPrivateKey(
          credential.apiKeyId,
          credential.apiKeySecret,
          privateCipher,
        );
      } catch (cause) {
        throw signingError("cryptography", "Client signing private key is invalid.", {
          cause,
          failOpenEligible: true,
        });
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private async sendSigned(
    request: ReplayableRequest,
    key: CryptoKey,
    signedAttempt: number,
  ): Promise<Response> {
    const credential = this.resolveCredential();
    const sessionId = request.headers.get(SESSION_ID_HEADER)?.trim();
    if (!sessionId) {
      throw signingError("invalid-config", "Client request signing requires X-Session-Id.");
    }
    const headers = sanitizeClientSigningHeaders(request.headers);
    const ts = String(Date.now());
    const nonce = randomHex(NONCE_BYTES);
    let proofOfWork: string;
    try {
      proofOfWork = await createClientRequestProofOfWork({
        apiKeyId: credential.apiKeyId,
        appId: APP_ID,
        sessionId,
        ts,
        powBits: POW_BITS,
        signal: request.signal,
      });
    } catch (cause) {
      if (request.signal?.aborted) throw cause;
      throw signingError("cryptography", "Client request proof of work failed.", { cause });
    }
    let signature: string;
    try {
      signature = await signBusinessMessage(
        key,
        `${credential.apiKeyId}\n${ts}\n${this.clientVersion}\n${sessionId}\n${nonce}`,
      );
    } catch (cause) {
      throw signingError("cryptography", "Client request signing failed.", { cause });
    }
    headers.set("X-Client-Ts", ts);
    headers.set("X-Client-Version", this.clientVersion);
    headers.set("X-Client-Sig", signature);
    headers.set(SESSION_ID_HEADER, sessionId);
    headers.set("X-Client-Nonce", nonce);
    headers.set("X-App-Id", APP_ID);
    headers.set("X-Client-Pow", proofOfWork);
    this.observe({ kind: "signed_sent", signedAttempt });
    return this.innerFetch(request.url, buildRequestInit(request, headers));
  }

  private sendUnsigned(
    request: ReplayableRequest,
    reason: Extract<ClientSigningObservation, { kind: "unsigned_sent" }>["reason"],
  ): Promise<Response> {
    this.observe({ kind: "unsigned_sent", reason });
    return this.innerFetch(
      request.url,
      buildRequestInit(request, sanitizeClientSigningHeaders(request.headers)),
    );
  }
}

interface ReplayableRequest {
  readonly url: string;
  readonly headers: Headers;
  readonly body: Uint8Array<ArrayBuffer> | undefined;
  readonly method: string;
  readonly credentials: RequestCredentials;
  readonly cache: RequestCache;
  readonly integrity: string;
  readonly keepalive: boolean;
  readonly mode: RequestMode;
  readonly redirect: RequestRedirect;
  readonly referrer: string;
  readonly referrerPolicy: ReferrerPolicy;
  readonly signal: AbortSignal | undefined;
}

/**
 * 把 fetch 入参固化成可重放形态：401 刷新后要用同一份 body 再发一次，
 * 直接把已消费的 stream 交给第二次 fetch 只会得到空 body。
 */
async function makeReplayableRequest(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<ReplayableRequest> {
  const request = new Request(input as RequestInfo, init);
  const method = request.method;
  const body =
    method === "GET" || method === "HEAD"
      ? undefined
      : new Uint8Array<ArrayBuffer>(await request.arrayBuffer());
  return {
    url: request.url,
    headers: new Headers(request.headers),
    body,
    method,
    credentials: request.credentials,
    cache: request.cache,
    integrity: request.integrity,
    keepalive: request.keepalive,
    mode: request.mode,
    redirect: request.redirect,
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
    signal: request.signal ?? undefined,
  };
}

function buildRequestInit(request: ReplayableRequest, headers: Headers): RequestInit {
  return {
    ...(request.body ? { body: request.body.slice() } : {}),
    cache: request.cache,
    credentials: request.credentials,
    headers,
    integrity: request.integrity,
    keepalive: request.keepalive,
    method: request.method,
    mode: request.mode,
    redirect: request.redirect,
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
    signal: request.signal,
  };
}

async function readRefreshableSignatureReason(response: Response): Promise<string | undefined> {
  if (response.status !== 401) return undefined;
  try {
    const payload: unknown = await response.clone().json();
    const envelope = asRecord(payload);
    if (!envelope) return undefined;
    const data = asRecord(envelope.data);
    const error = asRecord(envelope.error);
    const candidate = [
      envelope.msg,
      envelope.reason,
      data?.reason,
      error?.reason,
      error?.message,
    ].find((value) => REFRESHABLE_REASONS.includes(value as (typeof REFRESHABLE_REASONS)[number]));
    return typeof candidate === "string" ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function readHandshakeReason(value: unknown): string | undefined {
  return typeof value === "string" && /^HANDSHAKE_[A-Z_]+$/.test(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function randomHex(bytes: number): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(bytes) as Uint8Array<ArrayBuffer>));
}

function bytesToHex(bytes: Uint8Array<ArrayBuffer>): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64(bytes: Uint8Array<ArrayBuffer>): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error("invalid base64");
  }
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeUtf8(value: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(value);
}

function waitForPromiseOrAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
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

function signingError(
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
