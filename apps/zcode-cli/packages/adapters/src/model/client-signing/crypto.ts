/**
 * 客户端请求签名 V4 的密码学原语：HKDF 派生、握手 HMAC、
 * AES-GCM 私钥解密、Ed25519 业务签名与工作量证明。
 */

import {
  AES_GCM_IV_BYTES,
  AES_GCM_TAG_BITS,
  KDF_SALT,
  HKDF_INFO_HANDSHAKE,
  HKDF_INFO_PRIVATE_KEY,
  POW_BITS,
  POW_COUNTER_HEX_DIGITS,
  POW_COUNTER_MAX,
  POW_RANDOM_BYTES,
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  encodeUtf8,
  randomHex,
} from "./shared.js";

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

export async function createHandshakeSignature(secret: string, message: string): Promise<string> {
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
