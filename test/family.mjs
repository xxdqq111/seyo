/**
 * 家人端渲染自检：把 family.html 里的脚本放到 Node 里，用真实接口数据跑一遍。
 * 目的：抓出"语法没问题、一跑就崩"的错误（这种错在浏览器里就是整页空白）。
 * 用法：node test/family.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.SEYO_BASE || 'http://127.0.0.1:3789';
const html = fs.readFileSync(path.join(ROOT, 'public', 'family.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

let pass = 0;
const fails = [];
const ok = (c, name, extra = '') => {
  if (c) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fails.push(name + (extra ? ` —— ${extra}` : '')); console.log(`  ✗ ${name}${extra ? ` —— ${extra}` : ''}`); }
};

/* ---------------- 一个够用的假 DOM ---------------- */
const made = new Map();
function fakeEl(id) {
  if (made.has(id)) return made.get(id);
  const el = {
    id,
    innerHTML: '',
    textContent: '',
    value: '',
    hidden: false,
    dataset: {},
    className: '',
    style: { setProperty() {} },
    classList: { add() {}, remove() {}, toggle() {} },
    children: [],
    appendChild(c) { this.children.push(c); },
    insertAdjacentHTML(_pos, html) { this.innerHTML += html; },
    removeChild() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    remove() {},
    setAttribute(k, v) { this[k] = v; },
    getAttribute(k) { return this[k] ?? null; },
    contains() { return false; },
    focus() {},
    click() {},
    clientWidth: 900,
  };
  made.set(id, el);
  return el;
}
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
for (const id of ids) fakeEl(id);

globalThis.document = {
  getElementById: (id) => fakeEl(id),
  querySelector: (sel) => (sel.startsWith('#') ? fakeEl(sel.slice(1)) : null),
  querySelectorAll: () => [],
  createElement: () => fakeEl('tmp' + Math.random()),
  addEventListener() {},
  body: fakeEl('body'),
};
globalThis.window = { addEventListener() {}, location: { href: BASE } };
const realFetch = globalThis.fetch.bind(globalThis);
/* MySQL + 登录版：固定测试账号，注册过就直接登录（不每跑一次留一个新账号） */
let TEST_COOKIE = '';
try {
  const auth = async (path) => realFetch(BASE + '/api/auth/' + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'seyo_test_user', password: '123456' }),
  });
  let reg = await auth('register');
  if (!reg.ok) reg = await auth('login');
  const sc = reg.headers.get('set-cookie') || '';
  if (reg.ok && sc) TEST_COOKIE = sc.split(';')[0];
} catch { /* 服务没开登录就按 auth=off 跑 */ }
globalThis.fetch = (u, o = {}) => realFetch(
  String(u).startsWith('http') ? u : BASE + u,
  { ...o, headers: { ...(o.headers || {}), ...(TEST_COOKIE ? { cookie: TEST_COOKIE } : {}) } },
);
globalThis.alert = () => {};
globalThis.URL.createObjectURL = () => 'blob:x';
globalThis.Blob = class { constructor() {} };

/* ---------------- 跑一遍 ---------------- */
console.log(`\n家人端渲染自检（数据来自 ${BASE}）`);
const errors = [];
process.on('unhandledRejection', (e) => errors.push(e));

// 把脚本包成函数执行；末尾的 load() 会自动跑
const fn = new Function('window', 'document', 'fetch', 'alert', 'URL', 'Blob', script + '\nreturn { load, showTab, bindTabs, renderGraph, renderMeds, renderMap, replayFlags, showDim, showPlace, DATA, renderCards, renderTimeline, renderDims, renderLibrary };');
let api;
try {
  api = fn(globalThis.window, globalThis.document, globalThis.fetch, globalThis.alert, globalThis.URL, globalThis.Blob);
  ok(true, '脚本成功加载（没有在顶层就崩）');
} catch (e) {
  ok(false, '脚本成功加载', e.message);
}

