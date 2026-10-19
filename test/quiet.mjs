// 验「🤝 只想有人陪」= 安静模式：
// 按钮真的把状态传到服务端（不然守望照样开口），刷新之后还记得，
// 而且回一句话不会把模式悄悄关掉。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://127.0.0.1:3789';
const PORT = 9337;
const profile = mkdtempSync(join(tmpdir(), 'seyo-quiet-'));

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
const serverCompanion = async () => (await (await fetch(BASE + '/api/watch/state')).json()).config.companion;

try {
  const ws = new WebSocket(await target());
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  const send = cdp(ws);
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Browser.grantPermissions', { permissions: ['audioCapture', 'videoCapture'] });

  // 先确保是关着的
  await fetch(BASE + '/api/watch/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ companion: false }),
  });

  await send('Page.navigate', { url: BASE + '/' });
  await sleep(6000);
  const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.value;

  console.log('  安静模式：');
  chk((await serverCompanion()) === false, '一开始没开');
  chk(await ev(`document.getElementById('quietBtn').textContent.includes('安静模式')`), '按钮文案是「安静模式」');

  await ev(`document.getElementById('quietBtn').click()`);
  await sleep(2500);
  chk((await serverCompanion()) === true, '★ 点一下 → 服务端立刻知道（守望从此不主动开口）');
  chk(await ev(`document.getElementById('quietBtn').textContent.includes('开着')`),
    `按钮变成「${await ev(`document.getElementById('quietBtn').textContent`)}」`);
  chk((await ev(`localStorage.getItem('seyo.quiet')`)) === '1', '记在本地了');

  // 服务端真的不开口
  const d = await (await fetch(BASE + '/api/watch/state')).json();
  chk(d.due.speak === false && String(d.due.reason).includes('安静模式'),
    `★ 服务端判定：${d.due.reason}`);

  // 他在安静模式下说一句话 —— 岁语应该照常回，而且模式不能被关掉
  await ev(`(() => { const i = document.getElementById('input'); i.value = '我年轻时候在国棉三厂上班';
      i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await ev(`document.getElementById('sendBtn').click()`);
  await sleep(12000);
  const bubbles = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('#bubbles .bubble')].map(b => b.textContent))`));
  chk(bubbles.length >= 2, '★ 老人自己开口 → 岁语照常回话');
  chk((await serverCompanion()) === true, '★ 回完话，安静模式还在（没被覆盖掉）');
  chk(await ev(`document.getElementById('quietBtn').classList.contains('on')`), '按钮还亮着');

  // 刷新看记不记得
  await send('Page.navigate', { url: BASE + '/' });
  await sleep(5000);
  chk(await ev(`localStorage.getItem('seyo.quiet')`) === '1', '刷新之后本地还记着');
  chk(await ev(`document.getElementById('quietBtn').classList.contains('on')`), '★ 刷新之后按钮还是亮的');

  // 关掉
  await ev(`document.getElementById('quietBtn').click()`);
  await sleep(2500);
  chk((await serverCompanion()) === false, '★ 再点一下 → 关掉，恢复主动关心');

  console.log('\n  页面上的对话：');
  for (const b of bubbles) console.log('    · ' + b);

  console.log(`\n  ${bad === 0 ? '\x1b[32m全部通过\x1b[0m' : `\x1b[31m失败 ${bad} 项\x1b[0m`}`);
} finally {
  chrome.kill();
  await sleep(800);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}
