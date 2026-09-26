/**
 * ZCode 客户端请求签名 V4 的回归门（specs/zcode-client-signing/client-request-signing-v4.md）。
 *
 * 断言面：
 * - 凭据解析、签名头清洗、PoW 前导零比特与前缀一致性。
 * - 握手签名确定性；私钥解密链路（HKDF → AES-GCM → PKCS8 Ed25519）。
 * - 端到端：门开且握手成功时请求带全部 7 个头，签名可用同一公钥按头值复原的消息验证。
 * - 降级路径：门关 / 门异常 / 握手失败 / 非官方 origin / bypass 一律无签名且请求照常送达。
 * - fail closed：判定要签但缺 X-Session-Id 时抛错，而不是静默发无签名请求。
 * - 401 刷新：作废私钥 → 重新握手 → 再签一次；仍被拒则转 bypass，后续请求不再签。
 * - 重试不叠加旧签名头。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const APP_ID = "zcode";
const API_KEY_ID = "kid-1";
const API_KEY_SECRET = "s3cr3t-value";
const API_KEY = `${API_KEY_ID}.${API_KEY_SECRET}`;
const CLIENT_VERSION = "3.14.3";
const OFFICIAL_BASE_URL = "https://api.z.ai";
const HANDSHAKE_URL = "https://api.z.ai/api/paas/c1f3a7e2/v2/client";
const SESSION_ID = "sess_abc";
const POW_BITS = 8;

/** 一次性编译 TS 模块：测试直接跑源码，避免引入测试框架。 */
const moduleDir = await mkdtemp(join(tmpdir(), "cua-signing-"));
const modulePath = join(moduleDir, "client-request-signing.mjs");
await build({
  bundle: true,
  entryPoints: [join(packageRoot, "src/model/client-request-signing.ts")],
  format: "esm",
  outfile: modulePath,
  platform: "neutral",
  target: "node24",
});
const signing = await import(modulePath);
process.on("exit", () => {
  void rm(moduleDir, { force: true, recursive: true });
});

const textEncoder = new TextEncoder();

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

async function deriveBytes(secret, info) {
  const material = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    "HKDF",
    false,
    ["deriveBits"],
  );
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { hash: "SHA-256", info: textEncoder.encode(info), name: "HKDF", salt: textEncoder.encode("WD_CLIENT_SIGN_KDF_SALT") },
      material,
      256,
    ),
  );
}

/** 造一个 Ed25519 身份，并按官方算法把私钥加密成握手响应里的 privateCipher。 */
async function createSigningIdentity() {
  const keypair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keypair.privateKey));
  const derived = await deriveBytes(API_KEY_SECRET, "ed25519_priv");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aesKey = await crypto.subtle.importKey("raw", derived, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { additionalData: textEncoder.encode(API_KEY_ID), iv, name: "AES-GCM", tagLength: 128 },
      aesKey,
      textEncoder.encode(toBase64(pkcs8)),
    ),
  );
  const blob = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  blob.set(iv, 0);
  blob.set(ciphertext, iv.byteLength);
  return { privateCipher: toBase64(blob), publicKey: keypair.publicKey };
}

function gateResponse(enabled) {
  return new Response(
    JSON.stringify({ code: 0, data: { codingPlanSignature: { enable: enabled } } }),
    { headers: { "content-type": "application/json" } },
  );
}

function handshakeResponse(privateCipher) {
  return new Response(JSON.stringify({ code: 200, data: { privateCipher } }), {
    headers: { "content-type": "application/json" },
  });
}

