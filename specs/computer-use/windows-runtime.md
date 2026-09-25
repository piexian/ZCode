# Windows Computer Use runtime

Status: implementation-ready after review
Platform: Windows 11 x64, Node/Electron host, MSVC N-API addon
Baseline: ZCode 3.14.3

## Goal

Restore a real Windows producer so the model can observe and operate desktop applications through the existing `node_repl` CUA host. The current fail-closed placeholder remains the default until the Windows runtime passes the capability, security, and integration gates.

Implementation must be clean-room. No investigation binary, decompiled source, or extracted sample is copied into this repository, build output, or release artifact.

## Decision

Use a Node Windows Helper plus an MSVC-built N-API addon. The addon owns privileged Win32 operations: UI Automation, Windows Graphics Capture, Direct3D11, `SendInput`, clipboard, DPI, process/token inspection, Authenticode verification, and named-pipe peer checks.

The host was verified before implementation: WSL2 Ubuntu 24.04 on Windows 11 build 26100 x64; Visual Studio 2022 Build Tools with MSVC 14.44, Windows SDK 10.0.26100, Node 24.16, and .NET 10 are available. The addon path was selected by the user.

## Scope

Supported model tools:

`list_apps`, `list_windows`, `get_app_state`, `left_click`, `scroll`, `left_click_drag`, `type`, `set_value`, `select_text`, `key`, `perform_action`, `paste`, `request_access`, `stop_computer_control`.

Supported Helper capabilities:

- Application, window, and UIA element discovery.
- Semantic element actions.
- Foreground pointer and keyboard input through `SendInput`.
- WGC window/monitor capture through D3D11 with PMv2 coordinate safety.
- Clipboard text save/write/paste/restore used by `paste`.
- Session, elevation, DPI, capture-support, and UIA diagnostics.

Explicit Windows limits:

- No PiP presentation surface. PiP methods return `unimplemented`.
- No ghost cursor.
- No background-window pointer dispatch.
- No PID-scoped verified keyboard delivery. `*_to_app` requires the verified target to remain foreground.
- No arbitrary application launch. An unresolvable app returns `app_not_found`; `launch_failed` is reserved for a future launch contract and is not emitted by this slice.

These limits must be explicit in tool descriptions and diagnostics. macOS parity must not be implied.

## Actors and trust model

```text
desktop Host (services)
  -> Windows Helper entry (Node, forked child)
       -> Windows N-API addon
            -> Win32 / UIA / WGC / D3D11 / input / clipboard

node_repl MCP host
  -> JS producer runtime
       -> authenticated NDJSON client
            -> Windows Helper pipe
```

The pipe client is the `node_repl` host process. The desktop Host also connects for `probeHelperHealth` and controller methods. Both are descendants of, or equal to, the verified Host identity; the Helper never trusts a self-reported pid or role.

Before any business method the Helper verifies, using native APIs:

1. The pipe client process id is discoverable and its process creation time is recorded.
2. The client is the desktop Host itself or has an ancestor chain that reaches the Host pid and creation time.
3. Client and Helper have the same user SID and logon session.
4. Client and Helper have compatible integrity/elevation state. The Helper never elevates; an elevated target fails closed.
5. Product mode verifies the Host executable publisher/signature. Local development may skip only that signature check.

The Helper pins the verified client identity for each connection. A client cannot change its reported role after authentication. A failed or unavailable peer check fails closed before dispatch.

The model-visible Worker must start with an environment that has every `ZCODE_CUA_*` key removed, and must not receive the raw broker socket or token in `workerData`. It may use only a `MessagePort` request channel and the private in-process bridge exposed by `node_repl`. This is a hard prerequisite: remove `cuaBroker` from worker data, start `new Worker(..., { env: createWorkerEnv() })` where `createWorkerEnv` copies `process.env` and deletes the CUA broker keys, and add a test that model code cannot read broker credentials, cannot find any `ZCODE_CUA_*` key, and still sees the non-CUA env the Browser bridge needs. Clearing the whole environment is not acceptable: the Browser Use bridge reads its own broker socket and token from `process.env`.

