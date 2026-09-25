#include "ax_pipe_server.h"

#include <algorithm>
#include <cstdarg>
#include <cstdio>
#include <array>
#include <condition_variable>
#include <deque>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>

#include <memory>
#include <mutex>
#include <thread>
#include <vector>

#include <aclapi.h>
#include <sddl.h>

#include "ax_common.h"
#include "ax_peer.h"

namespace ax {
namespace {

constexpr DWORD kReadChunkBytes = 64 * 1024;
constexpr DWORD kOutBufferBytes = 1024 * 1024;
constexpr DWORD kInBufferBytes = 64 * 1024;
constexpr uint64_t kMaxWriteQueueBytes = 32ull * 1024 * 1024;
constexpr size_t kMaxPipeNameChars = 256;
constexpr wchar_t kPipePrefix[] = L"\\\\.\\pipe\\";

struct Connection;

struct EventData {
  std::string type;  // connection | line | error | disconnect
  uint32_t connectionId = 0;
  bool accepted = false;
  std::string reason;
  std::string message;
  std::string text;
  uint32_t activeConnections = 0;
  PeerEvidence peer;
};

std::mutex g_handler_mutex;
napi_threadsafe_function g_tsfn = nullptr;
napi_ref g_handler_ref = nullptr;

napi_value MakePeerObject(napi_env env, const PeerEvidence& peer) {
  napi_value result = nullptr;
  napi_create_object(env, &result);
  SetBoolProp(env, result, "verified", peer.verified);
  SetBoolProp(env, result, "clientPidDiscovered", peer.clientPidDiscovered);
  SetNumberProp(env, result, "clientPid", peer.clientPid);
  SetStringProp(env, result, "clientImageName", peer.clientImageName);
  SetBoolProp(env, result, "clientCreationTimeKnown", peer.clientCreationTimeKnown);
  SetNumberProp(env, result, "clientCreationTimeMs", static_cast<double>(peer.clientCreationTimeMs));
  SetBoolProp(env, result, "clientTokenRead", peer.clientTokenRead);
  SetStringProp(env, result, "clientTokenSource", peer.clientTokenSource);
  SetBoolProp(env, result, "impersonationAttempted", peer.impersonationAttempted);
  SetBoolProp(env, result, "impersonationOk", peer.impersonationOk);
  SetStringProp(env, result, "impersonationError", peer.impersonationError);
  SetBoolProp(env, result, "allowedByOverride", peer.allowedByOverride);
  SetStringProp(env, result, "clientUserSid", peer.clientUserSid);
  SetNumberProp(env, result, "clientSessionId", peer.clientSessionId);
  SetStringProp(env, result, "clientIntegritySid", peer.clientIntegritySid);
  SetNumberProp(env, result, "clientIntegrityRank", peer.clientIntegrityLevel);
  SetBoolProp(env, result, "clientElevated", peer.clientElevated);
  SetStringProp(env, result, "clientElevationType", peer.clientElevationType);
  SetStringProp(env, result, "selfUserSid", peer.selfUserSid);
  SetNumberProp(env, result, "selfSessionId", peer.selfSessionId);
  SetStringProp(env, result, "selfIntegritySid", peer.selfIntegritySid);
  SetNumberProp(env, result, "selfIntegrityRank", peer.selfIntegrityLevel);
  SetBoolProp(env, result, "selfElevated", peer.selfElevated);
  SetStringProp(env, result, "selfElevationType", peer.selfElevationType);
  SetBoolProp(env, result, "sameUser", peer.sameUser);
  SetBoolProp(env, result, "sameSession", peer.sameSession);
  SetBoolProp(env, result, "integrityCompatible", peer.integrityCompatible);
  SetBoolProp(env, result, "elevationCompatible", peer.elevationCompatible);
  SetBoolProp(env, result, "ancestryChecked", peer.ancestryChecked);
  SetBoolProp(env, result, "ancestryVerified", peer.ancestryVerified);
  SetBoolProp(env, result, "parentCreationTimeMatched", peer.parentCreationTimeMatched);
  SetStringProp(env, result, "signatureStatus", peer.signatureStatus);
  SetStringProp(env, result, "signatureReason", peer.signatureReason);
  SetStringProp(env, result, "rejectReason", peer.rejectReason);
  SetStringProp(env, result, "detail", peer.detail);

  napi_value failures = nullptr;
  napi_create_array_with_length(env, peer.failures.size(), &failures);
  for (size_t i = 0; i < peer.failures.size(); ++i) {
    napi_set_element(env, failures, static_cast<uint32_t>(i), MakeString(env, peer.failures[i]));
  }
  napi_set_named_property(env, result, "failures", failures);

  napi_value chain = nullptr;
  napi_create_array_with_length(env, peer.ancestorChain.size(), &chain);
  for (size_t i = 0; i < peer.ancestorChain.size(); ++i) {
    const ProcessIdentity& item = peer.ancestorChain[i];
    napi_value entry = nullptr;
    napi_create_object(env, &entry);
    SetNumberProp(env, entry, "pid", item.pid);
    SetStringProp(env, entry, "imageName", item.imageName);
    SetBoolProp(env, entry, "creationTimeKnown", item.valid);
    SetNumberProp(env, entry, "creationTimeMs", static_cast<double>(item.creationTimeMs));
    napi_set_element(env, chain, static_cast<uint32_t>(i), entry);
  }
  napi_set_named_property(env, result, "ancestorChain", chain);
  return result;
}

void CallJs(napi_env env, napi_value, void*, void* data) {
  // Node 24 的 napi_create_threadsafe_function 不再接收 finalize 回调，由这里释放事件负载。
  std::unique_ptr<EventData> event(static_cast<EventData*>(data));
  napi_handle_scope scope = nullptr;
  if (napi_open_handle_scope(env, &scope) != napi_ok) return;

  napi_value handler = nullptr;
  {
    std::lock_guard<std::mutex> lock(g_handler_mutex);
    if (g_handler_ref == nullptr) {
      napi_close_handle_scope(env, scope);
      return;
    }
    if (napi_get_reference_value(env, g_handler_ref, &handler) != napi_ok || handler == nullptr) {
      napi_close_handle_scope(env, scope);
      return;
    }
  }

  napi_value payload = nullptr;
  napi_create_object(env, &payload);
  SetStringProp(env, payload, "type", event->type);
  SetNumberProp(env, payload, "connectionId", event->connectionId);
  SetBoolProp(env, payload, "accepted", event->accepted);
  SetStringProp(env, payload, "reason", event->reason);
  SetStringProp(env, payload, "message", event->message);
  SetStringProp(env, payload, "text", event->text);
  SetNumberProp(env, payload, "activeConnections", event->activeConnections);
  SetProp(env, payload, "peer", MakePeerObject(env, event->peer));
  napi_value undefined = nullptr;
  napi_get_undefined(env, &undefined);
  napi_call_function(env, undefined, handler, 1, &payload, nullptr);
  napi_close_handle_scope(env, scope);
}

void Emit(EventData event) {
  napi_threadsafe_function tsfn = nullptr;
  {
    std::lock_guard<std::mutex> lock(g_handler_mutex);
    tsfn = g_tsfn;
  }
  if (tsfn == nullptr) return;
  auto* payload = new EventData(std::move(event));
  if (napi_call_threadsafe_function(tsfn, payload, napi_tsfn_nonblocking) != napi_ok) {
    delete payload;
  }
}

struct Slot {
  HANDLE pipe = INVALID_HANDLE_VALUE;
  HANDLE connectEvent = nullptr;
  // ConnectNamedPipe 的 OVERLAPPED 必须活到操作完成：放局部变量会在 I/O 完成时被内核写进
  // 已释放的栈内存，表现为随机时刻的系统 DLL 访问违例。
  OVERLAPPED connectOverlapped{};
  bool pending = false;   // ConnectNamedPipe 已发出，事件待触发
  bool connected = false; // 客户端已连上
  bool busy = false;      // 已交给某个连接线程
};

struct Connection {
  uint32_t id = 0;
  HANDLE pipe = INVALID_HANDLE_VALUE;
  HANDLE readEvent = nullptr;
  HANDLE writeEvent = nullptr;
  HANDLE closeEvent = nullptr;
  OVERLAPPED overlappedRead{};
  DWORD readBytes = 0;
  bool readSynchronous = false;
  std::thread io;
  std::mutex mu;
  std::deque<std::string> outQueue;
  uint64_t outBytes = 0;
  uint32_t outstandingRequests = 0;
  std::string inbox;
  bool authenticated = false;
  bool closed = false;
  bool finished = false;
  uint64_t handshakeDeadline = 0;
  PeerEvidence peer;
};

struct PipeSecurity {
  SECURITY_ATTRIBUTES attributes{};
  std::vector<uint8_t> tokenInfo;
  std::vector<uint8_t> userSid;
  std::vector<uint8_t> systemSid;
  std::vector<uint8_t> descriptor;
  PACL acl = nullptr;