function signatureRejected(reason) {
  return new Response(JSON.stringify({ code: 401, msg: reason }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

/**
 * 假出口：把控制面（功能门 / 握手）与业务面分开记账，
 * 以便断言「握手走最内层 transport」以及降级路径不会产生多余往返。
 */
function createFakeExit(handlers) {
  const controlCalls = [];
  const businessCalls = [];
  const control = async (url, init) => {
    controlCalls.push({ url: String(url), init });
    if (String(url).includes("/api/v1/agent/configs")) return handlers.gate();
    return handlers.handshake();
  };
  const business = async (url, init) => {
    const headers = new Headers(init?.headers);
    businessCalls.push({ url: String(url), headers, init });
    return handlers.business(headers);
  };
  return { business, businessCalls, control, controlCalls };
}

function modelRequest(overrides = {}) {
  return {
    apiKey: API_KEY,
    baseURL: OFFICIAL_BASE_URL,
    clientVersion: CLIENT_VERSION,
    featureGateUrl: "https://zcode.z.ai/api/v1/agent/configs",
    providerId: "zhipu-coding-plan",
    ...overrides,
  };
}

function modelCall(headers = { "X-Session-Id": SESSION_ID }) {
  return {
    init: {
      body: JSON.stringify({ model: "glm-4.6" }),
      headers,
      method: "POST",
    },
    url: `${OFFICIAL_BASE_URL}/api/anthropic/v1/messages`,
  };
}

test("凭据解析：恰好一个分隔符且两侧非空", () => {
  assert.deepEqual(signing.parseClientSigningCredential(API_KEY), {
    apiKeyId: API_KEY_ID,
    apiKeySecret: API_KEY_SECRET,
    credential: API_KEY,
  });
  assert.equal(signing.parseClientSigningCredential(undefined), undefined);
  assert.equal(signing.parseClientSigningCredential(""), undefined);
  assert.equal(signing.parseClientSigningCredential("no-separator"), undefined);
  assert.equal(signing.parseClientSigningCredential("a.b.c"), undefined);
  assert.equal(signing.parseClientSigningCredential(".secret"), undefined);
  assert.equal(signing.parseClientSigningCredential("kid."), undefined);
  assert.equal(signing.parseClientSigningCredential("  .secret"), undefined);
});

test("握手 URL 只接受 HTTPS，路径固定", () => {
  assert.equal(
    signing.resolveHandshakeUrl(OFFICIAL_BASE_URL),
    "https://api.z.ai/api/paas/c1f3a7e2/v2/client",
  );
  assert.equal(
    signing.resolveHandshakeUrl("http://localhost:8080", true),
    "http://localhost:8080/api/paas/c1f3a7e2/v2/client",
  );
  assert.throws(() => signing.resolveHandshakeUrl("http://api.z.ai"), /HTTPS/);
  assert.throws(() => signing.resolveHandshakeUrl("not-a-url"), /valid baseURL/);
});

test("签名头清洗会删掉全部 7 个签名头", () => {
  const headers = new Headers({
    "X-Client-Ts": "1",
    "X-Client-Version": "3.14.3",
    "X-Client-Sig": "sig",
    "X-Client-Nonce": "nonce",
    "X-Client-Pow": "pow",
    "X-App-Id": "zcode",
    "X-Client-Sign-Verified": "1",
    "X-Session-Id": SESSION_ID,
    "x-request-id": "req-1",
  });
  const sanitized = signing.sanitizeClientSigningHeaders(headers);
  assert.equal(sanitized.get("X-Session-Id"), SESSION_ID);
  assert.equal(sanitized.get("x-request-id"), "req-1");
  for (const name of [
    "X-Client-Ts",
    "X-Client-Version",
    "X-Client-Sig",
    "X-Client-Nonce",
    "X-Client-Pow",
    "X-App-Id",
    "X-Client-Sign-Verified",
  ]) {
    assert.equal(sanitized.get(name), null, `${name} 应被删除`);
  }
});

test("前导零比特判定覆盖整字节与不足一字节两种边界", () => {
  assert.equal(signing.hasLeadingZeroBits(new Uint8Array([0, 0, 0x10]), 8), true);
  assert.equal(signing.hasLeadingZeroBits(new Uint8Array([0x01, 0x00]), 8), false);
  assert.equal(signing.hasLeadingZeroBits(new Uint8Array([0x00]), 0), true);
  assert.equal(signing.hasLeadingZeroBits(new Uint8Array([0xff]), 1), false);
  assert.equal(signing.hasLeadingZeroBits(new Uint8Array([0x7f]), 1), true);
  // 0x40 = 0b0100_0000，前 2 位不是零；判定按字节内高位算，不做近似。
  assert.equal(signing.hasLeadingZeroBits(new Uint8Array([0x40]), 2), false);
  assert.equal(signing.hasLeadingZeroBits(new Uint8Array([0x3f]), 2), true);
  assert.equal(signing.hasLeadingZeroBits(new Uint8Array([0x80]), 2), false);
});

test("PoW 解满足前导零比特且前缀与 sha256 输入一致", async () => {
  const ts = "1700000000000";
  const solution = await signing.createClientRequestProofOfWork({
    apiKeyId: API_KEY_ID,
    appId: APP_ID,
    sessionId: SESSION_ID,
    ts,
  });
  const seed = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      textEncoder.encode(`${API_KEY_ID}\n${APP_ID}\n${SESSION_ID}\n${ts}`),
    ),
  );
  const prefix = bytesToHex(seed).slice(0, 32);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", textEncoder.encode(`${prefix}\n${solution}`)),
  );
  assert.ok(signing.hasLeadingZeroBits(digest, POW_BITS), "PoW 解必须满足前导 8 个零比特");
  assert.equal(solution.length, 12 * 2 + 8, "PoW 解 = 12 字节随机 + 8 位十六进制计数器");
  await assert.rejects(
    signing.createClientRequestProofOfWork({
      apiKeyId: API_KEY_ID,
      appId: APP_ID,
      sessionId: SESSION_ID,
      ts,
      powBits: 33,
    }),
    /powBits/,
  );
});

