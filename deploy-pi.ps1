# ==========================================================================
# 岁语 · 部署到树莓派
#
# 用法：双击同目录的「部署到树莓派.bat」，或在本目录运行：
#     powershell -ExecutionPolicy Bypass -File .\deploy-pi.ps1
#
# 它会做这些事：
#   1. 测树莓派通不通
#   2. 在本机生成一个 SSH 密钥（如果你还没有），并装到树莓派上
#      —— 这一步要你输一次树莓派的密码，之后就不用再输了
#   3. 把项目拷过去
#   4. 在树莓派上跑 deploy/install-pi.sh（装 Node、注册开机自启）
#   5. 打印访问网址
#
# 想换树莓派，直接改下面的默认值，或者运行时按提示输入。
# ==========================================================================

param(
  [string]$Pi   = "",
  [string]$User = ""
)

$ErrorActionPreference = 'Stop'
$ws = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ws

# ---------- 先把控制台切到 UTF-8 ----------
# 否则树莓派那边（Linux 一律 UTF-8）回来的中文会被 Windows 按 GBK 解码，
# 变成"鈥佽�路 鏍戣帗娲惧埞"这种乱码。
#   [Console]::OutputEncoding → 决定怎么"解码"原生命令的输出（ssh 回来的字节）
#   $OutputEncoding          → 决定怎么"编码"我们发给原生命令的内容
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $OutputEncoding = [System.Text.Encoding]::UTF8
  chcp 65001 | Out-Null
} catch { }

function Say($msg, $color = 'Gray') { Write-Host $msg -ForegroundColor $color }
function Head($msg) {
  Write-Host ""
  Write-Host ('─' * 58) -ForegroundColor DarkGray
  Write-Host "  $msg" -ForegroundColor White
  Write-Host ('─' * 58) -ForegroundColor DarkGray
}

Write-Host ""
Write-Host '==========================================' -ForegroundColor DarkYellow
Write-Host '   岁语 · 部署到树莓派' -ForegroundColor Yellow
Write-Host '==========================================' -ForegroundColor DarkYellow

# ---------- 0. 检查工具 ----------
if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
  Say '找不到 ssh。请先安装「OpenSSH 客户端」：' 'Red'
  Say '  设置 → 应用 → 可选功能 → 添加功能 → OpenSSH 客户端' 'Yellow'
  exit 1
}
if (-not (Get-Command scp -ErrorAction SilentlyContinue)) { Say '找不到 scp。' 'Red'; exit 1 }

# ---------- 1. 问地址 ----------
Head '树莓派在哪里'
if (-not $Pi) {
  $Pi = Read-Host '  树莓派 IP 或主机名（回车用 192.168.110.190）'
  if (-not $Pi) { $Pi = '192.168.110.190' }
}
if (-not $User) {
  $User = Read-Host "  登录用户名（回车用 pi）"
  if (-not $User) { $User = 'pi' }
}
Say "  目标：$User@$Pi" 'Cyan'

# ---------- 2. 测连通 ----------
Head '① 测试连通'
$tcp = New-Object System.Net.Sockets.TcpClient
try {
  $t = $tcp.ConnectAsync($Pi, 22)
  $ok = $t.Wait(5000)
  if (-not $ok -or $t.IsFaulted) { throw '连不上 22 端口' }
  Say '  ✓ SSH 端口通' 'Green'
} catch {
  Say "  ✗ 连不上 $Pi:22" 'Red'
  Say '    检查：树莓派开机了吗？和电脑在同一个 WiFi 吗？IP 对不对？' 'Yellow'
  $tcp.Close()
  exit 1
} finally { try { $tcp.Close() } catch {} }

# ---------- 3. SSH 密钥 ----------
Head '② 准备免密登录（只需输一次密码）'
$keyDir = Join-Path $env:USERPROFILE '.ssh'
$key    = Join-Path $keyDir 'id_ed25519'
if (-not (Test-Path $keyDir)) { New-Item -ItemType Directory -Force -Path $keyDir | Out-Null }
if (-not (Test-Path $key)) {
  Say '  生成新密钥……' 'Gray'
  & ssh-keygen -t ed25519 -N '""' -f "$key" -C 'seyo-deploy' | Out-Null
  Say '  ✓ 已生成' 'Green'
} else {
  Say '  ✓ 本机已有密钥' 'Green'
}

