/**
 * 把 `node:net` 的连接包装成 broker/connection.js 需要的最小 socket 形状。
 *
 * 单独成文件是为了让 connection.js 不直接依赖 `net`：测试注入假 socket，
 * 生产走这里，macOS unix socket 与 Windows 命名管道共用同一条路径。
 */

import { createConnection } from "node:net";

/** @returns {(path: string) => import("node:net").Socket} */
export function createNetConnector() {
  return (path) => createConnection({ path });
}
