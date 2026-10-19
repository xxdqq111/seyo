/**
 * 本地语音识别服务的管理器
 * ==========================================================================
 * 跟 fer.mjs 一个套路，但管的是 Vosk：
 *   · 找到装了 vosk 的那个 Python
 *   · 把 model/asr_service.py 拉起来（懒加载：第一次要用才启动）
 *   · 等它就绪，转发录音
 *   · Node 退出时一起收掉
 *
 * 为什么不用浏览器自带的 SpeechRecognition：
 *   那个会把录音传到 Google / 微软的服务器。老人家里说的话不该寄到外面转一圈，
 *   而且断网就不能用。Vosk 是纯本地的 —— 录完直接在本机转文字。
 * ========================================================================== */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, DATA_DIR, log } from './util.mjs';

const SERVICE = path.join(ROOT, 'model', 'asr_service.py');
const LOG_FILE = path.join(DATA_DIR, 'asr.log');
const FILE = path.join(DATA_DIR, 'asr.json');

/** Vosk 中文小模型（42 MB）放这儿；大模型 1.3 GB，树莓派扛不住 */
export const DEFAULT_MODEL_DIR = path.join(ROOT, 'model', 'asr', 'vosk-model-small-cn-0.22');

const DEFAULTS = {
  enabled: true,
  asrPort: 3792,
  asrModelDir: DEFAULT_MODEL_DIR,
  python: '',              // 留空就自动找装了 vosk 的那个
};

export function asrConfig() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { /* 第一次跑，没文件 */ }
  return { ...DEFAULTS, ...saved };
}

export function saveAsrConfig(patch = {}) {
  const next = { ...asrConfig(), ...patch };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

let pythonBin = null;
let proc = null;
let starting = null;
let lastError = '';

/** 候选 Python：能 import vosk 的那个 */
export function pythonCandidates(configured = '') {
  const list = [];
  if (configured) list.push(configured);
  list.push(
    process.env.SEYO_PYTHON || '',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python312', 'python.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python311', 'python.exe'),
    'python',
    'python3',
  );
  return [...new Set(list.filter(Boolean))];
}

export function probePython(configured = '') {
  if (pythonBin) return Promise.resolve(pythonBin);
  const cands = pythonCandidates(configured);
  return new Promise((resolve) => {
    let i = 0;
    const next = () => {
      if (i >= cands.length) { lastError = '找不到装了 vosk 的 Python（pip install vosk）'; resolve(null); return; }
      const bin = cands[i++];
      let out = '';
      let done = false;
      let p;
      try {
        p = spawn(bin, ['-c', 'import vosk;print("ok")'], { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch { next(); return; }
      const finish = (ok) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { p.kill(); } catch { /* ignore */ }
        if (ok) { pythonBin = bin; log(`本地语音识别：用 ${bin}`); resolve(bin); }
        else next();
      };
      const timer = setTimeout(() => finish(false), 20000);
      p.stdout.on('data', (d) => { out += d; });
      p.on('error', () => finish(false));
      p.on('exit', (code) => finish(code === 0));
    };
    next();
  });
}

export function isRunning() { return Boolean(proc && !proc.killed); }

export async function asrHealth(port, timeoutMs = 2500) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: ctl.signal });
    clearTimeout(t);
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

/**
 * 确保服务在跑。第一次调用会启动（加载模型要几秒），之后直接用。
 * @returns {Promise<{ok:boolean, health?:object, error?:string}>}
 */
export async function ensureAsr(cfg = {}) {
  const port = Number(cfg.asrPort) || 3792;
  const modelDir = String(cfg.asrModelDir || DEFAULT_MODEL_DIR);
  const py = String(cfg.python || '');

  if (isRunning()) {
    const h = await asrHealth(port);
    if (h) return { ok: true, health: h };
  }
  if (starting) return starting;

  if (!fs.existsSync(SERVICE)) return { ok: false, error: `找不到 ${SERVICE}` };
  if (!fs.existsSync(modelDir)) {
    return { ok: false, error: `找不到语音模型：${modelDir}（下载 vosk-model-small-cn-0.22 解压到那儿）` };
  }

  starting = (async () => {
    try {
      if (!isRunning()) {
        const bin = await probePython(py);
        if (!bin) return { ok: false, error: lastError || '找不到装了 vosk 的 Python' };

        fs.mkdirSync(DATA_DIR, { recursive: true });
        const fd = fs.openSync(LOG_FILE, 'a');
        log(`启动本地语音识别服务：${path.basename(bin)} asr_service.py --port ${port}`);
        proc = spawn(bin, [SERVICE, '--port', String(port), '--model-dir', modelDir], {
          cwd: ROOT,
          stdio: ['ignore', fd, fd],   // 输出写 data/asr.log（管道在沙箱下会被拒）
          windowsHide: true,
        });
        proc.on('exit', (code) => {
          log(`本地语音识别服务退出（code ${code}），需要时会重新拉起`);
          proc = null;
        });
        proc.on('error', (e) => { lastError = e.message; proc = null; });
      }

      // 等它就绪：加载 Vosk 模型一般 2~5 秒，给 60 秒余量
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 400));
        const h = await asrHealth(port);
        if (h) {
          if (h.ready) { log('本地语音识别服务就绪'); return { ok: true, health: h }; }
          if (h.error) return { ok: false, error: h.error, health: h };
        }
        if (!proc) return { ok: false, error: lastError || '进程起不来，看 data/asr.log' };
      }
      return { ok: false, error: '等了 60 秒还没就绪，看 data/asr.log' };
    } finally {
      starting = null;
    }
  })();

  return starting;
}

/**
 * 把一段录音转成文字。
 * @param {string} pcmB64 16 位小端、单声道、16 kHz 的裸 PCM（base64）
 */
export async function listen(cfg = {}, pcmB64, rate = 16000) {
  const port = Number(cfg.asrPort) || 3792;
  const up = await ensureAsr(cfg);
  if (!up.ok) return { ok: false, error: up.error };

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 60000);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/listen`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pcm: pcmB64, rate: Number(rate) || 16000 }),
      signal: ctl.signal,
    });
    const r = await res.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: r.error || `HTTP ${res.status}` };
    return r;
  } catch (e) {
    return { ok: false, error: e?.name === 'AbortError' ? '识别超时' : String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

/** Node 退出时一起收掉 */
export function stopAsr() {
  if (proc) {
    try { proc.kill(); } catch { /* ignore */ }
    proc = null;
  }
}

export function asrDebug() {
  return { python: pythonBin, running: isRunning(), error: lastError, pid: proc?.pid || null };
}
