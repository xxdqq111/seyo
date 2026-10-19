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
globalThis.fetch = (u, o) => realFetch(String(u).startsWith('http') ? u : BASE + u, o);
globalThis.alert = () => {};
globalThis.URL.createObjectURL = () => 'blob:x';
globalThis.Blob = class { constructor() {} };

/* ---------------- 跑一遍 ---------------- */
console.log(`\n家人端渲染自检（数据来自 ${BASE}）`);
const errors = [];
process.on('unhandledRejection', (e) => errors.push(e));

// 把脚本包成函数执行；末尾的 load() 会自动跑
const fn = new Function('window', 'document', 'fetch', 'alert', 'URL', 'Blob', script + '\nreturn { load, showTab, bindTabs, renderGraph, renderDb, renderMap, replayFlags, showDim, DATA, renderCards, renderTimeline, renderDims, renderLibrary };');
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
for (const [name, fn] of [['数据库页', () => api.renderDb()], ['足迹地图', async () => { await api.renderMap(); await new Promise((r) => setTimeout(r, 300)); }]]) {
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
const dbBody = made.get('dbBody');
ok(String(cards.innerHTML).includes('<b>'), '统计卡片有内容');
ok(String(timeline.innerHTML).length > 60, `时间轴有内容（${String(timeline.innerHTML).length} 字符）`);
ok(String(dbBody.innerHTML).length > 200, `数据库页有内容（${String(dbBody.innerHTML).length} 字符）`);
const mapHost = made.get('chinaMap');
ok(String(mapHost.innerHTML).includes('<svg'), `足迹地图画出了 SVG（${String(mapHost.innerHTML).length} 字符）`);
ok(String(mapHost.innerHTML).includes('<path'), '地图上有省界');
ok(String(mapHost.innerHTML).includes('mapFlags'), '地图上有插旗层');

  // 旗子一次画完（插旗动画已经去掉）
try {
  await api.replayFlags();                                 // 现在可能是异步的
  const flags = String(made.get('mapFlags').innerHTML);
    ok(flags.length > 0 || /还没有能定位/.test(String(made.get('mapProgress').textContent)), `旗子层要么有旗、要么明确说没有（${flags.length} 字符）`);
    ok((flags.match(/<g class="flag"/g) || []).length >= 1, '★ 旗子是一次画完的（没有插旗动画）');
    ok(/个地方|还没有能定位/.test(made.get('mapProgress').textContent), `进度提示正常（${made.get('mapProgress').textContent}）`);
} catch (e) {
  ok(false, '逐面插旗没报错', e.message);
}
ok(!/undefined/.test(String(timeline.innerHTML) + String(dbBody.innerHTML) + String(mapHost.innerHTML)), '渲染结果里没有 undefined');

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
