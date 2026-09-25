#include "ax_common.h"

#include <sddl.h>

namespace ax {
namespace {

constexpr uint64_t kFileTimeEpochDeltaMs = 11644473600000ULL;

}  // namespace

std::wstring WidenUtf8(const std::string& value) {
  if (value.empty()) return std::wstring();
  int needed = MultiByteToWideChar(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0);
  if (needed <= 0) return std::wstring();
  std::wstring out(static_cast<size_t>(needed), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), out.data(), needed);
  return out;
}

std::string NarrowUtf8(const std::wstring& value) {
  if (value.empty()) return std::string();
  int needed =
      WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  if (needed <= 0) return std::string();
  std::string out(static_cast<size_t>(needed), '\0');
  WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), out.data(), needed, nullptr, nullptr);
  return out;
}

napi_value MakeString(napi_env env, const std::string& value) {
  napi_value result = nullptr;
  napi_create_string_utf8(env, value.c_str(), value.size(), &result);
  return result;
}

napi_value MakeString(napi_env env, const std::wstring& value) {
  return MakeString(env, NarrowUtf8(value));
}

napi_value MakeUint32(napi_env env, uint32_t value) {
  napi_value result = nullptr;
  napi_create_uint32(env, value, &result);
  return result;
}

napi_value MakeBool(napi_env env, bool value) {
  napi_value result = nullptr;
  napi_get_boolean(env, value, &result);
  return result;
}

napi_value MakeDouble(napi_env env, double value) {
  napi_value result = nullptr;
  napi_create_double(env, value, &result);
  return result;
}

void SetProp(napi_env env, napi_value object, const char* key, napi_value value) {
  napi_set_named_property(env, object, key, value);
}

void SetStringProp(napi_env env, napi_value object, const char* key, const std::string& value) {
  napi_set_named_property(env, object, key, MakeString(env, value));
}

void SetBoolProp(napi_env env, napi_value object, const char* key, bool value) {
  napi_set_named_property(env, object, key, MakeBool(env, value));
}

void SetNumberProp(napi_env env, napi_value object, const char* key, double value) {
  napi_set_named_property(env, object, key, MakeDouble(env, value));
}

bool GetStringArg(napi_env env, napi_value value, std::string* out) {
  napi_valuetype type = napi_undefined;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) return false;
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) return false;
  std::string buffer(length + 1, '\0');
  size_t written = 0;
  if (napi_get_value_string_utf8(env, value, buffer.data(), length + 1, &written) != napi_ok) return false;
  buffer.resize(written);
  *out = std::move(buffer);
  return true;
}

bool GetUint32Arg(napi_env env, napi_value value, uint32_t* out) {
  napi_valuetype type = napi_undefined;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_number) return false;
  double number = 0;
  if (napi_get_value_double(env, value, &number) != napi_ok) return false;
  if (!(number >= 0) || number > 4294967295.0 || number != static_cast<double>(static_cast<uint64_t>(number))) {
    return false;
  }
  *out = static_cast<uint32_t>(number);
  return true;
}

std::optional<uint32_t> GetUint32Prop(napi_env env, napi_value object, const char* key) {
  napi_value value = nullptr;
  napi_valuetype type = napi_undefined;
  if (napi_get_named_property(env, object, key, &value) != napi_ok) return std::nullopt;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_number) return std::nullopt;
  uint32_t parsed = 0;
  if (!GetUint32Arg(env, value, &parsed)) return std::nullopt;
  return parsed;
}

std::optional<bool> GetBoolProp(napi_env env, napi_value object, const char* key) {
  napi_value value = nullptr;
  napi_valuetype type = napi_undefined;
  if (napi_get_named_property(env, object, key, &value) != napi_ok) return std::nullopt;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_boolean) return std::nullopt;
  bool result = false;
  if (napi_get_value_bool(env, value, &result) != napi_ok) return std::nullopt;
  return result;
}

std::optional<std::string> GetStringProp(napi_env env, napi_value object, const char* key) {
  napi_value value = nullptr;
  napi_valuetype type = napi_undefined;
  if (napi_get_named_property(env, object, key, &value) != napi_ok) return std::nullopt;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) return std::nullopt;
  std::string result;
  if (!GetStringArg(env, value, &result)) return std::nullopt;
  return result;
}

napi_value ThrowError(napi_env env, const char* code, const std::string& message) {
  std::string text = std::string(code) + ": " + message;
  napi_throw_error(env, code, text.c_str());
  return nullptr;
}

std::string HresultCode(HRESULT hr) {
  char buffer[16] = {};
  _snprintf_s(buffer, sizeof(buffer), _TRUNCATE, "0x%08lx", static_cast<unsigned long>(hr));
  return std::string(buffer);
}

std::string HresultMessage(HRESULT hr) {
  wchar_t* buffer = nullptr;
  HRESULT hr2 = FormatMessageW(
      FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS, nullptr, hr,
      MAKELANGID(LANG_NEUTRAL, SUBLANG_DEFAULT), reinterpret_cast<wchar_t*>(&buffer), 0, nullptr);
  if (FAILED(hr2) || buffer == nullptr) return std::string();
  std::wstring text(buffer);
  LocalFree(buffer);
  while (!text.empty() && (text.back() == L'\r' || text.back() == L'\n' || text.back() == L' ')) text.pop_back();
  return NarrowUtf8(text);
}

std::string Win32Code(DWORD code) {
  char buffer[16] = {};
  _snprintf_s(buffer, sizeof(buffer), _TRUNCATE, "%lu", static_cast<unsigned long>(code));
  return std::string(buffer);
}

std::string Win32Message(DWORD code) { return HresultMessage(HRESULT_FROM_WIN32(code)); }

std::string SidToString(const void* sid) {
  if (sid == nullptr) return std::string();
  wchar_t* text = nullptr;
  if (!ConvertSidToStringSidW(const_cast<void*>(sid), &text)) return std::string();
  std::wstring out(text);
  LocalFree(text);
  return NarrowUtf8(out);
}

std::optional<uint32_t> ParseIntegritySid(const std::string& sid) {
  // 强制标签 SID 形如 S-1-16-<level>。
  if (sid.size() < 9) return std::nullopt;
  if (sid.compare(0, 7, "S-1-16-") != 0) return std::nullopt;
  uint64_t value = 0;
  for (size_t i = 7; i < sid.size(); ++i) {
    const char c = sid[i];
    if (c < '0' || c > '9') return std::nullopt;
    value = value * 10 + static_cast<uint64_t>(c - '0');
    if (value > 0xffffffffULL) return std::nullopt;
  }
  return static_cast<uint32_t>(value);
}

std::string IntegrityName(const std::string& sid) {
  auto level = ParseIntegritySid(sid);
  if (!level.has_value()) return "unknown";
  switch (*level) {
    case 0x0000:
      return "untrusted";
    case 0x1000:
      return "low";
    case 0x2000:
      return "medium";
    case 0x2100:
      return "medium_plus";
    case 0x3000:
      return "high";
    case 0x4000:
      return "system";
    case 0x5000:
      return "protected";
    case 0x6000:
      return "secure";
    default:
      return "unknown";
  }
}

uint64_t FileTimeToUnixMs(const FILETIME& ft) {
  uint64_t ticks = (static_cast<uint64_t>(ft.dwHighDateTime) << 32) | ft.dwLowDateTime;
  return ticks / 10000ULL - kFileTimeEpochDeltaMs;
}

uint64_t UnixMsToFileTime(uint64_t ms) {
  return (ms + kFileTimeEpochDeltaMs) * 10000ULL;
}

}  // namespace ax