$pub = Get-Content "$key.pub" -Raw
$pub = $pub.Trim()
$remote = "$User@$Pi"

Say ''
Say '  接下来会要你输【树莓派的登录密码】（就是烧录时设的那个）。' 'Yellow'
Say '  输入时屏幕上不会显示任何字符，这是正常的。' 'DarkGray'
Say ''

$installKey = "mkdir -p ~/.ssh && chmod 700 ~/.ssh && grep -qF '$pub' ~/.ssh/authorized_keys 2>/dev/null || echo '$pub' >> ~/.ssh/authorized_keys; chmod 600 ~/.ssh/authorized_keys; echo KEY_OK"
$out = & ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 $remote $installKey 2>&1
if ($out -match 'KEY_OK') {
  Say '  ✓ 免密登录已装好（以后不用再输密码）' 'Green'
} else {
  Say '  ✗ 装密钥失败，输出：' 'Red'
  $out | ForEach-Object { Say "    $_" 'Red' }
  Say '  密码错了吗？或者用户名不是这个？' 'Yellow'
  exit 1
}

# ---------- 4. 传项目 ----------
Head '③ 传项目到树莓派'
& ssh -o BatchMode=yes $remote 'mkdir -p ~/seyo/data' 2>&1 | Out-Null

Say '  正在拷贝（约 4 MB，几十秒）……' 'Gray'
$items = @('src', 'public', 'test', 'deploy', 'package.json', 'README.md') |
  Where-Object { Test-Path (Join-Path $ws $_) }
& scp -q -r -o BatchMode=yes @items "${remote}:~/seyo/" 2>&1 | ForEach-Object { Say "    $_" 'DarkGray' }
if ($LASTEXITCODE -ne 0) { Say '  ✗ 拷贝失败' 'Red'; exit 1 }
Say '  ✓ 代码已传过去' 'Green'

# 大模型配置（含 API Key）单独传，避免覆盖树莓派上已有的
if (Test-Path "$ws\data\llm.json") {
  & scp -q -o BatchMode=yes "$ws\data\llm.json" "${remote}:~/seyo/data/llm.json" 2>&1 | Out-Null
  Say '  ✓ 大模型配置已传（API Key 一起带过去了）' 'Green'
}

# ---------- 5. 安装 ----------
Head '④ 在树莓派上安装'
Say '  装 Node、注册开机自启。可能要两三分钟，请耐心等……' 'Gray'
Say ''
Say '  ⚠ 如果下面出现「密码:」，输入树莓派的登录密码再回车。' 'Yellow'
Say '    这台机器的 sudo 没有免密配置，注册服务需要管理员权限。' 'DarkGray'
Say ''
# 注意：这一步**不能**把输出接到管道里再打印。
# sudo 的密码提示没有换行结尾，经过管道会被缓冲住，看起来就像脚本卡死了。
# 让 ssh 直接接管控制台，提示才能正常显示、你才能输入。
& ssh -t $remote 'cd ~/seyo && bash deploy/install-pi.sh'
$code = $LASTEXITCODE

Head '结果'
if ($code -eq 0) {
  Write-Host '  ✓ 部署完成！' -ForegroundColor Green
  Write-Host ''
  Write-Host '  同一 WiFi 下，用手机 / 平板 / 电脑打开：' -ForegroundColor White
  Write-Host "    对话界面     http://$Pi`:3789/" -ForegroundColor Cyan
  Write-Host "    家人查看端   http://$Pi`:3789/family.html" -ForegroundColor Cyan
  Write-Host ''
  Write-Host '  常用命令（在树莓派上）：' -ForegroundColor DarkGray
  Write-Host '    sudo systemctl status seyo     看状态' -ForegroundColor DarkGray
  Write-Host '    sudo systemctl restart seyo    重启' -ForegroundColor DarkGray
  Write-Host '    journalctl -u seyo -f          看日志' -ForegroundColor DarkGray
} else {
  Write-Host '  ✗ 安装没成功，把上面的输出发给开发者看。' -ForegroundColor Red
  Write-Host '  也可以手动 SSH 上去再跑一次：' -ForegroundColor Yellow
  Write-Host "    ssh $remote 'cd ~/seyo && bash deploy/install-pi.sh'" -ForegroundColor Yellow
}
Write-Host ''