  PipeSecurity() {
    attributes.nLength = sizeof(SECURITY_ATTRIBUTES);
    attributes.bInheritHandle = FALSE;
  }
  ~PipeSecurity() {
    if (acl != nullptr) LocalFree(acl);
  }
};

struct Server {
  std::mutex mu;
  ServerOptions options;
  std::wstring pipeName;
  std::array<Slot, kNativeMaxConnections> slots{};
  std::vector<std::unique_ptr<Connection>> connections;
  std::thread acceptThread;
  HANDLE stopEvent = nullptr;
  bool running = false;
  bool stopping = false;
  uint32_t nextId = 1;
  uint64_t acceptedConnections = 0;
  uint64_t rejectedConnections = 0;
  uint64_t emittedLines = 0;
  uint64_t sentResponses = 0;

  Connection* FindLocked(uint32_t id) {
    for (auto& entry : connections) {
      if (entry->id == id) return entry.get();
    }
    return nullptr;
  }

  bool IsStopping() {
    std::lock_guard<std::mutex> lock(mu);
    return stopping;
  }
};

Server& Global() {
  static Server server;
  return server;
}

bool BuildPipeSecurity(PipeSecurity* security, std::string* error) {
  HANDLE token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) {
    *error = "OpenProcessToken:" + Win32Message(GetLastError());
    return false;
  }
  DWORD size = 0;
  GetTokenInformation(token, TokenUser, nullptr, 0, &size);
  if (size == 0) {
    CloseHandle(token);
    *error = "TokenUser:insufficient_size";
    return false;
  }
  security->tokenInfo.resize(size);
  const BOOL gotUser = GetTokenInformation(token, TokenUser, security->tokenInfo.data(), size, &size);
  CloseHandle(token);
  if (!gotUser) {
    *error = "TokenUser:" + Win32Message(GetLastError());
    return false;
  }
  auto* user = reinterpret_cast<TOKEN_USER*>(security->tokenInfo.data());
  const DWORD userSidLength = GetLengthSid(user->User.Sid);
  security->userSid.resize(userSidLength);
  if (!CopySid(userSidLength, security->userSid.data(), user->User.Sid)) {
    *error = "CopySid:user_failed";
    return false;
  }
  // SYSTEM SID 直接由字符串构造，避免依赖工具集是否导出 WinBuiltinSystemSid 枚举。
  PSID systemSid = nullptr;
  if (!ConvertStringSidToSidW(L"S-1-5-18", &systemSid)) {
    *error = "ConvertStringSidToSid:" + Win32Message(GetLastError());
    return false;
  }
  const DWORD systemSidLength = GetLengthSid(systemSid);
  security->systemSid.resize(systemSidLength);
  if (!CopySid(systemSidLength, security->systemSid.data(), systemSid)) {
    LocalFree(systemSid);
    *error = "CopySid:system_failed";
    return false;
  }
  LocalFree(systemSid);

