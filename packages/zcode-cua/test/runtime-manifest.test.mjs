/**
 * 暂存产物的 manifest 契约测试。
 *
 * 官方打包运行时用 `resources/tools/cua-helper/runtime-manifest.json` 声明
 * entry/addon 与它们的 SHA-256，宿主侧据此做包含性与哈希校验。本仓库自己暂存的
 * `dist/win/` 必须满足同一份契约，否则打包模式解析会 fail closed。
 *
 * 官方契约（从 3.14.3 官方包读到的字面形状）：
 * { schemaVersion, packageName, packageVersion, platform, arch, electronVersion,
 *   entry, addon, sha256: { entry, addon } }
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const runtimeRoot = join(packageRoot, "dist", "win");
const manifestPath = join(runtimeRoot, "runtime-manifest.json");
const staged = existsSync(manifestPath);

const MANIFEST_KEYS = [
  "addon",
  "arch",
  "electronVersion",
  "entry",
  "packageName",
  "packageVersion",
  "platform",
  "schemaVersion",
  "sha256",
];

test("暂存 manifest 的键集合与官方契约完全一致", { skip: !staged && "先跑 build:win" }, () => {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.deepEqual(Object.keys(manifest).sort(), MANIFEST_KEYS);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.platform, "win32");
  assert.equal(manifest.arch, "x64");
  assert.equal(manifest.packageName, "@zcode/zcode-cua");
  assert.equal(typeof manifest.electronVersion, "string");
  assert.equal(manifest.electronVersion.length > 0, true);
  assert.deepEqual(Object.keys(manifest.sha256).sort(), ["addon", "entry"]);
});

test(
  "manifest 里的 entry/addon 必须是 runtime 根内的相对路径，且哈希匹配",
  { skip: !staged && "先跑 build:win" },
  () => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    for (const key of ["entry", "addon"]) {
      const relative = manifest[key];
      assert.equal(typeof relative, "string", `${key} 必须是字符串`);
      assert.equal(relative.startsWith("/"), false, `${key} 不能是绝对路径`);
      assert.equal(relative.includes(".."), false, `${key} 不能包含 ..`);
      assert.equal(relative.includes("\\"), false, `${key} 必须用正斜杠`);
      const absolute = join(runtimeRoot, ...relative.split("/"));
      assert.equal(existsSync(absolute), true, `${key} 指向的文件不存在：${relative}`);
      const digest = createHash("sha256").update(readFileSync(absolute)).digest("hex");
      assert.equal(digest, manifest.sha256[key], `${key} 哈希必须与文件一致`);
    }
  },
);

test("package.json 的 zcodeCuaRuntime 指向真实存在的开发期产物", () => {
  const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const windows = packageJson.zcodeCuaRuntime?.windows;
  assert.ok(windows, "缺少 zcodeCuaRuntime.windows");
  assert.equal(windows.entry, "win/entry.cjs");
  assert.equal(windows.nativeAddon, "dist/win/ax_native.node");
  assert.equal(existsSync(join(packageRoot, "win", "entry.cjs")), true, "Helper 入口必须存在");
  if (existsSync(join(packageRoot, windows.nativeAddon))) {
    assert.equal(existsSync(manifestPath), true, "有 addon 产物时必须同时有 manifest");
  }
});
