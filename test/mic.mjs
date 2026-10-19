// 端到端验"按住说话"：拿一个 WAV 假装麦克风，
// 用 CDP 真的按下/松开话筒按钮，看它认出了什么、有没有进对话。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://127.0.0.1:3789';
const PORT = 9334;
// 有传 WAV 就试着拿它当麦克风（注意：--headless=new 下 Chrome 不认这个参数，
// 录到的会是静音）。不传就用 Chrome 自带的假麦克风（有哔声）——
// 那个能证明"录音 → 重采样 → POST"这条链路确实有声音在走。
const WAV = process.argv[2] || '';
const profile = mkdtempSync(join(tmpdir(), 'seyo-asr-'));

if (WAV && !existsSync(WAV)) { console.error(`  找不到测试音频：${WAV}`); process.exitCode = 1; }

const audioFlags = WAV
  ? ['--use-file-for-fake-audio-capture=' + WAV]
  : [];
const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--no-first-run',
  '--enable-unsafe-swiftshader', '--disable-dev-shm-usage',
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${PORT}`,
  '--window-size=1200,1000',
  // 拿文件或内置信号假装成麦克风，这样无头浏览器也能"说话"
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  ...audioFlags,
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function target() {
  for (let i = 0; i < 40; i++) {
    try {
      const j = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = j.find((t) => t.type === 'page');
      if (p?.webSocketDebuggerUrl) return p.webSocketDebuggerUrl;
    } catch { /* 还没起来 */ }
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

try {
  const ws = new WebSocket(await target());
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  const send = cdp(ws);
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Browser.grantPermissions', { permissions: ['audioCapture'] });

  await send('Page.navigate', { url: BASE + '/' });
  await sleep(6000);            // 等页面起来 + 首字问候

  const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.value;

  // 模拟按住话筒 4 秒
  console.log('  按下话筒…');
  await ev(`(() => { const b = document.getElementById('micBtn');
      b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return true; })()`);
  await sleep(4000);
  console.log('  松开…');
  await ev(`(() => { const b = document.getElementById('micBtn');
      b.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); return true; })()`);

  await sleep(9000);            // 等识别 + 岁语回话

  const out = await ev(`JSON.stringify({
    bubbles: [...document.querySelectorAll('#bubbles .bubble')].map(b => b.textContent),
    status: document.getElementById('statusText')?.textContent || '',
    mic: document.getElementById('micText')?.textContent || '',
  })`);
  const o = JSON.parse(out);
  console.log('\n  页面上的对话：');
  for (const b of o.bubbles) console.log('    · ' + b);
  console.log(`\n  状态栏：${o.status}`);
  console.log(`  话筒：${o.mic}`);

  const st = await (await fetch(BASE + '/api/listen')).json();
  console.log(`\n  语音服务：运行中=${st.running}  模型=${st.health?.model_name || '—'}  调用=${st.health?.calls ?? 0} 次`);
  if (st.health?.last) {
    console.log(`  最近一次识别： "${st.health.last.text}"  （音频 ${st.health.last.audio_ms}ms → ${st.health.last.ms}ms）`);
  }
} finally {
  chrome.kill();
  await sleep(800);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}
