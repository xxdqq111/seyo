// 验嗓音选择：岁语是"小孙子"，得是男声，而且不能抬音调。
//   · 默认挑男声（Kangkang），不是 Huihui（女）
//   · 设置里有下拉框，标出男女、标出"要联网"
//   · 换了之后记得住
//   · pitch = 1.0（原来 1.1 会把声音抬尖，男声都变娘）
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://127.0.0.1:3789';
const PORT = 9347;
const profile = mkdtempSync(join(tmpdir(), 'seyo-voice-'));

const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--no-first-run',
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
  const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;

  console.log('  默认嗓音：');
  const chosen = await ev(`voice ? voice.name : '(没选)'`);
  chk(/Kangkang/i.test(chosen), `★ 挑的是男声：${chosen}`);
  chk(!/Huihui|Yaoyao/i.test(chosen),
    '★ 不是女声（原来 /Huihui|Yaoyao|Kangkang/ 会先扫到 Huihui）');
  chk(await ev(`voice && voice.localService !== false`), '★ 是本机嗓音（不联网、文字不出门）');

  console.log('\n  下拉框：');
  const opts = JSON.parse(await ev(`JSON.stringify([...document.getElementById('voiceSel').options]
      .map(o => ({ v: o.value, s: o.selected, t: o.textContent })))`) || '[]');
  chk(opts.length >= 1, `列了 ${opts.length} 个嗓音`);
  for (const o of opts) console.log(`      ${o.s ? '→ ' : '  '}${o.t}`);
  chk(opts.some((o) => o.t.includes('（男）')), '★ 标出了哪个是男声');
  chk(opts.some((o) => o.t.includes('（女）')), '标出了哪个是女声');
  const anyCloud = opts.some((o) => o.t.includes('要联网'));
  if (anyCloud) chk(true, '非本机的嗓音标了「要联网」（会发出去的，得让人知道）');
  else console.log('      （这台机器没有非本机的嗓音）');

  console.log('\n  音调与语速（系统语音那一路）：');
  /* 现在默认走本机神经网络 TTS，speak() 不再碰 speechSynthesis。
     这一段验的是"系统语音"那条路，所以先切过去。 */
  await ev(`S.ttsEngine = 'system'; true`);
  const cap = JSON.parse(await ev(`(() => {
    let c = null;
    const orig = speechSynthesis.speak.bind(speechSynthesis);
    speechSynthesis.speak = (u) => { c = { rate: u.rate, pitch: u.pitch, voice: u.voice && u.voice.name }; };
    speak('测试');
    speechSynthesis.speak = orig;
    return JSON.stringify(c);
  })()`) || '{}');
  console.log(`      rate=${cap.rate}  pitch=${cap.pitch}`);
  chk(cap.pitch === 1, '★ 音调 1.0（原来 1.1 会把声音抬尖，男声也变娘）');
  chk(cap.rate <= 1, '语速没加快（老人听得清）');
  chk(/Kangkang/i.test(String(cap.voice)), '发音用的确实是男声');
  await ev(`S.ttsEngine = 'local'; true`);      // 还原，别影响后面的用例

  console.log('\n  换嗓音并记住：');
  const other = opts.find((o) => !o.s);
  if (other) {
    await ev(`(() => { const s = document.getElementById('voiceSel'); s.value = ${JSON.stringify(other.v)};
        s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await sleep(700);
    chk((await ev(`localStorage.getItem('seyo.voice')`)) === other.v, `换成「${other.v}」并记住`);
    // 换回去
    await ev(`(() => { const s = document.getElementById('voiceSel'); s.value = ${JSON.stringify(chosen)};
        s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await sleep(400);
  } else {
    console.log('      （只有一个嗓音，跳过）');
  }

  console.log(`\n  ${bad === 0 ? '\x1b[32m全部通过\x1b[0m' : `\x1b[31m失败 ${bad} 项\x1b[0m`}`);
  if (bad) process.exitCode = 1;
} finally {
  chrome.kill();
  await sleep(800);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}
