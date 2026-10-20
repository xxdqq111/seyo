/**
 * 本地语音合成服务的管理器
 * ==========================================================================
 * 跟 asr.mjs / fer.mjs 一个套路，管的是 sherpa-onnx 的 TTS：
 *   · 找装了 sherpa-onnx 的 Python
 *   · 把 model/tts_service.py 拉起来（懒加载：第一次要说话才启动）
 *   · 等它就绪，转发要合成的话，把 WAV 拿回来
 *   · Node 退出时一起收掉
 *
 * 为什么不用浏览器自带的 speechSynthesis：
 *   Windows 上能选的中文本地嗓音就 Huihui / Kangkang / Yaoyao 三个，
 *   全是 2010 年代的拼接语音，男声对了但音质很硬。
 *   这里用神经网络 TTS（中文男声），音质好一档，而且纯本地、断网可用。
 *
 * 前端还留着"系统语音"这个选项 —— 老机器跑不动的时候能切回去。
 * ========================================================================== */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, DATA_DIR, log } from './util.mjs';
import { probePython, pythonProbeError, serviceHealth } from './python.mjs';

const SERVICE = path.join(ROOT, 'model', 'tts_service.py');
const LOG_FILE = path.join(DATA_DIR, 'tts.log');
const FILE = path.join(DATA_DIR, 'tts.json');

/** 中文男声模型（115 MB）放这儿 */
export const DEFAULT_MODEL_DIR = path.join(ROOT, 'model', 'tts', 'vits-zh-hf-fanchen-wnj');

const DEFAULTS = {
  enabled: true,
  ttsPort: 3793,
  ttsModelDir: DEFAULT_MODEL_DIR,
  python: '',        // 留空就自动找装了 sherpa-onnx 的那个
  numThreads: 4,
  speed: 1.0,
};

export function ttsConfig() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { /* 第一次跑，没文件 */ }
  return { ...DEFAULTS, ...saved };
}

export function saveTtsConfig(patch = {}) {
  const next = { ...ttsConfig(), ...patch };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

let pythonBin = null;
let proc = null;
let starting = null;
let lastError = '';

/** 找一个能 import sherpa_onnx 的 Python（探测结果缓存） */
async function findPython(configured = '') {
  const bin = await probePython({ configured, imports: ['sherpa_onnx'], label: '本地语音合成', hint: '（pip install sherpa-onnx）', timeoutMs: 25000 });
  if (bin) pythonBin = bin;
  else lastError = pythonProbeError(['sherpa_onnx']) || '找不到装了 sherpa-onnx 的 Python';
  return bin;
}

export function isRunning() { return Boolean(proc && !proc.killed); }

export const ttsHealth = serviceHealth;

/**
 * 确保服务在跑。第一次调用会启动（加载 115 MB 的模型，要几秒），之后直接用。
 * @returns {Promise<{ok:boolean, health?:object, error?:string}>}
 */
export async function ensureTts(cfg = ttsConfig()) {
  const port = Number(cfg.ttsPort) || 3793;
  const modelDir = String(cfg.ttsModelDir || DEFAULT_MODEL_DIR);
  const py = String(cfg.python || '');

  if (isRunning()) {
    const h = await ttsHealth(port);
    if (h) return { ok: true, health: h };
  }
  if (starting) return starting;

  if (!fs.existsSync(SERVICE)) return { ok: false, error: `找不到 ${SERVICE}` };
  if (!fs.existsSync(modelDir)) {
    return { ok: false, error: `找不到语音模型：${modelDir}（下载 vits-zh-hf-fanchen-wnj 解压到那儿）` };
  }

  starting = (async () => {
    try {
      if (!isRunning()) {
        const bin = await findPython(py);
        if (!bin) return { ok: false, error: lastError || '找不到装了 sherpa-onnx 的 Python' };

        fs.mkdirSync(DATA_DIR, { recursive: true });
        const fd = fs.openSync(LOG_FILE, 'a');
        log(`启动本地语音合成服务：${path.basename(bin)} tts_service.py --port ${port}`);
        proc = spawn(bin, [SERVICE, '--port', String(port), '--model-dir', modelDir,
          '--num-threads', String(Number(cfg.numThreads) || 4)], {
          cwd: ROOT,
          stdio: ['ignore', fd, fd],   // 输出写 data/tts.log
          windowsHide: true,
        });
        proc.on('exit', (code) => {
          log(`本地语音合成服务退出（code ${code}），需要时会重新拉起`);
          proc = null;
        });
        proc.on('error', (e) => { lastError = e.message; proc = null; });
      }

      // 等它就绪：加载 115 MB 模型一般 3~8 秒，给 90 秒余量
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
        const h = await ttsHealth(port);
        if (h) {
          if (h.ready) { log('本地语音合成服务就绪'); return { ok: true, health: h }; }
          if (h.error) return { ok: false, error: h.error, health: h };
        }
        if (!proc) return { ok: false, error: lastError || '进程起不来，看 data/tts.log' };
      }
      return { ok: false, error: '等了 90 秒还没就绪，看 data/tts.log' };
    } finally {
      starting = null;
    }
  })();

  return starting;
}

/**
 * 把一句话合成成 WAV。
 * @returns {Promise<{ok:boolean, wav?:Buffer, ms?:number, audioMs?:number, error?:string}>}
 */
export async function synthesize(cfg, text, speed = 1.0) {
  const port = Number(cfg.ttsPort) || 3793;
  const up = await ensureTts(cfg);
  if (!up.ok) return { ok: false, error: up.error };

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 120000);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/say`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: String(text || ''), speed: Number(speed) || 1.0 }),
      signal: ctl.signal,
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      return { ok: false, error: j.error || `HTTP ${res.status}` };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      ok: true,
      wav: buf,
      ms: Number(res.headers.get('X-Seyo-Ms')) || 0,
      audioMs: Number(res.headers.get('X-Seyo-Audio-Ms')) || 0,
      chars: Number(res.headers.get('X-Seyo-Chars')) || 0,
    };
  } catch (e) {
    return { ok: false, error: e?.name === 'AbortError' ? '合成超时' : String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

/** Node 退出时一起收掉 */
export function stopTts() {
  if (proc) {
    try { proc.kill(); } catch { /* ignore */ }
    proc = null;
  }
}

export function ttsDebug() {
  return { python: pythonBin, running: isRunning(), error: lastError, pid: proc?.pid || null };
}
