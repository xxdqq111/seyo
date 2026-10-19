#!/usr/bin/env bash
# 岁语（Seyo）· 树莓派安装
#
# 在树莓派上、项目目录里执行：
#     bash deploy/install-pi.sh
#
# 做四件事：
#   0. 确认拿得到管理员权限（这台机器的 sudo 可能要密码）
#   1. 保证有 Node 24（node:sqlite 需要 23.4 以上；系统自带的 18/20 不够）
#      —— 先试 NodeSource，不行就下官方压缩包（Debian 13 上 NodeSource 常常还没跟上）
#   2. 验证 node:sqlite 可用
#   3. 注册 systemd 服务：开机自启 + 崩溃自动拉起 + 局域网可访问
#
# 依赖：curl、tar（树莓派系统自带）

set -e

DIR="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${SEYO_PORT:-3789}"

echo "=============================================="
echo "  岁语 · 树莓派安装"
echo "  项目目录：$DIR"
echo "=============================================="
echo ""

# ---------- 0. 管理员权限 ----------
# 注意：树莓派官方的 NOPASSWD 配置并不一定存在（这台就没有
# /etc/sudoers.d/010_pi-nopasswd），所以不能假设 sudo 免密。
# 这里先探测一次：免密就直接用；要密码就让用户输一次，
# 认证通过后 sudo 会缓存几分钟，后面的调用就不用再输了。
if sudo -n true 2>/dev/null; then
  SUDO="sudo -n"
  echo ">> 管理员权限：免密 ✓"
else
  echo ">> 这台机器的 sudo 需要密码（没有 NOPASSWD 配置）"
  echo "   请输入登录密码，输一次就够（输入时不显示字符）："
  SUDO_PW=""
  if [ -r /dev/tty ]; then
    read -r -s -p "   密码: " SUDO_PW < /dev/tty || true
  else
    read -r -s -p "   密码: " SUDO_PW || true
  fi
  echo ""
  if [ -z "$SUDO_PW" ]; then
    echo "   !! 没读到密码。请在有终端的窗口里运行本脚本。"
    exit 1
  fi
  if ! printf '%s\n' "$SUDO_PW" | sudo -S -p '' -v 2>/dev/null; then
    echo "   !! 密码不对，或者这个账号不在 sudo 组里。"
    echo "      检查：groups $(id -un)"
    exit 1
  fi
  unset SUDO_PW
  SUDO="sudo -n"
  echo "   ✓ 已验证（几分钟内不用再输）"
fi
echo ""

# ---------- 判断 node:sqlite 是否可用 ----------
has_sqlite() {
  command -v node >/dev/null 2>&1 || return 1
  node -e "import('node:sqlite').then(()=>process.exit(0)).catch(()=>process.exit(1))" 2>/dev/null
}

# ---------- 架构 ----------
ARCH="$(uname -m)"
case "$ARCH" in
  aarch64|arm64) NODE_ARCH="arm64" ;;
  armv7l)        NODE_ARCH="armv7l" ;;
  x86_64)        NODE_ARCH="x64" ;;
  *)             NODE_ARCH="" ;;
esac
echo ">> 架构：$ARCH（Node 包用 $NODE_ARCH）"

# ---------- 1. 装 Node ----------
if has_sqlite; then
  echo ">> 已有可用的 Node：$(node -v)，跳过安装"
