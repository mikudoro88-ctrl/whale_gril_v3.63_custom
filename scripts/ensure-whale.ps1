# 鲸鲸 · 确保主服务在跑
# 给 scripts\bridge_loop.bat 调用：桥接启动时如果发现 8787 没监听，就后台把鲸鲸主服务拉起来。
# 单独用：powershell -File scripts\ensure-whale.ps1 [-Quiet] [-TimeoutSec 60]
param(
  [switch]$Quiet,
  [int]$TimeoutSec = 60
)

$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent $PSScriptRoot
if (-not $root) { $root = (Get-Location).Path }
Set-Location $root

function Say($msg, $color = 'Gray') {
  if (-not $Quiet) { Write-Host $msg -ForegroundColor $color }
}

function Test-WhaleUp {
  try {
    $conn = @(Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction Stop)
    if ($conn.Count -gt 0) { return $true }
  } catch { }
  # 老系统/受限环境没有 Get-NetTCPConnection 时退回 netstat，只认 LISTENING 行
  $lines = @(& netstat.exe -ano -p tcp 2>$null)
  foreach ($line in $lines) {
    if ($line -match ':8787\s' -and $line -match 'LISTENING') { return $true }
  }
  return $false
}

if (Test-WhaleUp) {
  Say '  · 鲸鲸主服务已在运行（127.0.0.1:8787）'
  exit 0
}

# 找运行时：包自带 node → PATH 里的 node → DSH 的 Electron 内核
$nodeExe = ''
$useElectron = $false
$bundled = Join-Path $root 'runtime\node.exe'
if (Test-Path $bundled) {
  $nodeExe = $bundled
} else {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) {
    $nodeExe = $cmd.Source
  } else {
    $dshCandidates = @(
      (Join-Path $env:LOCALAPPDATA 'Programs\DSH Desktop\DSH Desktop.exe'),
      (Join-Path $env:ProgramFiles 'DSH Desktop\DSH Desktop.exe'),
      (Join-Path $env:USERPROFILE 'DSH Desktop\DSH Desktop.exe')
    )
    if ($env:DSH_EXE) { $dshCandidates = @($env:DSH_EXE) + $dshCandidates }
    foreach ($p in $dshCandidates) {
      if ($p -and (Test-Path $p)) { $nodeExe = $p; $useElectron = $true; break }
    }
  }
}

if (-not $nodeExe) {
  Say '  ! 没找到 Node 运行时，无法自动启动鲸鲸（请先双击「启动鲸鱼娘.bat」）' 'Yellow'
  exit 1
}

# 和 start.ps1 保持一致：清掉可能残留的代理，避免模型请求打到没开的本地代理上
foreach ($name in @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy')) {
  if (Test-Path "env:$name") { Remove-Item "env:$name" -ErrorAction SilentlyContinue }
}
$env:NO_PROXY = '127.0.0.1,localhost,::1'
$env:no_proxy = $env:NO_PROXY
$env:TZ = 'Asia/Shanghai'
if ($useElectron) { $env:ELECTRON_RUN_AS_NODE = '1' }

$dataDir = Join-Path $root 'data'
if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir -Force | Out-Null }
$outLog = Join-Path $dataDir 'runtime.out.log'
$errLog = Join-Path $dataDir 'runtime.err.log'

Say ('  · 鲸鲸主服务没在跑，正在后台启动（' + (Split-Path -Leaf $nodeExe) + '）…')

try {
  $proc = Start-Process -FilePath $nodeExe `
    -ArgumentList @((Join-Path $root 'server.js'), '--no-browser') `
    -WorkingDirectory $root `
    -WindowStyle Hidden `
    -RedirectStandardOutput $outLog `
    -RedirectStandardError $errLog `
    -PassThru
  Set-Content -LiteralPath (Join-Path $dataDir 'whale.pid') -Value ([string]$proc.Id) -Encoding ASCII
} catch {
  Say ('  ! 启动失败：' + $_.Exception.Message) 'Yellow'
  exit 1
}

$deadline = (Get-Date).AddSeconds([Math]::Max(10, $TimeoutSec))
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 800
  if (Test-WhaleUp) {
    Say '  · 鲸鲸主服务已就绪（127.0.0.1:8787）' 'Green'
    exit 0
  }
  if ($proc.HasExited) { break }
}

if (Test-WhaleUp) { exit 0 }

Say ('  ! 等了 ' + $TimeoutSec + ' 秒鲸鲸还没起来，先继续启动桥接（桥接会自己重试）。') 'Yellow'
if (Test-Path $errLog) {
  $tail = Get-Content $errLog -Encoding UTF8 -ErrorAction SilentlyContinue | Select-Object -Last 5
  foreach ($line in @($tail)) { if ($line) { Say ('    ' + $line) 'DarkYellow' } }
}
exit 1