Multiple node_repl clients may connect. Each connection gets an isolated element-token namespace. Mutating native input is globally serialized; concurrent mutating requests return `controller_busy` rather than interleaving input.

## Broker protocol

- Transport: `\\\\.\\pipe\\zcode-cua-helper-<32 lowercase hex>` on Windows.
- Framing: UTF-8 NDJSON, one request or response per line.
- Server line limit: 16 MiB measured in bytes, not UTF-16 code units.
- Client request limit: 1 MiB. Client response limit: 16 MiB.
- Protocol version: `2`. Missing, malformed, or lower versions fail closed; higher versions return `version_mismatch`.
- The first frame must be `authenticate`; `ping` and business frames are not accepted before it succeeds.
- `authenticate` carries version, role, and non-authoritative metadata. Peer identity is decided by the native layer.
- Requests are serialized per connection. Connection count, request rate, and action concurrency are bounded.
- Request `id` is a non-empty string, generated by the client as `<prefix>-<time36>-<counter36>`. A string id is used instead of the official numeric counter so that two connections in the same Helper generation cannot collide and so a stale response from a previous generation can never be mistaken for a live one. Every response preserves the request `id`. Truncated, oversized, duplicate-key, or mismatched frames never resolve as success.

## Native transport and peer evidence

Node `net.Server` does not expose a Windows pipe HANDLE (`socket._handle.fd` is `-1` in Node 24). The Windows Helper therefore does not create the broker pipe with Node `net`. The addon creates the pipe with `CreateNamedPipeW`, `FILE_FLAG_FIRST_PIPE_INSTANCE`, and an explicit DACL that allows only the Helper user and SYSTEM. It owns the server HANDLE for the lifetime of the generation.

The addon exposes a small asynchronous transport surface to `win/entry.cjs`: start server, receive verified request lines, send a response line, close a connection, and stop the server. Native threadsafe functions carry events to JS; JS never receives the raw HANDLE and never uses `net` for the Helper server. Client processes continue to use ordinary named-pipe connections.

Peer evidence comes from the native server HANDLE: `GetNamedPipeClientProcessId`, SID/session/integrity queries, process creation times, and the process table for the ancestry chain. The Helper records the verified client identity for each connection. The Host health connection and node_repl tool connections are distinct roles; both must pass the same user/session/ancestry checks.

Thread impersonation is attempted first and is expected to fail on hosts where the pipe handle carries no `FILE_IMPERSONATE` right: `CreateNamedPipe` cannot request that right, so `ImpersonateNamedPipeClient` returns `ERROR_NO_TOKEN`. The implementation therefore falls back to the client PID's process token (`OpenProcess` + `OpenProcessToken`), reports which path was used in `client_token_source`, and fails closed when neither path yields a token. It never reports impersonation as verified when it was not. A later slice may add a dedicated impersonation-capable pipe handle; until then the process-token path is the contract, and the ancestry check plus creation-time binding is what prevents PID reuse from passing.

Native limits: at most 8 concurrent connections, 64 queued requests per connection, a bounded handshake timeout, a bounded line buffer, and one global mutating-input slot. Excess connections or requests receive a stable error or are closed; they never block the control channel.

Element tokens are opaque native strings and must never appear in model-visible text or structured content. The model uses the observation index; the producer resolves the index to a connection-scoped token before dispatch.

The existing 42-method table remains the version-negotiation contract. Windows returns `unimplemented` for macOS-only methods.

