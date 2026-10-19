/**
 * 本地表情识别服务的管理器
 * ==========================================================================
 * 你自己训练的那个 FER 模型是 PyTorch 的，只能由 Python 跑。
 * 这个文件负责：
 *   · 找到装了 torch 的那个 Python
 *   · 把 model/fer_service.py 拉起来（懒加载：第一次要用才启动）
 *   · 等它就绪，然后转发请求
 *   · Node 退出时把它一起收掉
 *
 * 好处是：照片一个字节都不出这台机器。老人家里的画面不传任何云。
 * ========================================================================== */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, DATA_DIR, log } from './util.mjs';

const SERVICE = path.join(ROOT, 'model', 'fer_service.py');
const LOG_FILE = path.join(DATA_DIR, 'fer.log');

/** 候选 Python：优先显式配置，然后挨个试（要能 import torch） */
export function pythonCandidates(configured = '') {
  const list = [];
  if (configured) list.push(configured);
  list.push(
    process.env.SEYO_PYTHON || '',
    // 装了 torch 的那个（这台机器上就是它）
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python312', 'python.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python311', 'python.exe'),
    'python',
    'python3',
  );
  return [...new Set(list.filter(Boolean))];
}

let pythonBin = null;   // 探测结果缓存
let proc = null;        // 子进程
let starting = null;    // 正在启动中的 Promise（防止并发起两个）
let lastError = '';

/** 让候选 Python 跑一句 import torch，看谁行 */
export function probePython(configured = '') {
  if (pythonBin) return Promise.resolve(pythonBin);
  const cands = pythonCandidates(configured);
  return new Promise((resolve) => {
    let i = 0;
    const next = () => {
      if (i >= cands.length) { lastError = '找不到装了 torch 的 Python'; resolve(null); return; }
      const bin = cands[i++];
      let out = '';
      let done = false;
      let p;
      try {
        p = spawn(bin, ['-c', 'import torch;print(torch.__version__)'], { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch { next(); return; }
      const finish = (ok) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { p.kill(); } catch { /* ignore */ }
        if (ok) { pythonBin = bin; log(`本地表情模型：用 ${bin}（torch ${out.trim()}）`); resolve(bin); }
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

/** 调一次服务，看活着没 */
export async function ferHealth(port, timeoutMs = 2500) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: ctl.signal });
    clearTimeout(t);
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

/**
 * 确保服务在跑。第一次调用会启动，之后直接用。
 * @returns {Promise<{ok:boolean, health?:object, error?:string}>}
 */
export async function ensureFer(cfg) {
  const port = Number(cfg.ferPort) || 3791;
  const modelDir = String(cfg.modelDir || '');
  const py = String(cfg.python || '');

  if (isRunning()) {
    const h = await ferHealth(port);
    if (h) return { ok: true, health: h };
    // 进程还在但没响应 —— 多半是还在加载，等一等
  }
  if (starting) return starting;

  if (!modelDir) return { ok: false, error: '还没配模型目录（FRE_Classroom 那份代码在哪）' };
  if (!fs.existsSync(SERVICE)) return { ok: false, error: `找不到 ${SERVICE}` };
  if (!fs.existsSync(modelDir)) return { ok: false, error: `模型目录不存在：${modelDir}` };

  starting = (async () => {
    try {
      if (!isRunning()) {
        const bin = await probePython(py);
        if (!bin) return { ok: false, error: lastError || '找不到装了 torch 的 Python' };

        fs.mkdirSync(DATA_DIR, { recursive: true });
        const fd = fs.openSync(LOG_FILE, 'a');
        log(`启动本地表情服务：${path.basename(bin)} fer_service.py --port ${port}`);
        proc = spawn(bin, [SERVICE, '--port', String(port), '--model-dir', modelDir, '--warmup'], {
          cwd: ROOT,
          stdio: ['ignore', fd, fd],   // 输出写进 data/fer.log，不用管道（管道在某些沙箱下会被拒）
          windowsHide: true,
        });
        proc.on('exit', (code) => {
          log(`本地表情服务退出（code ${code}），需要时会重新拉起`);
          proc = null;
        });
        proc.on('error', (e) => { lastError = e.message; proc = null; });
      }

      // 等它就绪：模型加载 + 可能的下采样，最多等 90 秒
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 700));
        const h = await ferHealth(port);
        if (h) {
          if (h.ready) { log('本地表情服务就绪'); return { ok: true, health: h }; }
          if (h.error) return { ok: false, error: h.error, health: h };
        }
        if (!proc) return { ok: false, error: lastError || '进程起不来，看 data/fer.log' };
      }
      return { ok: false, error: '等了 90 秒还没就绪，看 data/fer.log' };
    } finally {
      starting = null;
    }
  })();

  return starting;
}


/**
 * 让本地模型看一帧。
 * @param {string} dataUrl data:image/jpeg;base64,...
 */
export async function ferLookAt(cfg, dataUrl) {
  const port = Number(cfg.ferPort) || 3791;
  const up = await ensureFer(cfg);
  if (!up.ok) return { level: 'normal', mood: 'normal', error: up.error };

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 60000);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/predict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: dataUrl }),
      signal: ctl.signal,
    });
    const r = await res.json().catch(() => ({}));
    if (!r.ok) return { level: 'normal', mood: 'normal', error: r.error || `HTTP ${res.status}` };
    return {
      level: r.mood,                 // low | normal | happy  → 直接就是岁语的心情三档
      mood: r.mood,
      face: r.face,
      faces: r.faces,
      box: r.box,                    // 人脸框 [x1,y1,x2,y2]，测试页要画
      imageSize: r.imageSize,
      brightness: r.brightness,
      flatness: r.flatness,
      reason: r.reason,
      expression: r.top,             // 7 类里的哪一个
      confidence: r.conf,
      expressions: r.expressions,
      why: r.why,                    // 判定依据（pSad / pNeg / pPos）—— 界面上要说明"为什么是这个心情"
      note: r.face ? `${r.top} ${Math.round(r.conf * 100)}%` : (r.reason || '没看到人脸'),
      ms: r.ms,
      local: true,
    };
  } catch (e) {
    return { level: 'normal', mood: 'normal', error: e?.name === 'AbortError' ? '推理超时' : String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

/** Node 退出时把它一起收掉，别留孤儿进程 */
export function stopFer() {
  if (proc) {
    try { proc.kill(); } catch { /* ignore */ }
    proc = null;
  }
}

export function ferDebug() {
  return { python: pythonBin, running: isRunning(), error: lastError, pid: proc?.pid || null };
}
