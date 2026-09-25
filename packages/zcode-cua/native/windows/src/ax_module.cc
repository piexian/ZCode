// N-API 模块入口：只导出 hostInfo 与命名管道 transport，JS 不接触任何 HANDLE。
#include <node_api.h>

#include "ax_common.h"
#include "ax_host_info.h"
#include "ax_pipe_server.h"


namespace {

napi_value HostInfoBinding(napi_env env, napi_callback_info) { return ax::HostInfo(env); }

napi_value SetEventHandler(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1] = {nullptr};
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok) {
    return ax::ThrowError(env, "invalid_arguments", "setEventHandler(handler?)");
  }
  napi_value undefined = nullptr;
  napi_get_undefined(env, &undefined);
  ax::SetServerEventHandler(env, argc >= 1 ? argv[0] : undefined);
  return nullptr;
}

bool GetOptions(napi_env env, napi_callback_info info, std::string* pipeName, ax::ServerOptions* options,
                std::string* error) {
  size_t argc = 2;
  napi_value argv[2] = {nullptr, nullptr};
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok) {
    *error = "invalid_arguments";
    return false;
  }
  if (argc < 1 || !ax::GetStringArg(env, argv[0], pipeName)) {
    *error = "pipeName must be a string";
    return false;
  }
  napi_valuetype type = napi_undefined;
  if (argc < 2) return true;
  if (napi_typeof(env, argv[1], &type) != napi_ok || type != napi_object) {
    *error = "options must be an object";
    return false;
  }
  if (auto value = ax::GetUint32Prop(env, argv[1], "maxConnections")) options->maxConnections = *value;
  if (auto value = ax::GetUint32Prop(env, argv[1], "handshakeTimeoutMs")) options->handshakeTimeoutMs = *value;
  if (auto value = ax::GetUint32Prop(env, argv[1], "maxQueuedRequests")) options->maxQueuedRequests = *value;
  if (auto value = ax::GetUint32Prop(env, argv[1], "parentPid")) options->parentPid = *value;
  if (auto value = ax::GetUint32Prop(env, argv[1], "parentCreationTimeMs")) {
    options->parentCreationTimeMs = *value;
  }
  if (auto value = ax::GetBoolProp(env, argv[1], "allowUnverifiedPeer")) options->allowUnverifiedPeer = *value;
  if (auto value = ax::GetBoolProp(env, argv[1], "requireSignature")) options->requireSignature = *value;
  if (auto value = ax::GetUint32Prop(env, argv[1], "maxLineBytes")) {
    options->maxLineBytes = *value;
  }
  return true;
}

napi_value StartServer(napi_env env, napi_callback_info info) {
  std::string pipeName;
  ax::ServerOptions options;
  std::string error;
  if (!GetOptions(env, info, &pipeName, &options, &error)) {
    return ax::ThrowError(env, "invalid_arguments", error);
  }
  if (!ax::StartPipeServer(pipeName, options, &error)) {
    return ax::ThrowError(env, "start_server_failed", error);
  }
  napi_value result = nullptr;
  napi_create_object(env, &result);
  ax::SetStringProp(env, result, "pipeName", pipeName);
  ax::SetNumberProp(env, result, "serverPid", static_cast<double>(GetCurrentProcessId()));
  ax::SetNumberProp(env, result, "maxConnections", options.maxConnections);
  ax::SetNumberProp(env, result, "maxConnectionsHardLimit", ax::kNativeMaxConnections);
  ax::SetNumberProp(env, result, "maxLineBytes", static_cast<double>(options.maxLineBytes));
  ax::SetNumberProp(env, result, "maxLineBytesHardLimit", static_cast<double>(ax::kNativeMaxLineBytes));
  ax::SetNumberProp(env, result, "maxQueuedRequests", options.maxQueuedRequests);
  ax::SetNumberProp(env, result, "maxQueuedRequestsHardLimit", ax::kNativeMaxQueuedRequests);
  ax::SetNumberProp(env, result, "handshakeTimeoutMs", options.handshakeTimeoutMs);
  ax::SetBoolProp(env, result, "firstPipeInstance", true);
  ax::SetStringProp(env, result, "dacl", "current_user+system");
  ax::SetStringProp(env, result, "signatureVerification", "not_implemented");
  ax::SetStringProp(env, result, "lineDelimiters", "lf");
  return result;
}

