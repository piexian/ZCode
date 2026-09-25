// hostInfo()：Windows 构建/架构、会话、交互性、用户 SID、完整性/提权、DPI、UIA 与 WGC 能力诊断。
#pragma once

#include <node_api.h>

namespace ax {

napi_value HostInfo(napi_env env);

}  // namespace ax
