/**
 * 可重放请求形态：401 刷新后要用同一份 body 再发一次，
 * 直接把已消费的 stream 交给第二次 fetch 只会得到空 body。
 */

export interface ReplayableRequest {
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

export async function makeReplayableRequest(
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

export function buildRequestInit(request: ReplayableRequest, headers: Headers): RequestInit {
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
