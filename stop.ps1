# 停止岁语服务
#
# 两种起法都要能停：
#   ① 双击「start.bat」（start.ps1 起的）—— data\seyo.pid 里记着 PID
#   ② 手动 npm start / node src/server.mjs 起的 —— **没有** pid 文件
#
# 以前只看 pid 文件：手动起的服务停不掉，而「start.bat」又因为端口被占直接跳过，
# 于是改了代码也一直跑着旧进程 —— 页面上怎么看都是"没有变化"。
# 现在 pid 文件找不到就按端口找，确认是岁语（命令行 / api/health）再停，
# 顺手把它拉起的 Python 子服务（表情 3791 / 语音识别 3792 / 语音合成 3793）一起收掉。
#
# 【重要】绝对不要用 Get-Process -Name node | Stop-Process -Force ——
#   这个 Harness（DSH）自己就是 node 进程，那样会把宿主一起砍掉。
#   本脚本只动"确认是 server.mjs 的进程"。

param([int]$Port = 3789)

try { chcp 65001 > $null } catch { }
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }

# 不写死路径 —— 跟 start.ps1 一样，这个脚本跟着项目走
$ws = $PSScriptRoot
if (-not $ws) { $ws = Split-Path -Parent $MyInvocation.MyCommand.Path }
$pidFile = Join-Path $ws 'data\seyo.pid'

function Say([string]$msg, [string]$color = 'Gray') { Write-Host $msg -ForegroundColor $color }

# 端口上的监听进程 PID。Get-NetTCPConnection 拿不到（老系统 / 权限不足）就退回 netstat
function Pids-OnPort([int]$p) {
  $found = @()
  try {
    $found = @(Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction Stop |
      Select-Object -ExpandProperty OwningProcess -Unique)
  } catch { }
  if (-not $found.Count) {
    try {
      $found = @(netstat -ano | Select-String (':' + $p + '\s') |
        Where-Object { $_.Line -match 'LISTENING\s+(\d+)\s*$' } |
        ForEach-Object { [int]$Matches[1] } | Sort-Object -Unique)
    } catch { }
  }
  return @($found | Where-Object { $_ -and $_ -gt 0 })
}

# 这个 PID 是不是岁语服务
function Test-Seyo([int]$procId) {
  try {
    $cmd = (Get-CimInstance Win32_Process -Filter ('ProcessId=' + $procId) -ErrorAction Stop).CommandLine
    if ($cmd) { return [bool]($cmd -match 'server\.mjs') }
  } catch { }
  # 拿不到命令行（权限不足）：只能靠"这个端口上确实有岁语在应答"来判断
  try {
    $h = Invoke-RestMethod ('http://127.0.0.1:' + $Port + '/api/health') -TimeoutSec 2
    return [bool]$h.ok
  } catch { return $false }
}

function Stop-One([int]$procId, [string]$how) {
  try {
    Stop-Process -Id $procId -Force -ErrorAction Stop
    Say ('  已停止岁语服务（PID ' + $procId + '，' + $how + '）') 'Green'
    return $true
  } catch {
    Say ('  ✗ 结束不了 PID ' + $procId + '：' + $_.Exception.Message) 'Red'
    Say '    它可能是用管理员权限起的 —— 用「以管理员身份运行」再双击 stop.bat，' 'Yellow'
    Say '    或者：任务管理器 → 详细信息 → 找到这个 PID → 结束任务。' 'Yellow'
    return $false
  }
}

$stopped = @()
$failedIds = @()

# ① 先按 pid 文件停
if (Test-Path $pidFile) {
  $raw = Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1
  $old = 0
  $procExists = $false
  if ($raw -and [int]::TryParse(([string]$raw).Trim(), [ref]$old) -and $old -gt 0) {
    if (Get-Process -Id $old -ErrorAction SilentlyContinue) {
      $procExists = $true
      if (Test-Seyo $old) {
        $ok = Stop-One $old 'pid 文件'
        if ($ok) { $stopped += $old; $procExists = $false } else { $failedIds += $old }
      } else {
        Say ('PID ' + $old + ' 不是岁语服务（命令行对不上），不动它') 'Yellow'
        $procExists = $false
      }
    }
  }
  # 进程不在了 / PID 文件内容坏了才删；结束失败时留着，下次还能按它重试
  if (-not $procExists) { Remove-Item $pidFile -Force -ErrorAction SilentlyContinue }
}

# ② 再按端口找（手动起的那种没有 pid 文件）
foreach ($procId in (Pids-OnPort $Port)) {
  if (($stopped -contains $procId) -or ($failedIds -contains $procId)) { continue }
  if (-not (Test-Seyo $procId)) { continue }
  $ok = Stop-One $procId '按端口找到的'
  if ($ok) { $stopped += $procId } else { $failedIds += $procId }
}

# ③ 主服务收掉了，再把它的 Python 子服务收掉
if ($stopped.Count) {
  foreach ($helperPort in @(3791, 3792, 3793)) {
    foreach ($procId in (Pids-OnPort $helperPort)) {
      $pr = Get-Process -Id $procId -ErrorAction SilentlyContinue
      if ($pr -and $pr.ProcessName -like 'python*') {
        try {
          Stop-Process -Id $procId -Force -ErrorAction Stop
          Say ('  已收掉本地服务（PID ' + $procId + '，端口 ' + $helperPort + '）') 'Green'
        } catch { }
      }
    }
  }
}

if ($stopped.Count) {
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 600
  $left = @(Pids-OnPort $Port)
  if ($left.Count) {
    Say ('端口 ' + $Port + ' 还被 PID ' + ($left -join '、') + ' 占着 —— 可能没权限结束它') 'Yellow'
    Say '  用「以管理员身份运行」再双击 stop.bat。' 'Yellow'
    exit 1
  }
  Say ('岁语服务已停止（PID ' + ($stopped -join '、') + '）') 'Green'
  exit 0
}

if ($failedIds.Count) {
  Say ('没能停掉岁语服务（PID ' + ($failedIds -join '、') + '），按上面的提示处理。') 'Yellow'
  exit 1
}

Say ('没有找到正在跑的岁语服务（端口 ' + $Port + '）') 'Yellow'
exit 0
