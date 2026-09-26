# ZCode 客户端请求签名 V4

官方 3.14.3 客户端对官方 Coding Plan 端点的每个模型请求附带一组签名头（`X-Client-Sig` 等），上游据此判定调用方身份与套餐权益。开源版当前一个都不发，请求会被当作未验证调用方，套餐权益静默失效。本文规定该能力的规则、所有者、接口与验收标准。

证据基线：`/root/zcode-official-extracted/win/agent/zcode.cjs`（官方 agent bundle，9 处 `ClientRequestSigningV4` 符号、13 处 `clientRequestSigning` 引用）。本文只描述行为契约，不复制实现代码。

## 1. 产品规则

1. 只有官方端点（`api.z.ai`、`open.bigmodel.cn`）的模型请求参与签名。其余 provider、自建端点、第三方服务一律不发签名头。
2. 签名头是「附加」而非「替代」：现有 `x-request-id`、`x-zcode-session-type`、`x-zcode-trace-id`、`x-query-id`、`x-session-id` 与 `buildZCodeSourceHeaders` 的指纹头保持不变。
3. 签名失败不得阻断模型请求。握手失败、门禁不可用、凭据格式不符、origin 不匹配一律降级为无签名请求；只有「已判定要签、但缺少 `X-Session-Id`」这种内部不一致才 fail closed。
4. 签名不得成为重试放大源。同一请求最多 2 次签名尝试（首发 + 401 刷新后），刷新仍被拒则本次进程内该凭据转入 bypass，不再签。
5. 客户端不自行决定权益。是否签名由上游功能门决定，客户端只忠实反映门结果。

## 2. 协议常量

| 常量              | 值                             | 用途                                |
| ----------------- | ------------------------------ | ----------------------------------- |
| KDF salt          | `WD_CLIENT_SIGN_KDF_SALT`      | HKDF-SHA256 salt                    |
| HKDF info（握手） | `getSignKey_hmac`              | 派生 HMAC 密钥                      |
| HKDF info（私钥） | `ed25519_priv`                 | 派生 AES-GCM 密钥                   |
| app id            | `zcode`                        | 参与 PoW 前缀与 `X-App-Id`          |
| 握手 action       | `get_sign_key`                 | 握手签名前缀                        |
| 握手路径          | `/api/paas/c1f3a7e2/v2/client` | 相对 origin                         |
| 握手超时          | 10 000 ms                      | AbortController                     |
| nonce 字节数      | 16                             | 握手与业务各一次                    |
| PoW bits          | 8                              | 前导零比特                          |
| 功能门路径        | `/api/v1/agent/configs`        | 相对 ZCode 平台 origin              |
| 功能门缓存        | 3 600 000 ms                   | 进程内                              |
| 功能门超时        | 15 000 ms                      | AbortController                     |
| 客户端版本        | `ZCODE_VERSION`                | 参与业务签名串与 `X-Client-Version` |

## 3. 算法

### 3.1 凭据解析

api key 形如 `<apiKeyId>.<apiKeySecret>`。恰好一个 `.`、两侧去空白后非空才算合法；否则视为不参与签名。

### 3.2 握手

```text
ts     = String(Date.now())
nonce  = randomHex(16)                    // 32 个 hex 字符
sig    = base64(HMAC-SHA256(derive(secret, "getSignKey_hmac"), "get_sign_key\n{apiKeyId}\n{ts}\n{nonce}"))
POST {handshakeOrigin}/api/paas/c1f3a7e2/v2/client
  Authorization: <完整凭据>
  Content-Type: application/json
  { apiKey: <完整凭据>, nonce, sig, ts }
```

`derive(secret, info)` = `HKDF-SHA256(IKM = utf8(secret), salt = utf8("WD_CLIENT_SIGN_KDF_SALT"), info = utf8(info), L = 256)`。

响应要求 HTTP 200 且 `{ code: 200, data: { privateCipher } }`。`code === 500` 归为服务端错误；其它非 200 业务码归为业务拒绝；`msg` 形如 `HANDSHAKE_*` 时作为 reason 记录。`code !== 200` 与所有传输层失败都是 fail-open 候选。

### 3.3 私钥解密

```text
blob = base64decode(privateCipher)       // 必须 > 12 + 16 字节
iv   = blob[0..12)
ct   = blob[12..)
key  = derive(apiKeySecret, "ed25519_priv")
pkcs8 = utf8decode(AES-GCM-decrypt(key, ct, iv, aad = utf8(apiKeyId)))
signKey = importKey("pkcs8", base64decode(pkcs8), "Ed25519", ["sign"])
```

### 3.4 业务签名

```text
msg  = "{apiKeyId}\n{ts}\n{clientVersion}\n{sessionId}\n{nonce}"
sig  = base64(Ed25519-sign(signKey, utf8(msg)))
```

签名**不绑定 URL**，因此网关改写不会让签名失效；origin 只用于「是否参与签名」的策略判断。

### 3.5 工作量证明

```text
prefix = hex(sha256("{apiKeyId}\n{appId}\n{sessionId}\n{ts}")).slice(0, 32)
nonce  = randomHex(12) + counter.toString(16).padStart(8, "0")   // counter 从 0 单调到 0xFFFFFFFF
digest = sha256("{prefix}\n{nonce}")                              // 命中前导 powBits 个零比特即采用
```

`powBits` 必须是 0..32 的整数；`signal` 在每次迭代前检查中止。

### 3.6 发送头