  EXPLICIT_ACCESSW entries[2] = {};
  entries[0].grfAccessPermissions = GENERIC_ALL;
  entries[0].grfAccessMode = GRANT_ACCESS;
  entries[0].grfInheritance = NO_INHERITANCE;
  entries[0].Trustee.TrusteeForm = TRUSTEE_IS_SID;
  entries[0].Trustee.TrusteeType = TRUSTEE_IS_USER;
  entries[0].Trustee.ptstrName = reinterpret_cast<LPWSTR>(security->userSid.data());
  entries[1] = entries[0];
  entries[1].Trustee.TrusteeType = TRUSTEE_IS_WELL_KNOWN_GROUP;
  entries[1].Trustee.ptstrName = reinterpret_cast<LPWSTR>(security->systemSid.data());
  if (FAILED(SetEntriesInAclW(2, entries, nullptr, &security->acl))) {
    *error = "SetEntriesInAcl:" + HresultMessage(GetLastError());
    return false;
  }
  security->descriptor.resize(SECURITY_DESCRIPTOR_MIN_LENGTH);
  if (!InitializeSecurityDescriptor(security->descriptor.data(), SECURITY_DESCRIPTOR_REVISION)) {
    *error = "InitializeSecurityDescriptor:" + Win32Message(GetLastError());
    return false;
  }
  if (!SetSecurityDescriptorDacl(security->descriptor.data(), TRUE, security->acl, FALSE)) {
    *error = "SetSecurityDescriptorDacl:" + Win32Message(GetLastError());
    return false;
  }
  if (!SetSecurityDescriptorOwner(security->descriptor.data(), user->User.Sid, FALSE)) {
    *error = "SetSecurityDescriptorOwner:" + Win32Message(GetLastError());
    return false;
  }
  security->attributes.lpSecurityDescriptor = security->descriptor.data();
  return true;
}

void CloseSlot(Slot* slot) {
  if (slot->pipe != INVALID_HANDLE_VALUE) {
    CloseHandle(slot->pipe);
    slot->pipe = INVALID_HANDLE_VALUE;
  }
  if (slot->connectEvent != nullptr) {
    CloseHandle(slot->connectEvent);
    slot->connectEvent = nullptr;
  }
  slot->pending = false;
  slot->connected = false;
  slot->busy = false;
  slot->connectOverlapped = OVERLAPPED{};
}

bool CreateInstance(Server* server, Slot* slot, bool first, PipeSecurity* security, std::string* error) {
  // FILE_FLAG_OVERLAPPED 是前提：否则 ConnectNamedPipe 与 ReadFile/WriteFile 都会退化成阻塞调用。
  DWORD openMode = PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED;
  if (first) openMode |= FILE_FLAG_FIRST_PIPE_INSTANCE;
  slot->pipe = CreateNamedPipeW(server->pipeName.c_str(), openMode,
                                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT, kNativeMaxConnections,
                                kOutBufferBytes, kInBufferBytes, 0, &security->attributes);
  if (slot->pipe == INVALID_HANDLE_VALUE) {
    *error = "CreateNamedPipeW:" + Win32Message(GetLastError());
    return false;
  }
  slot->connectEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (slot->connectEvent == nullptr) {
    *error = "CreateEvent:" + Win32Message(GetLastError());
    CloseSlot(slot);
    return false;
  }
  // 必须传 OVERLAPPED：传 nullptr 会退化为阻塞式连接，把 accept 线程卡在第一个实例上。
  slot->connectOverlapped = OVERLAPPED{};
  slot->connectOverlapped.hEvent = slot->connectEvent;
  if (ConnectNamedPipe(slot->pipe, &slot->connectOverlapped) == FALSE) {
    const DWORD err = GetLastError();
    if (err == ERROR_PIPE_CONNECTED) {
      slot->connected = true;
    } else if (err == ERROR_IO_PENDING) {
      slot->pending = true;
    } else if (err == ERROR_NO_DATA) {
      // 客户端在连接后立刻断开，实例可复用。
      DisconnectNamedPipe(slot->pipe);
    } else {
      *error = "ConnectNamedPipe:" + Win32Message(err);
      CloseSlot(slot);
      return false;
    }
  } else {
    // 已连接的实例会同步返回成功。
    slot->connected = true;
  }
  return true;
}

// 重叠读必须先发出再等待：数据到达时内核只会唤醒已挂起的读请求。
bool StartRead(Connection* connection, std::vector<char>& buffer) {
  OVERLAPPED overlapped{};
  overlapped.hEvent = connection->readEvent;
  ResetEvent(connection->readEvent);
  connection->overlappedRead = overlapped;
  DWORD read = 0;
  if (ReadFile(connection->pipe, buffer.data(), static_cast<DWORD>(buffer.size()), &read, &connection->overlappedRead)) {
    // 同步完成（缓冲区够大或管道缓冲里已有数据且立即完成）。
    connection->readSynchronous = true;
    connection->readBytes = read;
    SetEvent(connection->readEvent);
    return true;
  }
  const DWORD err = GetLastError();
  if (err != ERROR_IO_PENDING) return false;
  connection->readSynchronous = false;
  return true;
}

bool CompleteRead(Server* server, Connection* connection) {
  if (connection->readSynchronous) {
    connection->readSynchronous = false;
    return connection->readBytes > 0;
  }
  if (!GetOverlappedResult(connection->pipe, &connection->overlappedRead, &connection->readBytes, FALSE)) {
    return false;
  }
  (void)server;
  return connection->readBytes > 0;
}

bool WriteChunk(Server* server, Connection* connection, const std::string& payload) {
  size_t offset = 0;
  OVERLAPPED overlapped{};
  overlapped.hEvent = connection->writeEvent;
  while (offset < payload.size()) {
    ResetEvent(connection->writeEvent);
    const size_t remaining = payload.size() - offset;
    const DWORD toWrite = static_cast<DWORD>(remaining > kReadChunkBytes ? kReadChunkBytes : remaining);
    DWORD written = 0;
    if (!WriteFile(connection->pipe, payload.data() + offset, toWrite, &written, &overlapped)) {
      const DWORD err = GetLastError();
      if (err != ERROR_IO_PENDING) return false;
      HANDLE handles[2] = {connection->writeEvent, server->stopEvent};
      const DWORD wait = WaitForMultipleObjects(2, handles, FALSE, INFINITE);
      if (wait != WAIT_OBJECT_0) {
        CancelIoEx(connection->pipe, &overlapped);
        return false;
      }
      if (!GetOverlappedResult(connection->pipe, &overlapped, &written, FALSE)) return false;
    }
    if (written == 0) return false;
    offset += written;
  }
  return true;
}

/** 队列里还有待写数据（含正在写的一半）。必须在 connection->mu 下调用。 */
bool HasPendingWritesLocked(const Connection* connection) {
  return !connection->outQueue.empty() || connection->outBytes > 0;
}

bool FlushWrites(Server* server, Connection* connection) {
  for (;;) {
    std::string front;
    {
      std::lock_guard<std::mutex> lock(connection->mu);
      if (connection->outQueue.empty()) return true;
      front = connection->outQueue.front();
    }
    const bool wrote = WriteChunk(server, connection, front);
    if (!wrote) return false;
    std::lock_guard<std::mutex> lock(connection->mu);
    if (!connection->outQueue.empty()) {
      connection->outBytes -= connection->outQueue.front().size();
      connection->outQueue.pop_front();
    }
  }
}

// 提取完整行并向 JS 派发；行缓冲与在途请求数都有硬上限。
bool ProcessInbox(Server* server, Connection* connection, std::string* reason) {
  for (;;) {
    const size_t position = connection->inbox.find('\n');
    if (position == std::string::npos) break;
    std::string line = connection->inbox.substr(0, position);
    connection->inbox.erase(0, position + 1);
    if (!line.empty() && line.back() == '\r') line.pop_back();
    if (line.size() > server->options.maxLineBytes) {
      *reason = "line_too_long";
      EventData event;
      event.type = "error";
      event.connectionId = connection->id;
      event.reason = "line_too_long";
      event.message = "line exceeds maxLineBytes=" + std::to_string(server->options.maxLineBytes);
      Emit(std::move(event));
      return false;
    }
    {
      std::lock_guard<std::mutex> lock(connection->mu);
      if (connection->outstandingRequests >= server->options.maxQueuedRequests) {
        *reason = "request_limit_exceeded";
        EventData event;
        event.type = "error";
        event.connectionId = connection->id;
        event.reason = "request_limit_exceeded";
        event.message = "more than maxQueuedRequests=" + std::to_string(server->options.maxQueuedRequests) +
                        " requests without a response";
        Emit(std::move(event));
        return false;
      }
      connection->outstandingRequests++;
    }
    connection->authenticated = true;
    {
      std::lock_guard<std::mutex> lock(server->mu);
      server->emittedLines++;
    }
    EventData event;
    event.type = "line";
    event.connectionId = connection->id;
    event.text = std::move(line);
    Emit(std::move(event));
  }
  if (connection->inbox.size() > server->options.maxLineBytes) {
    *reason = "line_too_long";
    EventData event;
    event.type = "error";
    event.connectionId = connection->id;
    event.reason = "line_too_long";
    event.message = "unterminated buffer exceeds maxLineBytes=" + std::to_string(server->options.maxLineBytes);
    Emit(std::move(event));
    return false;
  }
  return true;
}

void RunConnection(Server* server, Connection* connection) {
  std::string reason = "closed";
  connection->handshakeDeadline = GetTickCount64() + server->options.handshakeTimeoutMs;
  PeerCheckOptions peerOptions;
  peerOptions.parentPid = server->options.parentPid;
  peerOptions.parentCreationTimeMs = server->options.parentCreationTimeMs;
  peerOptions.allowUnverifiedPeer = server->options.allowUnverifiedPeer;
  peerOptions.requireSignature = server->options.requireSignature;
  connection->peer = VerifyPipePeer(connection->pipe, connection->id, peerOptions);

  EventData event;
  event.type = "connection";
  event.connectionId = connection->id;
  event.accepted = connection->peer.verified;
  event.reason = connection->peer.verified ? std::string() : connection->peer.rejectReason;
  event.message = connection->peer.verified ? std::string() : connection->peer.detail;
  event.peer = connection->peer;
  {
    std::lock_guard<std::mutex> lock(server->mu);
    event.activeConnections = static_cast<uint32_t>(server->connections.size());
    if (connection->peer.verified) {
      server->acceptedConnections++;
    } else {
      server->rejectedConnections++;
    }
  }
  Emit(std::move(event));
  if (!connection->peer.verified) {
    reason = connection->peer.rejectReason.empty() ? "peer_check_failed" : connection->peer.rejectReason;
    connection->finished = true;
    return;
  }

  connection->readEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  connection->writeEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  connection->closeEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (connection->readEvent == nullptr || connection->writeEvent == nullptr || connection->closeEvent == nullptr) {
    reason = "event_create_failed";
    connection->finished = true;
    return;
  }

  std::vector<char> chunk(kReadChunkBytes);
  if (!StartRead(connection, chunk)) {
    reason = "read_failed";
    connection->finished = true;
    return;
  }
  for (;;) {
    if (server->IsStopping()) {
      reason = "server_stopping";
      break;
    }
    {
      std::lock_guard<std::mutex> lock(connection->mu);
      if (connection->closed) {
        reason = "closed_by_host";
        break;
      }
    }
    DWORD timeout = INFINITE;
    if (!connection->authenticated && server->options.handshakeTimeoutMs > 0) {
      const uint64_t now = GetTickCount64();
      timeout = connection->handshakeDeadline > now ? static_cast<DWORD>(connection->handshakeDeadline - now) : 0;
    }
    // 丢唤醒防护：writeEvent 是手动复位事件，只有在持锁确认队列为空时才复位。
    // 无条件 ResetEvent 会把 JS 线程刚发来的 SetEvent 抹掉，响应就永远发不出去。
    {
      std::lock_guard<std::mutex> lock(connection->mu);
      if (!HasPendingWritesLocked(connection)) ResetEvent(connection->writeEvent);
    }
    HANDLE handles[4] = {connection->readEvent, connection->writeEvent, connection->closeEvent,
                         server->stopEvent};
    const DWORD wait = WaitForMultipleObjects(4, handles, FALSE, timeout);
    if (wait != WAIT_OBJECT_0 + 1) {
      bool pending = false;
      {
        std::lock_guard<std::mutex> lock(connection->mu);
        pending = HasPendingWritesLocked(connection);
      }
      if (pending) {
        if (!FlushWrites(server, connection)) {
          reason = "write_failed";
          break;
        }
        continue;
      }
    }
    if (wait == WAIT_OBJECT_0 + 3) {
      reason = "server_stopping";
      break;
    }
    if (wait == WAIT_OBJECT_0 + 2) {
      reason = "closed_by_host";
      break;
    }
    if (wait == WAIT_OBJECT_0 + 1) {
      if (!FlushWrites(server, connection)) {
        reason = "write_failed";
        break;
      }
      continue;
    }
    if (wait == WAIT_TIMEOUT) {
      reason = "handshake_timeout";
      EventData timeoutEvent;
      timeoutEvent.type = "error";
      timeoutEvent.connectionId = connection->id;
      timeoutEvent.reason = "handshake_timeout";
      timeoutEvent.message = "no first frame within handshakeTimeoutMs=" +
                             std::to_string(server->options.handshakeTimeoutMs);
      Emit(std::move(timeoutEvent));
      break;
    }
    if (wait != WAIT_OBJECT_0) {
      reason = "wait_failed";
      break;
    }
    if (!CompleteRead(server, connection)) {
      reason = "read_failed";
      break;
    }
    chunk.resize(kReadChunkBytes);
    connection->inbox.append(chunk.data(), connection->readBytes);
    if (!ProcessInbox(server, connection, &reason)) break;
    if (!StartRead(connection, chunk)) {
      reason = "read_failed";
      break;
    }
  }

  EventData disconnect;
  disconnect.type = "disconnect";
  disconnect.connectionId = connection->id;
  disconnect.reason = reason;
  Emit(std::move(disconnect));
  connection->finished = true;
}

/** 关闭一个已 join 的连接所占用的全部句柄。 */
void ReleaseConnectionHandles(Server* server, Connection* connection) {
  // join 之后才能安全关闭句柄：IO 已结束，不会再触碰 HANDLE。
  for (size_t i = 0; i < server->slots.size(); ++i) {
    if (server->slots[i].busy && server->slots[i].pipe == connection->pipe) {
      CloseSlot(&server->slots[i]);
      break;
    }
  }
  CancelIoEx(connection->pipe, nullptr);
  if (connection->pipe != INVALID_HANDLE_VALUE) CloseHandle(connection->pipe);
  for (HANDLE handle : {connection->readEvent, connection->writeEvent, connection->closeEvent}) {
    if (handle != nullptr) CloseHandle(handle);
  }
}

void ReapFinished(Server* server) {
  std::vector<std::unique_ptr<Connection>> finished;
  {
    std::lock_guard<std::mutex> lock(server->mu);
    for (auto it = server->connections.begin(); it != server->connections.end();) {
      if (!(*it)->finished) {
        ++it;
        continue;
      }
      finished.push_back(std::move(*it));
      it = server->connections.erase(it);
    }
  }
  // join 必须在锁外：IO 线程结束前可能还要拿 server->mu。
  for (auto& connection : finished) {
    if (connection->io.joinable()) connection->io.join();
    ReleaseConnectionHandles(server, connection.get());
  }
}

/**
 * 停机路径：把仍存活的连接搬出容器，先 join IO 线程再释放句柄。
 * 绝不能直接 clear()：joinable 的 std::thread 析构会 std::terminate，进程以 0xC0000409 崩掉。
 */
void ShutdownConnections(Server* server) {
  std::vector<std::unique_ptr<Connection>> live;
  {
    std::lock_guard<std::mutex> lock(server->mu);
    live.swap(server->connections);
    for (auto& connection : live) {
      connection->closed = true;
      if (connection->closeEvent != nullptr) SetEvent(connection->closeEvent);
      if (connection->pipe != INVALID_HANDLE_VALUE) CancelIoEx(connection->pipe, nullptr);
    }
  }
  for (auto& connection : live) {
    if (connection->io.joinable()) connection->io.join();
    ReleaseConnectionHandles(server, connection.get());
  }
}

void OnSlotConnected(Server* server, Slot* slot) {
  Connection* raw = nullptr;
  {
    std::lock_guard<std::mutex> lock(server->mu);
    if (server->stopping) {
      // stop 期间到达的连接立即回收。
    } else if (server->connections.size() >= server->options.maxConnections) {
      server->rejectedConnections++;
      EventData event;
      event.type = "connection";
      event.accepted = false;
      event.reason = "connection_limit";
      event.message = "maxConnections=" + std::to_string(server->options.maxConnections);
      ULONG pid = 0;
      if (GetNamedPipeClientProcessId(slot->pipe, &pid)) {
        event.peer.clientPidDiscovered = true;
        event.peer.clientPid = pid;
        ProcessIdentity identity = ReadProcessIdentity(pid);
        event.peer.clientImageName = identity.imageName;
        if (identity.valid) {
          event.peer.clientCreationTimeKnown = true;
          event.peer.clientCreationTimeMs = identity.creationTimeMs;
        }
      } else {
        event.peer.failures.emplace_back("client_pid_unavailable");
      }
      event.peer.rejectReason = "connection_limit";
      event.activeConnections = static_cast<uint32_t>(server->connections.size());
      Emit(std::move(event));
    } else {
      auto connection = std::make_unique<Connection>();
      connection->id = server->nextId++;
      connection->pipe = slot->pipe;
      slot->busy = true;
      server->connections.push_back(std::move(connection));
      raw = server->connections.back().get();
    }
  }
  if (slot->pipe != INVALID_HANDLE_VALUE && (raw == nullptr || slot->busy == false)) {
    // 未交给连接线程的实例（超限或 stop 中）直接关闭。
    CloseSlot(slot);
  }
  if (raw != nullptr) {
    raw->io = std::thread([server, raw] { RunConnection(server, raw); });
  }
}

void AcceptLoop(Server* server) {
  PipeSecurity security;
  std::string error;
  if (!BuildPipeSecurity(&security, &error)) {
    EventData event;
    event.type = "error";
    event.reason = "security_descriptor_failed";
    event.message = error;
    Emit(std::move(event));
  } else {
    // 第一个实例已由 StartPipeServer 同步建好，这里不能再次抢 FIRST_PIPE_INSTANCE。
    bool firstInstance = server->slots[0].pipe == INVALID_HANDLE_VALUE;
    bool createFailed = false;
    for (;;) {
      if (server->IsStopping()) break;
      ReapFinished(server);
      if (!createFailed) {
        for (auto& slot : server->slots) {
          if (slot.pipe != INVALID_HANDLE_VALUE) continue;
          std::string createError;
          if (!CreateInstance(server, &slot, firstInstance, &security, &createError)) {
            EventData event;
            event.type = "error";
            event.reason = "create_pipe_failed";
            event.message = createError;
            Emit(std::move(event));
            createFailed = true;
            break;
          }
          firstInstance = false;
        }
      }
      std::array<HANDLE, kNativeMaxConnections + 1> handles{};
      std::array<DWORD, kNativeMaxConnections + 1> indices{};
      DWORD count = 0;
      for (size_t i = 0; i < server->slots.size(); ++i) {
        Slot& slot = server->slots[i];
        if (slot.connected && !slot.busy) {
          OnSlotConnected(server, &slot);
        }
        if (!slot.pending) continue;
        handles[count] = slot.connectEvent;
        indices[count] = static_cast<DWORD>(i);
        ++count;
      }
      handles[count] = server->stopEvent;
      const DWORD stopIndex = count;
      ++count;
      if (count == 1) {
        if (WaitForSingleObject(server->stopEvent, 50) == WAIT_OBJECT_0) break;
        continue;
      }
      const DWORD wait = WaitForMultipleObjects(count, handles.data(), FALSE, 50);
      if (wait == WAIT_FAILED) break;
      if (wait < WAIT_OBJECT_0 || wait >= WAIT_OBJECT_0 + count) continue;
      if (wait == WAIT_OBJECT_0 + stopIndex) break;
      Slot& slot = server->slots[indices[wait - WAIT_OBJECT_0]];
      slot.pending = false;
      slot.connected = true;
      OnSlotConnected(server, &slot);
    }
  }
  ReapFinished(server);
  // 停机：先 join 仍在跑的 IO 线程，再关实例；直接 clear() 会因 joinable 线程崩溃。
  ShutdownConnections(server);
  for (auto& slot : server->slots) {
    if (!slot.busy) CloseSlot(&slot);
  }
  {
    std::lock_guard<std::mutex> lock(server->mu);
    server->running = false;
  }
  if (server->stopEvent != nullptr) {
    CloseHandle(server->stopEvent);
    server->stopEvent = nullptr;
  }
}

bool ValidatePipeName(const std::string& name, std::string* error) {
  const std::wstring wide = WidenUtf8(name);
  if (wide.rfind(kPipePrefix, 0) != 0) {
    *error = "pipeName must start with \\\\.\\pipe\\";
    return false;
  }
  if (wide.size() >= kMaxPipeNameChars) {
    *error = "pipeName too long";
    return false;
  }
  for (wchar_t c : wide) {
    if (c < 0x20) {
      *error = "pipeName contains control characters";
      return false;
    }
  }
  return true;
}

}  // namespace

