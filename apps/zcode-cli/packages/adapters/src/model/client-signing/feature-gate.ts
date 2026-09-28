/**
 * Coding Plan 签名功能门客户端：GET /api/v1/agent/configs，
 * 单飞行请求 + 可缓存快照。客户端只忠实反映门结果，不自行决定权益。
 */

import {
  FEATURE_GATE_CACHE_TTL_MS,
  FEATURE_GATE_TIMEOUT_MS,
  type ProviderFetch,
  asRecord,
  discardResponseBody,
  waitForPromiseOrAbort,
} from "./shared.js";

interface FeatureGateResult {
  readonly cacheable: boolean;
  readonly enabled: boolean;
  readonly failure?: string;
  readonly httpStatus?: number;
}

export class CodingPlanSignatureFeatureGate {
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly transport: ProviderFetch;
  private readonly url: string;
  private snapshot: { enabled: boolean; expiresAt: number } | undefined;
  private request: Promise<FeatureGateResult> | undefined;
  private readonly onResult: ((result: FeatureGateResult) => void) | undefined;

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
    const result = signal ? await waitForPromiseOrAbort(this.request, signal) : await this.request;
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
      } catch {
        return controller.signal.aborted
          ? { cacheable: false, enabled: false, failure: "timeout" }
          : { cacheable: false, enabled: false, failure: "network" };
      }
      if (!response.ok) {
        // 失败不可缓存 → 后续模型请求会反复打功能门，必须释放 body 归还连接。
        await discardResponseBody(response);
        return {
          cacheable: false,
          enabled: false,
          failure: "http_status",
          httpStatus: response.status,
        };
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        return {
          cacheable: false,
          enabled: false,
          failure: "malformed",
          httpStatus: response.status,
        };
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
