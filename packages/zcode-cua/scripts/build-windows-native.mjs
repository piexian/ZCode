import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 暂存 Windows CUA runtime 到 dist/win/：entry.cjs + ax_native.node + runtime-manifest.json。
 *
 * 编译与暂存分开：node-gyp 不接受 UNC cwd（WSL 下的仓库路径就是 UNC），所以编译走
 * native/windows/build.ps1（Windows）或 native/windows/build.sh（WSL），后者已经把
 * ax_native.node 复制进 dist/win。这里只补齐 entry、生成带哈希的 manifest，并做一致性校验。
 *
 * 用法：pnpm --filter @zcode/zcode-cua build:win
 */

if (process.platform !== "win32") {
  throw new Error("The Windows CUA runtime can only be staged on win32.");
}

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const nativeRoot = join(packageRoot, "native", "windows");
const outputRoot = join(packageRoot, "dist", "win");
const outputEntry = join(outputRoot, "entry.cjs");
const outputAddon = join(outputRoot, "ax_native.node");
const sourceEntry = join(packageRoot, "win", "entry.cjs");
const builtAddon = join(nativeRoot, "build", "Release", "ax_native.node");

const require = createRequire(import.meta.url);
const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
const electronVersion = JSON.parse(
  await readFile(require.resolve("electron/package.json"), "utf8"),
).version;

const exists = async (path) => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

if (!(await exists(builtAddon)) && !(await exists(outputAddon))) {
  throw new Error(
    `native addon not built: ${builtAddon}\n` +
      "先编译再暂存：Windows 用 pwsh -File native/windows/build.ps1，WSL 用 native/windows/build.sh",
  );
}

await rm(outputRoot, { force: true, recursive: true });
await mkdir(outputRoot, { recursive: true });
await copyFile(sourceEntry, outputEntry);
if (await exists(builtAddon)) {
  await copyFile(builtAddon, outputAddon);
}

const sha256 = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
const manifest = {
  schemaVersion: 1,
  packageName: packageJson.name,
  packageVersion: packageJson.version,
  platform: "win32",
  arch: "x64",
  electronVersion,
  entry: "entry.cjs",
  addon: "ax_native.node",
  sha256: {
    entry: await sha256(outputEntry),
    addon: await sha256(outputAddon),
  },
};
await writeFile(
  join(outputRoot, "runtime-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);

process.stdout.write(`${JSON.stringify({ outputRoot, manifest }, null, 2)}\n`);
