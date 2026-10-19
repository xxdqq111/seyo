/**
 * 两个页面的"互跳"与结构自检
 * 用法：node test/nav.mjs       （服务要在跑）
 */
const BASE = process.env.SEYO_BASE || 'http://127.0.0.1:3789';

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

ok(home.status === 200, '对话页能打开');
ok(fam.status === 200, '家人端能打开');

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
  '/': ['app', 'avatar', 'avatarStage', 'bubbles', 'micBtn', 'input', 'sendBtn', 'soundNote', 'ttsSel', 'ttsNote', 'voiceSel', 'voiceNote',
    'gearBtn', 'settings', 'settingsClose', 'camBtn', 'camNote',
    'insideBtn', 'insideBody', 'colHeard', 'colRecall', 'colStore', 'colDb', 'status', 'statusText'],
  // 三个页签（四个维度 / 主句库 / 数据库）已合成一个「记忆库」
  '/family.html': ['subtitle', 'banner', 'errBox', 'cards', 'tabs', 'p-timeline', 'p-memories',
    'p-graph', 'p-map', 'timeline', 'groupChips', 'libTable', 'chinaMap', 'graph', 'dbBody'],
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
  console.log(`全部通过：${pass} 项 —— 两个页面互跳正常`);
}
console.log('─'.repeat(52));
process.exitCode = fails.length ? 1 : 0;