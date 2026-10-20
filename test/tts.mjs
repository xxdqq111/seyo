// 验「说话」这条链路：本机神经网络 TTS（默认）能不能真的出声。
//   · 设置里有引擎切换，默认是"本机神经网络"
//   · 说话时会真的去 POST /api/say 拿 WAV（用服务端的调用计数验证）
//   · 拿到 WAV 会创建 <audio> 并 play()
//   · 切到"系统语音"会走 speechSynthesis
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://127.0.0.1:3789';
const PORT = 9348;
const profile = mkdtempSync(join(tmpdir(), 'seyo-tts-'));

const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--no-first-run', '--autoplay-policy=no-user-gesture-required',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
  '--window-size=1400,1000', '--hide-scrollbars', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function target() {
  for (let i = 0; i < 40; i++) {
    try {
      const j = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = j.find((t) => t.type === 'page');
      if (p?.webSocketDebuggerUrl) return p.webSocketDebuggerUrl;
    } catch { /* 等 */ }
    await sleep(500);
  }
  throw new Error('调试端口没起来');
}

function cdp(ws) {
  let id = 0;
  const wait = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); }
  });
  return (method, params = {}) => new Promise((res, rej) => {
    const my = ++id;
    wait.set(my, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
    ws.send(JSON.stringify({ id: my, method, params }));
  });
}

const ttsCalls = async () => {
  const st = await (await fetch(BASE + '/api/say')).json();
  return { calls: st.health?.calls ?? 0, ready: !!st.health?.ready, running: !!st.running };
};

let bad = 0;
const chk = (cond, label) => {
  console.log(`  ${cond ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${label}`);
  if (!cond) bad += 1;
};

try {
  console.log('  服务端：');
  const st0 = await ttsCalls();
  chk(st0.running || st0.ready, `本机 TTS 服务在跑（已合成 ${st0.calls} 次）`);

  const ws = new WebSocket(await target());
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  const send = cdp(ws);
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: BASE + '/' });
  await sleep(6000);
  const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;

  console.log('\n  设置里的引擎选择：');
  chk(await ev(`!!document.getElementById('ttsSel')`), '有「用什么念」下拉框');
  chk((await ev(`document.getElementById('ttsSel').value`)) === 'local', '★ 默认是「本机神经网络」');
  const opts = await ev(`[...document.getElementById('ttsSel').options].length`);
  chk(opts === 2, `两个选项（本机神经网络 / 系统语音）`);

  console.log('\n  真的走本机合成了吗：');
  // 打桩记录：<audio> 有没有被创建、src 是不是 blob
  await ev(`window.__audioProbe = null;
    const _A = window.Audio;
    window.Audio = function (src) {
      const a = new _A(src);
      window.__audioProbe = { src: String(src).slice(0, 20) };
      return a;
    };
    window.Audio.prototype = _A.prototype;
    true`);
  const before = (await ttsCalls()).calls;
  await ev(`speak('爷爷，这是测试。')`);
  await sleep(4000);
  const after = (await ttsCalls()).calls;
  chk(after > before, `★ 说话时真的调了本机合成（${before} → ${after} 次）`);
  const probe = JSON.parse(await ev(`JSON.stringify(window.__audioProbe)`));
  chk(probe && probe.src.startsWith('blob:'), `拿到 WAV 后建了 <audio>（src=${probe && probe.src}）`);
  chk(await ev(`S.ttsMs > 0`), `记录了合成耗时 ${await ev(`S.ttsMs`)} ms`);
  chk(await ev(`document.getElementById('ttsSel').value === 'local'`), '「用什么念」下拉框仍选着本机神经网络');

  console.log('\n  切到系统语音：');
  await ev(`(() => { const s = document.getElementById('ttsSel'); s.value = 'system';
      s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await sleep(600);
  chk((await ev(`localStorage.getItem('seyo.tts')`)) === 'system', '切到系统语音并记住');
  const before2 = (await ttsCalls()).calls;
  await ev(`speak('爷爷，这是系统语音。')`);
  await sleep(2500);
  chk((await ttsCalls()).calls === before2, '★ 走系统语音时不再调本机合成（省 CPU）');

  // 切回默认
  await ev(`(() => { const s = document.getElementById('ttsSel'); s.value = 'local';
      s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await sleep(2500);
  chk((await ev(`localStorage.getItem('seyo.tts')`)) === 'local', '切回本机神经网络');

  console.log(`\n  ${bad === 0 ? '\x1b[32m全部通过\x1b[0m' : `\x1b[31m失败 ${bad} 项\x1b[0m`}`);
  if (bad) process.exitCode = 1;
} finally {
  chrome.kill();
  await sleep(800);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}
