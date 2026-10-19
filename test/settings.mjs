// 验设置面板：默认收起、齿轮能开、点外面/Esc 能关、
// 摄像头和内部过程确实都在里面（不在主界面上了）。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://127.0.0.1:3789';
const PORT = 9336;
const profile = mkdtempSync(join(tmpdir(), 'seyo-set-'));

const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--no-first-run',
  '--enable-unsafe-swiftshader', '--disable-dev-shm-usage',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
  '--window-size=1400,1000', '--hide-scrollbars',
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  'about:blank',
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

let bad = 0;
const chk = (cond, label) => {
  console.log(`  ${cond ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${label}`);
  if (!cond) bad += 1;
};

try {
  const ws = new WebSocket(await target());
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  const send = cdp(ws);
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Browser.grantPermissions', { permissions: ['audioCapture', 'videoCapture'] });
  await send('Page.navigate', { url: BASE + '/' });
  await sleep(7000);

  const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.value;

  console.log('  设置面板：');
  chk(await ev(`document.getElementById('settings').hidden === true`), '一开始是收起的（不挡老人）');
  chk(await ev(`!!document.getElementById('gearBtn')`), '右上角有齿轮');

  // 主界面上不该再有摄像头和内部过程
  const strayCam = await ev(`(() => { const b = document.getElementById('camBtn');
      return b ? !document.getElementById('settings').contains(b) : false; })()`);
  chk(strayCam === false, '摄像头按钮在设置里，不在主界面上');
  const strayInside = await ev(`(() => { const b = document.getElementById('insideBtn');
      return b ? !document.getElementById('settings').contains(b) : false; })()`);
  chk(strayInside === false, '内部过程在设置里，不在主界面上');

  await ev(`document.getElementById('gearBtn').click()`);
  await sleep(500);
  chk(await ev(`document.getElementById('settings').hidden === false`), '点齿轮 → 打开');
  chk(await ev(`document.getElementById('gearBtn').getAttribute('aria-expanded') === 'true'`), '齿轮状态跟着变');

  await ev(`document.getElementById('settingsClose').click()`);
  await sleep(300);
  chk(await ev(`document.getElementById('settings').hidden === true`), '点 ✕ → 收起');

  await ev(`document.getElementById('gearBtn').click()`);
  await sleep(300);
  await ev(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
  await sleep(300);
  chk(await ev(`document.getElementById('settings').hidden === true`), '点面板外面 → 收起');

  await ev(`document.getElementById('gearBtn').click()`);
  await sleep(300);
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await sleep(300);
  chk(await ev(`document.getElementById('settings').hidden === true`), '按 Esc → 收起');

  console.log('\n  摄像头默认打开：');
  // 等自动开摄像头的定时器跑完
  await sleep(4000);
  const cam = await ev(`JSON.stringify({
    on: !!window.__camProbe, text: document.getElementById('camBtn').textContent,
    note: document.getElementById('camNote').textContent,
    ls: localStorage.getItem('seyo.camera'),
  })`);
  const c = JSON.parse(cam);
  chk(c.text.includes('开') && !c.text.includes('关'), `摄像头自动开了（"${c.text}"）`);
  console.log(`      说明：${c.note}`);

  console.log(`\n  ${bad === 0 ? '\x1b[32m全部通过\x1b[0m' : `\x1b[31m失败 ${bad} 项\x1b[0m`}`);
} finally {
  chrome.kill();
  await sleep(800);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}
