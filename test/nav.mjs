/**
 * 两个页面的"互跳"与结构自检
 * 用法：node test/nav.mjs       （服务要在跑）
 */
const BASE = process.env.SEYO_BASE || 'http://127.0.0.1:3789';

/* 登录版：固定测试账号，注册过就登录；服务端 auth=off 时会被忽略 */
const realFetch = globalThis.fetch.bind(globalThis);
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
} catch { /* ignore */ }
const fetchWithCookie = (url, opt = {}) => realFetch(url, {
  ...opt,
  headers: { ...(opt.headers || {}), ...(TEST_COOKIE ? { cookie: TEST_COOKIE } : {}) },
});
globalThis.fetch = fetchWithCookie;

let pass = 0;
const fails = [];
const ok = (c, name, extra = '') => {
  if (c) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fails.push(name + (extra ? ` —— ${extra}` : '')); console.log(`  ✗ ${name}${extra ? ` —— ${extra}` : ''}`); }
};

const get = async (p) => {
  const r = await fetch(BASE + p);
  return { status: r.status, text: await r.text() };
};

console.log(`\n两个页面互跳与结构自检（${BASE}）`);

const home = await get('/');
const fam = await get('/family.html');
const remote = await get('/remote.html');

ok(home.status === 200, '对话页能打开');
ok(fam.status === 200, '家人端能打开');
ok(remote.status === 200, '家人远程端能打开');

/* ---------- 远程端必须和老人端/大屏查看端分开 ---------- */
ok(!remote.text.includes('href="/"'), '远程端没有回对话页的入口');
ok(!remote.text.includes('href="/family.html"'), '远程端没有回大屏查看端的入口');
for (const id of ['moodAlert', 'p-messages', 'msgThread', 'msgInput', 'msgSend', 'p-daily', 'dailyCard', 'dailyLike', 'dailyReplySend']) {
  ok(remote.text.includes(`id="${id}"`), `远程端有 ${id}`);
}

/* ---------- 互跳 ---------- */
ok(home.text.includes('href="/family.html"'), '对话页有入口通往家人端');
ok(fam.text.includes('href="/"'), '家人端有入口回到对话页');

const navIn = (t) => t.includes('class="site-nav"');
ok(navIn(home.text), '对话页用了统一导航');
ok(navIn(fam.text), '家人端用了统一导航');

// 两页的品牌名与导航项一致
for (const [name, t] of [['对话页', home.text], ['家人端', fam.text]]) {
  ok(t.includes('class="brand"') && t.includes('brand-mark'), `${name}有品牌标识`);
  ok(t.includes('>对话<') && t.includes('>查看端<'), `${name}导航项齐全`);
}

/* ---------- 统一样式与脚本 ---------- */
for (const [name, t] of [['对话页', home.text], ['家人端', fam.text]]) {
  ok(t.includes('/theme.css'), `${name}引用统一设计系统`);
}
ok(home.text.includes('/avatar.css') && home.text.includes('/avatar.js'), '对话页引用数字人模块');
ok(fam.text.includes('/family.css') && !fam.text.includes('<style>'), '家人端样式已外链（没有内联 style）');

/* ---------- 关键元素 ---------- */
const need = {
  '/': ['app', 'avatar', 'avatarStage', 'bubbles', 'micBtn', 'input', 'sendBtn', 'ttsSel', 'voiceSel',
    'accountBtn', 'accountModal', 'accountClose', 'accountTabs', 'atab-account', 'atab-settings',
    'acctName', 'acctOldPw', 'acctNewPw', 'acctPwSave', 'logoutBtn', 'camBtn',
    'insideBtn', 'insideBody', 'colHeard', 'colRecall', 'colStore', 'colDb', 'status', 'statusText',
    // 吃药提醒：老人端只有提醒，没有设置
    'medBar', 'medRemind', 'medDoneBtn', 'medSnoozeBtn',
    // 记事本 / 到点提醒
    'notebookBtn', 'noteModal', 'noteClose', 'noteList', 'noteRemind', 'noteRemindText', 'noteDoneBtn',
    // 第一次用补基本信息
    'firstUse', 'fuCall', 'fuBirth', 'fuHome', 'fuSave', 'fuLater'],
  // 三个页签（四个维度 / 主句库 / 数据库）已合成一个「记忆库」；吃药设到家人端
  '/family.html': ['subtitle', 'banner', 'errBox', 'cards', 'tabs', 'p-timeline', 'p-memories',
    'p-graph', 'p-map', 'p-meds', 'timeline', 'groupChips', 'libTable', 'chinaMap', 'graph',
    'famAccountBtn', 'famAcctModal', 'famAcctTabs', 'famTabAccount', 'famTabSettings',
    'famOldPw', 'famNewPw', 'famPwSave', 'famLogout', 'famEditPersona', 'famResetAll',
    'medList', 'medToday', 'medName', 'medTimes', 'medAdd', 'medCancel'],
};
for (const [path, ids] of Object.entries(need)) {
  const t = path === '/' ? home.text : fam.text;
  const miss = ids.filter((id) => !t.includes(`id="${id}"`));
  ok(miss.length === 0, `${path} 关键元素齐全`, miss.join(', '));
}

/* ---------- 静态资源可访问 ---------- */
for (const asset of ['/theme.css', '/avatar.css', '/style.css', '/family.css', '/avatar.js', '/app.js']) {
  const r = await fetch(BASE + asset);
  ok(r.status === 200, `静态资源 ${asset}`);
}

console.log('\n' + '─'.repeat(52));
if (fails.length) {
  console.log(`失败 ${fails.length} 项 / 通过 ${pass} 项`);
  fails.forEach((f) => console.log('  - ' + f));
} else {
  console.log(`全部通过：${pass} 项 —— 页面结构与远程端检查正常`);
}
console.log('─'.repeat(52));
process.exitCode = fails.length ? 1 : 0;