test("握手签名对同一输入确定，对不同密钥敏感", async () => {
  const message = `get_sign_key\n${API_KEY_ID}\n1700000000000\n0123456789abcdef0123456789abcdef`;
  const first = await signing.createHandshakeSignature(API_KEY_SECRET, message);
  const again = await signing.createHandshakeSignature(API_KEY_SECRET, message);
  const other = await signing.createHandshakeSignature("another-secret", message);
  assert.equal(first, again);
  assert.notEqual(first, other);
  assert.equal(Buffer.from(first, "base64").byteLength, 32);

  // 独立复算：HKDF(secret, getSignKey_hmac) → HMAC-SHA256(message)
  const derived = await deriveBytes(API_KEY_SECRET, "getSignKey_hmac");
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    derived,
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const expected = toBase64(
    new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, textEncoder.encode(message))),
  );
  assert.equal(first, expected);
});

test("私钥解密链路能从官方 privateCipher 复原出可签名的 Ed25519 key", async () => {
  const identity = await createSigningIdentity();
  const key = await signing.decryptSigningPrivateKey(
    API_KEY_ID,
    API_KEY_SECRET,
    identity.privateCipher,
  );
  const message = "handshake";
  const signature = await signing.signBusinessMessage(key, message);
  const raw = fromBase64(signature);
  assert.equal(await crypto.subtle.verify("Ed25519", identity.publicKey, raw, textEncoder.encode(message)), true);

  // AAD 绑定了 apiKeyId，换一个 id 必须解不开。
  await assert.rejects(
    () => signing.decryptSigningPrivateKey("other-kid", API_KEY_SECRET, identity.privateCipher),
    /operation|decrypt/i,
  );
});

test("门开 + 握手成功：请求带全部签名头且签名可验证", async () => {
  const identity = await createSigningIdentity();
  const fake = createFakeExit({
    business: () => new Response("{}", { status: 200 }),
    gate: () => gateResponse(true),
    handshake: () => handshakeResponse(identity.privateCipher),
  });
  const signedFetch = signing.createClientRequestSigningV4Fetch({
    ...modelRequest(),
    fetch: fake.business,
    transport: fake.control,
  });

  const call = modelCall();
  const response = await signedFetch(call.url, call.init);
  assert.equal(response.status, 200);
  assert.equal(fake.businessCalls.length, 1);
  const headers = fake.businessCalls[0].headers;

  assert.equal(headers.get("X-App-Id"), APP_ID);
  assert.equal(headers.get("X-Client-Version"), CLIENT_VERSION);
  assert.equal(headers.get("X-Session-Id"), SESSION_ID);
  const ts = headers.get("X-Client-Ts");
  const nonce = headers.get("X-Client-Nonce");
  const sig = headers.get("X-Client-Sig");
  const pow = headers.get("X-Client-Pow");
  assert.ok(ts && /^\d+$/.test(ts), "X-Client-Ts 必须是毫秒时间戳");
  assert.ok(nonce && nonce.length === 32, "X-Client-Nonce 必须是 16 字节 hex");
  assert.ok(pow, "X-Client-Pow 必须存在");
  assert.equal(
    await crypto.subtle.verify(
      "Ed25519",
      identity.publicKey,
      fromBase64(sig),
      textEncoder.encode(`${API_KEY_ID}\n${ts}\n${CLIENT_VERSION}\n${SESSION_ID}\n${nonce}`),
    ),
    true,
    "X-Client-Sig 必须能按头值复原的消息验证通过",
  );

  // body 可重放：刷新后第二次发送仍带同一份 body。
  assert.equal(fake.businessCalls[0].init.body.byteLength, call.init.body.length);

  assert.deepEqual(
    fake.controlCalls.map((call2) => call2.url),
    ["https://zcode.z.ai/api/v1/agent/configs", HANDSHAKE_URL],
    "功能门与握手都走最内层 transport",
  );
  const handshakeInit = fake.controlCalls[1].init;
  assert.equal(handshakeInit.method, "POST");
  assert.equal(handshakeInit.headers.Authorization, API_KEY);
  const handshakeBody = JSON.parse(handshakeInit.body);
  assert.equal(handshakeBody.apiKey, API_KEY);
  assert.equal(handshakeBody.nonce.length, 32);
  assert.ok(handshakeBody.sig && handshakeBody.ts);
});

