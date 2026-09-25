/**
 * node_repl CUA 凭据隔离的回归门（specs/computer-use/windows-runtime.md 的 migration boundary #1）。
 *
 * 断言面：
 * - 生产 Worker 剔除 CUA 凭据后启动，workerData 里没有 socket/token；模型代码读 `process.env` 与
 *   `require("node:worker_threads").workerData` 都拿不到凭据，且 Browser bridge 的非 CUA env 仍然保留。
 * - bridge call 仍能把 main 侧 runtime 的结果带回来，并合入 responseMeta 与 app identity。
 * - subagent 拒绝与无 runtime 时的 unavailable 语义不变。
 * - abort 会把 capability 端口与在途请求一起收掉。
 *
 * 这里用真实 Worker（esbuild 现编 `src/server.ts`）而不是直接调 bridge：隔离边界的价值正在于
 * 进程级 `env`/`workerData` 不可见，注入假端口测不到这一层。
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const SECRET_SOCKET = "\\\\.\\pipe\\zcode-cua-helper-deadbeefdeadbeefdeadbeefdeadbeef";
const SECRET_TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const CUA_APP_ASSOCIATIONS_META_KEY = "zcode.cua/app-associations-v1";

/**
 * 假 runtime：每次调用都记一条 `by: "main"`。runtime 只存在于 main 侧，Worker 里的任何调用
 * 都必须以 capability 请求的形式抵达这里，不可能直接触达。
 */
function createFakeRuntime(calls) {
  const runtime = {
    async execute(input) {
      calls.push({ by: "main", toolName: input.toolName, context: input.context });
      if (input.toolName === "stop_computer_control") {
        return { content: [{ type: "text", text: "stopped" }], isError: false };
      }
      if (input.toolName === "left_click") {
        return {
          content: [{ type: "text", text: "clicked" }],
          isError: false,
          _meta: {
            [CUA_APP_ASSOCIATIONS_META_KEY]: {
              primary: { appKey: "com.example.editor", displayName: "Editor" },
            },
          },
          responseMeta: { "zcode/cuaSurface": { kind: "computerUse" } },
        };
      }
      if (input.toolName === "list_apps") {
        return { content: [{ type: "text", text: "no apps" }], isError: false };
      }
      if (input.toolName === "left_click_drag") {
        // 取消路径：等到 signal abort 才结束，验证 abort 会穿透到 runtime。
        await new Promise((resolve, reject) => {
          input.signal?.addEventListener(
            "abort",
            () => reject(input.signal?.reason ?? new Error("aborted")),
            { once: true },
          );
        });
        return { content: [] };
      }
      if (input.toolName === "list_windows") {
        return { content: [{ type: "text", text: "no windows" }], isError: false };
      }
      return { content: [{ type: "text", text: `ok:${input.toolName}` }], isError: false };
    },
    async closeSession() {},
    async dispose() {},
  };
  return runtime;
}

let bundleDir;
const bundlePromise = (async () => {
  bundleDir = await mkdtemp(join(tmpdir(), "node-repl-cua-isolation-"));
  const outfile = join(bundleDir, "server.mjs");
  await build({
    bundle: true,
    entryPoints: [join(packageRoot, "src", "server.ts")],
    format: "esm",
    legalComments: "none",
    outfile,
    platform: "node",
    target: "node24",
    // esbuild 产物里 __require shim 在 ESM 作用域没有 require 可用；core 拖进来的 CJS 依赖
    // 会在求值阶段抛错。和 scripts/build.mjs 的 banner 同因。
    banner: {
      js: 'import { createRequire as __zcodeCreateRequire } from "node:module";\nconst require = __zcodeCreateRequire(import.meta.url);',
    },
  });
  return await import(outfile);
})();
process.on("exit", () => {
  if (bundleDir) rmSync(bundleDir, { recursive: true, force: true });
});

async function loadServerModule() {
  return await bundlePromise;
}

function requestMeta(overrides = {}) {
  return {
    runtime_scope: "main",
    session_id: "session-1",
    workspace_identity: "/workspace/example",
    workspace_key: "/workspace/example",
    workspace_path: "/workspace/example",
    turn_id: "turn-1",
    ...overrides,
  };
}