// 页签处理必须存在 —— 少了它页签就是死按钮（这就是"点不开"的原因）
ok(typeof api?.bindTabs === 'function', '页签点击处理存在（bindTabs）');
ok(typeof api?.showTab === 'function', '页签切换函数存在（showTab）');
try {
  api.showTab('map');
  const pMap = made.get('p-map');
  const pTimeline = made.get('p-timeline');
  ok(pMap.hidden === false && pTimeline.hidden === true, '点"足迹地图"能切过去（面板显隐正确）');
  // 原来「四个维度 / 主句库 / 数据库」三个页签合成一个「记忆库」了
  api.showTab('memories');
  ok(made.get('p-memories').hidden === false, '点"记忆库"能切过去（原来的三个页签合并成这一个）');
  api.showTab('meds');
  ok(made.get('p-meds').hidden === false, '点"吃药提醒"能切过去');
  api.showTab('timeline');
  ok(made.get('p-timeline').hidden === false && made.get('p-memories').hidden === true, '切回"人生时间轴"正常');
} catch (e) {
  ok(false, '页签切换能用', e.message);
}

// 等 load() 里的 await 跑完
await new Promise((r) => setTimeout(r, 1200));

const raw = await (await fetch(BASE + '/api/family')).json();
ok(raw && typeof raw === 'object', '接口 /api/family 有返回');
ok(Array.isArray(raw.sentences), '主句库是数组');
ok(raw.stats && typeof raw.stats.sentences === 'number', `统计可用（记忆 ${raw.stats?.sentences} 条）`);
ok(Array.isArray(raw.archive?.timeline), '时间轴是数组');
ok(raw.archive?.summary?.person !== undefined, '四个维度都在');
ok(Array.isArray(raw.graph?.nodes), `图谱节点是数组（${raw.graph?.nodes?.length} 个）`);

/* 关键：逐个渲染函数单独跑，看哪个会崩 */const renders = [
  ['卡片', 'renderCards'],
  ['时间轴', 'renderTimeline'],
  ['四个维度', 'renderDims'],
  ['主句库', 'renderLibrary'],
  ['关系图', 'renderGraph'],
];
for (const [label, name] of renders) {
  if (typeof api?.[name] !== 'function') { ok(false, `${label} 渲染函数存在`); continue; }
  try {
    if (name === 'renderLibrary') api[name](raw.sentences);
    else api[name]();
    ok(true, `${label} 渲染没报错`);
  } catch (e) {
    ok(false, `${label} 渲染没报错`, e.message);
  }
}
for (const [name, fn] of [['足迹地图', async () => { await api.renderMap(); await new Promise((r) => setTimeout(r, 300)); }], ['吃药提醒', async () => { await api.renderMeds(); await new Promise((r) => setTimeout(r, 300)); }]]) {
  try {
    await fn();
    ok(true, `${name}渲染没报错`);
  } catch (e) {
    ok(false, `${name}渲染没报错`, e.message);
  }
}

// 验证渲染后确实往页面里写了东西
const timeline = made.get('timeline');
const cards = made.get('cards');
ok(String(cards.innerHTML).includes('<b>'), '统计卡片有内容');
ok(String(timeline.innerHTML).length > 60 || /还没有记忆|暂无记录/.test(String(timeline.innerHTML)), `时间轴要么有内容、要么明确说没有（${String(timeline.innerHTML).length} 字符）`);
ok(String(timeline.innerHTML).length <= 60 || String(timeline.innerHTML).includes('data-photo-add'),
  '★ 时间轴每张卡上都有「＋ 照片」入口');
ok(String(made.get('dbFileInfo').textContent).includes('数据库文件'), '数据库信息挂在记忆库底部');
const mapHost = made.get('chinaMap');
ok(String(mapHost.innerHTML).includes('<svg'), `足迹地图画出了 SVG（${String(mapHost.innerHTML).length} 字符）`);
ok(String(mapHost.innerHTML).includes('<path'), '地图上有省界');
ok(String(mapHost.innerHTML).includes('mapFlags'), '地图上有插旗层');

  // 旗子一次画完（插旗动画已经去掉）
