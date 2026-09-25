/**
 * Producer 侧的固定上限。这些值同时约束 JS runtime、Helper 与模型可见输出，
 * 属于跨进程契约的一部分；单方面放宽会让 native 层的 16 MiB / 8 连接门限失效。
 */

/** Helper 协商的协议版本；低于该值 fail closed，高于 Helper 能力时返回 version_mismatch。 */
export const BROKER_PROTOCOL_VERSION = 2;
/** 客户端可接受的最低 Helper 版本。 */
export const MIN_BROKER_PROTOCOL_VERSION = 2;

/** 客户端请求单行上限，按 UTF-8 字节计。 */
export const CLIENT_REQUEST_MAX_BYTES = 1024 * 1024;
/** 客户端可接受的响应单行上限，按 UTF-8 字节计。 */
export const CLIENT_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
/** Helper 服务端单行上限，按 UTF-8 字节计。 */
export const SERVER_LINE_MAX_BYTES = 16 * 1024 * 1024;

/** 进程级 session 分区上限；超出按 LRU 关闭最久未用的 session。 */
export const MAX_SESSION_ENTRIES = 128;
/** 单个 session 保留的 observation state 数量。 */
export const MAX_STATES_PER_SESSION = 8;
/** 单个 session 保留的 actionable frame 数量。 */
export const MAX_FRAMES_PER_SESSION = 16;
/** frame TTL，超时后写 tombstone 并要求重新观察。 */
export const FRAME_TTL_MS = 10 * 60 * 1000;

/** 元素树展平上限与深度上限，防止 Helper 返回无界结构。 */
export const MAX_ELEMENT_TREE_ENTRIES = 6000;
export const MAX_ELEMENT_TREE_DEPTH = 64;

/** 单次按键/按钮保持的硬上限，与 key.hold_seconds 的最大值一致。 */
export const MAX_HOLD_SECONDS = 30;
export const MAX_KEY_REPEAT = 100;
export const MAX_CLICK_COUNT = 3;
export const SCROLL_AMOUNT_MAX = 100;

/** 模型可见文本上限，与结构化元素数组分别计预算。 */
export const MODEL_TEXT_MAX_CHARS = 12000;

/** 最终 raster 的边长与质量阶梯；base64 内联预算由既有 frame 契约负责。 */
export const RASTER_MAX_EDGE = 1280;
export const RASTER_QUALITY_LADDER = Object.freeze([75, 65, 55, 45, 40]);
export const RASTER_SHRINK_FACTOR = 0.8;
export const RASTER_MIN_EDGE = 320;

/** 单次请求的客户端预算；超时按 possibly_sent 处理，不自动重放。 */
export const REQUEST_TIMEOUT_MS = 30_000;
/** broker_unavailable 允许的 bounded backoff，仅在方法帧越过管道之前生效。 */
export const BROKER_UNAVAILABLE_BACKOFF_MS = Object.freeze([250, 500, 750, 1000, 1500]);

/** native 层并发连接上限；producer 侧按此拒绝超预算的新连接。 */
export const MAX_BROKER_CONNECTIONS = 8;

/** 严格 JSON 解析的最大嵌套深度，防止深层嵌套耗尽栈。 */
export const MAX_JSON_DEPTH = 64;
