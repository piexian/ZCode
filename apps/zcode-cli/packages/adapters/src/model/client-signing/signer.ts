/**
 * 客户端请求签名 V4 的请求编排器：功能门 → 握手取钥 → PoW+签名发送，
 * 以及 401 刷新一次、仍拒则 bypass 的状态机。事件顺序与失败语义
 * 见 specs/zcode-client-signing/client-request-signing-v4.md。
 */

import type {
  ClientSigningCredential,
  ClientSigningKeyCache,
  ClientSigningKeyState,
} from "./credential.js";
import {
  parseClientSigningCredential,
  resolveHandshakeUrl,
  sanitizeClientSigningHeaders,
} from "./credential.js";
import { createClientRequestProofOfWork, signBusinessMessage } from "./crypto.js";
import { CodingPlanSignatureFeatureGate } from "./feature-gate.js";
import { performSigningHandshake } from "./handshake.js";
import {
  buildRequestInit,
  makeReplayableRequest,
  type ReplayableRequest,
} from "./replayable-request.js";
import {
  APP_ID,
  NONCE_BYTES,
  POW_BITS,
  type ProviderFetch,
  REFRESHABLE_REASONS,
  SESSION_ID_HEADER,
  type ClientSigningObservation,
  type ClientSigningObservationBody,
  ClientRequestSigningV4Error,
  asRecord,
  randomHex,
  signingError,
  waitForPromiseOrAbort,
} from "./shared.js";

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
    const pending = performSigningHandshake({
      credential: this.resolveCredential(),
      handshakeUrl: this.handshakeUrl,
      transport: this.transport,
    })
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
