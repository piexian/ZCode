/**
 * PR#1 审查 P1 回归：provider transport 缓存必须按 providerId+baseURL+凭据 区分。
 *
 * zhipu-account 在 bindModel 期不带 API Key（toAiSdkProviderConfig 剔除），请求期
 * resolveRequest 才注入；若 transport 只按 providerId 缓存，请求期会复用绑定期的
 * 无签名 transport，账号模型对官方 Coding Plan 端点永远不带签名头。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

/** 一次性编译 TS 模块：测试直接跑源码，避免引入测试框架。 */
const moduleDir = await mkdtemp(join(tmpdir(), "model-execution-"));
const modulePath = join(moduleDir, "model-execution.mjs");
await build({
  banner: {
    // proxy-agent 等依赖的 CJS 包（debug → tty 等）需要运行时 require。
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  bundle: true,
  entryPoints: [join(packageRoot, "src/model/model-execution.ts")],
  format: "esm",
  outfile: modulePath,
  platform: "node",
  target: "node24",
});
const { AiSdkModelExecution } = await import(modulePath);
process.on("exit", () => {
  void rm(moduleDir, { force: true, recursive: true });
});

const PROVIDER_ID = "zhipu-coding-plan";
const BASE_URL = "https://api.z.ai";
const API_KEY = "kid-1.s3cr3t-value";
const GATE_PATH = "/api/v1/agent/configs";

test("transport 缓存按凭据区分：zhipu-account 请求期注入 key 后获得带签名层的新 transport", async () => {
  const calls = [];
  const fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes(GATE_PATH)) {
      // 门关：不触发握手，业务请求照常无签名送达。
      return new Response(
        JSON.stringify({ code: 0, data: { codingPlanSignature: { enable: false } } }),
        { headers: { "content-type": "application/json" } },
      );
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  const execution = new AiSdkModelExecution({ env: {} }, { transport: fetch });

  const binding = execution.bindModel({
    providerId: PROVIDER_ID,
    modelId: "glm-4.6",
    providerConfig: {
      access: { type: "zhipu-account" },
      api: { type: "anthropic-messages", baseUrl: BASE_URL },
    },
    supportsJsonSchemaOutput: false,
    optionSpecs: {
      reasoningLevel: { values: ["minimal"], map: '{"thinking": reasoningLevel}' },
      maxOutputTokens: { max: 8192, map: '{"max_tokens": maxOutputTokens}' },
    },
  });

  // 绑定期（无 API Key）：只产生一条无签名 transport 记录。
  const transportsAfterBind = new Map(execution.providerTransports);
  assert.equal(transportsAfterBind.size, 1);
  const unsignedKey = [...transportsAfterBind.keys()][0];
  assert.equal(unsignedKey, `${PROVIDER_ID}\n${BASE_URL}\n`);

  // 请求期注入凭据：不得复用无签名 transport。
  binding.resolveRequest({
    options: {},
    requestAuth: { apiKey: API_KEY },
  });
  const transportsAfterAuth = new Map(execution.providerTransports);
  assert.equal(transportsAfterAuth.size, 2, "注入凭据后必须生成新的 transport 条目");
  const signedKey = `${PROVIDER_ID}\n${BASE_URL}\n${API_KEY}`;
  assert.ok(
    transportsAfterAuth.has(signedKey),
    `缓存键必须包含凭据: ${[...transportsAfterAuth.keys()].join(" | ")}`,
  );

  // 行为差异：带凭据的 transport 参与签名编排（先查功能门），绑定期 transport 不会。
  const message = `${BASE_URL}/api/anthropic/v1/messages`;
  const request = { body: "{}", headers: { "X-Session-Id": "sess_abc" }, method: "POST" };
  calls.length = 0;
  await transportsAfterBind.get(unsignedKey)(message, request);
  assert.ok(!calls.some((url) => url.includes(GATE_PATH)), "绑定期 transport 不查功能门");

  calls.length = 0;
  const response = await transportsAfterAuth.get(signedKey)(message, request);
  assert.equal(response.status, 200);
  assert.ok(calls.some((url) => url.includes(GATE_PATH)), "注入凭据后的 transport 必须先过功能门");
});