test("门关：不握手、不带签名头、请求照常送达", async () => {
  let handshakeCalls = 0;
  const fake = createFakeExit({
    business: () => new Response("{}", { status: 200 }),
    gate: () => gateResponse(false),
    handshake: () => {
      handshakeCalls += 1;
      return handshakeResponse("unused");
    },
  });
  const signedFetch = signing.createClientRequestSigningV4Fetch({
    ...modelRequest(),
    fetch: fake.business,
    transport: fake.control,
  });
  const call = modelCall();
  await signedFetch(call.url, call.init);
  assert.equal(handshakeCalls, 0);
  assert.equal(fake.businessCalls[0].headers.get("X-Client-Sig"), null);
  assert.equal(fake.businessCalls[0].headers.get("X-App-Id"), null);
});

test("门查询异常：降级为无签名而不是让请求失败", async () => {
  const fake = createFakeExit({
    business: () => new Response("{}", { status: 200 }),
    gate: () => new Response("nope", { status: 500 }),
    handshake: () => handshakeResponse("unused"),
  });
  const signedFetch = signing.createClientRequestSigningV4Fetch({
    ...modelRequest(),
    fetch: fake.business,
    transport: fake.control,
  });
  const call = modelCall();
  const response = await signedFetch(call.url, call.init);
  assert.equal(response.status, 200);
  assert.equal(fake.businessCalls[0].headers.get("X-Client-Sig"), null);
});

test("握手失败：降级为无签名", async () => {
  const fake = createFakeExit({
    business: () => new Response("{}", { status: 200 }),
    gate: () => gateResponse(true),
    handshake: () => new Response(JSON.stringify({ code: 500, msg: "boom" }), { status: 200 }),
  });
  const signedFetch = signing.createClientRequestSigningV4Fetch({
    ...modelRequest(),
    fetch: fake.business,
    transport: fake.control,
  });
  const call = modelCall();
  const response = await signedFetch(call.url, call.init);
  assert.equal(response.status, 200);
  assert.equal(fake.businessCalls[0].headers.get("X-Client-Sig"), null);
});

test("非官方 origin：不签名，也不产生功能门与握手往返", async () => {
  const fake = createFakeExit({
    business: () => new Response("{}", { status: 200 }),
    gate: () => gateResponse(true),
    handshake: () => handshakeResponse("unused"),
  });
  const signedFetch = signing.createClientRequestSigningV4Fetch({
    ...modelRequest(),
    fetch: fake.business,
    transport: fake.control,
  });
  const response = await signedFetch("https://third-party.example.com/v1/messages", {
    headers: { "X-Session-Id": SESSION_ID },
    method: "POST",
  });
  assert.equal(response.status, 200);
  assert.equal(fake.controlCalls.length, 0, "origin 不匹配时不应查询功能门或握手");
  assert.equal(fake.businessCalls[0].headers.get("X-Client-Sig"), null);
});

test("判定要签但缺 X-Session-Id：fail closed", async () => {
  const identity = await createSigningIdentity();
  const fake = createFakeExit({
    business: () => new Response("{}", { status: 200 }),
    gate: () => gateResponse(true),
    handshake: () => handshakeResponse(identity.privateCipher),
  });
  const signedFetch = signing.createClientRequestSigningV4Fetch({
    ...modelRequest(),
    fetch: fake.business,
    transport: fake.control,
  });
  await assert.rejects(
    () => signedFetch(`${OFFICIAL_BASE_URL}/api/anthropic/v1/messages`, { method: "POST" }),
    (error) => {
      assert.equal(error.name, "ClientRequestSigningV4Error");
      assert.equal(error.kind, "invalid-config");
      assert.match(error.message, /X-Session-Id/);
      return true;
    },
  );
  assert.equal(fake.businessCalls.length, 0, "fail closed 时不得发出业务请求");
});

