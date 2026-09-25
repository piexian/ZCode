# @zcode/zcode-cua-plugin

Model-visible Computer Use surface: the `computer-use` skill, its reference doc,
and the SDK client that the skill talks to. Execution is provided by the shared
`node_repl` host and `@zcode/zcode-cua`.

## Provenance

These files are the officially shipped Computer Use plugin payload
(`@zcode/zcode-cua-plugin` 0.6.3, `computer-use` plugin 0.6.3), taken from the
ZCode 3.14.3 Windows x64 distribution and vendored verbatim under its MIT
license (see `LICENSE`, copyright Z.ai). Attribution is recorded in the
repository `THIRD-PARTY-LICENSES.md` and `NOTICE.md`.

Do not hand-edit the vendored files: re-vendor from a new official release
instead, so the model-visible contract stays identical to what the skill
documents. Local behavior changes belong in `@zcode/zcode-cua`.

## What works today

`computer-use-client.mjs` exposes the 14 Computer Use tools over the
`node_repl` bridge. On Windows the Helper currently implements transport,
peer identity, and diagnostics only, so observation and input tools return
`unimplemented` until the remaining native slices land. The failure is explicit
and retryable rather than silent.
