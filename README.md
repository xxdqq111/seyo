# 岁语（Seyo）

一个给老人用的陪伴式对话应用：Node.js + MySQL，浏览器访问；支持账号隔离、语音识别、语音合成、3D 数字人和本地记忆整理。

> 本 README 只讲安装。功能说明、接口和开发记录在 `docs/README-full.md`。

---

## 1. 环境要求

| 组件 | 要求 |
|---|---|
| Node.js | >= 20（推荐 22 / 24） |
| MySQL | MySQL 8.0+ 或 MariaDB 11+ |
| Python | 3.10+（只影响语音识别 / 合成 / 表情识别） |
| 浏览器 | Chrome / Edge（树莓派用 Chromium） |
| 磁盘 | 代码 + 模型约 250 MB；另需 MySQL 数据空间 |

不装 Python 也能启动：对话、账号、家人端都正常，只是没有本机语音和表情识别。

---

## 2. Windows 安装

### 2.1 安装 Node.js

安装 Node.js 20 以上版本，确认：

```bat
node -v
npm -v
```

### 2.2 安装 MySQL

两种方式任选：

**A. 已经有 MySQL 服务**

启动 MySQL，确认 `127.0.0.1:3306` 可连接。

**B. 使用便携版 MySQL**

把 MySQL 解压到下面的路径（`start.ps1` 会自动识别）：

```
D:\mysql\mysql-8.0.46-winx64
```

如果你装在别的路径，请手动启动 MySQL 服务或 `mysqld`，不要依赖 `start.bat` 自动启动。

### 2.3 初始化数据库

在项目根目录执行：

```bat
mysql -u root -p < scripts\setup-mysql.sql
```

这个脚本会创建：

- 数据库 `seyo`
- 应用账号 `seyo`（密码在脚本里，先改掉）
- 每个账号自动建的 `seyo_u_*` 库所需权限

如果直接使用 `root` 账号，也可以只建库：

```sql
CREATE DATABASE IF NOT EXISTS seyo
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;
```

### 2.4 复制配置

```bat
mkdir data
copy config\mysql.example.json data\mysql.json
copy config\llm.example.json data\llm.json
copy config\vision.example.json data\vision.json
```

然后编辑 `data\mysql.json`，填入 MySQL 地址、账号和密码：

```json
{
  "host": "127.0.0.1",
  "port": 3306,
  "user": "seyo",
  "password": "你在 SQL 里设置的密码",
  "database": "seyo",
  "prefix": "seyo_u_"
}
```

`data\llm.json` 填大模型接口。支持 DeepSeek、任何 OpenAI 兼容接口、本地 Ollama：

```json
{
  "baseUrl": "https://api.deepseek.com/v1",
  "model": "deepseek-chat",
  "apiKey": "你的 key",
  "temperature": 0.9,
  "maxTokens": 300,
  "timeoutMs": 25000
}
```

没有 `apiKey` 时，程序会退回内置规则引擎，能跑，但对话质量会差一些。

### 2.5 安装 Node 依赖

```bat
npm install --omit=dev
```

### 2.6 安装 Python 语音依赖（可选）

```bat
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
```

程序会优先使用项目下的 `.venv`，不需要额外设置环境变量。  
没有装 Python 或依赖时，页面依然能打开，只是语音按钮不可用。

### 2.7 启动

```bat
start.bat
```

`start.bat` 会用独立浏览器配置打开 kiosk 全屏窗口：打开即全屏，查看端和对话端之间切换不会退出；用 `Alt+F4` 退出。

默认打开：

```
http://127.0.0.1:3789/
```

第一次使用先注册账号；一个账号对应一位老人和一套独立数据。

停止：

```bat
stop.bat
```

---

## 3. 树莓派安装

树莓派 5 / 64 位 Raspberry Pi OS 的安装步骤、systemd、Chromium kiosk、虚拟键盘和语音服务说明见：

```
deploy/pi/README.md
```

简要流程：

```bash
sudo apt install mariadb-server python3-venv
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
npm install --omit=dev
```

把 `config/mysql.example.json` 复制成 `data/mysql.json`，然后配置 systemd 服务：

```ini
[Service]
WorkingDirectory=/opt/seyo
Environment=HOST=0.0.0.0
Environment=PORT=3789
ExecStart=/usr/bin/node src/server.mjs
```

---

## 4. 模型和路径

完整发行包已经包含下面这些模型；从 GitHub 克隆仓库时，`model/` 被 `.gitignore` 排除，需要单独放到对应路径。

| 用途 | 路径 | 是否必需 |
|---|---|---|
| 中文语音识别（Vosk） | `model/asr/vosk-model-small-cn-0.22/` | 语音输入时需要 |
| 中文语音合成（sherpa-onnx） | `model/tts/vits-zh-hf-fanchen-wnj/` | 本机神经网络语音时需要 |
| 3D 数字人 | `public/models/seyo.vrm` | 可选，缺失时用 2D 形象 |
| 摄像头表情模型 | `data/vision.json` 里的 `modelDir` | 可选 |

语音识别 / 合成模型文件较大，不提交到 Git 仓库。  
GitHub 上请把完整包作为 **Release 附件** 上传，而不是直接提交进仓库。

---

## 5. 配置文件

所有本地配置都在 `data/` 目录：

| 文件 | 作用 |
|---|---|
| `data/mysql.json` | MySQL 地址、账号、密码、库名 |
| `data/llm.json` | 对话大模型接口 |
| `data/vision.json` | 摄像头表情识别开关和模型路径 |

`data/` 已被 `.gitignore` 排除，不会上传到 GitHub。  
`data/llm.json` 里有 API key，**不要提交、不要发给别人**。

常用环境变量：

```bat
set HOST=0.0.0.0
set PORT=3789
set SEYO_PYTHON=C:\path\to\python.exe
```

---

## 6. GitHub 上传说明

仓库里不会包含：

- `data/`（账号、API key、上传照片等）
- `model/`（大模型文件）
- `node_modules/`
- 各类备份 zip

可以直接：

```bash
git add -A
git commit -m "init"
git remote add origin <你的仓库地址>
git push -u origin master
```

模型和完整运行包单独放在 GitHub Releases：

```text
seyo-complete-YYYYMMDD.zip
```

下载后解压，按第 2 节配置 MySQL，即可运行。

---

## 7. 常见问题

**启动后一直提示数据库连不上**

- 确认 MySQL 服务已启动
- 确认 `data/mysql.json` 的账号密码正确
- 确认 `3306` 端口没有被其他程序占用
- 用 `mysql -u seyo -p -h 127.0.0.1` 手动试一下

**页面能打开，但没有声音**

- 先确认浏览器没有静音
- 检查 Python 环境和 `requirements.txt` 是否安装成功
- 检查 `model/asr`、`model/tts` 路径下的模型是否完整

**我想用本地大模型**

把 `data/llm.json` 的 `baseUrl` 改成 Ollama 或其他本地 OpenAI 兼容服务地址，例如：

```json
{
  "baseUrl": "http://127.0.0.1:11434/v1",
  "model": "qwen2.5:7b",
  "apiKey": "ollama"
}
```

模型文件本身由 Ollama 管理，不在本项目仓库里。