napi_value StopServer(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1] = {nullptr};
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  uint32_t timeoutMs = 2000;
  if (argc >= 1) ax::GetUint32Arg(env, argv[0], &timeoutMs);
  const ax::StopResult stop = ax::StopPipeServer(timeoutMs);
  napi_value result = nullptr;
  napi_create_object(env, &result);
  ax::SetBoolProp(env, result, "stopped", stop.stopped && stop.remainingConnections == 0);
  ax::SetNumberProp(env, result, "remainingConnections", stop.remainingConnections);
  ax::SetNumberProp(env, result, "timeoutMs", timeoutMs);
  return result;
}

napi_value SendResponse(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2] = {nullptr, nullptr};
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc < 2) {
    return ax::ThrowError(env, "invalid_arguments", "sendResponse(connectionId, line)");
  }
  uint32_t connectionId = 0;
  std::string line;
  if (!ax::GetUint32Arg(env, argv[0], &connectionId) || !ax::GetStringArg(env, argv[1], &line)) {
    return ax::ThrowError(env, "invalid_arguments", "sendResponse(connectionId, line)");
  }
  return ax::MakeBool(env, ax::SendPipeResponse(connectionId, line));
}

napi_value CloseConnection(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2] = {nullptr, nullptr};
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc < 1) {
    return ax::ThrowError(env, "invalid_arguments", "closeConnection(connectionId, reason?)");
  }
  uint32_t connectionId = 0;
  if (!ax::GetUint32Arg(env, argv[0], &connectionId)) {
    return ax::ThrowError(env, "invalid_arguments", "closeConnection(connectionId, reason?)");
  }
  std::string reason = "closed_by_host";
  if (argc >= 2) ax::GetStringArg(env, argv[1], &reason);
  return ax::MakeBool(env, ax::ClosePipeConnection(connectionId, reason));
}

napi_value ServerStatusBinding(napi_env env, napi_callback_info) {
  const ax::ServerStatus status = ax::GetServerStatus();
  napi_value result = nullptr;
  napi_create_object(env, &result);
  ax::SetBoolProp(env, result, "running", status.running);
  ax::SetBoolProp(env, result, "stopping", status.stopping);
  ax::SetStringProp(env, result, "pipeName", status.pipeName);
  ax::SetNumberProp(env, result, "activeConnections", status.activeConnections);
  ax::SetNumberProp(env, result, "acceptedConnections", static_cast<double>(status.acceptedConnections));
  ax::SetNumberProp(env, result, "rejectedConnections", static_cast<double>(status.rejectedConnections));
  ax::SetNumberProp(env, result, "emittedLines", static_cast<double>(status.emittedLines));
  ax::SetNumberProp(env, result, "sentResponses", static_cast<double>(status.sentResponses));
  napi_value ids = nullptr;
  napi_create_array_with_length(env, status.openConnectionCount, &ids);
  for (uint32_t i = 0; i < status.openConnectionCount; ++i) {
    napi_set_element(env, ids, i, ax::MakeUint32(env, status.openConnectionIds[i]));
  }
  ax::SetProp(env, result, "openConnectionIds", ids);
  return result;
}

void Cleanup(void*) { ax::ShutdownPipeServer(); }

napi_value Init(napi_env env, napi_value exports) {
  const napi_property_descriptor properties[] = {
      {"hostInfo", nullptr, HostInfoBinding, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"setEventHandler", nullptr, SetEventHandler, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"startServer", nullptr, StartServer, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"stopServer", nullptr, StopServer, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"sendResponse", nullptr, SendResponse, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"closeConnection", nullptr, CloseConnection, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"serverStatus", nullptr, ServerStatusBinding, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  napi_value version = nullptr;
  napi_create_uint32(env, NAPI_VERSION, &version);
  napi_set_named_property(env, exports, "napiVersion", version);
  napi_add_env_cleanup_hook(env, Cleanup, nullptr);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
