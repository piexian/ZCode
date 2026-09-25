# @zcode/zcode-cua

Computer Use producer runtime. This build ships the **Windows transport slice**:
the protocol layer, the 14-tool producer runtime, and a Windows Helper that owns
its own named pipe and verifies peer identity.

What works today on Windows:

- Broker protocol: 42 business methods plus `authenticate`/`ping`, NDJSON framing,
  protocol version 2, byte limits, `authenticate`-first, per-connection serialization.
- Producer runtime: strict tool schemas, per-session state/frame registries, kill
  switch, action receipts, and `not_sent` versus `possibly_sent` dispatch accounting.
- Helper: native named-pipe server (`CreateNamedPipeW`,
  `FILE_FLAG_FIRST_PIPE_INSTANCE`, user+SYSTEM DACL), peer evidence from the server
  HANDLE, bounded connections/lines/queues, handshake timeout, and clean shutdown.
- Diagnostics: `broker_info`, `ping`, `permission_status`, `input_permission_status`,
  `screen_capture_status`, `screen_capture_probe`, `supports_accessibility`,
  `request_access` (read-only report), `controller_status`.

What is **not** available yet, and fails closed:

- UI Automation observation and element actions.
- Windows Graphics Capture frames and coordinate frame handles.
- `SendInput` mouse/keyboard, input holds, and clipboard paste.
- Picture-in-picture, ghost cursor, controller lease/takeover, and macOS-only methods.
- Authenticode verification of the peer (reported as `not_verified`, never as passed).

Without a broker socket the runtime returns the usual unavailable result; with a
socket but no Helper it returns `broker_unavailable` with a `not_sent` receipt.
Neither path throws at the call site.

Design and verification record: `specs/computer-use/windows-runtime.md`.

License: Apache-2.0.
