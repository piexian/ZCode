#include "ax_host_info.h"

// 必须先引入 windows.h：lmaccess.h / UIAutomationClient.h 依赖基础类型。
#include "ax_common.h"
#include "ax_peer.h"

#include <lmaccess.h>
#include <lmcons.h>
#include <objbase.h>
#include <roapi.h>
#define SECURITY_WIN32 1
#include <security.h>
#include <sysinfoapi.h>
#include <UIAutomationClient.h>
#include <wtsapi32.h>

#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Graphics.Capture.h>

#include <iterator>
#include <optional>
#include <string>
#include <vector>

namespace ax {
namespace {

namespace wc = winrt::Windows::Graphics::Capture;

const char* ArchitectureName() {
#if defined(_M_ARM64)
  return "arm64";
#elif defined(_M_X64)
  return "x64";
#elif defined(_M_IX86)
  return "x86";
#else
  return "unknown";
#endif
}

const char* ProductName(uint32_t major, const std::string& installationType) {
  const bool server = installationType == "Server" || installationType == "Server Core";
  if (major == 10 && !server) return "Windows 11";
  if (major == 10 && server) return "Windows Server";
  return "Windows";
}

// SDK 的 um/shared 头文件不导出 RtlGetVersion，这里按 ntddk 签名自声明，链 ntdll.lib。
extern "C" LONG __stdcall RtlGetVersion(OSVERSIONINFOW* versionInformation);

// SDK 头文件在只暴露 OSVERSIONINFOEXW 的工具集下没有 wBuildNumber，
// 这里按 ntddk 的 RTL_OSVERSIONINFOEXW 布局自带一份，保证 RtlGetVersion 可用。
struct AxRtlOsVersionInfoExW {
  ULONG dwOSVersionInfoSize;
  ULONG dwMajorVersion;
  ULONG dwMinorVersion;
  ULONG dwBuildNumber;
  ULONG dwPlatformId;
  WCHAR szCSDVersion[128];
  USHORT wServicePackMajor;
  USHORT wServicePackMinor;
  USHORT wSuiteMask;
  UCHAR wProductType;
  UCHAR wReserved;
};

std::optional<uint32_t> ReadRegistryDword(const wchar_t* valueName) {
  HKEY key = nullptr;
  if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, L"SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion", 0, KEY_READ, &key) !=
      ERROR_SUCCESS) {
    return std::nullopt;
  }
  DWORD value = 0;
  DWORD size = sizeof(value);
  const LSTATUS status = RegQueryValueExW(key, valueName, nullptr, nullptr, reinterpret_cast<LPBYTE>(&value), &size);
  RegCloseKey(key);
  if (status != ERROR_SUCCESS) return std::nullopt;
  return static_cast<uint32_t>(value);
}

std::optional<std::string> ReadRegistryString(const wchar_t* valueName) {
  HKEY key = nullptr;
  if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, L"SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion", 0, KEY_READ, &key) !=
      ERROR_SUCCESS) {
    return std::nullopt;
  }
  DWORD size = 0;
  RegQueryValueExW(key, valueName, nullptr, nullptr, nullptr, &size);
  std::optional<std::string> result;
  if (size > 0) {
    std::wstring buffer(size / sizeof(wchar_t) + 1, L'\0');
    DWORD read = static_cast<DWORD>((buffer.size()) * sizeof(wchar_t));
    if (RegQueryValueExW(key, valueName, nullptr, nullptr, reinterpret_cast<LPBYTE>(buffer.data()), &read) ==
        ERROR_SUCCESS) {
      result = NarrowUtf8(std::wstring(buffer.c_str()));
    }
  }
  RegCloseKey(key);
  return result;
}

napi_value MakeOsInfo(napi_env env) {
  // RtlGetVersion 是唯一不被 manifest 撒谎的版本来源。
  AxRtlOsVersionInfoExW info{};
  info.dwOSVersionInfoSize = sizeof(info);
  napi_value result = nullptr;
  napi_create_object(env, &result);
  const bool ok = RtlGetVersion(reinterpret_cast<OSVERSIONINFOW*>(&info)) == 0;
  SetStringProp(env, result, "api", "RtlGetVersion");
  SetBoolProp(env, result, "ok", ok);
  if (!ok) return result;
  // InstallationType 在桌面 SKU 上是 Client，在 Server 上是 Server，避免额外依赖 GetProductInfo。
  const std::string installationType = ReadRegistryString(L"InstallationType").value_or("Unknown");
  SetStringProp(env, result, "name", ProductName(info.dwMajorVersion, installationType));
  SetStringProp(env, result, "installationType", installationType);
  SetBoolProp(env, result, "isWorkstation", installationType == "Client");
  SetNumberProp(env, result, "major", static_cast<double>(info.dwMajorVersion));
  SetNumberProp(env, result, "minor", static_cast<double>(info.dwMinorVersion));
  SetNumberProp(env, result, "build", static_cast<double>(info.dwBuildNumber));
  SetNumberProp(env, result, "servicePackMajor", info.wServicePackMajor);
  SetNumberProp(env, result, "servicePackMinor", info.wServicePackMinor);
  SetStringProp(env, result, "servicePack", NarrowUtf8(std::wstring(info.szCSDVersion)));
  SetNumberProp(env, result, "platformId", static_cast<double>(info.dwPlatformId));
  if (auto ubr = ReadRegistryDword(L"UBR")) {
    SetNumberProp(env, result, "updateBuildRevision", *ubr);
  }
  if (auto display = ReadRegistryString(L"DisplayVersion")) {
    SetStringProp(env, result, "displayVersion", *display);
  }
  if (auto currentBuild = ReadRegistryString(L"CurrentBuild")) {
    SetStringProp(env, result, "currentBuild", *currentBuild);
  }
  return result;
}