bool StartPipeServer(const std::string& pipeName, const ServerOptions& options, std::string* error) {
  Server& server = Global();
  {
    std::lock_guard<std::mutex> lock(server.mu);
    if (server.running) {
      *error = "server already running on " + NarrowUtf8(server.pipeName);
      return false;
    }
  }
  if (!ValidatePipeName(pipeName, error)) return false;
  if (options.maxConnections == 0 || options.maxConnections > kNativeMaxConnections) {
    *error = "maxConnections must be within 1..8";
    return false;
  }
  if (options.maxLineBytes == 0 || options.maxLineBytes > kNativeMaxLineBytes) {
    *error = "maxLineBytes must be within 1..16777216";
    return false;
  }
  if (options.maxQueuedRequests == 0 || options.maxQueuedRequests > kNativeMaxQueuedRequests) {
    *error = "maxQueuedRequests must be within 1..64";
    return false;
  }
  if (options.requireSignature) {
    // Authenticode 校验未实现：不能在这里假装通过，直接拒绝该配置。
    *error = "requireSignature is not supported: authenticode verification is not implemented";
    return false;
  }
  // DACL 必须在建实例之前备好：CreateNamedPipe 会复制它，之后本地对象即可析构。
  PipeSecurity security;
  if (!BuildPipeSecurity(&security, error)) return false;

  {
    std::lock_guard<std::mutex> lock(server.mu);
    server.options = options;
    server.pipeName = WidenUtf8(pipeName);
    server.stopping = false;
    server.nextId = 1;
    server.acceptedConnections = 0;
    server.rejectedConnections = 0;
    server.emittedLines = 0;
    server.sentResponses = 0;
    server.stopEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (server.stopEvent == nullptr) {
      *error = "CreateEvent:" + Win32Message(GetLastError());
      return false;
    }
    for (auto& slot : server.slots) CloseSlot(&slot);
    server.connections.clear();
    server.running = true;
    // 同步建好第一个管道实例再返回：调用方拿到返回值后立刻连接（Host 健康探针与冒烟测试都是
    // 紧接着 connect），若等 accept 线程再建实例就会撞上 ENOENT。
    std::string createError;
    if (!CreateInstance(&server, &server.slots[0], true, &security, &createError)) {
      server.running = false;
      if (server.stopEvent != nullptr) {
        CloseHandle(server.stopEvent);
        server.stopEvent = nullptr;
      }
      *error = createError;
      return false;
    }
  }
  // 必须按值捕获 Server*：server 是函数内的引用变量，`[&server]` 捕获的是这个引用本身，
  // StartPipeServer 返回后它就是悬垂引用，accept 线程会在任意时刻读到垃圾指针并崩溃。
  Server* serverPtr = &server;
  server.acceptThread = std::thread([serverPtr] { AcceptLoop(serverPtr); });
  return true;
}