| Method group                                                              | Windows behavior                                                                                            |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `broker_info`, `ping`, diagnostics                                        | supported; `broker_info` includes `pid`, `boot_nonce`, generation, platform, arch, and capability flags     |
| `controller_status`, `controller_takeover`, `controller_stop`             | Host role only; tool role is `not_authorized`                                                               |
| `request_access`, `permission_status`, `input_permission_status`          | read-only Windows report; no prompt and no authorization change                                             |
| `screen_capture_status`, `screen_capture_probe`, `supports_accessibility` | supported only after the target platform probe; no TCC prompt                                               |
| `list_applications`, `application_info`, `list_windows`                   | supported                                                                                                   |
| `capture_app`, `element_at_point`, `read_element`                         | supported                                                                                                   |
| element action methods                                                    | supported where the UIA pattern exists; otherwise `not_settable`, `not_selectable`, or `action_unavailable` |
| pointer/keyboard methods                                                  | supported with foreground verification and `SendInput` return-count checks                                  |
| `paste`                                                                   | supported text paste with explicit restore result                                                           |
| `prevent_activation`, `reenable_activation`, `is_focus_steal_prevented`   | `unimplemented` on Windows                                                                                  |
| `pip_*` and `pip_session_*`                                               | `unimplemented` on Windows                                                                                  |

## Tool contract

All top-level argument objects are strict. Unknown top-level keys are rejected. `target` is a strict public union; the runtime parser must also reject unknown element keys. `app_ref` is a string bundle id or a strict object with `pid`, `bundle_id`, `name`, and optional `window_id`.

| Tool                    | Input                                                                                   | Defaults and bounds                                                               |
| ----------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `list_apps`             | `{}`                                                                                    | no fields                                                                         |
| `list_windows`          | `{app_ref}`                                                                             | required                                                                          |
| `get_app_state`         | `{app_ref, include_screenshot?, disable_diffing?, tree_shown_to_model?}`                | `false`, `false`, `true`; last key is internal                                    |
| `left_click`            | `{target, mouse_button?, click_count?, modifiers?, strategy?, app_ref?, return_state?}` | `left`, `1..3`, `""`, `auto`, `none`                                              |
| `scroll`                | `{target, scroll_direction, scroll_amount, strategy?, app_ref?, return_state?}`         | amount clamp `0..100`; zero is a no-op                                            |
| `left_click_drag`       | `{from_target, to, modifiers?, app_ref?, return_state?}`                                | no `strategy` field                                                               |
| `type`                  | `{text, target?, app_ref?, strategy?, return_state?}`                                   | empty text is a no-op                                                             |
| `set_value`             | `{target, value, strategy?, app_ref?, return_state?}`                                   | empty value is legal                                                              |
| `select_text`           | `{target, text_range?, app_ref?, return_state?}`                                        | two non-negative integers; omitted means caret                                    |
| `key`                   | `{text, repeat?, hold_seconds?, app_ref?, strategy?, return_state?}`                    | repeat `0` no-op, otherwise `1..100`; hold `<0` reject, `0` no-op, max 30 seconds |
| `perform_action`        | `{target, action, app_ref?, return_state?}`                                             | action must be present in the target's current `actions`                          |
| `paste`                 | `{text, format?, app_ref?, return_state?}`                                              | `text`, `md`, or `html`; default `text`                                           |
| `request_access`        | `{capabilities?}`                                                                       | read-only, never prompts                                                          |
| `stop_computer_control` | `{reason?}`                                                                             | idempotent; first reason is retained                                              |

`target` is either `{type:"element", index: non-negative integer}` or `{type:"coordinate", x, y, frame_id?}`. Coordinates are integer pixels inside the delivered raster. Element/app/window bounds are diagnostic only.

## Runtime ownership and time

| State                                                                | Owner                        |
| -------------------------------------------------------------------- | ---------------------------- |
| workspace/session/turn routing                                       | node_repl host               |
| per-session state, frames, kill switch, holds, pending receipts      | JS producer runtime          |
| pipe connections, peer identity, dispatch, input mutex               | Windows Helper               |
| UIA element COM references, capture surface, held input, DPI, tokens | native addon                 |
| Helper generations and transport publication                         | services Windows Helper host |
| tool/result/app/screenshot projection                                | existing CLI/shared protocol |