napi_value MakeSessionInfo(napi_env env) {
  napi_value result = nullptr;
  napi_create_object(env, &result);
  DWORD sessionId = 0;
  const bool sessionKnown = ProcessIdToSessionId(GetCurrentProcessId(), &sessionId) != FALSE;
  const DWORD activeConsole = WTSGetActiveConsoleSessionId();
  SetNumberProp(env, result, "id", sessionKnown ? sessionId : 0);
  SetBoolProp(env, result, "idAvailable", sessionKnown);
  SetNumberProp(env, result, "activeConsoleSessionId", activeConsole);
  SetBoolProp(env, result, "isActiveConsoleSession", sessionKnown && sessionId == activeConsole);
  SetBoolProp(env, result, "isRemoteSession", sessionKnown && sessionId != 0 && sessionId != activeConsole);

  HWINSTA station = GetProcessWindowStation();
  const bool stationVisible = [station]() -> bool {
    if (station == nullptr) return false;
    USEROBJECTFLAGS flags{};
    DWORD needed = 0;
    if (!GetUserObjectInformationW(station, UOI_FLAGS, &flags, sizeof(flags), &needed)) return false;
    return (flags.dwFlags & WSF_VISIBLE) != 0;
  }();
  SetBoolProp(env, result, "hasWindowStation", station != nullptr);
  SetBoolProp(env, result, "windowStationVisible", stationVisible);
  SetBoolProp(env, result, "interactive", stationVisible && sessionKnown && sessionId != 0);

  BOOL screenSaverActive = FALSE;
  SystemParametersInfoW(SPI_GETSCREENSAVEACTIVE, 0, &screenSaverActive, 0);
  SetBoolProp(env, result, "screenSaverRunning", screenSaverActive != FALSE);
  SetNumberProp(env, result, "processId", static_cast<double>(GetCurrentProcessId()));
  return result;
}

napi_value MakeUserInfo(napi_env env) {
  napi_value result = nullptr;
  napi_create_object(env, &result);
  TokenSnapshot self = ReadSelfTokenSnapshot();
  SetStringProp(env, result, "sid", self.userSid);
  SetBoolProp(env, result, "sidAvailable", !self.userSid.empty());

  // GetUserNameEx 的定长调用更可靠：空指针探测在部分令牌下不返回长度。
  WCHAR sam[512] = {};
  DWORD samChars = static_cast<DWORD>(std::size(sam));
  std::wstring userName;
  std::string samFailure;
  if (GetUserNameExW(NameSamCompatible, sam, &samChars)) {
    userName.assign(sam);
  } else {
    samFailure = Win32Code(GetLastError());
  }
  SetStringProp(env, result, "name", NarrowUtf8(userName));
  if (!samFailure.empty()) SetStringProp(env, result, "nameFailure", samFailure);

  WCHAR account[257] = {};
  DWORD accountChars = 256;
  std::wstring accountName;
  if (GetUserNameW(account, &accountChars) && accountChars > 0) {
    accountName.assign(account);
    while (!accountName.empty() && accountName.back() == L'\0') accountName.pop_back();
  }
  SetStringProp(env, result, "account", NarrowUtf8(accountName));
  SetBoolProp(env, result, "elevated", self.elevated);
  SetStringProp(env, result, "elevationType", self.elevationType);
  SetBoolProp(env, result, "administrator", self.administrator);
  SetStringProp(env, result, "integritySid", self.integritySid);
  SetStringProp(env, result, "integrityLevel", IntegrityName(self.integritySid));
  SetNumberProp(env, result, "integrityRank", self.integrityLevel);
  if (!self.valid && !self.failure.empty()) SetStringProp(env, result, "tokenFailure", self.failure);
  return result;
}