/** 用生产路径跑一个 cell：真实 Worker + main 侧 runtime + MessagePort capability 通道。 */
async function runCell(mod, { code, meta, runtime, signal, timeoutMs = 20_000 }) {
  const run = mod.executeJsInWorker(
    {
      code,
      requestMeta: meta ?? requestMeta(),
      signal: signal ?? new AbortController().signal,
      syncTimeoutMs: timeoutMs,
    },
    runtime,
  );
  return await Promise.race([
    run,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("cell timed out")), timeoutMs + 5_000).unref(),
    ),
  ]);
}

test("production Worker cannot read CUA broker credentials from env or workerData", async (t) => {
  const mod = await loadServerModule();
  const calls = [];
  const runtime = createFakeRuntime(calls);

  // main 侧也把凭据放进自己的 env，模拟 Helper 凭据已注入的宿主进程。Worker 必须看不到。
  const previous = { ...process.env };
  process.env.ZCODE_CUA_PERMISSION_BROKER_SOCKET = SECRET_SOCKET;
  process.env.ZCODE_CUA_PERMISSION_BROKER_TOKEN = SECRET_TOKEN;
  process.env.ZCODE_CUA_PLUGIN_AUTHORITY = "cua-plugin-authority-secret";
  process.env.ZCODE_CUA_PERMISSION_BROKER_REFRESH_MARKER = "cua-refresh-marker-secret";
  // Browser bridge 依赖自己的 broker 凭据，因此 Worker 环境必须保留非 CUA 键。
  process.env.ZCODE_TEST_BROWSER_MARKER = "browser-broker-marker";
  t.after(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
  });

  // 指纹在模型代码里现拼，不能内联进 code：workerData 会把 code 原文带进去，直接内联会让
  // 「workerData 含凭据」这个断言变成永真。
  const run = await runCell(mod, {
    code: `
      const { workerData } = require("node:worker_threads");
      const fingerprint = ["zcode", "cua", "helper"].join("-");
      const portNeedle = ["Message", "Port"].join("");
      nodeRepl.write(JSON.stringify({
        cuaKeys: Object.keys(process.env).filter((k) => k.startsWith("ZCODE_CUA_")),
        browserMarker: process.env.ZCODE_TEST_BROWSER_MARKER ?? null,
        hasSocket: Object.values(process.env).some((v) => String(v).includes(fingerprint)),
        workerDataKeys: Object.keys(workerData ?? {}).sort(),
        workerDataText: JSON.stringify(workerData ?? null).includes(fingerprint),
        // capability 只能经 parentPort 转移到达，不能躺在 workerData 里任模型读取。
        workerDataHasPort: JSON.stringify(Object.values(workerData ?? {})).includes(portNeedle),
      }));
    `,
    runtime,
  });

  assert.equal(run.error, undefined, run.error?.message);
  const seen = JSON.parse(run.result ?? run.logs);
  assert.equal(seen.hasSocket, false, "model code must not see the CUA broker socket in process.env");
  assert.deepEqual(seen.cuaKeys, [], "Worker env must not expose any ZCODE_CUA_* key");
  assert.equal(seen.browserMarker, "browser-broker-marker", "non-CUA env must survive the Worker env copy");
  assert.deepEqual(seen.workerDataKeys, ["code", "kind", "requestMeta", "syncTimeoutMs"]);
  assert.equal(seen.workerDataText, false, "workerData must not carry the broker socket");
  assert.equal(seen.workerDataHasPort, false, "the capability port must not live in workerData");
});

test("bridge call returns the main-side result and merges responseMeta plus app identity", async () => {
  const mod = await loadServerModule();
  const calls = [];
  const runtime = createFakeRuntime(calls);

  const run = await runCell(mod, {
    code: `
      const bridge = globalThis[Symbol.for("zcode.node-repl.computer-use-bridge")];
      const result = await bridge.call("left_click", {
        target: { type: "coordinate", x: 10, y: 20 },
      });
      nodeRepl.write(JSON.stringify({ text: result.content[0].text }));
    `,
    runtime,
  });

  assert.equal(run.error, undefined, run.error?.message);
  assert.equal(JSON.parse(run.logs).text, "clicked");
  assert.equal(calls.length, 1, "exactly one capability request must reach the main-side runtime");
  assert.equal(calls[0].by, "main");
  assert.equal(calls[0].toolName, "left_click");
  assert.equal(calls[0].context.sessionId, "session-1");
  assert.equal(calls[0].context.workspaceKey, "/workspace/example");
  assert.equal(calls[0].context.runtimeScope, "main");
  // bridge 只发 {id, method, input, context}；runtime 调用与凭据都在 main。
  assert.equal(
    Object.keys(calls[0].context).some((key) => /socket|token|broker/i.test(key)),
    false,
    "the capability request context must not carry broker credentials",
  );
  assert.equal(run.responseMeta?.["zcode/cuaSurface"]?.kind, "computerUse");
  assert.equal(run.cuaApp?.appKey, "com.example.editor");
  assert.equal(run.cuaApp?.displayName, "Editor");
});

