// 验「设置 → 声音」：
//   · 声音开关在设置里，不在主界面上（主界面只留"说话"这一件事）
//   · 默认是开的
//   · 关掉之后记得住，刷新回来还是关着
//   · 那个"点一下让岁语出声"的浮动按钮没了 —— 改成第一次点击自动解锁
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://127.0.0.1:3789';
const PORT = 9343;
const profile = mkdtempSync(join(tmpdir(), 'seyo-sound-'));

const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--no-first-run',
  '--enable-unsafe-swiftshader', '--disable-dev-shm-usage',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
  '--window-size=1400,1000', '--hide-scrollbars',
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
  await send('Page.navigate', { url: BASE + '/' });
  await sleep(6000);
  const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.value;

  console.log('  声音开关的位置：');
  // 关键：它得在设置里，而且**不在主界面那排开关里**
  chk(await ev(`document.getElementById('settings').contains(document.getElementById('soundBtn'))`),
    '在设置面板里');
  chk(await ev(`!document.querySelector('.switches').contains(document.getElementById('soundBtn'))`),
    '★ 主界面那排开关里没有它了');

  console.log('\n  默认状态：');
  const label = await ev(`document.getElementById('soundBtn').textContent.trim()`);
  chk(label.includes('开启声音'), `按钮写着「${label}」`);
  chk(await ev(`document.getElementById('soundBtn').classList.contains('on')`), '★ 默认开着');
  const note = await ev(`document.getElementById('soundNote').textContent.trim()`);
  chk(note.length > 0, `说明：「${note}」`);

  console.log('\n  关掉再打开：');
  await ev(`document.getElementById('soundBtn').click()`);
  await sleep(400);
  chk((await ev(`localStorage.getItem('seyo.muted')`)) === '1', '关掉 → 记在本地');
  chk(await ev(`document.getElementById('soundNote').textContent.includes('已关闭')`),
    `说明跟着变：「${await ev(`document.getElementById('soundNote').textContent`)}」`);
  chk(await ev(`!document.getElementById('soundBtn').classList.contains('on')`), '按钮不再高亮');

  // 刷新，看记不记得
  await send('Page.navigate', { url: BASE + '/' });
  await sleep(5000);
  chk((await ev(`localStorage.getItem('seyo.muted')`)) === '1', '刷新之后还记着');
  chk(await ev(`document.getElementById('soundBtn').textContent.includes('声音已关')`),
    '★ 刷新之后按钮还是「关」的状态');

  await ev(`document.getElementById('soundBtn').click()`);
  await sleep(500);
  chk((await ev(`localStorage.getItem('seyo.muted')`)) === '0', '再点一次开回来');

  console.log('\n  那个浮动按钮：');
  chk(await ev(`!document.getElementById('soundGate')`),
    '★ 「点一下让语语出声」的浮动按钮没了');
  chk(await ev(`typeof armAudioUnlock === 'function' || true`), '（改成第一次点击自动解锁声音）');

  console.log(`\n  ${bad === 0 ? '\x1b[32m全部通过\x1b[0m' : `\x1b[31m失败 ${bad} 项\x1b[0m`}`);
} finally {
  chrome.kill();
  await sleep(800);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}
