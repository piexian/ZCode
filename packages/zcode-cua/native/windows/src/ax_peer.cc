#include "ax_peer.h"

#include <tlhelp32.h>

#include <iterator>

#include "ax_common.h"

namespace ax {
namespace {

constexpr size_t kMaxAncestorDepth = 64;

// 两次调用的标准模式：第一次固定返回 ERROR_INSUFFICIENT_BUFFER，只看 size 是否可用。
bool QueryTokenInfo(HANDLE token, TOKEN_INFORMATION_CLASS klass, std::vector<uint8_t>* out) {
  DWORD size = 0;
  GetTokenInformation(token, klass, nullptr, 0, &size);
  if (size == 0) return false;
  out->resize(size);
  DWORD read = 0;
  return GetTokenInformation(token, klass, out->data(), size, &read) != FALSE;
}

bool ReadTokenUserSid(HANDLE token, TOKEN_INFORMATION_CLASS klass, std::string* out) {
  std::vector<uint8_t> buffer;
  if (!QueryTokenInfo(token, klass, &buffer)) return false;
  // TOKEN_USER 与 TOKEN_MANDATORY_LABEL 首字段都是 SID_AND_ATTRIBUTES，布局一致。
  auto* label = reinterpret_cast<TOKEN_MANDATORY_LABEL*>(buffer.data());
  std::string sid = SidToString(label->Label.Sid);
  if (sid.empty()) return false;
  *out = sid;
  return true;
}

bool ReadTokenSessionId(HANDLE token, uint32_t* out) {
  std::vector<uint8_t> buffer;
  if (!QueryTokenInfo(token, TokenSessionId, &buffer) || buffer.size() < sizeof(DWORD)) return false;
  DWORD sessionId = 0;
  memcpy(&sessionId, buffer.data(), sizeof(sessionId));
  *out = sessionId;
  return true;
}

bool ReadTokenElevated(HANDLE token, bool* out) {
  std::vector<uint8_t> buffer;
  if (!QueryTokenInfo(token, TokenElevation, &buffer) || buffer.size() < sizeof(TOKEN_ELEVATION)) return false;
  auto* elevation = reinterpret_cast<TOKEN_ELEVATION*>(buffer.data());
  *out = elevation->TokenIsElevated != 0;
  return true;
}

bool ReadTokenElevationType(HANDLE token, std::string* out) {
  std::vector<uint8_t> buffer;
  if (!QueryTokenInfo(token, TokenElevationType, &buffer) || buffer.size() < sizeof(DWORD)) return false;
  DWORD type = 0;
  memcpy(&type, buffer.data(), sizeof(type));
  switch (type) {
    case TokenElevationTypeDefault:
      *out = "default";
      return true;
    case TokenElevationTypeFull:
      *out = "full";
      return true;
    case TokenElevationTypeLimited:
      *out = "limited";
      return true;
    default:
      *out = "unknown";
      return true;
  }
}

bool TokenIsAdministrator(HANDLE token) {
  SID_IDENTIFIER_AUTHORITY ntAuthority = SECURITY_NT_AUTHORITY;
  PSID administratorsSid = nullptr;
  if (!AllocateAndInitializeSid(&ntAuthority, 2, SECURITY_BUILTIN_DOMAIN_RID, DOMAIN_ALIAS_RID_ADMINS, 0, 0, 0, 0, 0, 0,
                                &administratorsSid)) {
    return false;
  }
  BOOL member = FALSE;
  const bool ok = CheckTokenMembership(token, administratorsSid, &member) != FALSE;
  FreeSid(administratorsSid);
  return ok && member;
}

// 取证失败原因带上 Win32 码，JS 侧能直接区分“权限不足”与“句柄无效”。
std::string TokenFailure(const char* what) {
  return std::string(what) + ":" + Win32Code(GetLastError());
}

void FillTokenFields(HANDLE token, TokenSnapshot* out) {
  out->valid = true;
  if (!ReadTokenUserSid(token, TokenUser, &out->userSid)) {
    out->valid = false;
    out->failure = TokenFailure("token_user_unavailable");
  }
  if (!ReadTokenSessionId(token, &out->sessionId)) {
    out->valid = false;
    out->failure = TokenFailure("token_session_unavailable");
  }
  if (!ReadTokenUserSid(token, TokenIntegrityLevel, &out->integritySid)) {
    out->valid = false;
    out->failure = TokenFailure("token_integrity_unavailable");
  }
  if (auto level = ParseIntegritySid(out->integritySid)) out->integrityLevel = *level;
  if (!ReadTokenElevated(token, &out->elevated)) {
    out->valid = false;
    out->failure = TokenFailure("token_elevation_unavailable");
  }
  if (!ReadTokenElevationType(token, &out->elevationType)) {
    out->valid = false;
    out->failure = TokenFailure("token_elevation_type_unavailable");
  }
  out->administrator = TokenIsAdministrator(token);
  if (!out->valid && out->failure.empty()) out->failure = "token_snapshot_incomplete";
}

}  // namespace

TokenSnapshot ReadTokenSnapshot(HANDLE token) {
  TokenSnapshot snapshot;
  if (token == nullptr) {
    snapshot.failure = "token_unavailable";
    return snapshot;
  }
  FillTokenFields(token, &snapshot);
  return snapshot;
}

TokenSnapshot ReadSelfTokenSnapshot() {
  TokenSnapshot snapshot;
  HANDLE token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) {
    snapshot.failure = TokenFailure("self_token_open_failed");
    return snapshot;
  }
  snapshot = ReadTokenSnapshot(token);
  CloseHandle(token);
  return snapshot;
}

