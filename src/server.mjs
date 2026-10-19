/**
 * Seyo（岁语）· 智能体服务
 *
 *   node src/server.mjs                  → http://127.0.0.1:3789
 *   node src/server.mjs --port 8080
 *   node src/server.mjs --host 0.0.0.0   → 允许局域网访问
 *
 * 只有三件事：把网页发出去、把对话接进来、把主句库露出来给你看。
 * 数据库初始为空 —— 里面只会出现老人真实说过的话。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { PUBLIC_DIR, DATA_DIR, readBody, log, fmtTime } from './util.mjs';
import {
  stats, listSentences, deleteSentence, search, listEntities, recentUtterances, archive, dimensionMap, graph, dbTables, deleteDimension, updateSentence, pruneDimensions, getDb,
  openCandidates, listTopics, resetAll, dumpIndex, getSentence, DB_FILE, putNote, putPlaceGeo, getPlaceGeo, allPlaceNames,
} from './store.mjs';
import { handleTurn, opening, getPersona, setPersona, analyze, watchCheck, notePoll, ackSpoken, judgeTimes, watchState, watchConfigure, watchClearLog, watchSetMood } from './engine.mjs';
import { polishMany, narrateGroups, curateEvents, judgePlaces } from './understand.mjs';
import { llmStatus, saveLLMConfig, testLLM, PRESETS } from './llm.mjs';
import { visionStatus, saveVisionConfig, lookAt, warmUp as visionWarmUp, stopFer, visionHealth } from './vision.mjs';
import { asrConfig, saveAsrConfig, listen as asrListen, asrHealth, stopAsr, asrDebug } from './asr.mjs';
import { ttsConfig, saveTtsConfig, synthesize, ttsHealth, stopTts, ttsDebug } from './tts.mjs';

/** 带实时探测的状态：本地服务到底活着没 */
async function visionStatusLive() {
  const st = visionStatus();
  try { st.live = await visionHealth(); } catch { st.live = null; }
  return st;
}
import { footprints, lookup, bboxOf, cityIn, simplifyMap } from './geo.mjs';

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const PORT = Number(process.env.PORT || argOf('port', 3789));
const HOST = process.env.HOST || argOf('host', '127.0.0.1');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.vrm': 'model/gltf-binary',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

function send(res, code, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  res.writeHead(code, { 'Content-Length': buf.length, 'Cache-Control': 'no-store', ...headers });
  res.end(buf);
}
const json = (res, code, obj) => send(res, code, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });

