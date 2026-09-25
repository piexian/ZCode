#!/usr/bin/env bash
# 在 WSL 中通过 UNC 映射调用 Windows 工具链构建 ax_native.node。
# 直接在 Windows 上运行 build.ps1 也可以；这里只解决 WSL 侧的 cwd 与 node-gyp glob 限制。
#
# 已知限制：cmd 的 pushd 不接受带引号的 UNC 路径，因此仓库路径里不能有空格。
set -euo pipefail

native_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# cmd 的 pushd 既不接受正斜杠，也不接受带引号的 UNC。
unc_dir="$(wslpath -m "$native_dir" | tr '/' '\\')"
if [[ "$unc_dir" == *" "* ]]; then
  echo "仓库路径不能包含空格：$unc_dir" >&2
  exit 2
fi
# 不需要手动 call vcvars：node-gyp 自己通过 vswhere/注册表定位 MSVC，
# 而带空格的 vcvars 路径在 cmd 里又要一层引号转义，容易出错。

# WSL 侧的 cmd 位置：默认取 Windows 盘挂载点，可用 ZCODE_CUA_CMD 覆盖。
cmd_path="${ZCODE_CUA_CMD:-/mnt/c/Windows/System32/cmd.exe}"
exec "$cmd_path" /d /c "pushd ${unc_dir} && pwsh -NoProfile -ExecutionPolicy Bypass -File build.ps1 $*"