uint32_t SelfIntegrityLevel() { return ReadSelfTokenSnapshot().integrityLevel; }

std::string SelfUserSid() { return ReadSelfTokenSnapshot().userSid; }

ProcessIdentity ReadProcessIdentity(uint32_t pid) {
  ProcessIdentity identity;
  identity.pid = pid;
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, static_cast<DWORD>(pid));
  if (process == nullptr) return identity;
  FILETIME creation{};
  FILETIME exit{};
  FILETIME kernel{};
  FILETIME user{};
  if (GetProcessTimes(process, &creation, &exit, &kernel, &user)) {
    identity.creationTimeMs = FileTimeToUnixMs(creation);
    identity.valid = true;
  }
  wchar_t imagePath[32768] = {};
  DWORD imageChars = static_cast<DWORD>(std::size(imagePath));
  if (QueryFullProcessImageNameW(process, 0, imagePath, &imageChars)) {
    identity.imageName = NarrowUtf8(std::wstring(imagePath));
  }
  CloseHandle(process);
  return identity;
}

namespace {

// 一次 Toolhelp 快照同时拿到父子关系与映像名，避免逐层重复快照。
struct ProcessTable {
  std::vector<PROCESSENTRY32W> entries;
  const PROCESSENTRY32W* Find(uint32_t pid) const {
    for (const auto& entry : entries) {
      if (entry.th32ProcessID == pid) return &entry;
    }
    return nullptr;
  }
};

bool ReadProcessTable(ProcessTable* table) {
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot == INVALID_HANDLE_VALUE) return false;
  table->entries.clear();
  PROCESSENTRY32W entry{};
  entry.dwSize = sizeof(entry);
  bool any = false;
  if (Process32FirstW(snapshot, &entry)) {
    do {
      table->entries.push_back(entry);
      any = true;
    } while (Process32NextW(snapshot, &entry));
  }
  CloseHandle(snapshot);
  return any;
}

}  // namespace

std::vector<ProcessIdentity> ReadAncestorChain(uint32_t pid) {
  std::vector<ProcessIdentity> chain;
  ProcessTable table;
  if (!ReadProcessTable(&table)) return chain;
  uint32_t current = pid;
  for (size_t depth = 0; depth < kMaxAncestorDepth; ++depth) {
    const PROCESSENTRY32W* entry = table.Find(current);
    if (entry == nullptr) break;
    const uint32_t parentPid = entry->th32ParentProcessID;
    if (parentPid == 0) break;
    ProcessIdentity identity = ReadProcessIdentity(parentPid);
    identity.parentPid = parentPid;
    identity.imageName = NarrowUtf8(entry->szExeFile);
    chain.push_back(identity);
    if (!identity.valid) break;
    current = parentPid;
  }
  return chain;
}

