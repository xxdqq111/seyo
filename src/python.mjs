/**
 * 本机 Python 探测 + 本地服务健康检查
 * ==========================================================================
 * 表情（fer）、语音识别（asr）、语音合成（tts）三个模块原来各抄了一份：
 *   · pythonCandidates()   找候选 Python 路径
 *   · probePython()        挨个试 import，看哪个装了依赖
 *   · xxxHealth()          调一次 /health 看服务活着没
 * 三段几乎一模一样，只是 import 的模块名和日志文案不同。现在合成这一份。
 *
 * 注意两点：
 *   ① 探测结果按 **依赖组合** 缓存（不是全局一个）—— 万一机器上有两个 Python，
 *      一个装了 vosk、另一个装了 torch，不能互相顶替。
 *   ② 探测只用退出码，**不开管道**：某些受限运行环境（DSH 沙箱、服务化运行）
 *      不允许子进程开 pipe，`stdio:'pipe'` 会直接 EPERM，导致明明装了 torch 也找不到。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { ROOT, log } from './util.mjs';

/** 候选 Python：显式配置优先，其次 SEYO_PYTHON，再到项目 .venv、常见安装位置，最后 PATH 里的 */
export function pythonCandidates(configured = '') {
  const list = [];
  if (configured) list.push(configured);
  list.push(
    process.env.SEYO_PYTHON || '',
    path.join(ROOT, '.venv', 'Scripts', 'python.exe'),
    path.join(ROOT, '.venv', 'bin', 'python'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python312', 'python.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python311', 'python.exe'),
    'python',
    'python3',
  );
  return [...new Set(list.filter(Boolean))];
}

const found = new Map();     // "torch" → python 路径
const errors = new Map();    // "torch" → 找不到时的说明

/** 上次探测失败的原因（给 ensure* 拼错误信息用） */
export function pythonProbeError(imports = []) {
  return errors.get(imports.join(',')) || '';
}

/**
 * 找一个能 import 指定依赖的 Python。
 * @param {object} o
 * @param {string}   o.configured  配置里指定的 python
 * @param {string[]} o.imports     要 import 的模块（如 ['torch'] / ['vosk'] / ['sherpa_onnx']）
 * @param {string}   o.label       日志前缀（"本地表情模型"…）
 * @param {string}   o.hint        失败提示补充（"（pip install vosk）"…）
 * @param {number}   o.timeoutMs   每个候选等多久
 * @returns {Promise<string|null>}
 */
export function probePython({
  configured = '', imports = [], label = '本地服务', hint = '', timeoutMs = 20000,
} = {}) {
  const key = imports.join(',');
  if (found.has(key)) return Promise.resolve(found.get(key));
  const cands = pythonCandidates(configured);
  return new Promise((resolve) => {
    let i = 0;
    const next = () => {
      if (i >= cands.length) {
        errors.set(key, `找不到装了 ${imports.join(' / ')} 的 Python${hint}`);
        resolve(null);
        return;
      }
      const bin = cands[i++];
      let done = false;
      let p;
      const code = `import ${imports.join(',')};print("ok")`;
      try {
        p = spawn(bin, ['-c', code], { stdio: 'ignore' });
      } catch { next(); return; }
      const finish = (ok) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { p.kill(); } catch { /* ignore */ }
        if (ok) {
          found.set(key, bin);
          log(`${label}：用 ${bin}`);
          resolve(bin);
        } else next();
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      p.on('error', () => finish(false));
      p.on('exit', (code) => finish(code === 0));
    };
    next();
  });
}

/** 调一次本地服务的 /health（活着返回 json，否则 null） */
export async function serviceHealth(port, timeoutMs = 2500) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: ctl.signal });
    clearTimeout(t);
    return r.ok ? await r.json() : null;
  } catch { return null; }
}
