// 验"老人在对话里改口"这件事。
//
// 老人说 "那是1987年不是88年" 不是讲新事，是在**改之前的记录**。
// 原来直接当新记忆存 —— 时间轴上冒出"1987 年 · 那是1987年不是88年"，
// 而原来的 1988 纹丝不动，看着莫名其妙。
//
// 需要：服务在跑 + 配好了大模型
const BASE = process.env.SEYO_BASE || 'http://127.0.0.1:3789';

let bad = 0;
const chk = (cond, label) => {
  console.log(`  ${cond ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${label}`);
  if (!cond) bad += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (p) => (await fetch(BASE + p)).json();
const post = async (p, body) => (await fetch(BASE + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
})).json();

const SESSION = 'fix-' + Math.random().toString(36).slice(2, 7);

console.log(`\n老人改口（${BASE}）`);

/* ---------- 1. 先存一条带年份的记忆 ---------- */
const LINE = '我一九七五年在县城看过一场露天电影';
const TARGET = '露天电影';
console.log(`\n  先说一句：${LINE}`);
const t1 = await post('/api/chat', { text: LINE, sessionId: SESSION });
console.log(`    岁语：${t1.reply}`);

let row = null;
for (let i = 0; i < 30; i += 1) {
  await sleep(1000);
  const rows = await get('/api/sentences?limit=400');
  row = rows.items.find((r) => String(r.statement).includes(TARGET));
  if (row && row.year) break;
}
chk(Boolean(row), '这句话进了库');
chk(row && Number(row.year) === 1975, `年份记成了 1975（实际 ${row && row.year}）`);

if (!row) {
  console.log('\n  没存上，后面的没法验');
  process.exitCode = 1;
} else {
  /* ---------- 2. 老人改口 ---------- */
  const BEFORE = (await get('/api/sentences?limit=400')).items.length;
  const FIX = '不对，那不是75年，是1976年';
  console.log(`\n  老人改口：${FIX}`);
  const t2 = await post('/api/chat', { text: FIX, sessionId: SESSION });
  console.log(`    岁语：${t2.reply}`);

  await sleep(1500);
  const rows = await get('/api/sentences?limit=400');
  const after = rows.items.find((r) => r.id === row.id);

  console.log(`\n  改完：year=${after && after.year}  label='${after && after.time_label}'`);
  chk(after && Number(after.year) === 1976, `★ 年份改成了 1976（实际 ${after && after.year}）`);
  chk(after && String(after.statement).includes(TARGET), '原来那句话还在（改的是年份，不是删了重存）');
  chk(rows.items.length === BEFORE, `★ 没多存一条（${BEFORE} → ${rows.items.length}）`);

  // "不对，那不是75年，是1976年" 本身不该在库里
  const junk = rows.items.filter((r) => /不是\s*\d{2,4}\s*年/.test(String(r.statement)));
  chk(junk.length === 0, `★ 改口那句话没被当成记忆存下来${junk.length ? `（${junk.map((r) => r.statement).join('、')}）` : ''}`);

  /* ---------- 3. 收尾：删掉测试造的那条 ---------- */
  await fetch(`${BASE}/api/sentences/${row.id}`, { method: 'DELETE' });
  console.log('\n  已清掉测试造的那条');
}

console.log(`\n  ${bad === 0 ? '\x1b[32m全部通过\x1b[0m' : `\x1b[31m失败 ${bad} 项\x1b[0m`}`);
if (bad) process.exitCode = 1;