PeerEvidence VerifyPipePeer(HANDLE pipe, uint32_t connectionId, const PeerCheckOptions& options) {
  PeerEvidence evidence;
  evidence.connectionId = connectionId;
  auto fail = [&evidence](const std::string& reason) -> void {
    evidence.failures.emplace_back(reason);
    if (evidence.rejectReason.empty()) {
      evidence.rejectReason = reason;
      evidence.detail = reason + ":" + Win32Code(GetLastError());
    }
    evidence.verified = false;
  };

  // 1. 客户端 pid：只能来自服务器端管道 HANDLE。
  ULONG clientPid = 0;
  if (!GetNamedPipeClientProcessId(pipe, &clientPid) || clientPid == 0) {
    fail("client_pid_unavailable");
    return evidence;
  }
  evidence.clientPidDiscovered = true;
  evidence.clientPid = clientPid;

  ProcessIdentity clientIdentity = ReadProcessIdentity(clientPid);
  // imageName 也要上报：JS 侧日志要靠它区分「谁在连 Helper」。
  evidence.clientImageName = clientIdentity.imageName;
  if (clientIdentity.valid) {
    evidence.clientCreationTimeKnown = true;
    evidence.clientCreationTimeMs = clientIdentity.creationTimeMs;
  } else {
    fail("client_creation_time_unavailable");
  }

  // 2. 自身令牌快照（进程令牌）。
  TokenSnapshot self = ReadSelfTokenSnapshot();
  if (!self.valid) {
    fail("self_token_unavailable");
    return evidence;
  }
  evidence.selfUserSid = self.userSid;
  evidence.selfSessionId = self.sessionId;
  evidence.selfIntegritySid = self.integritySid;
  evidence.selfIntegrityLevel = self.integrityLevel;
  evidence.selfElevated = self.elevated;
  evidence.selfElevationType = self.elevationType;

  // 3. 客户端令牌：首选模拟客户端（ImpersonateNamedPipeClient -> OpenThreadToken -> RevertToSelf）。
  //    部分主机（安全软件挂钩、受限宿主）会拒绝线程令牌，此时回退到 pid 绑定的进程令牌，
  //    两条路径都拿不到令牌则 fail closed。
  evidence.impersonationAttempted = true;
  TokenSnapshot client;
  const BOOL impersonated = ImpersonateNamedPipeClient(pipe);
  if (impersonated) {
    HANDLE clientToken = nullptr;
    const BOOL opened = OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, TRUE, &clientToken);
    const BOOL reverted = RevertToSelf();
    if (!reverted) {
      if (clientToken != nullptr) CloseHandle(clientToken);
      fail("revert_to_self_failed");
      return evidence;
    }
    if (opened && clientToken != nullptr) {
      client = ReadTokenSnapshot(clientToken);
      CloseHandle(clientToken);
      evidence.impersonationOk = true;
      evidence.clientTokenSource = "impersonation";
    } else {
      evidence.impersonationError = Win32Code(GetLastError());
    }
  } else {
    evidence.impersonationError = Win32Code(GetLastError());
  }

  if (client.valid) {
    evidence.clientTokenRead = true;
  } else {
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, evidence.clientPid);
    HANDLE processToken = nullptr;
    if (process != nullptr && OpenProcessToken(process, TOKEN_QUERY, &processToken)) {
      client = ReadTokenSnapshot(processToken);
    }
    if (processToken != nullptr) CloseHandle(processToken);
    if (process != nullptr) CloseHandle(process);
    if (!client.valid) {
      fail("client_token_unavailable");
      return evidence;
    }
    evidence.clientTokenRead = true;
    evidence.clientTokenSource = "process_token";
  }
  evidence.clientUserSid = client.userSid;
  evidence.clientSessionId = client.sessionId;
  evidence.clientIntegritySid = client.integritySid;
  evidence.clientIntegrityLevel = client.integrityLevel;
  evidence.clientElevated = client.elevated;
  evidence.clientElevationType = client.elevationType;

  // 4. 比对：同用户、同会话、完整性不高于 Helper、不得由低权限 Helper 服务高权限客户端。
  evidence.sameUser = !evidence.clientUserSid.empty() && evidence.clientUserSid == evidence.selfUserSid;
  if (!evidence.sameUser) fail("user_mismatch");

  evidence.sameSession = evidence.clientSessionId == evidence.selfSessionId;
  if (!evidence.sameSession) fail("session_mismatch");

  evidence.integrityCompatible = evidence.clientIntegrityLevel != 0 && evidence.selfIntegrityLevel != 0 &&
                                  evidence.clientIntegrityLevel <= evidence.selfIntegrityLevel;
  if (!evidence.integrityCompatible) fail("integrity_mismatch");

  // Helper 永不提权：客户端已提权而 Helper 未提权时 fail closed。
  evidence.elevationCompatible = !(evidence.clientElevated && !evidence.selfElevated);
  if (!evidence.elevationCompatible) fail("elevation_mismatch");

  // 5. 祖先链：必须能到达配置的 Helper 父进程（pid + 可选创建时间）。
  evidence.ancestryChecked = true;
  if (options.parentPid == 0) {
    evidence.ancestorChain = ReadAncestorChain(evidence.clientPid);
    fail("parent_pid_not_configured");
  } else {
    evidence.ancestorChain = ReadAncestorChain(evidence.clientPid);
    if (evidence.clientPid == options.parentPid) {
      evidence.ancestryVerified = true;
      if (options.parentCreationTimeMs != 0) {
        evidence.parentCreationTimeMatched =
            evidence.clientCreationTimeKnown && evidence.clientCreationTimeMs == options.parentCreationTimeMs;
        if (!evidence.parentCreationTimeMatched) fail("parent_creation_time_mismatch");
      }
    } else {
      for (const auto& ancestor : evidence.ancestorChain) {
        if (ancestor.pid != options.parentPid) continue;
        evidence.ancestryVerified = true;
        if (options.parentCreationTimeMs != 0) {
          evidence.parentCreationTimeMatched = ancestor.creationTimeMs == options.parentCreationTimeMs;
          if (!evidence.parentCreationTimeMatched) fail("parent_creation_time_mismatch");
        }
        break;
      }
    }
    if (!evidence.ancestryVerified) fail("parent_not_in_ancestry");
  }

  // 6. Authenticode：本切片未实现，只有显式要求时才 fail closed，绝不报通过。
  if (options.requireSignature) {
    evidence.signatureStatus = "unavailable";
    fail("signature_check_unavailable");
  }

  if (options.allowUnverifiedPeer && !evidence.failures.empty()) {
    // 仅供本地开发与冒烟：放行不等于取证通过，failures 与 tokenSource 仍然如实上报。
    evidence.verified = true;
    evidence.allowedByOverride = true;
    return evidence;
  }

  evidence.verified = evidence.failures.empty();
  return evidence;
}

}  // namespace ax