else
  echo ""
  echo ">> 需要安装 Node 24（当前：$(node -v 2>/dev/null || echo '无')）"

  # 方案一：NodeSource
  echo "   试 NodeSource 源……"
  if curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/nodesource_setup.sh 2>/dev/null \
     && $SUDO -E bash /tmp/nodesource_setup.sh >/tmp/nodesource.log 2>&1 \
     && $SUDO apt-get install -y nodejs >/tmp/apt-node.log 2>&1 \
     && has_sqlite; then
    echo "   ✓ NodeSource 装好了：$(node -v)"
  else
    # 方案二：官方压缩包（最可靠，任何发行版都能用）
    echo "   NodeSource 不行（Debian 13 常见），改用官方压缩包……"
    if [ -z "$NODE_ARCH" ]; then
      echo "   !! 不认识的架构 $ARCH，请手动装 Node 24：https://nodejs.org/"
      exit 1
    fi
    FILE="$(curl -fsSL https://nodejs.org/dist/latest-v24.x/ 2>/dev/null \
            | grep -o "node-v[0-9.]*-linux-${NODE_ARCH}\.tar\.xz" | head -1)"
    if [ -z "$FILE" ]; then
      echo "   !! 取不到 Node 包名，检查网络：curl -I https://nodejs.org/dist/latest-v24.x/"
      exit 1
    fi
    echo "   下载 $FILE ……"
    curl -fsSL "https://nodejs.org/dist/latest-v24.x/$FILE" -o /tmp/node.tar.xz
    $SUDO tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
    rm -f /tmp/node.tar.xz
    hash -r
    echo "   ✓ 官方包装好了：$(node -v)"
  fi
fi

echo ""

# ---------- 2. 验证 node:sqlite ----------
if ! has_sqlite; then
  echo "!! 当前 Node（$(node -v)）没有 node:sqlite 模块"
  echo "   需要 Node 23.4 以上（建议 24）。请手动升级后重跑本脚本。"
  exit 1
fi
echo ">> node:sqlite 可用 ✓   Node $(node -v)"

# ---------- 3. 注册 systemd 服务 ----------
NODE_BIN="$(command -v node)"

# 以调用本脚本的普通用户身份运行，不要用 root：
# 这是个对局域网开放的服务，用 root 跑等于把整台机器交出去。
RUN_USER="${SUDO_USER:-$(id -un)}"
if [ "$RUN_USER" = "root" ]; then RUN_USER="$(id -un)"; fi
RUN_GROUP="$(id -gn "$RUN_USER" 2>/dev/null || echo "$RUN_USER")"

echo ">> 服务将以用户 $RUN_USER:$RUN_GROUP 运行"
# 数据目录得归他，否则写不了库
$SUDO chown -R "$RUN_USER:$RUN_GROUP" "$DIR" 2>/dev/null || true

echo ">> 注册开机自启服务（用 $NODE_BIN）……"

$SUDO tee /etc/systemd/system/seyo.service > /dev/null <<EOF
[Unit]
Description=Seyo companion (岁语)
After=network-online.target
Wants=network-online.target

[Service]
User=$RUN_USER
Group=$RUN_GROUP
WorkingDirectory=$DIR
ExecStart=$NODE_BIN src/server.mjs --host 0.0.0.0 --port $PORT
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

$SUDO systemctl daemon-reload
$SUDO systemctl enable seyo >/dev/null 2>&1 || true
$SUDO systemctl restart seyo

# ---------- 4. 自检 ----------
echo ""
echo ">> 等服务起来……"
OK=0
for i in $(seq 1 24); do
  sleep 0.5
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then OK=1; break; fi
done

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"

echo ""
echo "=============================================="
if [ "$OK" = "1" ]; then
  echo "  装好了，服务已在跑"
else
  echo "  服务已注册，但还没响应 —— 看日志："
  echo "    journalctl -u seyo -n 40 --no-pager"
fi
echo "=============================================="
echo "  同一 WiFi 下，用手机 / 平板 / 电脑打开："
echo ""
echo "    对话界面    http://$IP:$PORT/"
echo "    家人查看端  http://$IP:$PORT/family.html"
echo ""
echo "  服务管理："
echo "    看状态  sudo systemctl status seyo"
echo "    停止    sudo systemctl stop seyo"
echo "    重启    sudo systemctl restart seyo"
echo "    看日志  journalctl -u seyo -f"
echo ""
echo "  数据都在 $DIR/data/ 里，备份就拷 seyo.db"
echo "=============================================="