| 头                 | 值                         |
| ------------------ | -------------------------- |
| `X-Client-Ts`      | 本次签名的 `ts`            |
| `X-Client-Version` | 客户端版本                 |
| `X-Client-Sig`     | 业务签名                   |
| `X-Client-Nonce`   | 业务 nonce                 |
| `X-Client-Pow`     | PoW 解                     |
| `X-App-Id`         | `zcode`                    |
| `X-Session-Id`     | 请求自带的 session id 原值 |

签名前先从请求头中删除上述全部头以及 `X-Client-Sign-Verified`，避免重试时叠加旧值。

## 4. 状态所有者

| 状态                   | 唯一所有者                                   | 生命周期               | 失效行为                              |
| ---------------------- | -------------------------------------------- | ---------------------- | ------------------------------------- |
| 私钥与 epoch           | 按 `(apiKey, handshakeUrl)` 缓存的 key state | 进程内，首次握手后常驻 | 401 刷新或 dispose 时清空并递增 epoch |
| 握手 in-flight promise | 同上                                         | 单次                   | epoch 变化时结果丢弃                  |
| bypass 标志            | 按 provider 的 signer                        | 进程内                 | 不恢复；新进程重新握手                |
| 功能门快照             | 每个 signer 一份                             | 3 600 ms               | 过期重查；不可缓存的结果不写快照      |
| 观察事件               | 调用方注入的 observer                        | 无                     | 抛错不影响请求                        |

## 5. 事件顺序

```text
模型请求进入 provider transport
  → 清洗 7 个签名头（幂等，可重入）
  → 目标 origin ≠ 握手 origin  ────────────────→ 无签名发送（origin_mismatch）
  → 已在 bypass ─────────────────────────────→ 无签名发送（bypass）
  → 查功能门（命中缓存直接返回）
      门为关 ────────────────────────────────→ 无签名发送（feature_gate_disabled）
      门查询异常 ────────────────────────────→ 无签名发送（feature_gate_unavailable）
  → 取私钥（命中缓存 / 握手）
      握手失败且 fail-open 候选 ────────────→ 无签名发送（handshake_failed）
      其它握手失败 ─────────────────────────→ 抛错（fail closed）
  → 缺 X-Session-Id ────────────────────────→ 抛错（invalid-config，fail closed）
  → 算 PoW + Ed25519 签名 → 签名发送（signed_sent）
  → 401 且 body 含 VERIFY_SIGNATURE_INVALID / VERIFY_APIKEY_EXPIRED
      → 作废私钥 → 重新握手 → 签名重发（signed_attempt 2）
      → 仍被拒 → bypass 置位 → 无签名发送（verify_refresh_exhausted）
  → 其它响应原样返回
```

握手与功能门请求走最内层 transport（proxy fetch），不复用网关改写，也不被业务错误检测包装。

## 6. 失败语义

| 错误 kind                                                                                                                     | fail-open | 触发                                              |
| ----------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------- |
| `invalid-config`                                                                                                              | 否        | baseURL 非 HTTPS、凭据无分隔符、缺 `X-Session-Id` |
| `disposed`                                                                                                                    | 否        | signer 已释放                                     |
| `handshake-timeout` / `handshake-network` / `handshake-protocol` / `handshake-server` / `handshake-business` / `cryptography` | 是        | 握手各阶段                                        |
| `request_failed_closed`                                                                                                       | 否        | 观察器记录后原样抛出                              |

fail-open 只影响「本次是否带签名」，不吞掉 provider 自身的业务错误。

## 7. 接口

```ts
createClientRequestSigningV4Fetch(options: {
  apiKey: string | undefined;
  baseURL: string;
  clientVersion: string;
  providerId: string;
  fetch: ProviderFetch;          // 被包装的业务请求出口
  transport: ProviderFetch;      // 握手与功能门用的最内层出口
  allowInsecureHttp?: boolean;
  featureGateUrl: string;
  now?: () => number;
  observer?: (event: SigningObservation) => void;
}): ProviderFetch;
```

`ProviderFetch` 沿用 `adapters/src/model` 既有的 fetch 端口类型，不新增 HTTP 抽象。

## 8. 迁移边界

1. 签名 fetch 插在 `resolveProviderTransport` 返回值外层，位于网关改写之上：签名针对用户配置的官方端点 origin 生成，改写只换投递地址。
2. 握手与功能门使用 `createProviderProxyFetch` 的结果，不经过 `createOfficialCodingPlanGatewayFetch`，也不经过 `createProviderBusinessErrorFetch`。
3. 不改 `official-coding-plan-gateway.ts` 的路由表，不改 `runner-attribution.ts` 的既有头。
4. 不改 shared 协议、UI 与 desktop。

## 9. 验收标准

1. 合法凭据 + 官方 origin + 门开 → 请求带全部 7 个头，`X-Client-Sig` 可被同一私钥的公钥验证，签名串与头值一致。
2. 门关 / 门异常 / 握手失败 / bypass → 请求不含任何签名头，但原始请求照常送达。
3. 非官方 origin → 不含签名头，且不产生握手与功能门请求。
4. 缺 `X-Session-Id` 且判定要签 → 抛错，不静默发无签名请求。
5. 401 + `VERIFY_SIGNATURE_INVALID` → 作废私钥、重新握手、再签一次；第二次仍 401 → 后续请求全部无签名。
6. 重试不叠加旧签名头：同一请求两次发送的 `X-Client-Nonce`、`X-Client-Pow`、`X-Client-Sig` 互不相同。
7. PoW 解满足前导 8 个零比特且前缀与 `sha256(apiKeyId\nappId\nsessionId\nts)` 一致。
8. 功能门结果可缓存 3 600 ms；`codingPlanSignature` 缺失按「关」处理且可缓存。
9. 既有 provider 测试与 `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 无回归。