try {
  await api.replayFlags();                                 // 现在可能是异步的
  const flags = String(made.get('mapFlags').innerHTML);
  const progress = String(made.get('mapProgress').textContent);
  const emptyMap = /还没有能定位|暂无可定位/.test(progress);
    ok(flags.length > 0 || emptyMap, `旗子层要么有旗、要么明确说没有（${flags.length} 字符）`);
    ok((flags.match(/<g class="flag"/g) || []).length >= 1 || emptyMap, '★ 旗子是一次画完的（没有插旗动画；空库时不画）');
    ok(/个地方/.test(progress) || emptyMap, `进度提示正常（${progress}）`);
} catch (e) {
  ok(false, '逐面插旗没报错', e.message);
}
ok(!/undefined/.test(String(timeline.innerHTML) + String(mapHost.innerHTML)), '渲染结果里没有 undefined');

/* 地图浮窗：只显示整理过的那一句（年份行和原话列表都不要）。
   只验渲染，不调模型 —— 给一个带 note 的地点，浮窗里就该只有那句话。 */
try {
  const pop = {
    className: '', id: '', innerHTML: '',
    querySelector: () => ({ onclick: null }),
    addEventListener() {},
    appendChild() {}, remove() {},
  };
  const realCreate = globalThis.document.createElement;
  const renderPop = (p) => {
    pop.innerHTML = '';
    globalThis.document.createElement = () => pop;
    try { api.showPlace(p); } finally { globalThis.document.createElement = realCreate; }
    return String(pop.innerHTML);
  };
  const base = {
    id: 'p_test', label: '上海', time_label: '1989 年', approx: false,
    memories: [{ id: 's_a', statement: '1989 年结了婚' }, { id: 's_b', statement: '1989 年在上海结婚' }],
    note: '1989年，我在上海结了婚。', basis: '地名本身',
  };
  const popHtml = renderPop({ ...base, spurs: [], photos: [{ id: 'ph_test', url: '/api/photos/ph_test' }] });
  ok(pop.className === 'place-pop', '★ 点旗帜能生成地点浮窗');
  ok(popHtml.includes('place-pop-note') && popHtml.includes('1989年，我在上海结了婚。'),
    '★ 浮窗显示合并成的那句话');
  ok(!popHtml.includes('1989 年'), '★ 年份那行删掉了（不再显示 1989 年）');
  ok(!popHtml.includes('place-pop-meta'), '没有年份时不留空行');
  ok(!popHtml.includes('<details') && !popHtml.includes('1989 年结了婚'),
    '★ 原话列表不再展示');
  ok(!popHtml.includes('定位依据'), '★ 定位依据也删掉了');
  ok(popHtml.includes('photo-cell') && popHtml.includes('src="/api/photos/ph_test"'),
    '★ 浮窗里显示这个地点的事件照片');
  ok(popHtml.includes('data-photo-add="s_a"'), '浮窗上有「＋ 照片」入口（挂到第一条记忆）');

  const withSpur = renderPop({ ...base, spurs: [{ name: '静安寺' }] });
  ok(withSpur.includes('place-pop-meta') && withSpur.includes('静安寺'),
    '有具体小地名时只显示地名，不显示年份');
  ok(!withSpur.includes('1989 年'), '带小地名时也不显示年份');

  const noNote = renderPop({ ...base, note: '', spurs: [], photos: [] });
  ok(noNote.includes('1989 年结了婚'), '还没合并出句子时，逐条兜底（点开不会是空的）');
} catch (e) {
  ok(false, '地图浮窗渲染合并叙述', e.message);
}

