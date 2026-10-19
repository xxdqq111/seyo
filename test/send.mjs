// 验输入框 + 按钮的联动：没字时灰着按不动，写了字才亮，按下去才真发出去。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://127.0.0.1:3789';
const PORT = 9335;
const profile = mkdtempSync(join(tmpdir(), 'seyo-send-'));

const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--no-first-run',
  '--enable-unsafe-swiftshader', '--disable-dev-shm-usage',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
  '--window-size=1200,1000', 'about:blank',
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

const ok = (cond, label) => console.log(`  ${cond ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${label}`);
let bad = 0;
const chk = (cond, label) => { ok(cond, label); if (!cond) bad += 1; };

try {
  const ws = new WebSocket(await target());
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  const send = cdp(ws);
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: BASE + '/' });
  await sleep(5000);

  const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.value;

  console.log('  输入框与发送按钮的联动：');
  chk(await ev(`document.getElementById('sendBtn').disabled === true`), '一开始没字 → 灰着');
  // 文案不锁死 —— 它是产品措辞，随时会改；这里只确认它不是空的
  const label = await ev(`document.getElementById('sendBtn').textContent.trim()`);
  chk(label.length > 0, `按钮有文案（「${label}」）`);

  // 打几个字
  await ev(`(() => { const i = document.getElementById('input'); i.value = '我年轻时候住在东四';
      i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  chk(await ev(`document.getElementById('sendBtn').disabled === false`), '★ 写了字 → 亮起来');

  // 清空
  await ev(`(() => { const i = document.getElementById('input'); i.value = '';
      i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  chk(await ev(`document.getElementById('sendBtn').disabled === true`), '清空 → 又灰回去');

  // 写一句真的发出去
  const before = await ev(`document.querySelectorAll('#bubbles .bubble').length`);
  await ev(`(() => { const i = document.getElementById('input'); i.value = '我年轻时候在国棉三厂上班';
      i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await ev(`document.getElementById('sendBtn').click()`);
  await sleep(12000);

  const after = await ev(`JSON.stringify([...document.querySelectorAll('#bubbles .bubble')].map(b => b.textContent))`);
  const list = JSON.parse(after);
  console.log('\n  页面上的对话：');
  for (const b of list) console.log('    · ' + b);
  chk(list.length > before, '★ 按下去真的发出去了（多了气泡）');

  console.log(`\n  ${bad === 0 ? '\x1b[32m全部通过\x1b[0m' : `\x1b[31m失败 ${bad} 项\x1b[0m`}`);
} finally {
  chrome.kill();
  await sleep(800);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}
