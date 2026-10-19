# 停止岁语服务：只杀记录在案的 PID
#
# 【重要】绝对不要用 Get-Process -Name node | Stop-Process -Force
#   这个 Harness（DSH）自己就是 node 进程，那样会把宿主一起砍掉，
#   结果就是命令行彻底不能用。我这次就是这么把自己弄瘸的。
#   这个脚本会先核对命令行，确认是我们的 server.mjs 才动手。

try { chcp 65001 > $null } catch { }
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# 不写死路径 —— 跟 start.ps1 一样，这个脚本跟着项目走
$ws = $PSScriptRoot
if (-not $ws) { $ws = Split-Path -Parent $MyInvocation.MyCommand.Path }
$pidFile = Join-Path $ws "data\seyo.pid"

if (-not (Test-Path $pidFile)) {
  Write-Host "没有 PID 文件，服务应该没在跑" -ForegroundColor Yellow
  exit 0
}
$old = (Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
if (-not $old) {
  Write-Host "PID 文件是空的，清掉" -ForegroundColor Yellow
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  exit 0
}

$proc = Get-Process -Id $old -ErrorAction SilentlyContinue
if (-not $proc) {
  Write-Host "PID $old 已经不在了，清掉记录" -ForegroundColor Yellow
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  exit 0
}

$cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$old" -ErrorAction SilentlyContinue).CommandLine
if ($cmd -and $cmd -notmatch "server\.mjs") {
  Write-Host "PID $old 不是岁语服务（命令行：$cmd），不动它" -ForegroundColor Red
  exit 1
}

Stop-Process -Id $old -Force
Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
Write-Host "已停止岁语服务（PID $old）" -ForegroundColor Green