async function api(req, res, pathname, query) {
  const method = req.method || 'GET';
  const body = method === 'POST' || method === 'PATCH' || method === 'DELETE' ? await readBody(req) : {};

  if (pathname === '/api/health') {
    return json(res, 200, { ok: true, time: fmtTime(), stats: stats(), persona: getPersona() });
  }

  if (pathname === '/api/persona') {
    if (method === 'GET') return json(res, 200, { persona: getPersona() });
    return json(res, 200, { persona: setPersona(body) });
  }

  // 一轮对话（核心）
  if (pathname === '/api/chat' && method === 'POST') {
    try {
      const r = await handleTurn({ text: String(body.text || ''), sessionId: String(body.sessionId || 'default') });
      return json(res, 200, r);
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  // 主动开口（现在是异步的：智能体拿着全部记忆现起话头）
  if (pathname === '/api/opening' && method === 'POST') {
    return json(res, 200, await opening({ sessionId: String(body.sessionId || 'default'), reason: String(body.reason || 'auto') }));
  }

  /* ---------------- 陪伴守望：主动关心 ---------------- */

  // 客户端每隔一会儿轮询一次：现在该主动开口吗？
  if (pathname === '/api/watch') {
    if (method === 'GET') {
      notePoll();                    // 记一笔，界面上显示"页面问过多少次"
      const r = await watchCheck({ sessionId: String(query.get('sessionId') || 'default') });
      return json(res, 200, r);
    }
  }

  // 看守望状态（闲置多久、最近情绪、摄像头开着没）
  if (pathname === '/api/watch/state') return json(res, 200, watchState());

  // 某个页面把主动开口显示出来了 —— 记一下，便于排查"到底有几个页面在收"
  if (pathname === '/api/watch/ack' && method === 'POST') {
    return json(res, 200, ackSpoken(String(query.get('id') || body.id || '')));
  }

  // 调参数（闲置多久、夜间静默、摄像头开关…）
  if (pathname === '/api/watch/config' && method === 'POST') {
    return json(res, 200, watchConfigure(body));
  }

  // 手动塞一条情绪读数（调试用；正常是摄像头来的）
  if (pathname === '/api/mood' && method === 'POST') {
    return json(res, 200, watchSetMood({
      level: body.level, score: body.score, note: body.note, source: body.source || 'manual',
      why: body.why || null, expression: body.expression || '',
    }));
  }


  // 清空情绪记录
  if (pathname === '/api/watch/log' && method === 'DELETE') {
    watchClearLog();
    return json(res, 200, { ok: true });
  }

  /* ---------------- 摄像头情绪识别 ---------------- */

  if (pathname === '/api/vision') {
    if (method === 'GET') return json(res, 200, await visionStatusLive());
    if (method === 'POST') {
      // 收一帧，看一眼，记下结果。图片只在内存里过一下，不落盘。
      const out = await lookAt(body.image);
      let proactive = null;
      if (!out.error) {
        watchSetMood({
          level: out.level, score: out.score, note: out.note, source: 'camera',
          why: out.why, expression: out.expression, face: out.face,
        });

        /* ★ 顺便在这里判一次"该不该主动开口"。
           原来纯靠客户端每 12 秒轮询 /api/watch 来问 —— 但浏览器对后台标签页的
           定时器会限流、久了还会冻结，老人把页面切走之后它就不吭声了。
           摄像头这条链路本来就是活的（人还在镜头前），顺手判一次最稳，
           客户端拿到 proactive 就直接显示，不再依赖定时器。
           并发由 watch.mjs 的 claim 机制保证：两边都判到了也只会说一遍。 */
        try {
          const c = await watchCheck({ sessionId: String(body.sessionId || 'default') });
          proactive = c.speak && c.text
            ? { speak: true, text: c.text, reason: c.reason }
            : { speak: false, reason: c.reason || '' };
        } catch (e) {
          proactive = { speak: false, reason: `判断失败：${e.message}` };
        }
      }
      return json(res, 200, { ...out, proactive, watch: watchState() });
    }
  }
  if (pathname === '/api/vision/config' && method === 'POST') {
    return json(res, 200, { ...saveVisionConfig(body), saved: true });
  }

  /* ---------------- 本地语音识别（Vosk，录音不出门） ---------------- */

  if (pathname === '/api/listen') {
    if (method === 'GET') {
      const c = asrConfig();
      let health = null;
      if (asrDebug().running) health = await asrHealth(Number(c.asrPort) || 3792);
      return json(res, 200, { ...c, ...asrDebug(), health, provider: 'vosk' });
    }
    if (method === 'POST') {
      // body.pcm 是 16 位小端、单声道、16 kHz 的裸 PCM（base64）
      if (!body.pcm) return json(res, 400, { ok: false, error: '没有收到录音' });
      const r = await asrListen(asrConfig(), String(body.pcm), Number(body.rate) || 16000);
      return json(res, 200, { ...r, provider: 'vosk' });
    }
  }
  if (pathname === '/api/listen/config' && method === 'POST') {
    return json(res, 200, { ...saveAsrConfig(body), saved: true });
  }

  /* ---------------- 时间轴：润色 + 补时间 ---------------- */

  if (pathname === '/api/map/places' && method === 'POST') {
    /* 地图上"这个地方在哪儿"以前靠坐标表和城市名表做字面匹配，
       认不出"剪子巷""国棉三厂"这类 —— 全退到"老家附近"，挤成一个点。
       这里让模型判：是不是地名、归哪个城市，结果缓存在 place_geo。 */
    const names = allPlaceNames().filter((name) => !getPlaceGeo(name));
    if (!names.length) return json(res, 200, { ok: true, pending: 0, changed: 0 });
    let changed = 0;
    for (let k = 0; k < names.length; k += 20) {
      const got = await judgePlaces({ persona: getPersona(), names: names.slice(k, k + 20) });
      for (const g of got) { putPlaceGeo(g.name, g); changed += 1; }
    }
    return json(res, 200, { ok: true, pending: names.length, changed });
  }

  if (pathname === '/api/timeline/curate' && method === 'POST') {
    /* 时间轴只放人生大事 —— 给还没判过的记忆补上判断 */
    const rows = listSentences({ limit: 400 });
    if (!rows.length) return json(res, 200, { ok: true, pending: 0, changed: 0 });
    let changed = 0;
    for (let k = 0; k < rows.length; k += 10) {
      const got = await curateEvents({ persona: getPersona(), rows: rows.slice(k, k + 10) });
      /* 2=major（单独成条）/ 1=detail（并进那件事）/ 0=none（时间轴外） */
      for (const g of got) { updateSentence(g.id, { life_event: g.scope === 'major' ? 2 : (g.scope === 'detail' ? 1 : 0) }); changed += 1; }
    }
    return json(res, 200, { ok: true, pending: rows.length, changed });
  }
  if (pathname === '/api/timeline/narrate' && method === 'POST') {
    /* 一个时间段里散着好几条记忆（同一件事）→ 合成一句话 */
    const arch = archive();
    const todo = (arch.timeline || []).filter((g) => g.items.length >= 2 && !g.note);
    if (!todo.length) return json(res, 200, { ok: true, pending: 0, changed: 0 });
    let changed = 0;
    for (let k = 0; k < todo.length; k += 6) {
      const got = await narrateGroups({ persona: getPersona(), groups: todo.slice(k, k + 6) });
      for (const g of got) { putNote(g.key, g.text); changed += 1; }
    }
    return json(res, 200, { ok: true, pending: todo.length, changed });
  }
  if (pathname === '/api/timeline/polish' && method === 'POST') {
    /* 时间轴上要读起来像小传，不是聊天记录 —— 给还没润色过的补上。 */
    const rows = listSentences({ limit: 400 }).filter((r) => !String(r.polished || '').trim());
    if (!rows.length) return json(res, 200, { ok: true, pending: 0, changed: 0 });
    let changed = 0;
    for (let k = 0; k < rows.length; k += 12) {
      const chunk = rows.slice(k, k + 12);
      const got = await polishMany({ persona: getPersona(), rows: chunk });
      for (const g of got) { updateSentence(g.id, { polished: g.text }); changed += 1; }
    }
    return json(res, 200, { ok: true, pending: rows.length, changed });
  }

  /* ---------------- 时间轴：让大模型补时间 ---------------- */

  if (pathname === '/api/timeline/judge' && method === 'POST') {
    /* 规则认不出"那年""那会儿""过了两年"，那些记忆就掉进"时间未定"。
       这里让模型结合上下文重判一遍。家人端可以手动点一下重跑。 */
    const rows = listSentences({ limit: 400 });
    const need = rows.filter((r) => !r.year && !/\d{4}/.test(String(r.time_label || '')));
    if (!need.length) return json(res, 200, { ok: true, pending: 0, changed: 0 });
    const out = await judgeTimes(need.map((r) => r.id), {
      sessionId: String(body.sessionId || 'timeline'),
      history: rows.slice(-10).map((r) => ({ role: 'elder', text: r.statement })),
    });
    return json(res, 200, { ok: !out.error, pending: need.length, ...out });
  }

  /* ---------------- 本地语音合成（sherpa-onnx，文字不出门） ---------------- */

  if (pathname === '/api/say') {
    if (method === 'GET') {
      const c = ttsConfig();
      let health = null;
      if (ttsDebug().running) health = await ttsHealth(Number(c.ttsPort) || 3793);
      return json(res, 200, { ...c, ...ttsDebug(), health, engine: 'sherpa-onnx' });
    }
    if (method === 'POST') {
      const text = String(body.text || '');
      if (!text.trim()) return json(res, 400, { ok: false, error: '没有要合成的内容' });
      const r = await synthesize(ttsConfig(), text, Number(body.speed) || 1.0);
      if (!r.ok) return json(res, 503, { ok: false, error: r.error });
      // 直接回 WAV 二进制 —— 前端拿到就一个 blob，塞进 <audio> 就能播
      return send(res, 200, r.wav, {
        'Content-Type': 'audio/wav',
        'X-Seyo-Ms': String(r.ms || 0),
        'X-Seyo-Audio-Ms': String(r.audioMs || 0),
        'X-Seyo-Chars': String(r.chars || 0),
      });
    }
  }
  if (pathname === '/api/say/config' && method === 'POST') {
    return json(res, 200, { ...saveTtsConfig(body), saved: true });
  }

  // 单独试检索：老人这句话能查到哪条
  if (pathname === '/api/search') {
    const q = method === 'POST' ? String(body.q || '') : String(query.get('q') || '');
    if (!q) return json(res, 400, { error: '缺少查询内容' });
    const a = analyze(q);
    return json(res, 200, {
      query: q,
      heard: {
        statement: a.statement,
        persons: a.persons, places: a.places,
        times: a.times.map((t) => t.label), events: a.events,
        keywords: a.keywords.slice(0, 10),
      },
      hits: search(q, a),
    });
  }

  // 主句库
  if (pathname === '/api/sentences') {
    if (method === 'GET') return json(res, 200, { items: listSentences({ limit: Number(query.get('limit') || 500), status: query.get('status') || undefined }) });
    if (method === 'DELETE') return json(res, 200, resetAll({ keepPersona: true }));
  }
  if (pathname.startsWith('/api/sentences/')) {
    const id = pathname.split('/')[3];
    if (method === 'GET') {
      const one = getSentence(id);
      return json(res, one ? 200 : 404, one || { error: '未找到' });
    }
    if (method === 'DELETE') {
      deleteSentence(id);
      return json(res, 200, { ok: true, stats: stats() });
    }
  }

  // 四个维度（人物 / 时间 / 地点 / 事件）
  // 大模型配置：看状态 / 保存 / 试连通
  if (pathname === '/api/llm') {
    if (method === 'GET') return json(res, 200, { ...llmStatus(), presets: PRESETS });
    if (method === 'POST') {
      if (body.test) return json(res, 200, await testLLM());
      if (body.preset && PRESETS[body.preset]) {
        const p = PRESETS[body.preset];
        return json(res, 200, saveLLMConfig({ ...p, ...(body.apiKey ? { apiKey: body.apiKey } : {}) }));
      }
      return json(res, 200, saveLLMConfig(body));
    }
  }

  // 足迹：按时间顺序，老人去过 / 待过的地方（给中国地图插旗用）
  if (pathname === '/api/footprints') {
    const persona = getPersona();
    const home = persona.hometown ? (lookup(persona.hometown) || cityIn(persona.hometown)?.coord || null) : null;
    const list = footprints(getDb(), { hometown: persona.hometown || '', hometownCoord: home });
    return json(res, 200, {
      places: list,
      located: list.filter((p) => p.located).length,
      unlocated: list.filter((p) => !p.located).map((p) => p.name),
    });
  }

  // 中国地图数据（本地那份，只读一次，浏览器缓存）
  if (pathname === '/api/map/china') {
    const f = new URL('../public/map/china.json', import.meta.url);
    if (!fs.existsSync(f)) return json(res, 404, { error: '地图数据缺失：public/map/china.json' });
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    // 抽稀后再发：文件里 16 万个点，浏览器其实用不了那么细
    const thin = simplifyMap(raw, Number(query.get('tol') || 0.05));
    return json(res, 200, { geojson: thin, bbox: bboxOf(thin) });
  }

  // 网页上直接看数据库
  if (pathname === '/api/db/tables') return json(res, 200, dbTables());

  // 删一个维度条目（人物/时间/地点/事件）；有记忆挂着时要带 force
  if (pathname.startsWith('/api/db/dimension/') && method === 'DELETE') {
    // /api/db/dimension/<dim>/<id> → ['', 'api', 'db', 'dimension', '<dim>', '<id>']
    const parts = pathname.split('/').filter(Boolean);
    const dim = parts[3];
    const id = parts[4];
    const out = deleteDimension(dim, id, { force: query.get('force') === '1' || body.force === true });
    return json(res, out.ok ? 200 : 400, out);
  }

  // 改一条记忆（文字 / 状态）
  if (pathname.startsWith('/api/db/sentence/') && (method === 'PATCH' || method === 'PUT')) {
    const parts = pathname.split('/').filter(Boolean);
    const id = parts[3];
    const next = updateSentence(id, body);
    return json(res, next ? 200 : 404, next || { error: '没找到这条' });
  }

  // 清掉没人提到的空维度条目
  if (pathname === '/api/db/prune' && method === 'POST') return json(res, 200, { removed: pruneDimensions(), stats: stats() });

  // 老人自己在图谱里显示成什么
  function selfLabel() {
    const p = getPersona();
    if (p.elder_name) return p.elder_name;
    return '我' + (p.elder_call ? '（' + p.elder_call + '）' : '');
  }

  // 家人端：一个口子把要用的都给全（时间轴 / 四维 / 主句库 / 关系 / 统计）
  if (pathname === '/api/family') {
    /* **不再给示例数据。**
       以前库里是空的时候会返回一份 PREVIEW，页面看着像已经有内容了，
       容易让人以为记忆真的存在 —— 假的就是假的，空就显示空。 */
    const st = stats();
    // listSentences 返回的是数组（不是 {items}），别解构错了
    const items = listSentences({ limit: 1000 });
    return json(res, 200, {
      preview: false,
      persona: getPersona(),
      stats: st,
      archive: archive({}),
      sentences: items,
      graph: graph({ selfName: selfLabel() }),
      candidates: openCandidates(20),
      topics: listTopics(20),
      watch: watchState(),
    });
  }

  if (pathname === '/api/entities') {
    return json(res, 200, {
      persons: listEntities('person'),
      times: listEntities('time'),
      places: listEntities('place'),
      events: listEntities('event'),
    });
  }

  // 记忆档案库：按四个维度筛选浏览
  if (pathname === '/api/archive') {
    return json(res, 200, archive({
      dim: query.get('dim') || '',
      id: query.get('id') || '',
      status: query.get('status') || '',
    }));
  }
  if (pathname === '/api/utterances') return json(res, 200, { items: recentUtterances(Number(query.get('limit') || 40)) });
  if (pathname === '/api/candidates') return json(res, 200, { items: openCandidates(20) });
  if (pathname === '/api/topics') return json(res, 200, { items: listTopics(20) });
  if (pathname === '/api/stats') return json(res, 200, stats());
  /* 默认**连基本信息一起清**（称呼/出生年份/老家），要保留才显式传 keepPersona:true */
  if (pathname === '/api/reset' && method === 'POST') return json(res, 200, resetAll({ keepPersona: body.keepPersona === true }));
  if (pathname === '/api/dump' && method === 'POST') return json(res, 200, dumpIndex());
  if (pathname === '/api/db' && method === 'GET') {
    // 直接把数据库文件给你（想用 SQLite 工具打开就拿这个）
    const buf = fs.readFileSync(DB_FILE);
    return send(res, 200, buf, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="seyo.db"`,
    });
  }

  /* 临时：无头浏览器截图用。验收完就删。 */

  return json(res, 404, { error: `未知接口 ${pathname}` });
}

function staticFile(res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const p = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!p.startsWith(PUBLIC_DIR)) return send(res, 403, '禁止访问');
  if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) return send(res, 404, '未找到');

  // vendor/ 和 models/ 是永不改动的静态资源（three.js 700KB、VRM 模型 14MB），
  // 给它长缓存 —— 否则每次刷新都要重下十几兆。其它文件仍然 no-store，
  // 免得改一行 JS 还得手动清缓存。
  const rel2 = path.relative(PUBLIC_DIR, p).replace(/\\/g, '/');
  const longCache = /^(vendor|models)\//.test(rel2);
  send(res, 200, fs.readFileSync(p), {
    'Content-Type': MIME[path.extname(p).toLowerCase()] || 'application/octet-stream',
    ...(longCache ? { 'Cache-Control': 'public, max-age=604800' } : {}),
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url.pathname, url.searchParams);
    return staticFile(res, url.pathname);
  } catch (e) {
    log('异常：', e?.message || e);
    json(res, 500, { error: e?.message || '服务内部错误' });
  }
});

server.listen(PORT, HOST, () => {
  const st = stats();
  log('─'.repeat(58));
  log('Seyo（岁语）智能体已启动');
  log(`  对话界面 : http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}/`);
  log(`  主句库   : ${st.sentences} 条${st.sentences ? '' : ' —— 空库，等老人开口'}`);
  log(`  人物 ${st.persons} · 地点 ${st.places} · 原话 ${st.utterances} 句`);
  log(`  数据库   : ${path.relative(process.cwd(), st.dbFile)}   索引 ${st.indexed} 个词条`);
  log('─'.repeat(58));
  // 本地表情模型提前拉起来，别等第一次要用才慢
  try { visionWarmUp(); } catch { /* 起不来也不影响别的 */ }
});

// 退出时把 Python 子进程一起收掉，别留孤儿
for (const sig of ['SIGINT', 'SIGTERM', 'exit']) {
  process.on(sig, () => {
    try { stopFer(); } catch { /* ignore */ }
    try { stopAsr(); } catch { /* ignore */ }
    try { stopTts(); } catch { /* ignore */ }
    if (sig !== 'exit') {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 600);
    }
  });
}
