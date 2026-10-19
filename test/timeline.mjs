// 验"说话之后大模型自己把时间补上"。
//
// 规则表认不出"那年""那会儿""过了两年"—— 老人偏偏最爱这么说话，
// 整件事就掉进时间轴的"时间未定"。现在回完话会**后台**让模型判一次。
//
// 这个测试模拟真实用法：说一句带相对时间的，等几秒，看时间轴有没有自动补上。
//
// 需要：服务在跑 + 配好了大模型（会真的调模型）
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

console.log(`\n时间轴：说完话能不能自己把时间补上（${BASE}）`);

const persona = (await get('/api/persona')).persona;
const birth = Number(persona.birth_year) || null;
const thisYear = new Date().getFullYear();
console.log(`  出生年份 ${birth || '（没设）'}，今年 ${thisYear}`);
if (!birth) {
  console.log('  ⚠ 没设出生年份 —— 模型推算年份会差一截，但流程照样能验');
}

/* 挑一句**规则一定认不出年份**的话：
   只有"进了厂那年""那会儿"这种相对说法，没有任何绝对年份和年代词。 */
const SESSION = 'timeline-test-' + Math.random().toString(36).slice(2, 7);
const LINE = '我进厂那年刚满二十，一个月挣十八块五，住集体宿舍';
const TARGET = '一个月挣十八块五';       // 用这句认成果，够独特

console.log(`\n  说一句（session=${SESSION}）：`);
console.log(`    「${LINE}」`);

const before = await get('/api/sentences?limit=400');
const beforeCount = before.items.length;

const turn = await post('/api/chat', { text: LINE, sessionId: SESSION });
console.log(`    岁语：${turn.reply}`);

// 回完话，后台会去补时间（不 await，所以这里要等）
console.log('\n  等后台补时间…');
let hit = null;
for (let i = 0; i < 40; i += 1) {   // 后台是 fire-and-forget，模型慢的时候要等久一点
  await sleep(1000);
  const rows = await get('/api/sentences?limit=400');
  hit = rows.items.find((r) => String(r.statement).includes(TARGET));
  if (hit && (hit.year || /\d{4}/.test(String(hit.time_label || '')))) break;
}

const after = await get('/api/sentences?limit=400');
chk(after.items.length >= beforeCount, `记忆条数没丢（${beforeCount} → ${after.items.length}）`);

if (!hit) {
  console.log(`  ⚠ 没找到含「${TARGET}」的句子，看看实际存了什么：`);
  for (const r of after.items.slice(-4)) console.log(`      [${r.seq}] ${r.statement}`);
  chk(false, '这句话进了库');
} else {
  console.log(`\n  存下来的那条：`);
  console.log(`    [${hit.seq}] ${hit.statement}`);
  console.log(`    时间：year=${hit.year}  label='${hit.time_label}'`);
  chk(Boolean(hit.year || hit.time_label), '★ 后台给这条补上了时间（不是"时间未定"）');
  if (hit.year) {
    chk(hit.year >= 1900 && hit.year <= thisYear, `★ 年份在合理范围（${hit.year}）`);
    // 出生 1948 + 二十岁 ≈ 1968，给个宽松区间
    if (birth) {
      const guess = birth + 20;
      chk(Math.abs(hit.year - guess) <= 12, `★ 和"二十岁"对得上（判成 ${hit.year}，理想约 ${guess}）`);
    }
  }
}

/* 时间轴本身：不许再有"时间未定"这一组 */
const arch = await get('/api/archive');
const tl = arch.timeline || [];
console.log('\n  时间轴：');
for (const g of tl) console.log(`    ${String(g.label).padEnd(12)} ${g.items.length} 条`);
chk(tl.length > 0, '分出了时间段');
chk(!tl.some((g) => g.label === '时间未定'), '★ 没有"时间未定"这一组');

// 有年份的组要从早到晚
const years = tl.map((g) => Number(String(g.label).replace(/[^\d]/g, ''))).filter(Boolean);
chk(years.every((v, i) => i === 0 || v >= years[i - 1]), '★ 按年份从小到大排');

/* 没有具体年份的那些（"中年时期""杭州开餐馆那几年"）必须**插到该在的位置**，
   不能一股脑堆到最后 —— 那正是原来时间轴看着乱的原因。
   后端给每组算了个 order，前端按它排。 */
const orders = tl.map((g) => g.order);
/* 空库时只有一段、order 可能是 null —— 那不算错 */
chk(orders.every((o) => typeof o === 'number') || tl.length <= 1, `每个时间段都有排序位置${orders.some((o) => typeof o !== 'number') ? '（有缺的）' : ''}`);
chk(orders.every((v, i) => i === 0 || v >= orders[i - 1]),
  `★ order 单调不减（${orders.join(' < ')}）`);

/* 同一件事不能被拆成好几张卡。
   "1978 年""去杭州后中年时期""杭州开餐馆那几年""约 1978 年" 讲的都是
   去杭州开餐馆那一件事 —— 原来摊成四张卡，看着像四件不相干的事。
   后端现在会把"推算年份相差不到 1 年"的相邻组合并成一张。 */
const solidYears = tl.filter((g) => /^\d{4}\s*年$/.test(g.label))
  .map((g) => String(g.label).replace(/[^\d]/g, ''));
chk(new Set(solidYears).size === solidYears.length,
  `★ 同一年没被拆成多张卡（${solidYears.join('、')}）`);
chk(tl.length <= 12, `时间段数量合理（${tl.length} 段）`);

// 有确切年份的组，其 label 里的年份应该和 order 差不多
const drift = tl.filter((g) => /^\d{4}\s*年$/.test(g.label))
  .filter((g) => Math.abs(Number(String(g.label).replace(/[^\d]/g, '')) - g.order) > 0.01);
chk(drift.length === 0, `确切年份的组 order 与年份一致${drift.length ? `（${drift.map((g) => g.label).join('、')}）` : ''}`);

// 清掉测试造的这一条，别污染真实时间轴
if (hit) {
  await fetch(`${BASE}/api/sentences/${hit.id}`, { method: 'DELETE' });
  console.log('\n  已清掉测试造的那条');
}

console.log(`\n  ${bad === 0 ? '\x1b[32m全部通过\x1b[0m' : `\x1b[31m失败 ${bad} 项\x1b[0m`}`);
if (bad) process.exitCode = 1;
