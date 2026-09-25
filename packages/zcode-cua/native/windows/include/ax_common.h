// 通用工具：UTF-8 转换、napi 构造辅助、SID/时间/HRESULT 格式化。
#pragma once

#include <node_api.h>
#include <windows.h>

#include <cstdint>
#include <optional>
#include <string>

namespace ax {

std::wstring WidenUtf8(const std::string& value);
std::string NarrowUtf8(const std::wstring& value);

napi_value MakeString(napi_env env, const std::string& value);
napi_value MakeString(napi_env env, const std::wstring& value);
napi_value MakeUint32(napi_env env, uint32_t value);
napi_value MakeBool(napi_env env, bool value);
napi_value MakeDouble(napi_env env, double value);

void SetProp(napi_env env, napi_value object, const char* key, napi_value value);
void SetStringProp(napi_env env, napi_value object, const char* key, const std::string& value);
void SetBoolProp(napi_env env, napi_value object, const char* key, bool value);
void SetNumberProp(napi_env env, napi_value object, const char* key, double value);

bool GetStringArg(napi_env env, napi_value value, std::string* out);
bool GetUint32Arg(napi_env env, napi_value value, uint32_t* out);

std::optional<uint32_t> GetUint32Prop(napi_env env, napi_value object, const char* key);
std::optional<bool> GetBoolProp(napi_env env, napi_value object, const char* key);
std::optional<std::string> GetStringProp(napi_env env, napi_value object, const char* key);

napi_value ThrowError(napi_env env, const char* code, const std::string& message);

// "0x80070005" 形式，便于 JS 侧结构化上报。
std::string HresultCode(HRESULT hr);
std::string HresultMessage(HRESULT hr);
std::string Win32Code(DWORD code);
std::string Win32Message(DWORD code);

// SID 文本化（调用方需保证 sid 有效）。失败返回空串。
std::string SidToString(const void* sid);
// 解析强制标签 SID（S-1-16-x）的等级值；非强制标签返回 nullopt。
std::optional<uint32_t> ParseIntegritySid(const std::string& sid);
// 常见完整性级别名称，未知返回 "unknown"。
std::string IntegrityName(const std::string& sid);

uint64_t FileTimeToUnixMs(const FILETIME& ft);
uint64_t UnixMsToFileTime(uint64_t ms);

}  // namespace ax