StopResult StopPipeServer(uint32_t timeoutMs) {
  Server& server = Global();
  StopResult result;
  // 只复制 HANDLE，不跨线程持有 Connection*：accept 线程可能在下面 join 期间回收它们。
  std::vector<HANDLE> pipesToCancel;
  HANDLE acceptHandle = nullptr;
  {
    std::lock_guard<std::mutex> lock(server.mu);
    if (server.running && !server.stopping) {
      server.stopping = true;
      if (server.stopEvent != nullptr) SetEvent(server.stopEvent);
      for (auto& connection : server.connections) {
        {
          std::lock_guard<std::mutex> lock2(connection->mu);
          connection->closed = true;
          if (connection->closeEvent != nullptr) SetEvent(connection->closeEvent);
        }
        if (connection->pipe != INVALID_HANDLE_VALUE) pipesToCancel.push_back(connection->pipe);
      }
    }
    if (server.acceptThread.joinable()) acceptHandle = server.acceptThread.native_handle();
  }
  for (HANDLE pipe : pipesToCancel) CancelIoEx(pipe, nullptr);
  if (acceptHandle != nullptr) {
    const DWORD wait = WaitForSingleObject(acceptHandle, timeoutMs);
    result.stopped = wait == WAIT_OBJECT_0;
    // 无论如何都要 join：残留 joinable 的 std::thread 会在静态析构时 std::terminate，
    // 进程以 0xC0000409 崩掉。accept 循环看到 stopEvent 就会退出，所以 join 不会长阻塞。
    if (server.acceptThread.joinable()) server.acceptThread.join();
    if (!result.stopped) result.stopped = !server.running;
  } else {
    result.stopped = !server.running;
  }
  // accept 线程退出时会回收连接；这里再兜一次，覆盖「它没跑到那一步」的情况。
  ShutdownConnections(&server);
  {
    std::lock_guard<std::mutex> lock(server.mu);
    result.remainingConnections = static_cast<uint32_t>(server.connections.size());
  }
  return result;
}

