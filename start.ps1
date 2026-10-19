<#
  岁语 · 一键启动
  ==========================================================================
  双击「启动.bat」会跑到这里。做五件事：
    ① 找 node（要 >= 23.4，因为用了 Node 内置的 node:sqlite）
    ② 3789 上已经有岁语在跑 → 不重复起，直接开网页
    ③ 起服务（隐藏窗口，日志写 data\server.log，PID 写 data\seyo.pid）
    ④ 等它真的能应答
    ⑤ **自动打开浏览器**

  为什么隐藏起来跑：
    老人的电脑上不该多一个黑窗口。服务在后台待着，日志在 data\server.log 里，
    出了问题也能查。要停就双击「停止.bat」。

  参数：
    -Port 3789     换端口
    -NoBrowser     只起服务，不开浏览器
#>
[CmdletBinding()]
param(
  [int]$Port = 3789,
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'

# ---- 控制台 UTF-8，不然中文全是问号 ----
try { chcp 65001 > $null } catch { }
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }

# 不再写死路径 —— 这个脚本跟着项目走
$root = $PSScriptRoot
if (-not $root) { $root = Split-Path -Parent $MyInvocation.MyCommand.Path }
$server = Join-Path $root 'src\server.mjs'
$dataDir = Join-Path $root 'data'
$logOut = Join-Path $dataDir 'server.log'
$logErr = Join-Path $dataDir 'server.log.err'
$pidFile = Join-Path $dataDir 'seyo.pid'
$url = "http://127.0.0.1:$Port/"

function Ok($t) { Write-Host "  [OK]   $t" -ForegroundColor Green }
function Warn($t) { Write-Host "  [注意] $t" -ForegroundColor Yellow }
function Bad($t) { Write-Host "  [错误] $t" -ForegroundColor Red }

