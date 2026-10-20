// 验「吃药提醒」：
//   · 设定放在**家人查看端**（设定每天几点吃什么药）
//   · 老人端（展示端）快到点 / 到点弹提醒卡片
//   · 老人按「我吃过了」→ 这顿记成已吃，提醒消失
// 用法：先起服务，然后 node test/meds.mjs
// 环境变量：SEYO_BASE（默认 http://127.0.0.1:3789）
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.SEYO_BASE || 'http://127.0.0.1:3789';
const PORT = Number(process.env.SEYO_CDP_PORT || 9344);
const profile = mkdtempSync(join(tmpdir(), 'seyo-meds-'));

const get = async (p) => (await fetch(BASE + p)).json();
const del = async (p) => (await fetch(BASE + p, { method: 'DELETE' })).json();

// 先把之前的测试用药清掉
for (const m of (await get('/api/meds')).meds || []) await del('/api/meds/' + encodeURIComponent(m.id));

const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const dueTime = hhmm(new Date(now.getTime() - 2 * 60000));   // 已经过点 → due
const nearMidnight = (now.getHours() === 23 && now.getMinutes() >= 55) || (now.getHours() === 0 && now.getMinutes() < 5);

const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--no-first-run',
  '--enable-unsafe-swiftshader', '--disable-dev-shm-usage',
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
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
  const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.value;

  // ---------- 家人端：设定 ----------
  await send('Page.navigate', { url: BASE + '/family.html' });
  await sleep(5000);
  await ev(`localStorage.setItem('seyo.muted','1')`);   // 老人端也用同一个源，顺手静音，测试不拖 TTS
  chk(await ev(`Boolean(document.querySelector('#tabs button[data-tab="meds"]'))`), '家人端有「吃药提醒」页签');
  await ev(`document.querySelector('#tabs button[data-tab="meds"]').click()`);
  await sleep(1200);
  chk(!(await ev(`Boolean(document.getElementById('p-meds').hidden)`)), '点开就是吃药提醒面板');

  console.log('\n  家人端设定"每天几点吃什么药"：');
  await ev(`(() => {
    document.getElementById('medName').value = '降压药';
    document.getElementById('medDose').value = '1 片';
    document.getElementById('medTimes').value = '${dueTime}';
    document.getElementById('medNote').value = '饭后吃';
    document.getElementById('medAdd').click();
    return true;
  })()`);
  await sleep(1800);
  const listTxt = await ev(`document.getElementById('medList').textContent`);
  chk(/降压药/.test(listTxt) && /1 片/.test(listTxt) && /饭后吃/.test(listTxt), `设定里列出来了：${String(listTxt).replace(/\\s+/g, ' ').trim()}`);
  const todayTxt = await ev(`document.getElementById('medToday').textContent`);
  chk(/降压药/.test(todayTxt), '「今天的药」里有这一顿');
  if (!nearMidnight) chk(/到点|还没吃/.test(todayTxt), `今天状态标出了"到点还没吃"：${String(todayTxt).replace(/\\s+/g, ' ').trim().slice(0, 60)}`);

  // ---------- 老人端：到点提醒 ----------
  console.log('\n  老人端到点提醒：');
  await send('Page.navigate', { url: BASE + '/' });
  await sleep(6500);
  if (nearMidnight) {
    chk(true, '（正好在零点附近，跳过到点提醒断言）');
  } else {
    chk(await ev(`!document.getElementById('medRemind').hidden`), '★ 到点弹出吃药提醒');
    const remindTxt = await ev(`document.getElementById('medRemind').textContent`);
    chk(/降压药/.test(remindTxt) && /1 片/.test(remindTxt), `提醒上写着药名和剂量：${String(remindTxt).replace(/\\s+/g, ' ').trim().slice(0, 60)}`);
    chk(await ev(`!document.getElementById('medBar').hidden`), '主界面有"今天的药"');
    chk(/我吃过了/.test(String(remindTxt)), '有「我吃过了」按钮');

    console.log('\n  老人确认吃过：');
    await ev(`document.getElementById('medDoneBtn').click()`);
    await sleep(1500);
    chk(await ev(`document.getElementById('medRemind').hidden`), '★ 确认后提醒消失');
    const st = await get('/api/meds');
    chk((st.items || []).every((i) => i.state !== 'due'), '★ 服务端记成"这顿已吃"');
    chk(await ev(`!!document.querySelector('#medBar .med-state.done')`), '用药条上标了已吃（绿点）');
  }

  console.log(`\n  ${bad === 0 ? '\x1b[32m全部通过\x1b[0m' : `\x1b[31m失败 ${bad} 项\x1b[0m`}`);
} finally {
  // 清掉测试加的用药
  try {
    for (const m of (await get('/api/meds')).meds || []) {
      if (/降压药/.test(m.name)) await del('/api/meds/' + encodeURIComponent(m.id));
    }
  } catch { /* ignore */ }
  chrome.kill();
  await sleep(800);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}