bool SendPipeResponse(uint32_t connectionId, const std::string& line) {
  Server& server = Global();
  HANDLE writeEvent = nullptr;
  {
    std::lock_guard<std::mutex> lock(server.mu);
    Connection* connection = server.FindLocked(connectionId);
    if (connection == nullptr) return false;
    std::string payload = line;
    payload += '\n';
    {
      std::lock_guard<std::mutex> lock2(connection->mu);
      if (connection->closed || !connection->authenticated) return false;
      if (connection->outstandingRequests == 0) return false;
      if (connection->outBytes + payload.size() > kMaxWriteQueueBytes) {
        connection->closed = true;
        if (connection->closeEvent != nullptr) SetEvent(connection->closeEvent);
        return false;
      }
      connection->outBytes += payload.size();
      connection->outQueue.push_back(std::move(payload));
      connection->outstandingRequests--;
      server.sentResponses++;
      writeEvent = connection->writeEvent;
    }
  }
  if (writeEvent != nullptr) SetEvent(writeEvent);
  return true;
}

bool ClosePipeConnection(uint32_t connectionId, const std::string& reason) {
  Server& server = Global();
  HANDLE closeEvent = nullptr;
  HANDLE pipe = nullptr;
  {
    std::lock_guard<std::mutex> lock(server.mu);
    Connection* connection = server.FindLocked(connectionId);
    if (connection == nullptr) return false;
    std::lock_guard<std::mutex> lock2(connection->mu);
    if (connection->closed) return false;
    connection->closed = true;
    closeEvent = connection->closeEvent;
    pipe = connection->pipe;
  }
  if (closeEvent != nullptr) SetEvent(closeEvent);
  if (pipe != nullptr) CancelIoEx(pipe, nullptr);
  EventData event;
  event.type = "error";
  event.connectionId = connectionId;
  event.reason = "closed_by_host";
  event.message = reason;
  Emit(std::move(event));
  return true;
}