The runtime is a process-wide object with a session-keyed table: `workspaceKey`, `remoteSessionId`, and `sessionId`. The table is bounded; eviction calls `closeSession`. `stop_computer_control` affects only the addressed session.

Native work is never performed on the JS thread:

- UIA, clipboard, and element actions run on a bounded STA worker.
- WGC/D3D11 run on a bounded MTA worker.
- `SendInput` runs through the native input owner with a global action mutex.
- Every blocking operation has a deadline and cancellation. UIA provider stalls return `timeout` with a provider diagnostic, not a hung Helper.
- Held keys and buttons have a hard maximum duration aligned with `key.hold_seconds` (30 seconds). Shutdown, abort, disconnect, and watchdog paths release them best-effort; a hard-killed process can leave at most the bounded hold duration, never an unbounded modifier.

## Observation, frames, and coordinates

The Helper returns structural facts, not a second diff state: app, window, full element list, snapshot epoch, structure digest, and optional raster. The producer computes `full`, `delta`, and `no_change` from its own state LRU.

Producer limits:

- 8 cached states per session; ids are monotonic `s-N`.
- 16 cached frames per session; TTL is 10 minutes; eviction and expiry create tombstones.
- Element tree flattening is capped at 6,000 entries with a depth cap.
- Model-visible text is bounded separately from the structured element array.

The native capture layer signs an opaque frame handle containing HWND, owner pid, crop, delivered size, display topology, DPI/PMv2 state, generation, and expiry. The producer maps `frame_id` to that handle. Coordinate actions send the handle plus pixel coordinates; the native layer reprojects and rechecks topology. A stale, moved, resized, expired, or unverifiable handle returns `action_sent=false` and requires a new observation.

Raster rules:

- WGC-captured occluded windows remain actionable when their own surface is valid; occlusion is not a macOS-style rejection.
- Blank, zero-size, closed, identity-unbound, or non-PMv2 rasters are not actionable.
- Output is JPEG for the 200 KiB inline budget, with a fixed max edge of 1280, quality ladder 75 down to 40, and bounded shrink. The delivered size, digest, and format are recorded in the existing frame-integrity metadata.
- `frame-contract` exports and their consumer invariants are not duplicated or renamed.

## Input and clipboard

- `SendInput` return count must equal the submitted event count. Zero/partial submission is `permission_denied` or `foreground_required` with `action_sent=false`, never `accepted`.
- App-scoped keyboard requires the target pid to be foreground immediately before and after dispatch.
- Drag owns the pointer sequence until release; conflicting input is rejected.
- Clipboard paste saves only the text format it can restore, writes the requested text, sends paste, uses a bounded consume heuristic, and restores prior text. Any concurrent clipboard change, unavailable prior format, or restore failure is reported explicitly; the Helper never claims atomic clipboard replacement.

## Errors, receipts, and retries

Stable server codes are `invalid_request`, `not_authorized`, `permission_denied`, `controller_busy`, `element_unavailable`, `not_settable`, `not_selectable`, `action_unavailable`, `foreground_required`, `app_not_found`, `ambiguous_app`, `screen_locked`, `control_stopped`, `launch_failed` (reserved), `timeout`, `version_mismatch`, `unimplemented`, `method_not_found`, and `internal`.

`broker_unavailable` is a producer/client classification, not a server method code.

Every action result has:

```text
schema_version = zcode-cua-action-receipt-v1
action_sent = boolean
dispatch_status = accepted | possibly_sent | not_sent
retry_action = false              // this receipt never authorizes automatic replay
target_verification_status = matched | mismatched | unavailable
effect_evidence = changed | unchanged | unknown
ax_error?
```

- Validation, admission, and pre-dispatch failures are `not_sent`.
- A response lost after the frame crossed the pipe is `possibly_sent`; never replay automatically.
- A clear Helper error before execution is `not_sent`; a Helper-declared possibly-executed error is `possibly_sent`.
- `effect_evidence` is computed by the producer on the next observation when `return_state=none`.
- `foreground_required`, permission, version, unsupported, and malformed-request errors are never automatically retried.
- `broker_unavailable` may retry only before a method frame crosses the pipe, with bounded backoff.
- `stop_computer_control` blocks every non-exempt action for that session; `request_access` and repeated stop remain idempotent.