napi_value MakeDpiInfo(napi_env env) {
  napi_value result = nullptr;
  napi_create_object(env, &result);
  DPI_AWARENESS awareness = DPI_AWARENESS_INVALID;
  const char* awarenessName = "invalid";
  if (GetThreadDpiAwarenessContext != nullptr && GetAwarenessFromDpiAwarenessContext != nullptr) {
    awareness = GetAwarenessFromDpiAwarenessContext(GetThreadDpiAwarenessContext());
  }
  // SDK 的 DPI_AWARENESS 枚举没有 V2 项，GetAwarenessFromDpiAwarenessContext 会直接返回 -4。
  switch (static_cast<int>(awareness)) {
    case 0:
      awarenessName = "unaware";
      break;
    case 1:
      awarenessName = "system_aware";
      break;
    case 2:
      awarenessName = "per_monitor_aware";
      break;
    case -4:
      awarenessName = "per_monitor_aware_v2";
      break;
    default:
      awarenessName = "invalid";
      break;
  }
  SetStringProp(env, result, "threadAwareness", awarenessName);
  SetNumberProp(env, result, "awarenessValue", static_cast<double>(static_cast<int>(awareness)));
  SetNumberProp(env, result, "systemDpi", GetDpiForSystem != nullptr ? static_cast<double>(GetDpiForSystem()) : 0);
  SetBoolProp(env, result, "processDpiAware", IsProcessDPIAware() != FALSE);
  return result;
}

napi_value MakeUiaInfo(napi_env env) {
  napi_value result = nullptr;
  napi_create_object(env, &result);
  SetStringProp(env, result, "probe", "CoCreateInstance(CLSID_CUIAutomation)");

  // CUIAutomation 只在 MTA 中可直接激活，因此临时切到 MTA 再探测。
  const HRESULT initResult = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  const bool shouldUninitialize = SUCCEEDED(initResult);
  if (initResult == RPC_E_CHANGED_MODE) {
    SetStringProp(env, result, "apartment", "sta");
  } else {
    SetStringProp(env, result, "apartment", "mta");
  }
  IUIAutomation* automation = nullptr;
  const HRESULT hr = CoCreateInstance(CLSID_CUIAutomation, nullptr, CLSCTX_INPROC_SERVER, __uuidof(IUIAutomation),
                                      reinterpret_cast<void**>(&automation));
  if (automation != nullptr) automation->Release();
  if (shouldUninitialize) CoUninitialize();

  SetBoolProp(env, result, "available", SUCCEEDED(hr));
  SetStringProp(env, result, "hresult", HresultCode(hr));
  if (FAILED(hr)) {
    SetStringProp(env, result, "error", HresultMessage(hr));
    return result;
  }
  HMODULE module = LoadLibraryExW(L"UIAutomationCore.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
  if (module != nullptr) {
    wchar_t fileName[MAX_PATH] = {};
    if (GetModuleFileNameW(module, fileName, MAX_PATH) != 0) {
      SetStringProp(env, result, "library", NarrowUtf8(fileName));
    }
    FreeLibrary(module);
  }
  return result;
}

napi_value MakeWgcInfo(napi_env env) {
  napi_value result = nullptr;
  napi_create_object(env, &result);
  SetStringProp(env, result, "api", "GraphicsCaptureSession::IsSupported");
  bool supported = false;
  std::string error;
  try {
    supported = wc::GraphicsCaptureSession::IsSupported();
  } catch (const winrt::hresult_error& e) {
    error = HresultMessage(e.code());
    if (error.empty()) error = HresultCode(e.code());
  } catch (...) {
    error = "unknown_error";
  }
  SetBoolProp(env, result, "isSupported", supported);
  if (!error.empty()) SetStringProp(env, result, "error", error);
  return result;
}

}  // namespace

napi_value HostInfo(napi_env env) {
  napi_value result = nullptr;
  napi_create_object(env, &result);
  SetStringProp(env, result, "platform", "win32");
  SetStringProp(env, result, "arch", ArchitectureName());
  SetNumberProp(env, result, "pointerBytes", static_cast<double>(sizeof(void*)));
  SetNumberProp(env, result, "processId", static_cast<double>(GetCurrentProcessId()));
  SetNumberProp(env, result, "napiVersion", NAPI_VERSION);
  SetProp(env, result, "os", MakeOsInfo(env));
  SetProp(env, result, "session", MakeSessionInfo(env));
  SetProp(env, result, "user", MakeUserInfo(env));
  SetProp(env, result, "dpi", MakeDpiInfo(env));
  SetProp(env, result, "uia", MakeUiaInfo(env));
  SetProp(env, result, "wgc", MakeWgcInfo(env));
  SetBoolProp(env, result, "captureImplemented", false);
  SetBoolProp(env, result, "inputImplemented", false);
  return result;
}

}  // namespace ax