ServerStatus GetServerStatus() {
  Server& server = Global();
  ServerStatus status;
  std::lock_guard<std::mutex> lock(server.mu);
  status.running = server.running;
  status.stopping = server.stopping;
  status.pipeName = NarrowUtf8(server.pipeName);
  status.activeConnections = static_cast<uint32_t>(server.connections.size());
  for (size_t i = 0; i < server.connections.size() && i < kNativeMaxConnections; ++i) {
    status.openConnectionIds[i] = server.connections[i]->id;
  }
  status.openConnectionCount = std::min<uint32_t>(status.activeConnections, kNativeMaxConnections);
  status.acceptedConnections = server.acceptedConnections;
  status.rejectedConnections = server.rejectedConnections;
  status.emittedLines = server.emittedLines;
  status.sentResponses = server.sentResponses;
  return status;
}

void SetServerEventHandler(napi_env env, napi_value handler) {
  napi_valuetype type = napi_undefined;
  napi_typeof(env, handler, &type);
  const bool enabled = type == napi_function;
  if (!enabled && type != napi_null && type != napi_undefined) {
    ThrowError(env, "invalid_event_handler", "handler must be a function, null or undefined");
    return;
  }

  napi_threadsafe_function released = nullptr;
  {
    std::lock_guard<std::mutex> lock(g_handler_mutex);
    if (g_handler_ref != nullptr) {
      napi_delete_reference(env, g_handler_ref);
      g_handler_ref = nullptr;
    }
    if (enabled) {
      if (g_tsfn != nullptr) return;
      if (napi_create_reference(env, handler, 1, &g_handler_ref) != napi_ok) {
        ThrowError(env, "handler_reference_failed", "cannot hold the event handler reference");
        return;
      }
      napi_value resourceName = MakeString(env, "zcode-cua:server-events");
      if (napi_create_threadsafe_function(env, nullptr, nullptr, resourceName, 0, 1, nullptr, nullptr,
                                          g_handler_ref, CallJs, &g_tsfn) != napi_ok) {
        napi_delete_reference(env, g_handler_ref);
        g_handler_ref = nullptr;
        g_tsfn = nullptr;
        ThrowError(env, "threadsafe_function_failed", "cannot create the server event threadsafe function");
        return;
      }
      // 不让 transport 事件本身吊住事件循环，Helper 生命周期由 Host 控制。
      napi_unref_threadsafe_function(env, g_tsfn);
    } else {
      // 运行中先只清空 JS 引用，threadsafe function 留到停止后释放。
      released = g_tsfn;
      g_tsfn = nullptr;
    }
  }
  if (released != nullptr) {
    if (GetServerStatus().running) {
      napi_release_threadsafe_function(released, napi_tsfn_abort);
    } else {
      napi_release_threadsafe_function(released, napi_tsfn_release);
    }
  }
}

void ShutdownPipeServer() {
  const StopResult stop = StopPipeServer(2000);
  if (!stop.stopped) return;
  napi_threadsafe_function released = nullptr;
  {
    std::lock_guard<std::mutex> lock(g_handler_mutex);
    released = g_tsfn;
    g_tsfn = nullptr;
  }
  if (released != nullptr) napi_release_threadsafe_function(released, napi_tsfn_abort);
}

}  // namespace ax
