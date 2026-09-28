/**
 * ZCode 客户端请求签名 V4 的公共入口。
 *
 * 官方 Coding Plan 端点按签名头判定调用方身份，缺签名时套餐权益静默失效。
 * 行为契约见 specs/zcode-client-signing/client-request-signing-v4.md。
 *
 * 关键约束：签名不绑定 URL（只绑 apiKeyId/ts/版本/session/nonce），因此官方端点经
 * ZCode 平台网关改写投递地址后签名依然成立；origin 只用于「是否参与签名」的策略判断。
 * 握手与功能门走最内层 transport，不复用网关改写，也不被业务错误检测包装。
 *
 * 实现按职责拆分在 ./client-signing/ 子模块，本文件只聚合导出，公共面不变。
 */

export {
  ClientRequestSigningV4Error,
  type ClientSigningErrorKind,
  type ClientSigningObservation,
  type ClientSigningObservationBody,
} from "./client-signing/shared.js";
export {
  createClientSigningKeyCache,
  type ClientSigningCredential,
  type ClientSigningKeyCache,
  type ClientSigningKeyState,
  parseClientSigningCredential,
  resolveHandshakeUrl,
  sanitizeClientSigningHeaders,
} from "./client-signing/credential.js";
export {
  createClientRequestProofOfWork,
  createHandshakeSignature,
  decryptSigningPrivateKey,
  deriveSigningBytes,
  hasLeadingZeroBits,
  signBusinessMessage,
} from "./client-signing/crypto.js";
export {
  createClientRequestSigningV4Fetch,
  type CreateClientRequestSigningV4FetchOptions,
} from "./client-signing/signer.js";
