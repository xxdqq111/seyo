# 树莓派部署进度（暂停于 2026-10-20）

> 用户已主动关闭树莓派，当前暂停部署。本文记录现场状态，恢复时照着往下做。
> **不保存 SSH 密码**；连接信息问用户。

## 目标机器

| 项 | 值 |
|---|---|
| 局域网 IP | `<PI_IP>` |
| SSH 用户 | `<PI_USER>` |
| 型号 | Raspberry Pi 5 |
| 系统 | Debian GNU/Linux 13 (trixie)，aarch64，64 位 |
| 桌面 | Wayland + labwc，lightdm 已配置自动登录 `x` |
| Node | v24.22.0（系统自带） |
| Python | 3.13.5 |
| 内存 | 约 1 GB 可见（注意 OOM） |
| 磁盘 | 29 GB，可用约 21 GB |

## 已完成

- [x] MariaDB 11.8 安装并开机自启
- [x] 数据库 `seyo`、应用账号 `seyo` 和权限
- [x] 代码复制到 `/opt/seyo`（含 `model/asr`、`model/tts`、前端资源）
- [x] `npm install --omit=dev`（含 mysql2）
- [x] Python venv `/opt/seyo/.venv`：flask / numpy / vosk / sherpa-onnx
- [x] 配置：`/opt/seyo/data/mysql.json`、`llm.json`、`vision.json`（FER 先禁用）
- [x] systemd 服务 `/etc/systemd/system/seyo.service` 已改为 `/opt/seyo`，运行 MySQL 版
- [x] 服务健康检查通过：`mysql://127.0.0.1:3306/seyo`
- [x] Chromium kiosk 自启文件：`/home/<PI_USER>/.config/autostart/seyo-kiosk.desktop`
- [x] kiosk 已用 Wayland 启动过一次（必须带 `--ozone-platform=wayland`）
- [x] 虚拟键盘：`public/vkbd.js`，已加载到登录页 / 老人端 / 查看端 / 远程端，右下角 ⌨
- [ ] **前端 emoji 清理**：本地 `public/` 已清理；Pi 已关机，未同步到 `/opt/seyo/public`，恢复后要重新上传 `public/`

## 未完成 / 未验证

- [ ] 树莓派重启后的 kiosk 自启验证（用户已关机）
- [ ] ASR（Vosk）实际识别验证
- [ ] TTS（sherpa-onnx）实际出声验证
- [ ] 摄像头、麦克风硬件接入与 Chromium 权限验证
- [ ] FER 表情识别（需 PyTorch + FRE_Classroom 源码/权重；1 GB 内存需谨慎）
- [ ] 部署脚本和安装文档正式化（本文即恢复说明）
- [ ] 旧 SQLite 迁移：未迁移；旧数据仍在 `/home/<PI_USER>/seyo/data`

## 恢复后先检查

```bash
ssh <PI_USER>@<PI_IP>
systemctl status seyo mariadb --no-pager
curl -s http://127.0.0.1:3789/api/health
tail -30 /opt/seyo/data/server.log
```

正常应看到：

```json
{"ok":true,"time":"...","db":"mysql://127.0.0.1:3306/seyo"}
```

页面：

- 本机：`http://127.0.0.1:3789/`
- 局域网：`http://<PI_IP>:3789/`
- 远程端：`http://<PI_IP>:3789/remote.html`

## 服务文件

`/etc/systemd/system/seyo.service` 当前内容：

```ini
[Unit]
Description=Seyo companion (岁语)
After=network-online.target mariadb.service
Wants=network-online.target

[Service]
User=x
Group=x
WorkingDirectory=/opt/seyo
Environment=HOST=0.0.0.0
Environment=PORT=3789
Environment=SEYO_PYTHON=/opt/seyo/.venv/bin/python
ExecStart=/usr/bin/node src/server.mjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

## kiosk 自启文件

`/home/<PI_USER>/.config/autostart/seyo-kiosk.desktop`：

```ini
[Desktop Entry]
Type=Application
Name=Seyo Kiosk
Exec=/usr/bin/chromium --kiosk --ozone-platform=wayland --noerrdialogs --disable-infobars --disable-session-crashed-bubble --no-first-run --no-default-browser-check --password-store=basic --autoplay-policy=no-user-gesture-required http://127.0.0.1:3789/
X-GNOME-Autostart-enabled=true
```

手动启动 kiosk：

```bash
env XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-0 \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus \
  /usr/bin/chromium --kiosk --ozone-platform=wayland \
  --noerrdialogs --disable-infobars --no-first-run \
  --password-store=basic --autoplay-policy=no-user-gesture-required \
  http://127.0.0.1:3789/
```

## 语音服务单测（注意内存）

不要同时拉起两个和 Chromium，1 GB 内存容易卡死。

ASR：

```bash
cd /opt/seyo
.venv/bin/python model/asr_service.py --port 3792 \
  --model-dir model/asr/vosk-model-small-cn-0.22
curl -s http://127.0.0.1:3792/health
```

TTS：

```bash
cd /opt/seyo
.venv/bin/python model/tts_service.py --port 3793 \
  --model-dir model/tts/vits-zh-hf-fanchen-wnj --num-threads 2
curl -s http://127.0.0.1:3793/health
```

如果内存不够：先停 Chromium 再测、给 Pi 加 2 GB swap，或只保留 Vosk / 浏览器系统语音。

## FER 表情识别（暂缓）

需要额外准备：

- `pip install torch torchvision pillow flask`
- 复制 `FRE_Classroom` 源码、`weights/final_best.pth`、`yolov8s-face-lindevs.pt`
- 在 `/opt/seyo/data/vision.json` 里填 `modelDir` 并重新启用

1 GB 内存 + ARM64 跑 PyTorch 面部检测可能很慢，建议先不启用。

## 回退

旧版本仍在 `/home/<PI_USER>/seyo`，旧 SQLite 数据未迁移。  
回退：把 `seyo.service` 的 `WorkingDirectory` 改回 `/home/<PI_USER>/seyo` 并重启。

## 虚拟键盘

- 文件：`/opt/seyo/public/vkbd.js`
- 已在登录页、老人端、查看端、远程端加载
- 右下角 ⌨ 打开；触屏聚焦输入框会自动弹出
- 目前是英文字母/数字/常用符号键盘；中文输入需后续接系统输入法或扩展拼音候选

## 当前状态

- 树莓派：**用户已关闭电源**
- 本地 Windows 岁语：不受影响
- 本地备份：`C:\Users\zhang\Desktop\x\seyo\seyo-backup.zip`
