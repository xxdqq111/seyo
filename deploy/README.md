# 岁语（Seyo）· 树莓派部署

把岁语跑在树莓派上，家里老人用手机/平板/电脑打开网页就能聊；数据都存在树莓派本地。

## 一、先说三个坑（很重要）

1. **Node 版本**：项目用了 `node:sqlite`（Node 内置模块）。
   - 系统自带 Node 18/20 **不够**；
   - Node 22.x 还需要 `--experimental-sqlite` 标志；
   - **Node 23.4 以上（建议 24 LTS）才能直接跑**。
2. **硬件架构**：推荐 **Pi 4 / Pi 5**（ARM64）。Pi 3B+ 也行但慢。Pi Zero 2 W 可用（armv7 版 Node）。Pi Zero 1 / Pi 1 是 ARMv6，现代 Node 不支持。
3. **必须联网**：说话走 DeepSeek 云端 API，树莓派要能上外网。

## 二、烧录系统

1. 电脑上装 **Raspberry Pi Imager**（raspberrypi.com/software）
2. 选「Raspberry Pi OS（64-bit）」，写进 SD 卡
3. 写之前点右下角齿轮，设置好 WiFi 和 SSH（勾选"启用 SSH"）——这样插卡开机后能远程连

## 三、把项目传到树莓派

在**你的电脑**（Windows）上，把整个 `seyo` 文件夹传过去（三选一）：

```bash
# 方式 A：scp（把 pi 换成树莓派的用户名/IP）
scp -r C:\Users\zhang\Desktop\x\seyo\seyo pi@树莓派IP:/home/pi/seyo

# 方式 B：U 盘拷过去

# 方式 C：如果项目在 git 仓库里
git clone 你的仓库地址
```

> `data/` 里有你的 API key（`llm.json`）和数据库。想干净开始就只拷 `data/llm.json`，不拷 `seyo.db*`。

## 四、一键安装

SSH 进树莓派，执行：

```bash
cd ~/seyo
bash deploy/install-pi.sh
```

脚本会：装 Node 24 → 验证 `node:sqlite` → 注册开机自启服务。

## 五、访问

装完脚本会打印地址。同一 WiFi 下：

```
对话界面    http://树莓派IP:3789/
家人查看端  http://树莓派IP:3789/family.html
```

## 六、日常管理

```bash
sudo systemctl status seyo      # 看状态
sudo systemctl stop seyo        # 停
sudo systemctl restart seyo     # 重启
journalctl -u seyo -f           # 看实时日志
```

## 七、备份数据

所有记忆都在 `data/seyo.db`（还有 WAL 文件）。备份：

```bash
sudo systemctl stop seyo
cp data/seyo.db 备份路径/
sudo systemctl start seyo
```

## 八、语音说明

现在语音是浏览器做的（Web Speech API）：
- 老人用**手机/平板/电脑**打开，录音和朗读都由那个设备完成，树莓派只当服务器、存数据。
- 想让树莓派自己带麦克风+喇叭直接对话，需要再配浏览器 kiosk 模式 + TTS，属于进阶，需要的话再说。

## 附：不用系统服务，手动跑

```bash
node src/server.mjs --host 0.0.0.0 --port 3789
```

> 不加 `--host 0.0.0.0` 时只监听 127.0.0.1，别的设备连不进来。
