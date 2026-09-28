/**
 * 客户端请求签名 V4 的控制面握手：POST /api/paas/c1f3a7e2/v2/client，
 * 换取并解密 Ed25519 业务签名私钥。纯协议步骤，不持有状态。
 */

import type { ClientSigningCredential } from "./credential.js";
import { createHandshakeSignature, decryptSigningPrivateKey } from "./crypto.js";
import {
  HANDSHAKE_ACTION,
  HANDSHAKE_TIMEOUT_MS,
  NONCE_BYTES,
  type ProviderFetch,
  asRecord,
  discardResponseBody,
  randomHex,
  signingError,
} from "./shared.js";

export async function performSigningHandshake(options: {
  readonly credential: ClientSigningCredential;
  readonly handshakeUrl: string;
  readonly transport: ProviderFetch;
}): Promise<CryptoKey> {
  const { credential, handshakeUrl, transport } = options;
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
      response = await transport(handshakeUrl, {
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
        timedOut ? "Client signing handshake timed out." : "Client signing handshake failed.",
        { cause, failOpenEligible: true },
      );
    }
    if (response.status !== 200) {
      // 失败路径同样要释放 body，握手失败会退化为无签名请求并反复重试。
      await discardResponseBody(response);
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
        timedOut
          ? "Client signing handshake timed out."
          : "Client signing handshake JSON is invalid.",
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

function readHandshakeReason(value: unknown): string | undefined {
  return typeof value === "string" && /^HANDSHAKE_[A-Z_]+$/.test(value) ? value : undefined;
}
