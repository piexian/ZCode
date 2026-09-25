// 自建命名管道服务端：CreateNamedPipeW + FILE_FLAG_FIRST_PIPE_INSTANCE + 当前用户/SYSTEM DACL。
// JS 永不接触 HANDLE，事件经 napi_threadsafe_function 回到 JS 线程。
#pragma once

#include <node_api.h>

#include <cstdint>
#include <string>

namespace ax {

// 原生硬上限，不随 JS 侧配置放大。
constexpr uint32_t kNativeMaxConnections = 8;
constexpr uint64_t kNativeMaxLineBytes = 16ull * 1024 * 1024;
constexpr uint32_t kNativeMaxQueuedRequests = 64;

struct ServerOptions {
  uint32_t maxConnections = 8;  // 原生硬上限 8
  uint64_t maxLineBytes = 16ull * 1024 * 1024;
  uint32_t handshakeTimeoutMs = 5000;
  uint32_t maxQueuedRequests = 64;
  uint32_t parentPid = 0;
  uint64_t parentCreationTimeMs = 0;
  bool allowUnverifiedPeer = false;
  bool requireSignature = false;
};

struct ServerStatus {
  bool running = false;
  bool stopping = false;
  std::string pipeName;
  uint32_t activeConnections = 0;
  uint32_t openConnectionIds[kNativeMaxConnections] = {};
  uint32_t openConnectionCount = 0;
  uint64_t acceptedConnections = 0;
  uint64_t rejectedConnections = 0;
  uint64_t emittedLines = 0;
  uint64_t sentResponses = 0;
};

struct StopResult {
  bool stopped = false;
  uint32_t remainingConnections = 0;
};

bool StartPipeServer(const std::string& pipeName, const ServerOptions& options, std::string* error);
StopResult StopPipeServer(uint32_t timeoutMs);
// 入队成功返回 true；连接不存在/已关闭/无待响应请求返回 false。
bool SendPipeResponse(uint32_t connectionId, const std::string& line);
bool ClosePipeConnection(uint32_t connectionId, const std::string& reason);
ServerStatus GetServerStatus();
// 注册/清除 JS 事件回调；失败时自行抛出 napi 异常。
void SetServerEventHandler(napi_env env, napi_value handler);
// 进程退出钩子：停服务端并释放 threadsafe function。
void ShutdownPipeServer();

}  // namespace ax