/* 时间轴 / 地图接口都要把照片带出来，前端才画得出图片区 */
try {
  const foot = await (await fetch(BASE + '/api/footprints')).json();
  ok((foot.places || []).every((p) => Array.isArray(p.photos)), '足迹数据每个地点都带 photos 数组');
  const fam = await (await fetch(BASE + '/api/family')).json();
  ok(((fam.archive || {}).timeline || []).every((g) => Array.isArray(g.photos)),
    '时间轴每组都带 photos 数组');
  const hasTlPhoto = ((fam.archive || {}).timeline || []).some((g) => (g.photos || []).length > 0);
  ok(!hasTlPhoto || String(made.get('timeline').innerHTML).includes('photo-cell'),
    '★ 时间轴卡片把事件照片显示出来了');
} catch (e) {
  ok(false, '时间轴/地图照片字段', e.message);
}

/* 地图数据要带合并叙述的字段，否则前端就算不出"该不该补一句" */
try {
  const foot = await (await fetch(BASE + '/api/footprints')).json();
  ok(Array.isArray(foot.places), '足迹接口返回 places 数组');
  ok((foot.places || []).every((p) => 'key' in p && 'note' in p && 'needNote' in p),
    '足迹数据带 key / note / needNote（地图浮窗据此显示合并叙述）');
} catch (e) {
  ok(false, '足迹接口字段', e.message);
}

/* 记忆库：原来"原始数据"和上面的表看的是同一批记忆 —— 现在合成一个 */
try {
  ok(!made.has('dbBody'), '★ 「原始数据」那块删掉了（不再和上面的表重复）');
  const libHtml = String(made.get('libTable').innerHTML);
  if ((raw.sentences || []).length) {
    ok(libHtml.includes('data-edit-id') && libHtml.includes('data-del-id'), '★ 记忆表格每一行直接带「编辑 / 删」');
    ok(made.has('tgStatement'), '编辑弹窗里能改记忆内容（内容和标签一个框改完）');
  } else {
    ok(true, '（空库，跳过行内操作断言）');
  }
} catch (e) {
  ok(false, '记忆库整合', e.message);
}

/* 吃药提醒：设定放在家人端 */
try {
  api.showTab('meds');
  const meds0 = await (await fetch(BASE + '/api/meds')).json();
  ok(Array.isArray(meds0.meds) && Array.isArray(meds0.items), '吃药接口有返回（用药安排 + 今天状态）');
  const pad2 = (n) => String(n).padStart(2, '0');
  const at = new Date(Date.now() + 3 * 60000);
  const hm = `${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
  made.get('medName').value = '测试降压药';
  made.get('medDose').value = '1 片';
  made.get('medTimes').value = hm;
  made.get('medNote').value = '饭后吃';
  await made.get('medAdd').onclick();
  await new Promise((r) => setTimeout(r, 800));
  const meds1 = await (await fetch(BASE + '/api/meds')).json();
  const testMed = (meds1.meds || []).find((m) => m.name === '测试降压药');
  ok(testMed, '★ 家人端能设定"每天几点吃什么药"');
  ok(String(made.get('medList').innerHTML).includes('测试降压药'), '设置里列出这个药');
  ok(String(made.get('medToday').innerHTML).includes('测试降压药'), '「今天的药」里有这一顿');
  ok(String(made.get('medToday').innerHTML).includes('标记吃过'), '家人端能看到状态、也能标记吃过');
  if (testMed) await fetch(BASE + '/api/meds/' + encodeURIComponent(testMed.id), { method: 'DELETE' });
} catch (e) {
  ok(false, '吃药提醒（家人端）', e.message);
}

await new Promise((r) => setTimeout(r, 200));
ok(errors.length === 0, '没有未处理的异步错误', errors.map((e) => e?.message).join(' / '));

console.log('\n' + '─'.repeat(56));
if (fails.length) {
  console.log(`失败 ${fails.length} 项 / 通过 ${pass} 项`);
  fails.forEach((f) => console.log('  - ' + f));
} else {
  console.log(`全部通过：${pass} 项 —— 页面能正常渲染`);
}
console.log('─'.repeat(56));
process.exitCode = fails.length ? 1 : 0;
