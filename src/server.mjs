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
import os from 'node:os';
import { PUBLIC_DIR, DATA_DIR, readBody, log, fmtTime, uid } from './util.mjs';
import { withDb, DB_LABEL, DEFAULT_ACCOUNT } from './mysql.mjs';
import { initAuth, register, login, sessionOf, logout, userCount, changePassword } from './auth.mjs';
import {
  stats, listSentences, deleteSentence, search, listEntities, recentUtterances, archive, dimensionMap, graph, dbTables, deleteDimension, updateSentence, pruneDimensions, getDb,
  openCandidates, listTopics, resetAll, dumpIndex, getSentence, DB_FILE, putNote, setSentenceTags, putPlaceGeo, getPlaceGeo, allPlaceNames,
  addPhoto, getPhoto, deletePhoto,
  saveMed, deleteMed, confirmMed,
  addReminder, listReminders, dueReminders, doneReminder, deleteReminder,
  addFamilyMessage, getFamilyMessage, listFamilyMessages, pendingFamilyMessages, markFamilyMessagesDelivered, markFamilyMessagesRead,
  addAlert, listAlerts, acknowledgeAlerts,
  getDailySummary, setDailyFeedback, dayOf,
} from './store.mjs';
import { handleTurn, opening, getPersona, setPersona, analyze, watchCheck, notePoll, ackSpoken, judgeTimes, watchState, watchConfigure, watchClearLog, watchSetMood, watchResetConfig, recentHistory, buildDailySummary, rememberFamilyMessage, resolvePeopleAliases, clearSessions } from './engine.mjs';
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

/** 记事本状态：还没到点的 + 已经到点等确认的 */
function reminderStatus() {
  const now = Date.now();
  const items = listReminders().map((r) => ({
    ...r,
    due: r.dueAt <= now,
    dueInMs: Math.max(0, r.dueAt - now),
  }));
  return { now, items, due: dueReminders(now) };
}
import { footprints, lookup, bboxOf, cityIn, simplifyMap } from './geo.mjs';
import { medStatus } from './meds.mjs';

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const PORT = Number(process.env.PORT || argOf('port', 3789));
const HOST = process.env.HOST || argOf('host', '127.0.0.1');

/* 记忆配图存放目录：备份 data/ 就把记忆和照片一起带走了 */
const PHOTO_DIR = path.join(DATA_DIR, 'photos');
fs.mkdirSync(PHOTO_DIR, { recursive: true });
const PHOTO_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

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

/* ---------------- 登录会话 ---------------- */
const SESSION_COOKIE = 'seyo_sid';
const SESSION_MAX_AGE = 30 * 24 * 3600;
/* 开发/自测时可用：SEYO_AUTH=off 跳过登录，所有数据落到默认账号库 */
const AUTH_OFF = process.env.SEYO_AUTH === 'off';