function Pause-OnError {
  Write-Host ''
  Write-Host '  按任意键关闭…' -ForegroundColor DarkGray
  try { $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown') } catch { Start-Sleep -Seconds 20 }
}

function Open-Page {
  if ($NoBrowser) { return }
  try {
    Start-Process $url
    Ok "已打开浏览器：$url"
  } catch {
    Warn "浏览器没打开，自己访问：$url"
  }
}

Write-Host ''
Write-Host '  岁语 · 陪老人说话' -ForegroundColor Cyan
Write-Host '  ────────────────────────────────────────'

if (-not (Test-Path $server)) {
  Bad "找不到 $server —— 这个脚本要跟 src\ 放在一起"
  Pause-OnError
  exit 1
}

# --------------------------------------------------------------------------
# ① 已经开着就不重复起
# --------------------------------------------------------------------------
function Test-Seyo {
  try {
    $r = Invoke-RestMethod "http://127.0.0.1:$Port/api/health" -TimeoutSec 2
    if ($r.ok) { return $r }
    return $null
  } catch { return $null }
}

$h = Test-Seyo
if ($h) {
  Ok "岁语已经在跑了（记忆 $($h.stats.sentences) 条）"
  Open-Page
  Write-Host ''
  Write-Host '  这个窗口 3 秒后自动关掉。' -ForegroundColor DarkGray
  Start-Sleep -Seconds 3
  exit 0
}

# --------------------------------------------------------------------------
# ② 找 node —— 系统装的优先，Harness 自带的只当兜底
#    （那个是别的程序的运行时，说不定哪天就没了）
# --------------------------------------------------------------------------
$candidates = @()
if ($env:SEYO_NODE) { $candidates += $env:SEYO_NODE }
try { $candidates += (Get-Command node -ErrorAction Stop).Source } catch { }
$candidates += @(
  (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
  (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
)
$candidates += (Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe')

$node = $null
$version = ''
foreach ($c in $candidates) {
  if (-not $c -or -not (Test-Path $c)) { continue }
  try {
    $v = & $c --version 2>$null
    if ($LASTEXITCODE -ne 0) { continue }
    $v = "$v".Trim().TrimStart('v')
    $p = $v.Split('.')
    $major = [int]$p[0]; $minor = [int]$p[1]
    if ($major -gt 23 -or ($major -eq 23 -and $minor -ge 4)) {
      $node = $c; $version = $v; break
    }
    Warn "$c 是 v$v，太旧（要 23.4 以上，Node 才带 node:sqlite）"
  } catch { }
}

if (-not $node) {
  Bad '没找到能用的 node（需要 23.4 以上）'
  Write-Host ''
  Write-Host '  到 https://nodejs.org 下 LTS 版本装一下，装完再双击启动.bat。'
  Pause-OnError
  exit 1
}
Ok "node v$version"

# --------------------------------------------------------------------------
# ③ 顺带报一下 Python 的情况（语音识别、表情识别要用）
#    找不到不算失败 —— 那两个是懒加载的，打字用对话完全不受影响
# --------------------------------------------------------------------------
$pyList = @(
  $env:SEYO_PYTHON,
  (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'),
  (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python311\python.exe')
)
$pyOk = $null
foreach ($py in $pyList) {
  if (-not $py -or -not (Test-Path $py)) { continue }
  try {
    $r = & $py -c "import vosk, torch; print('ok')" 2>$null
    if ("$r".Trim() -eq 'ok') { $pyOk = $py; break }
  } catch { }
}
if ($pyOk) {
  Ok 'Python 齐了（vosk + torch）—— 语音和表情识别都能用'
} else {
  Warn '没找到同时装了 vosk 和 torch 的 Python'
  Warn '  语音/表情识别会不可用，打字说话照样能用'
  Warn '  装法：pip install vosk torch torchvision'
}

# --------------------------------------------------------------------------
# ④ 起服务
# --------------------------------------------------------------------------
if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Force -Path $dataDir | Out-Null }

Write-Host ''
Write-Host "  正在启动…（端口 $Port）"
try {
  $proc = Start-Process -FilePath $node `
    -ArgumentList @('src/server.mjs', '--port', "$Port") `
    -WorkingDirectory $root -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput $logOut -RedirectStandardError $logErr
} catch {
  Bad "起不来：$($_.Exception.Message)"
  Pause-OnError
  exit 1
}
$proc.Id | Out-File -FilePath $pidFile -Encoding ascii

# --------------------------------------------------------------------------
# ⑤ 等它真的能应答
# --------------------------------------------------------------------------
$ready = $null
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 500
  $ready = Test-Seyo
  if ($ready) { break }
  if ($proc.HasExited) { break }
}

if (-not $ready) {
  Bad '服务没起来'
  Write-Host ''
  Write-Host "  日志：$logErr"
  Write-Host '  ─────────── 最后几行 ───────────' -ForegroundColor DarkGray
  foreach ($f in @($logErr, $logOut)) {
    if (Test-Path $f) {
      Get-Content $f -Tail 15 -ErrorAction SilentlyContinue | ForEach-Object { "  $_" }
    }
  }
  if (-not $proc.HasExited) { try { Stop-Process -Id $proc.Id -Force } catch { } }
  Pause-OnError
  exit 1
}

Ok "就绪（PID $($proc.Id)，记忆 $($ready.stats.sentences) 条）"

# --------------------------------------------------------------------------
# ⑥ 开网页
# --------------------------------------------------------------------------
Open-Page

Write-Host ''
Write-Host '  ────────────────────────────────────────'
Write-Host '  岁语正在陪着老人。' -ForegroundColor Green
Write-Host ''
Write-Host '  · 说话：按住话筒，或者直接打字'
Write-Host '  · 右上角齿轮 = 设置（摄像头、内部过程）'
Write-Host "  · 家人的记忆档案：${url}family.html"
Write-Host ''
Write-Host '  服务在后台跑，日志在 data\server.log' -ForegroundColor DarkGray
Write-Host '  要停它：双击「停止.bat」' -ForegroundColor DarkGray
Write-Host '  ────────────────────────────────────────'
Write-Host ''
Write-Host '  这个窗口 5 秒后自动关掉。' -ForegroundColor DarkGray
Start-Sleep -Seconds 5
exit 0