## Lifecycle and control protocol

Startup argv is exactly:

```text
<entry> --socket <pipe> --parent-pid <host-pid>
```

Required env: `ZCODE_CUA_HELPER_ADDON`, `ZCODE_CUA_PERMISSION_BROKER_SOCKET`, and the existing CUA authority metadata. The entry is single-file CommonJS, self-contained except for Node builtins and the verified addon.

```text
Host demand
  -> create generation
  -> fork entry with ELECTRON_RUN_AS_NODE
  -> entry loads verified ax_native.node
  -> native binds peer-checked pipe
  -> transport_ready
  -> authenticate + broker_info
  -> ready
  -> publish socket/authority to trusted node_repl
```

Control messages are `zcode-cua-windows-dev/v1` and must carry the exact socket path and Helper pid. `transport_ready` precedes full health; `ready` requires a matching `broker_info` pid. `error` is surfaced verbatim.

Shutdown freezes admission, cancels holds, drains accepted work, releases native input, closes the pipe, and reports within 1 second for the current Host contract. The Windows Host may use its existing 1-second first budget, then kill; a termination blocker remains a hard failure and is not silently downgraded.

A Helper crash invalidates the current generation. The first vertical slice reports `broker_unavailable` until the Host publishes a new generation; in-session automatic Helper restart is a later Host feature and is not an acceptance gate for this slice.

Transport name reuse is allowed across generations, but credentials are not: `broker_info.boot_nonce` and generation change invalidate frames and element mappings.

## Build and packaging

Source layout:

```text
packages/zcode-cua/
  native/windows/binding.gyp
  native/windows/include/*.h
  native/windows/src/*.cc
  win/entry.cjs                 # single-file, generated or linted as one unit
  dist/win/                     # ignored build output
```

Build requirements:

- Windows x64.
- VS 2022 Build Tools `Microsoft.VisualStudio.Workload.VCTools`.
- Windows 11 SDK 10.0.26100.
- Windows Python for node-gyp.
- Node-API headers matching the Node/Electron runtime.

`package.json` must expose the existing dev contract:

```json
"zcodeCuaRuntime": {
  "schema": 1,
  "windows": {
    "entry": "win/entry.cjs",
    "nativeAddon": "dist/win/ax_native.node"
  }
}
```

Product output is `resources/tools/cua-helper/runtime-manifest.json` with the exact existing keys and SHA-256 for entry and addon. The manifest is generated after a successful build; no hand-edited hash is accepted.

Use Node-API only, declare a fixed `NAPI_VERSION`, and load-test the addon under `ELECTRON_RUN_AS_NODE`. Add the package to the repository typecheck/lint surface; generated `dist/` is excluded from source checks.

## Migration boundary

Existing node-repl bridge, shared protocol, UI, macOS permission control plane, and Windows Helper process-host contracts remain source-compatible. The following consumer changes are explicitly part of this implementation:

1. `node_repl` Worker isolation: remove `cuaBroker` socket/token from `workerData`, pass a `MessagePort` request channel to the Worker after it starts, and start the Worker with an environment that has every `ZCODE_CUA_*` key removed. The main thread owns the runtime call and the private broker credential; the model sees only the bridge methods. The Browser Use bridge keeps its own broker credentials, so the environment must not be emptied wholesale.
2. Windows socket path minting: platform-aware named-pipe paths.
3. Windows shutdown/termination behavior: match the existing 1-second first budget and preserve hard failure.
4. A Windows capability report is text/structured tool output only. No new macOS-shaped permission schema is added; the Settings entry is the existing plugin toggle plus a capability probe.
5. `packages/zcode-cua` is added to the checked source surface and architecture visibility; generated artifacts stay ignored.