function cookieOf(req, name) {
  const raw = String(req.headers.cookie || '');
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}
function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}`);
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}
function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

/** 注册 / 登录 / 当前账号 / 退出 —— 不要求已登录 */
async function authEndpoint(req, res, pathname) {
  const method = req.method || 'GET';
  const token = cookieOf(req, SESSION_COOKIE);

  if (pathname === '/api/auth/register' && method === 'POST') {
    const body = await readBody(req);
    const r = register(body.username, body.password);
    if (r.ok) setSessionCookie(res, r.token);
    return json(res, r.ok ? 200 : 400, r);
  }
  if (pathname === '/api/auth/login' && method === 'POST') {
    const body = await readBody(req);
    const r = login(body.username, body.password);
    if (r.ok) setSessionCookie(res, r.token);
    return json(res, r.ok ? 200 : 400, r);
  }
  if (pathname === '/api/auth/logout' && method === 'POST') {
    logout(token);
    clearSessionCookie(res);
    return json(res, 200, { ok: true });
  }
  if (pathname === '/api/auth/me') {
    const s = sessionOf(token);
    if (!s) return json(res, 401, { ok: false, error: '还没登录' });
    return json(res, 200, { ok: true, user: { id: s.userId, username: s.username } });
  }
  if (pathname === '/api/auth/change-password' && method === 'POST') {
    const s = sessionOf(token);
    if (!s) return json(res, 401, { ok: false, error: '请先登录' });
    const body = await readBody(req);
    const r = changePassword(s.userId, body.oldPassword, body.newPassword, token);
    return json(res, r.ok ? 200 : 400, r);
  }
  return json(res, 404, { error: `未知接口 ${pathname}` });
}

/**
 * 所有普通接口先过登录，再在“这个账号自己的数据库”上下文里执行。
 * 注意：withDb 用 AsyncLocalStorage，engine 里 await 大模型之后上下文仍然在。
 */
async function api(req, res, pathname, query) {
  if (pathname === '/api/health') return json(res, 200, { ok: true, time: fmtTime(), db: DB_LABEL });
  if (pathname.startsWith('/api/auth/')) return authEndpoint(req, res, pathname);
  if (AUTH_OFF) return withDb(DEFAULT_ACCOUNT, () => apiInner(req, res, pathname, query));
  const sess = sessionOf(cookieOf(req, SESSION_COOKIE));
  if (!sess) return json(res, 401, { error: '请先登录', login: true });
  return withDb(sess.accountDb, () => apiInner(req, res, pathname, query));
}

/**
 * 足迹数据 —— 地图页和「合并叙述」必须**算同一份**。
 * 老家坐标只传一半会出岔子：`hometownCoord` 没给时，只能按老家兜底定位的地点
 * 会算成"没定位"，旗子合并结果和缓存键都不一样了，
 * 于是地图浮窗里存下的那句话永远对不上（看起来就是"合并不上"）。
 */
function footprintData() {
  const persona = getPersona();
  const home = persona.hometown
    ? (lookup(persona.hometown) || cityIn(persona.hometown)?.coord || null)
    : null;
  return footprints(getDb(), { hometown: persona.hometown || '', hometownCoord: home });
}

async function apiInner(req, res, pathname, query) {
  const method = req.method || 'GET';
  /* 照片是 base64 传上来的，比普通 JSON 大 —— 这条接口单独放宽 */
  const body = method === 'POST' || method === 'PATCH' || method === 'DELETE'
    ? await readBody(req, pathname === '/api/photos' ? 16 * 1024 * 1024 : 2 * 1024 * 1024)
    : {};

  if (pathname === '/api/health') {
    return json(res, 200, { ok: true, time: fmtTime(), stats: stats(), persona: getPersona() });
  }

  // 页面刷新后恢复最近几条对话（不触发新的开场白）
  if (pathname === '/api/history') {
    const sessionId = String(query.get('sessionId') || 'default');
    return json(res, 200, { items: recentHistory(sessionId, query.get('limit') || 10) });
  }

  /* ---------------- 家人远程：消息 ---------------- */
  if (pathname === '/api/family/messages' && method === 'GET') {
    const items = listFamilyMessages(query.get('limit') || 100);
    markFamilyMessagesRead();
    return json(res, 200, { items });
  }
  if (pathname === '/api/family/messages' && method === 'POST') {
    const text = String(body.text || '').trim();
    if (!text) return json(res, 400, { ok: false, error: '消息不能为空' });
    addFamilyMessage({ sender: 'family', kind: 'text', text });
    return json(res, 200, { ok: true, items: listFamilyMessages(100) });
  }
  // 老人端轮询：孩子发来的、还没念过的
  if (pathname === '/api/family/pending' && method === 'GET') {
    return json(res, 200, { items: pendingFamilyMessages(20) });
  }
  if (pathname === '/api/family/ack' && method === 'POST') {
    const ids = Array.isArray(body.ids) ? body.ids : [];
    const sessionId = String(body.sessionId || 'default');
    // 先把孩子的话补进老人端会话历史，再标记送达 —— 这样刷新后还在
    for (const id of ids) {
      const m = getFamilyMessage(id);
      if (m && !m.delivered_at) rememberFamilyMessage(sessionId, m);
    }
    return json(res, 200, { ok: true, count: markFamilyMessagesDelivered(ids) });
  }

  /* ---------------- 求助警报 ---------------- */
  if (pathname === '/api/alerts' && method === 'GET') {
    return json(res, 200, {
      items: listAlerts({
        status: String(query.get('status') || ''),
        limit: query.get('limit') || 30,
      }),
    });
  }
  if (pathname === '/api/alerts' && method === 'POST') {
    const item = addAlert({
      source: String(body.source || 'self').slice(0, 32),
      reason: String(body.reason || '').slice(0, 500),
      detail: String(body.detail || '').slice(0, 5000),
    });
    return json(res, 200, { ok: true, item });
  }
  if (pathname === '/api/alerts/ack' && method === 'POST') {
    const ids = Array.isArray(body.ids) ? body.ids : [];
    return json(res, 200, { ok: true, count: acknowledgeAlerts(ids) });
  }

  /* ---------------- 家人远程：当天总结 ---------------- */
  if (pathname === '/api/daily' && method === 'GET') {
    const day = String(query.get('date') || dayOf(Date.now()));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return json(res, 400, { ok: false, error: '日期格式不对' });
    const summary = await buildDailySummary(day);
    return json(res, 200, { ok: true, day, summary });
  }
  if (pathname === '/api/daily/feedback' && method === 'POST') {
    const day = String(body.day || dayOf(Date.now()));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return json(res, 400, { ok: false, error: '日期格式不对' });
    await buildDailySummary(day);
    const summary = setDailyFeedback(day, {
      liked: Boolean(body.liked),
      reply: body.reply == null ? null : String(body.reply).slice(0, 500),
    });
    if (body.liked) {
      addFamilyMessage({ sender: 'family', kind: 'like', text: '孩子给您今天的聊天点了个赞。' });
    }
    if (body.reply != null && String(body.reply).trim()) {
      addFamilyMessage({ sender: 'family', kind: 'summary_reply', text: String(body.reply).trim().slice(0, 500) });
    }
    return json(res, 200, { ok: true, summary });
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
  // 节奏类的最小 1 分钟：调试时写进去的 1 毫秒会一直显示"再过 0 分钟"。
  if (pathname === '/api/watch/config') {
    if (method === 'POST') {
      const patch = { ...body };
      for (const k of ['idleMs', 'debounceMs', 'minGapMs', 'sadRepeatMs']) {
        if (patch[k] != null) patch[k] = Math.max(60_000, Number(patch[k]) || 60_000);
      }
      return json(res, 200, watchConfigure(patch));
    }
    if (method === 'DELETE') return json(res, 200, { reset: true, config: watchResetConfig() });
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
    /* 一个时间段 / 一个地点里散着好几条记忆（同一件事）→ 合成一句话 */
    const arch = archive();
    const foot = footprintData();
    const todo = [
      ...(arch.timeline || []).filter((g) => g.items.length >= 2 && !g.note)
        .map((g) => ({ key: g.key, label: g.label, items: g.items })),
      /* footprints() 直接返回地点数组（不是 { places }）—— 这里以前按对象取，
         永远拿到空列表，所以地图浮窗的"合并叙述"一次都没生成过。 */
      ...(foot || []).filter((p) => p.located && p.needNote)
        .map((p) => {
          /* 同一句话可能在城市和具体地点下各挂了一次，喂给模型前先去掉重复；
             去完只剩一条就没有"合并"可言，别浪费一次调用。 */
          const seen = new Set();
          const items = (p.memories || []).filter((m) => {
            const t = String(m.statement || '').trim();
            if (!t || seen.has(t)) return false;
            seen.add(t);
            return true;
          }).map((m) => ({ statement: m.statement }));
          return { key: p.key, label: p.label, items };
        })
        .filter((g) => g.items.length >= 2),
    ].filter((g) => g.key);
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
    /* 改时间 / 人物 / 地点 / 事件标签（家人端手改） */
    if (method === 'POST') {
      const one = setSentenceTags(id, body || {});
      return json(res, one ? 200 : 404, one ? { ok: true, item: one, stats: stats() } : { error: '未找到' });
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
    const list = footprintData();
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

  /* ---------------- 记忆配图（家人端上传） ----------------
     照片挂在"记忆"（一条主句）上：时间轴卡片显示组里各条记忆的照片，
     地图浮窗显示这个地点相关记忆的照片。文件在 data/photos/，库里只存文件名。 */
  if (pathname === '/api/photos' && method === 'POST') {
    const sentenceId = String(body.sentenceId || '').trim();
    if (!sentenceId || !getSentence(sentenceId)) return json(res, 400, { ok: false, error: '没有找到这条记忆，没法挂照片' });
    const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/.exec(String(body.dataUrl || ''));
    if (!m) return json(res, 400, { ok: false, error: '图片格式不对（只收 jpg / png / webp / gif）' });
    const mime = m[1];
    const ext = PHOTO_EXT[mime] || 'jpg';
    const buf = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
    if (!buf.length) return json(res, 400, { ok: false, error: '图片是空的' });
    if (buf.length > 12 * 1024 * 1024) return json(res, 413, { ok: false, error: '图片太大（最多 12MB）' });
    const id = uid('ph');
    const file = id + '.' + ext;
    try {
      fs.writeFileSync(path.join(PHOTO_DIR, file), buf);
    } catch (e) {
      return json(res, 500, { ok: false, error: '照片存不下来：' + e.message });
    }
    const photo = addPhoto({ id, sentenceId, file, mime, caption: String(body.caption || '').slice(0, 120) });
    if (!photo) {
      try { fs.unlinkSync(path.join(PHOTO_DIR, file)); } catch { /* ignore */ }
      return json(res, 500, { ok: false, error: '照片记录写不进库' });
    }
    return json(res, 200, { ok: true, photo });
  }
  if (pathname.startsWith('/api/photos/') && method === 'GET') {
    const id = pathname.slice('/api/photos/'.length);
    const p = getPhoto(id);
    if (!p) return json(res, 404, { error: '没有这张照片' });
    const f = path.join(PHOTO_DIR, p.file);
    if (!fs.existsSync(f)) return json(res, 404, { error: '照片文件不见了' });
    return send(res, 200, fs.readFileSync(f), {
      'Content-Type': p.mime || 'image/jpeg',
      // 文件名带唯一 id，内容不会变 —— 浏览器可以放心长缓存
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
  }
  if (pathname.startsWith('/api/photos/') && method === 'DELETE') {
    const id = pathname.slice('/api/photos/'.length);
    const p = deletePhoto(id);
    if (!p) return json(res, 404, { ok: false, error: '没有这张照片' });
    try { fs.unlinkSync(path.join(PHOTO_DIR, p.file)); } catch { /* 文件没了也无所谓 */ }
    return json(res, 200, { ok: true, id });
  }

  /* ---------------- 吃药提醒 ----------------
     药名 + 每天几个时间点；页面自己轮询 /api/meds，到点提醒，
     没确认就一直提醒。确认只记"这顿"（药 + 日期 + 时间）。 */
  if (pathname === '/api/meds' && method === 'GET') return json(res, 200, medStatus());
  if (pathname === '/api/meds' && method === 'POST') {
    const out = saveMed(body);
    if (!out.ok) return json(res, 400, out);
    return json(res, 200, { ...out, ...medStatus() });
  }
  if (pathname.startsWith('/api/meds/') && method === 'DELETE') {
    const id = pathname.slice('/api/meds/'.length);
    const ok = deleteMed(id);
    return json(res, ok ? 200 : 404, { ok, ...(ok ? medStatus() : { error: '没有这个药' }) });
  }
  if (pathname === '/api/meds/confirm' && method === 'POST') {
    const got = confirmMed(String(body.medId || ''), String(body.slot || ''));
    if (!got) return json(res, 400, { ok: false, error: '这条用药记录对不上' });
    return json(res, 200, { ok: true, ...got, ...medStatus() });
  }

  /* ---------------- 记事本 / 到点提醒 ----------------
     老人说"5 分钟后提醒我关火" → 引擎存一条；
     老人端每 5 秒轮询一次 /api/reminders，到点弹卡片，点"知道了"才算完。 */
  if (pathname === '/api/reminders' && method === 'GET') return json(res, 200, reminderStatus());
  if (pathname === '/api/reminders' && method === 'POST') {
    const dueAt = body.dueAt != null
      ? Number(body.dueAt)
      : Date.now() + Math.max(0, Number(body.delayMs) || 0);
    const item = addReminder({ text: body.text, dueAt, session: body.session || 'default' });
    if (!item) return json(res, 400, { ok: false, error: '要说清楚提醒什么、什么时候' });
    return json(res, 200, { ok: true, item, ...reminderStatus() });
  }
  if (pathname.startsWith('/api/reminders/') && method === 'POST') {
    const rest = pathname.slice('/api/reminders/'.length);
    if (rest.endsWith('/done')) {
      const item = doneReminder(rest.slice(0, -'/done'.length));
      return json(res, item ? 200 : 404, { ok: Boolean(item), item, ...(item ? reminderStatus() : { error: '没有这条提醒' }) });
    }
  }
  if (pathname.startsWith('/api/reminders/') && method === 'DELETE') {
    const id = pathname.slice('/api/reminders/'.length);
    const ok = deleteReminder(id);
    return json(res, ok ? 200 : 404, { ok, ...(ok ? reminderStatus() : { error: '没有这条提醒' }) });
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
    // 加载人物图谱前先让 AI 归并同一个人（如“小陈”和“儿子”）
    try { await resolvePeopleAliases(); } catch { /* 归并失败不影响页面 */ }
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
  if (pathname === '/api/reset' && method === 'POST') {
    const result = resetAll({ keepPersona: body.keepPersona === true });
    clearSessions();
    return json(res, 200, result);
  }
  if (pathname === '/api/dump' && method === 'POST') return json(res, 200, dumpIndex());
  if (pathname === '/api/db' && method === 'GET') {
    // 现在数据在 MySQL 里，不再有 .db 文件可下载；导出一份 JSON 方便家人备份/查看
    const payload = {
      exported_at: fmtTime(),
      database: DB_LABEL,
      stats: stats(),
      tables: dbTables(),
    };
    const buf = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
    return send(res, 200, buf, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="seyo-data.json"`,
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

