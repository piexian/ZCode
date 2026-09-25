<#
.SYNOPSIS
  用 Windows 工具链构建 ax_native.node，产物落到 packages/zcode-cua/dist/win/。

.DESCRIPTION
  依赖 VS Build Tools v143、Windows Python 和 npm 自带的 node-gyp。
  从 WSL 调用时 native 目录是 UNC 路径，node-gyp 的 sln 查找不接受 UNC cwd，
  因此统一用 cmd pushd 把 UNC 映射成盘符后再执行 node-gyp。

.EXAMPLE
  pwsh -NoProfile -ExecutionPolicy Bypass -File packages/zcode-cua/native/windows/build.ps1
#>
param(
  [string]$NodeTarget = '24.16.0',
  [string]$Python = 'C:\Users\i3\.astrbot_launcher\components\python\py312\python.exe',
  [string]$DistUrl = 'https://npmmirror.com/mirrors/node',
  [switch]$ConfigureOnly
)

$ErrorActionPreference = 'Stop'
$nativeDir = $PSScriptRoot
$packageDir = Split-Path -Parent (Split-Path -Parent $nativeDir)
$outputDir = Join-Path $packageDir 'dist\win'
$nodeGyp = Join-Path $env:ProgramFiles 'nodejs\node_modules\npm\node_modules\node-gyp\bin\node-gyp.js'

if (-not (Test-Path $Python)) { throw "Windows Python not found: $Python" }
if (-not (Test-Path $nodeGyp)) { throw "bundled node-gyp not found: $nodeGyp" }

$env:npm_config_python = $Python
$env:npm_config_target = $NodeTarget
$env:npm_config_disturl = $DistUrl
$env:npm_config_arch = 'x64'

$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) { $nodeExe = Join-Path $env:ProgramFiles 'nodejs\node.exe' }
$action = if ($ConfigureOnly) { 'configure' } else { 'rebuild' }
$gypArgs = @($action, "--target=$NodeTarget", '--arch=x64', "--dist-url=$DistUrl")

function Invoke-NodeGyp([string[]]$Arguments) {
  $gyp = '"{0}"' -f $nodeGyp
  $tail = ($Arguments -join ' ')
  if ($nativeDir.StartsWith('\\')) {
    # UNC cwd：pushd 映射成临时盘符，退出时自动解除。
    $line = 'pushd "{0}" && node {1} {2} & popd' -f $nativeDir, $gyp, $tail
    & cmd /d /s /c $line
  }
  else {
    Push-Location $nativeDir
    try { & $nodeExe $nodeGyp @Arguments }
    finally { Pop-Location }
  }
  if ($LASTEXITCODE -ne 0) { throw "node-gyp $action failed with exit code $LASTEXITCODE" }
}

Write-Host "[ax_native] node-gyp $action --target=$NodeTarget --arch=x64 --dist-url=$DistUrl"
Invoke-NodeGyp $gypArgs

New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
$built = Join-Path $nativeDir 'build\Release\ax_native.node'
if (Test-Path $built) {
  Copy-Item -Force $built (Join-Path $outputDir 'ax_native.node')
}
Get-ChildItem $outputDir -Filter 'ax_native.*' | Select-Object Name, Length, LastWriteTime
