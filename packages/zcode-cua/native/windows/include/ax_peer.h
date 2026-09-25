// 令牌快照与管道 peer 取证。取证失败一律 fail closed，调用方不得把缺字段当作通过。
#pragma once

#include <windows.h>

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace ax {

struct TokenSnapshot {
  bool valid = false;
  std::string userSid;
  uint32_t sessionId = 0;
  std::string integritySid;
  uint32_t integrityLevel = 0;
  bool elevated = false;
  std::string elevationType;  // default | full | limited
  bool administrator = false;
  std::string failure;  // valid=false 时的原因
};

// 读取指定令牌的快照；token 由调用方负责关闭。
TokenSnapshot ReadTokenSnapshot(HANDLE token);
// 当前进程主线程令牌快照。
TokenSnapshot ReadSelfTokenSnapshot();
uint32_t SelfIntegrityLevel();
std::string SelfUserSid();

struct ProcessIdentity {
  bool valid = false;
  uint32_t pid = 0;
  std::string imageName;
  uint64_t creationTimeMs = 0;
  uint32_t parentPid = 0;
};

// 通过 Toolhelp 快照读取 pid 的父进程与创建时间。
ProcessIdentity ReadProcessIdentity(uint32_t pid);
// 从 pid 向上收集祖先链（不含自身，最多 64 层）。
std::vector<ProcessIdentity> ReadAncestorChain(uint32_t pid);

struct PeerEvidence {
  bool verified = false;
  uint32_t connectionId = 0;

  bool clientPidDiscovered = false;
  uint32_t clientPid = 0;
  bool clientCreationTimeKnown = false;
  uint64_t clientCreationTimeMs = 0;
  std::string clientImageName;

  bool clientTokenRead = false;
  // impersonation = 线程令牌；process_token = pid 绑定的进程令牌回退。
  std::string clientTokenSource;
  bool impersonationAttempted = false;
  bool impersonationOk = false;
  std::string impersonationError;
  std::string clientUserSid;
  uint32_t clientSessionId = 0;
  std::string clientIntegritySid;
  uint32_t clientIntegrityLevel = 0;
  bool clientElevated = false;
  std::string clientElevationType;

  std::string selfUserSid;
  uint32_t selfSessionId = 0;
  std::string selfIntegritySid;
  uint32_t selfIntegrityLevel = 0;
  bool selfElevated = false;
  std::string selfElevationType;

  bool sameUser = false;
  bool sameSession = false;
  bool integrityCompatible = false;
  bool elevationCompatible = false;

  bool ancestryChecked = false;
  bool ancestryVerified = false;
  bool parentCreationTimeMatched = false;
  std::vector<ProcessIdentity> ancestorChain;

  // 本切片不做 Authenticode 校验：状态恒为 not_verified，只有显式要求时才 fail closed。
  std::string signatureStatus = "not_verified";
  std::string signatureReason = "authenticode_verification_not_implemented";

  std::vector<std::string> failures;
  std::string rejectReason;
  bool allowedByOverride = false;
  // 首个取证失败的细节（Win32 码等），只用于诊断，不参与放行判断。
  std::string detail;
};

struct PeerCheckOptions {
  uint32_t parentPid = 0;
  uint64_t parentCreationTimeMs = 0;
  bool allowUnverifiedPeer = false;
  bool requireSignature = false;
};

// 从服务器端管道 HANDLE 取证；不使用客户端自报的任何字段。
PeerEvidence VerifyPipePeer(HANDLE pipe, uint32_t connectionId, const PeerCheckOptions& options);

}  // namespace ax