test("one cell can issue several capability calls on the same port", async () => {
  const mod = await loadServerModule();
  const calls = [];
  const runtime = createFakeRuntime(calls);

  const run = await runCell(mod, {
    code: `
      const bridge = globalThis[Symbol.for("zcode.node-repl.computer-use-bridge")];
      const first = await bridge.call("list_apps", {});
      const second = await bridge.call("list_windows", { app_ref: "com.example.editor" });
      nodeRepl.write(
        JSON.stringify([first.content[0].text, second.content[0].text]),
      );
    `,
    runtime,
  });

  assert.equal(run.error, undefined, run.error?.message);
  assert.deepEqual(JSON.parse(run.logs), ["no apps", "no windows"]);
  assert.deepEqual(
    calls.map((call) => call.toolName),
    ["list_apps", "list_windows"],
    "the capability port must stay open for the whole cell",
  );
});

test("subagent scope is still refused before any capability request", async () => {
  const mod = await loadServerModule();
  const calls = [];
  const runtime = createFakeRuntime(calls);

  const run = await runCell(mod, {
    code: `
      const bridge = globalThis[Symbol.for("zcode.node-repl.computer-use-bridge")];
      try {
        bridge.assertAvailable();
        nodeRepl.write("unexpectedly available");
      } catch (error) {
        nodeRepl.write(error.message);
      }
    `,
    meta: requestMeta({ runtime_scope: "subagent" }),
    runtime,
  });

  assert.equal(run.error, undefined, run.error?.message);
  assert.equal(run.logs.trim(), "Computer Use is not available in subagent");
  assert.equal(calls.length, 0, "subagent must not reach the runtime");
});

test("bridge reports unavailable when the host has no CUA runtime", async () => {
  const mod = await loadServerModule();
  const run = await runCell(mod, {
    code: `
      const bridge = globalThis[Symbol.for("zcode.node-repl.computer-use-bridge")];
      try {
        bridge.assertAvailable();
        nodeRepl.write("unexpectedly available");
      } catch (error) {
        nodeRepl.write(error.message);
      }
    `,
    runtime: undefined,
  });

  assert.equal(run.error, undefined, run.error?.message);
  assert.equal(run.logs.trim(), "Computer Use is unavailable for this node_repl session");
});

test("aborting a cell tears down the capability port and cancels the in-flight request", async () => {
  const mod = await loadServerModule();
  const calls = [];
  const runtime = createFakeRuntime(calls);
  const controller = new AbortController();

  const started = Date.now();
  const pending = runCell(mod, {
    code: `
      const bridge = globalThis[Symbol.for("zcode.node-repl.computer-use-bridge")];
      const result = await bridge.call("left_click_drag", {
        from_target: { type: "coordinate", x: 1, y: 1 },
        to: { type: "coordinate", x: 2, y: 2 },
      });
      nodeRepl.write(result.content[0].text);
    `,
    runtime,
    signal: controller.signal,
    timeoutMs: 30_000,
  });
  const abortLater = setTimeout(() => controller.abort(new Error("cua isolation test abort")), 500);

  try {
    await assert.rejects(pending, /cua isolation test abort/);
  } finally {
    clearTimeout(abortLater);
  }
  // abort 必须在毫秒级生效，而不是等到 30s sync timeout —— 证明在途请求和端口都被收掉了。
  assert.ok(Date.now() - started < 15_000, "abort must not wait for the sync timeout");
  assert.equal(calls.length, 1, "the drag must have reached the runtime before abort");
});