test("401 刷新：重新握手后再签一次，仍被拒则转 bypass", async () => {
  const first = await createSigningIdentity();
  const second = await createSigningIdentity();
  let handshakeCount = 0;
  let businessCount = 0;
  const fake = createFakeExit({
    business: () => {
      businessCount += 1;
      return businessCount <= 2
        ? signatureRejected("VERIFY_SIGNATURE_INVALID")
        : new Response("{}", { status: 200 });
    },
    gate: () => gateResponse(true),
    handshake: () => handshakeResponse((handshakeCount++ === 0 ? first : second).privateCipher),
  });
  const signedFetch = signing.createClientRequestSigningV4Fetch({
    ...modelRequest(),
    fetch: fake.business,
    transport: fake.control,
  });

  const call = modelCall();
  const response = await signedFetch(call.url, call.init);
  assert.equal(response.status, 200, "第二次签名尝试后应返回上游响应");
  assert.equal(handshakeCount, 2, "被拒后必须重新握手");
  assert.equal(businessCount, 3, "首发 + 刷新重发 + 兜底无签名");
  const [firstSigned, secondSigned, bypassed] = fake.businessCalls;
  assert.notEqual(
    firstSigned.headers.get("X-Client-Nonce"),
    secondSigned.headers.get("X-Client-Nonce"),
    "重发不得复用上一次 nonce",
  );
  assert.notEqual(
    firstSigned.headers.get("X-Client-Sig"),
    secondSigned.headers.get("X-Client-Sig"),
    "重发不得复用上一次签名",
  );
  assert.equal(bypassed.headers.get("X-Client-Sig"), null, "刷新用尽后兜底不带签名");

  // 后续请求走 bypass，不再握手。
  const after = modelCall();
  await signedFetch(after.url, after.init);
  assert.equal(handshakeCount, 2, "bypass 后不再握手");
  assert.equal(fake.businessCalls[3].headers.get("X-Client-Sig"), null);
});

test("401 但原因不匹配签名刷新时直接原样返回，不重发", async () => {
  const identity = await createSigningIdentity();
  let businessCount = 0;
  const fake = createFakeExit({
    business: () => {
      businessCount += 1;
      return businessCount === 1 ? signatureRejected("QUOTA_EXCEEDED") : new Response("{}", { status: 200 });
    },
    gate: () => gateResponse(true),
    handshake: () => handshakeResponse(identity.privateCipher),
  });
  const signedFetch = signing.createClientRequestSigningV4Fetch({
    ...modelRequest(),
    fetch: fake.business,
    transport: fake.control,
  });
  const call = modelCall();
  const response = await signedFetch(call.url, call.init);
  assert.equal(response.status, 401, "非签名原因的 401 不应被客户端吞掉或重试");
  assert.equal(businessCount, 1);
});

test("功能门结果按 TTL 缓存，不重复往返", async () => {
  const identity = await createSigningIdentity();
  let gateCount = 0;
  const fake = createFakeExit({
    business: () => new Response("{}", { status: 200 }),
    gate: () => {
      gateCount += 1;
      return gateResponse(true);
    },
    handshake: () => handshakeResponse(identity.privateCipher),
  });
  let now = 1_000;
  const signedFetch = signing.createClientRequestSigningV4Fetch({
    ...modelRequest(),
    fetch: fake.business,
    transport: fake.control,
    now: () => now,
  });
  for (let index = 0; index < 3; index += 1) {
    const call = modelCall();
    await signedFetch(call.url, call.init);
  }
  assert.equal(gateCount, 1, "TTL 内只查一次功能门");
  assert.equal(fake.businessCalls.length, 3);

  now += 3_600_001;
  const call = modelCall();
  await signedFetch(call.url, call.init);
  assert.equal(gateCount, 2, "TTL 过期后重新查询");
});

test("codingPlanSignature 缺失按关闭处理且可缓存", async () => {
  let gateCount = 0;
  const fake = createFakeExit({
    business: () => new Response("{}", { status: 200 }),
    gate: () => {
      gateCount += 1;
      return new Response(JSON.stringify({ code: 0, data: {} }), {
        headers: { "content-type": "application/json" },
      });
    },
    handshake: () => handshakeResponse("unused"),
  });
  const signedFetch = signing.createClientRequestSigningV4Fetch({
    ...modelRequest(),
    fetch: fake.business,
    transport: fake.control,
  });
  for (let index = 0; index < 2; index += 1) {
    const call = modelCall();
    await signedFetch(call.url, call.init);
  }
  assert.equal(gateCount, 1);
  assert.equal(fake.businessCalls[0].headers.get("X-Client-Sig"), null);
});