const PROTECTED_PAGES = new Set(['/', '/index.html', '/family.html', '/remote.html', '/avatar-test.html']);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  try {
    const sess = AUTH_OFF ? { accountDb: DEFAULT_ACCOUNT } : sessionOf(cookieOf(req, SESSION_COOKIE));
    if (url.pathname.startsWith('/api/')) return await api(req, res, url.pathname, url.searchParams);

    if (url.pathname === '/login' || url.pathname === '/login.html') {
      const next = url.searchParams.get('next') || '/';
      if (sess) return redirect(res, next.startsWith('/') && !next.startsWith('//') ? next : '/');
      return staticFile(res, '/login.html');
    }
    if (PROTECTED_PAGES.has(url.pathname)) {
      if (!sess) return redirect(res, '/login?next=' + encodeURIComponent(url.pathname));
      return staticFile(res, url.pathname);
    }
    return staticFile(res, url.pathname);
  } catch (e) {
    log('异常：', e?.message || e);
    json(res, 500, { error: e?.message || '服务内部错误' });
  }
});

try { initAuth(); } catch (e) { log('初始化登录库失败：', e.message); }

server.listen(PORT, HOST, () => {
  log('─'.repeat(58));
  log('Seyo（岁语）智能体已启动');
  log(`  对话界面 : http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}/`);
  log(`  数据库   : ${DB_LABEL}（已注册账号 ${userCount()} 个）`);
  log(`  登录入口 : http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}/login`);
  if (HOST === '0.0.0.0') {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list || []) {
        if (a.family === 'IPv4' && !a.internal) {
          log(`  家人远程 : http://${a.address}:${PORT}/remote.html`);
        }
      }
    }
  }
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