Any further consumer contract change requires a new decision in this spec.

## Implementation stages

1. Toolchain smoke test: build and load a minimal Node-API addon from Windows via WSL/UNC.
2. Runtime contracts: strict schemas, 42-method table, NDJSON client, receipts, state/frame registries, kill switch.
3. Native host/identity/DPI/session probes and secure peer checks.
4. UIA observation and semantic element actions.
5. WGC/D3D11 capture and coordinate frame handles.
6. Foreground `SendInput`, holds, and clipboard paste.
7. Helper entry, manifest, Host integration, and packaging.
8. Node REPL bridge hardening and end-to-end enablement.

## Validation gates

1. Protocol/schema tests for all 14 tools, 42 methods, version matrix, byte limits, id correlation, and error codes.
2. Runtime tests for state/frame LRU, tombstones, receipts, `not_sent` versus `possibly_sent`, and stop/abort behavior.
3. Native tests for peer identity, UIA token isolation, DPI/PMv2, UIPI, held-input release, and clipboard restore failure.
4. Capture tests for visible, occluded, minimized, closed, resized, moved, blank, and non-PMv2 windows.
5. Security tests for wrong pid, wrong user, wrong session, forged role, pipe spam, oversized lines, and unauthorized controller commands.
6. Windows integration/E2E: plugin enable -> capability probe -> Helper ready -> observe -> semantic action -> coordinate action -> paste -> stop.
7. Merge order: unit/integration tests -> CI -> `pnpm typecheck` -> `pnpm lint` -> `pnpm architecture:check --changed` -> security review.

## Slice 1 status: verified on the Windows host (2026-09-26)

Measured on the development host (Windows 11 26100.3775 24H2, session 2, elevated, x64) by building and running the real artifacts from WSL:

- Native addon builds with the VS 2022 v143 toolchain and loads in Node 24.16: `native/windows/build.sh` (WSL) or `native/windows/build.ps1` (Windows), staged by `pnpm --filter @zcode/zcode-cua build:win`.
- `packages/zcode-cua/test/windows-native-smoke.cjs` passes: host report, peer evidence (client pid, SID, integrity SID, 6-level ancestry), request/response round trip, handshake timeout, line limit, clean stop with the pipe released.
- `packages/zcode-cua/test/windows-helper-integration.test.mjs` passes against the real `dist/win/entry.cjs`: control protocol, authenticate-first rejection, `broker_info` with verified peer evidence, read-only permission report, `unimplemented` for desktop actions, clean shutdown.
- 58 unit/contract tests pass on Linux (`node --test packages/zcode-cua/test/*.test.mjs`); the two Windows-only suites skip elsewhere.
- `hostInfo` reports `dpi.threadAwareness = unaware` for a plain Node process. Coordinate issuance therefore still requires a later slice to set per-monitor-v2 awareness inside the Helper and to re-read it before capture; no frame is actionable in this slice.

Native defects found and fixed while validating this slice, kept here because each one is a trap the next slice will meet again:

1. The accept thread captured `Server*` by reference to a local reference variable, leaving a dangling pointer after `StartPipeServer` returned; it now captures the pointer by value.
2. `ConnectNamedPipe` was given a stack-local `OVERLAPPED`; the kernel completed into freed stack memory, producing access violations inside system DLLs at unpredictable moments. The structure now lives in the pipe slot for the lifetime of the operation.
3. The connection loop reset the manual-reset write event on every iteration, swallowing a `SetEvent` that raced with it and stalling responses forever. The reset now happens only while holding the connection lock with an empty queue, and the queue is re-checked after every wait.
4. Shutdown cleared the connection list while IO threads were still joinable, terminating the process with `0xC0000409`. Teardown now joins first, and `StopPipeServer` always joins the accept thread and drains connections.
5. `startServer` created the first pipe instance asynchronously, so a client connecting immediately after it returned got `ENOENT`. The first instance is now created before `startServer` returns.
