/**
 * 独立数据库层
 *
 * 数据库：<项目>/data/seyo.db（SQLite，独立文件，可用任意 SQLite 工具打开）
 *    utterances  原话留档（一字不改）
 *    sentences   主句库：陈述主句 + 疑问形式 + 关键词 + 实体 + 时间 + 置信度 + 状态
 *    candidates  待确认队列（老人点头后才算正式档案）
 *    people      人物维度（含别名合并：老张 / 张师傅 / 张建国 = 同一人）
 *    times       时间维度（含模糊时间归一化：原话 + 归一后的年份/区间）
 *    places      地点维度
 *    events      事件维度
 *    *_links     记忆 ↔ 四个维度的关联表（一条主句 = 一段记忆）
 *    topics      话题断点
 *    meta        杂项（人设等）
 *
 * 检索：进程内倒排索引（字面 n-gram → 主句 id），全部走字面重合度打分。
 *       实测能对上老人换过说法的问句（"我以前是干啥工作的来着？" → "我在纺织厂当挡车工"）。
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, uid, nowISO, DATA_DIR, log } from './util.mjs';
import { bare, grams, personKey, keywords as kwOf, queryKinds, sentenceKinds } from './text.mjs';
import { attachDimensions, browseArchive, archiveSummary, resolveTime, saveTime, savePlace, savePerson, saveEvent } from './archive.mjs';

const DB_FILE = path.join(DATA_DIR, 'seyo.db');
const INDEX_FILE = path.join(DATA_DIR, 'index.json');

/** 每条主句的话题类别缓存（id → Set） */
const kindCache = new Map();

export const db = new DatabaseSync(DB_FILE);

db.exec(`
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS utterances (
  id         TEXT PRIMARY KEY,
  session    TEXT NOT NULL,
  role       TEXT NOT NULL,
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_utt_time ON utterances(created_at DESC);

CREATE TABLE IF NOT EXISTS sentences (
  id          TEXT PRIMARY KEY,
  seq         INTEGER,
  statement   TEXT NOT NULL,          -- 主句（陈述）
  asks        TEXT NOT NULL DEFAULT '[]', -- 疑问形式（老人可能会怎么问）
  keywords    TEXT NOT NULL DEFAULT '[]',
  persons     TEXT NOT NULL DEFAULT '[]',
  places      TEXT NOT NULL DEFAULT '[]',
  events      TEXT NOT NULL DEFAULT '[]',
  time_raw    TEXT NOT NULL DEFAULT '',
  time_label  TEXT NOT NULL DEFAULT '',
  year        INTEGER,
  confidence  REAL NOT NULL DEFAULT 0.6,
  status      TEXT NOT NULL DEFAULT 'pending',   -- pending | confirmed
  source      TEXT NOT NULL DEFAULT '',
  session     TEXT NOT NULL DEFAULT '',
  asked_count INTEGER NOT NULL DEFAULT 0,
  told_count  INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sent_seq ON sentences(seq);
CREATE INDEX IF NOT EXISTS idx_sent_status ON sentences(status);

CREATE TABLE IF NOT EXISTS candidates (
  id          TEXT PRIMARY KEY,
  sentence_id TEXT,
  question    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open',
  created_at  TEXT NOT NULL,
  resolved_at TEXT
);


CREATE TABLE IF NOT EXISTS topics (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  last_said  TEXT NOT NULL DEFAULT '',
  ask_count  INTEGER NOT NULL DEFAULT 0,
  avoid_count INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'open',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

/* ------------------------------------------------------------------ *
 * 记忆档案库的四个维度（对应产品说明：人物 / 时间 / 地点 / 事件）
 * 每个维度有自己的表和 id，用关联表挂到"记忆"（一条主句即一段记忆）上，
 * 这样既能按维度筛选浏览，也能做人物实体合并与模糊时间归一化。
 * ------------------------------------------------------------------ */

CREATE TABLE IF NOT EXISTS people (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,              -- 主名（取最正式的那个叫法）
  alias_key  TEXT NOT NULL,              -- 归一后的键：老张 / 张师傅 / 张建国 → 同一人
  aliases    TEXT NOT NULL DEFAULT '[]', -- 老人用过的所有叫法
  relation   TEXT NOT NULL DEFAULT '',   -- 关系：老伴 / 儿子 / 师傅 / 工友…
  count      INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_seen  TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_people_key ON people(alias_key);

CREATE TABLE IF NOT EXISTS times (
  id         TEXT PRIMARY KEY,
  key        TEXT NOT NULL,              -- 归一键：abs:1950 / age:二十来岁 / era:文革
  raw        TEXT NOT NULL,              -- 老人原话（保留）
  label      TEXT NOT NULL,              -- 归一后的说法
  kind       TEXT NOT NULL DEFAULT 'other', -- abs | age | life | era | other
  year       INTEGER,                    -- 单一确定年份
  from_year  INTEGER,                    -- 区间起
  to_year    INTEGER,                    -- 区间止
  circa      INTEGER NOT NULL DEFAULT 0, -- 是否为约数
  basis      TEXT NOT NULL DEFAULT '',   -- 归一依据（按出生年推算 / 保留原说法）
  count      INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_seen  TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_times_key ON times(key);
CREATE INDEX IF NOT EXISTS idx_times_year ON times(year);

CREATE TABLE IF NOT EXISTS places (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  label      TEXT NOT NULL DEFAULT '',   -- 展示名（"沈阳·纺织厂"）；地图上插旗用它
  kind       TEXT NOT NULL DEFAULT '',   -- 城市 / 厂矿 / 村庄 / 院子 …
  count      INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_seen  TEXT NOT NULL
);
-- 同名地点在不同城市要分开："沈阳·纺织厂" 和 "北京·纺织厂" 是两条
CREATE UNIQUE INDEX IF NOT EXISTS idx_places_label ON places(label);
CREATE INDEX IF NOT EXISTS idx_places_name ON places(name);

CREATE TABLE IF NOT EXISTS events (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,              -- 事件（住宿舍 / 分房 / 当兵 / 出嫁…）
  raw        TEXT NOT NULL DEFAULT '',   -- 当时的原话
  count      INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_seen  TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_name ON events(name);

CREATE TABLE IF NOT EXISTS person_links (sentence_id TEXT NOT NULL, person_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (sentence_id, person_id));
CREATE TABLE IF NOT EXISTS time_links   (sentence_id TEXT NOT NULL, time_id   TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (sentence_id, time_id));
CREATE TABLE IF NOT EXISTS place_links  (sentence_id TEXT NOT NULL, place_id  TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (sentence_id, place_id));
CREATE TABLE IF NOT EXISTS event_links  (sentence_id TEXT NOT NULL, event_id  TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (sentence_id, event_id));
`);

/* ================================================================== *
 * 内存倒排索引
 * ================================================================== */

/** gram → Set<句子 id> */
const inverted = new Map();
/** id → 该句的全部 gram */
const docGrams = new Map();

function indexAdd(id, text) {
  const gs = grams(text);
  docGrams.set(id, gs);
  for (const g of gs) {
    if (!inverted.has(g)) inverted.set(g, new Set());
    inverted.get(g).add(id);
  }
}

function indexRemove(id) {
  const gs = docGrams.get(id);
  if (!gs) return;
  for (const g of gs) {
    const set = inverted.get(g);
    if (set) {
      set.delete(id);
      if (!set.size) inverted.delete(g);
    }
  }
  docGrams.delete(id);
}

const rowCache = new Map();

function hydrate(row) {
  if (!row) return null;
  return {
    ...row,
    asks: JSON.parse(row.asks || '[]'),
    keywords: JSON.parse(row.keywords || '[]'),
    persons: JSON.parse(row.persons || '[]'),
    places: JSON.parse(row.places || '[]'),
    events: JSON.parse(row.events || '[]'),
  };
}

export function getSentence(id) {
  const row = db.prepare('SELECT * FROM sentences WHERE id = ?').get(id);
  return hydrate(row);
}

/** 启动时把已入库的主句读进索引 */
function loadIndex() {
  const rows = db.prepare('SELECT id, statement, asks, keywords, persons, places, events FROM sentences').all();
  for (const r of rows) {
    const s = hydrate(r);
    indexAdd(s.id, `${s.statement} ${s.asks.join(' ')} ${s.keywords.join(' ')} ${[...s.persons, ...s.places, ...s.events].join(' ')}`);
  }
  return rows.length;
}
// 老库缺列自动补上（升级时不用重建数据库）
const _addedCols = ensureColumns();
if (_addedCols.length) log(`数据库升级：补了 ${_addedCols.join('、')}`);

/* ------------------------------------------------------------------ *
 * 一次性迁移：核对流程已经砍掉
 * ------------------------------------------------------------------
 * 以前记忆是两档的：pending（等老人点头）→ confirmed（他点头了才算数）。
 * 现在不问了，老人说什么就直接记下。所以老库里那些挂着 pending 的
 * 要一次性转正 —— 否则家人端会一直显示"待确认"，而那些永远不会有人去确认了。
 * ------------------------------------------------------------------ */
try {
  const stuck = db.prepare("SELECT COUNT(*) c FROM sentences WHERE status <> 'confirmed'").get().c;
  if (stuck > 0) {
    db.prepare("UPDATE sentences SET status = 'confirmed' WHERE status <> 'confirmed'").run();
    db.prepare("UPDATE candidates SET status = 'accepted', resolved_at = ? WHERE status = 'open'")
      .run(new Date().toISOString());
    log(`数据库升级：核对流程已取消，把 ${stuck} 条"待确认"的记忆直接转为已记下`);
  }
} catch (e) {
  log('迁移待确认记忆失败（不影响使用）：', e.message);
}

export const indexedCount = loadIndex();

/* ================================================================== *
 * 主句库：写入
 * ================================================================== */

function nextSeq() {
  return Number(db.prepare('SELECT COALESCE(MAX(seq),0) m FROM sentences').get()?.m || 0) + 1;
}

/** 相邻双字组 */
function bigrams(text = '') {
  const s = String(text).replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
  const out = new Set();
  for (let i = 0; i + 2 <= s.length; i += 1) out.add(s.slice(i, i + 2));
  return out;
}

/** 最长公共子串长度（连续汉字）——中文里判断"是不是同一件事"最靠谱的判据 */
function longestCommonRun(a = '', b = '') {
  const x = String(a).replace(/[^\u4e00-\u9fa5]/g, '');
  const y = String(b).replace(/[^\u4e00-\u9fa5]/g, '');
  if (!x || !y) return 0;
  let best = 0;
  let prev = new Array(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i += 1) {
    const cur = new Array(y.length + 1).fill(0);
    for (let j = 1; j <= y.length; j += 1) {
      if (x[i - 1] === y[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      }
    }
    prev = cur;
  }
  return best;
}

const TIME_FILLER = /(二十来岁|二十出头|三十来岁|三十多岁|四十来岁|五十来岁|年轻时候|年轻那会儿|小时候|那会儿|那时候|当时|那年|这年|后来|以前|之后|刚参加工作|退休前|退休那年|结婚前|结婚那年|来岁|多岁|出头|岁那年|那年我)/g;

/** 去掉时间状语（"我年轻时候在纺织厂当挡车工" → "我在纺织厂当挡车工"） */
const stripTime = (s = '') => String(s).replace(TIME_FILLER, '');

/**
 * 同一件事换种说法又讲一遍 → 合并，不重复入库
 * 判据（满足其一即算同一件事）：
 *   ① 最长公共片段覆盖较短那句的 75%（"我年轻时候在纺织厂当挡车工" ⊂ 原句）
 *   ② 去掉时间状语之后，最长公共片段覆盖较短那句的 75%
 *      （"我年轻时候在纺织厂当挡车工" 与 "我二十来岁那年在纺织厂当挡车工…" 只差时间状语）
 */
function findDuplicate(statement) {
  const key = bare(statement).replace(/[^\u4e00-\u9fa5]/g, '');
  if (key.length < 5) return null;
  const keyStripped = stripTime(key);

  const cands = new Set();
  for (const g of grams(key)) {
    const set = inverted.get(g);
    if (!set) continue;
    for (const id of set) cands.add(id);
  }

  let best = null;
  for (const id of cands) {
    const row = getSentence(id);
    if (!row) continue;
    const other = bare(row.statement).replace(/[^\u4e00-\u9fa5]/g, '');
    const otherStripped = stripTime(other);

    const shorter = key.length <= other.length ? key : other;
    const run = longestCommonRun(key, other);
    const cover = run / shorter.length;

    const s2 = keyStripped.length <= otherStripped.length ? keyStripped : otherStripped;
    const run2 = longestCommonRun(keyStripped, otherStripped);
    const cover2 = s2.length ? run2 / s2.length : 0;

    const hit = (run >= 5 && cover >= 0.75) || (run2 >= 4 && cover2 >= 0.75);
    if (!hit) continue;

    // 地点对不上就不是同一件事
    const samePlace = !(row.places || []).length || (row.places || []).some((p) => statement.includes(p));
    if (!samePlace) continue;

    const score = Math.max(cover, cover2);
    if (!best || score > best.overlap) best = { id, overlap: Number(score.toFixed(3)), run: Math.max(run, run2), row };
  }
  return best;
}

/** 实体落库（四个维度各有自己的表；这里只做"提及次数"记账） */
function rememberEntity(kind, names) {
  const list = Array.isArray(names) ? names : [names];
  for (const name of list) {
    if (!name) continue;
    const dim = kind === 'person' ? 'person' : kind === 'place' ? 'place' : 'event';
    if (dim === 'person') savePerson(db, name, personKey(name));
    else if (dim === 'place') savePlace(db, name);
    else saveEvent(db, name);
  }
}

/** 这条记忆挂在四个维度上的条目 */
export function dimensionMap(sentenceId) {
  const DIM_TABLE = { person: 'people', time: 'times', place: 'places', event: 'events' };
  const one = (dim) => db.prepare(
    `SELECT d.* FROM ${DIM_TABLE[dim]} d JOIN ${dim}_links l ON l.${dim}_id = d.id WHERE l.sentence_id = ?`,
  ).all(sentenceId);
  return {
    persons: one('person').map((p) => ({ id: p.id, name: p.name, aliases: JSON.parse(p.aliases || '[]') })),
    times: one('time').map((t) => ({ id: t.id, raw: t.raw, label: t.label, year: t.year, from: t.from_year, to: t.to_year, circa: Boolean(t.circa), basis: t.basis })),
    places: one('place').map((p) => ({ id: p.id, name: p.name })),
    events: one('event').map((e) => ({ id: e.id, name: e.name })),
  };
}

/** 记忆档案库：四维浏览 */
export function archive(opts = {}) {
  return browseArchive(db, opts);
}

export { archiveSummary, resolveTime };

/**
 * 入库一条记忆
 * @returns {{action:'created'|'merged'|'skipped', sentence?:object, id?:string}}
 */
export function addSentence(a, meta = {}) {
  const statement = bare(a.statement);
  if (statement.replace(/[^\u4e00-\u9fa5]/g, '').length < 3) return { action: 'skipped' };
  /* 身份信息（名字、生日、属相）人设里已经有了，不必再当"记忆"占位。
     但**原来这条写得太宽**：`^我今年` 也在里面，于是
       "我今年七十八了"        → 整句丢掉
       "我今年七十八，还能自己做饭" → 也整句丢掉（后半句明明是正经记忆）
     "我今年" 是老人最常见的开场白之一，这一条吞掉了大量真实记忆。

     现在两层收紧：
       · 去掉 "我今年"（年龄是变化的、值得记）
       · 只在**整句就是个身份声明**（很短、没别的信息）时才跳过 */
  const IDENTITY = /^(我叫|我的名字|我姓|我小名|我生日|我属|我是[\u4e00-\u9fa5]{1,3})$/;
  if (IDENTITY.test(statement) && statement.length <= 10) return { action: 'skipped' };

  const dup = findDuplicate(statement);
  if (dup) {
    // 合并时不能丢信息：新句更长、或带来了年份，就把内容与时间一起并进那条
    const old = dup.row;
    const oldYear = old.year !== null && old.year !== undefined;
    const newYear = a.times?.find((t) => t.year)?.year;
    const better = statement.length >= bare(old.statement).length || (newYear && !oldYear);
    if (better) {
      const t0 = a.times?.find((t) => t.year) || a.times?.[0] || {};
      db.prepare(
        `UPDATE sentences SET statement = ?, time_raw = COALESCE(NULLIF(?,''), time_raw),
           time_label = COALESCE(NULLIF(?,''), time_label), year = COALESCE(?, year),
           keywords = ?, persons = ?, places = ?, events = ?,
           told_count = told_count + 1, updated_at = ?, confidence = MAX(confidence, ?)
         WHERE id = ?`,
      ).run(
        statement, t0.raw || '', t0.label || '', t0.year ?? null,
        JSON.stringify(a.keywords || []), JSON.stringify(a.persons || []),
        JSON.stringify(a.places || []), JSON.stringify(a.events || []),
        nowISO(), a.confidence ?? 0.6, dup.id,
      );
      const row = getSentence(dup.id);
      indexRemove(dup.id);
      indexAdd(dup.id, `${row.statement} ${row.asks.join(' ')} ${row.keywords.join(' ')} ${[...row.persons, ...row.places, ...row.events].join(' ')}`);
      rememberEntity('person', row.persons);
      rememberEntity('place', row.places);
      rememberEntity('event', row.events);
      // 补齐这条记忆的四个维度：要带上原有的，不能只用这次的新碎片
      //   （只用碎片会把"北京·院子"退化成裸"院子"）
      const merged = {
        ...a,
        statement: row.statement,
        times: [...(row.times || []), ...(a.times || [])].filter((t, i, arr) => arr.findIndex((x) => x.label === t.label) === i),
        persons: [...new Set([...(row.persons || []), ...(a.persons || [])])],
        places: [...new Set([...(row.places || []), ...(a.places || [])])],
        events: [...new Set([...(row.events || []), ...(a.events || [])])],
      };
      attachDimensions(db, dup.id, merged, { birthYear: meta.birthYear ?? null });
      return { action: 'merged', id: dup.id, sentence: getSentence(dup.id), overlap: dup.overlap, dims: dimensionMap(dup.id) };
    }
    db.prepare('UPDATE sentences SET told_count = told_count + 1, updated_at = ?, confidence = MAX(confidence, ?) WHERE id = ?')
      .run(nowISO(), a.confidence ?? 0.6, dup.id);
    return { action: 'merged', id: dup.id, sentence: getSentence(dup.id), overlap: dup.overlap, dims: dimensionMap(dup.id) };
  }

  const id = uid('s');
  const seq = nextSeq();
  const now = nowISO();
  const asks = (a.askForms || []).slice(0, 5);
  const t0 = (a.times || [])[0] || {};
  // 模糊时间归一化：有出生年就把"二十来岁"落成区间；没有就只保留原说法
  const tNorm = t0.raw ? resolveTime(t0, meta.birthYear ?? null) : {};
  db.prepare(
    `INSERT INTO sentences
     (id, seq, statement, polished, life_event, asks, keywords, persons, places, events, time_raw, time_label, year,
      confidence, status, source, session, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id, seq, statement, String(a.polished || ''), Number.isFinite(a.lifeEvent) ? a.lifeEvent : null, JSON.stringify(asks), JSON.stringify(a.keywords || []),
    JSON.stringify(a.persons || []), JSON.stringify(a.places || []), JSON.stringify(a.events || []),
    t0.raw || '', (tNorm.label || t0.label || ''), (t0.year ?? tNorm.from ?? null),
    a.confidence ?? 0.6, meta.status || 'pending', meta.source || '', meta.session || '',
    now, now,
  );

  const row = getSentence(id);
  indexAdd(id, `${row.statement} ${row.asks.join(' ')} ${row.keywords.join(' ')} ${[...row.persons, ...row.places, ...row.events].join(' ')}`);
  rememberEntity('person', row.persons);
  rememberEntity('place', row.places);
  rememberEntity('event', row.events);
  const dims = attachDimensions(db, id, a, { birthYear: meta.birthYear ?? null });
  return { action: 'created', id, sentence: row, dims };
}

/* ================================================================== *
 * 主句库：检索（字面重合度打分）
 * ================================================================== */

const IGNORE_ASK = new Set(['你还记得吗', '记得吗', '你还记得', '还记得', '你还记不记得', '来着']);

function askGrams(asks = []) {
  const out = new Set();
  for (const a of asks) for (const g of grams(String(a).replace(/你还记得吗|记得吗|还记得|来着/g, ''))) out.add(g);
  return out;
}

/**
 * 按老人的问法检索主句库
 * @param {string} query 老人这句话
 * @param {object} a     analyze() 的结果
 * @returns {Array} 命中，按相关度排序，带分项得分
 */
export function search(query, a = {}) {
  const docTotal = docGrams.size || 1;
  const qGrams = a.grams || grams(query);
  const qKw = a.keywords || kwOf(query);
  const qPersons = a.persons || [];
  const qPlaces = a.places || [];
  const qEvents = a.events || [];
  const qTimes = a.times || [];
  const qKinds = queryKinds(query);
  /** 按称呼直接命中的次数（"老张是谁" → 含"老张"的那些记录） */
  const nameHits = new Map();

  // ① 倒排索引取候选
  const hitCount = new Map();
  for (const g of qGrams) {
    const set = inverted.get(g);
    if (!set) continue;
    for (const id of set) hitCount.set(id, (hitCount.get(id) || 0) + 1);
  }
  // ② 话题类别直查：问"干啥工作的"时，把带 work 类别的记录捞进候选
  if (qKinds.length) {
    for (const row of listSentences({ limit: 5000 })) {
      const sk = sentenceKinds(row);
      kindCache.set(row.id, sk);
      if (qKinds.some((k) => sk.has(k)) && !hitCount.has(row.id)) hitCount.set(row.id, 1);
    }
  }
  // ③ 实体/关键词直查兜底
  for (const term of [...qPersons, ...qPlaces, ...qEvents, ...qKw.slice(0, 6)]) {
    if (term.length < 2) continue;
    for (const [g, set] of inverted) {
      if (g.length >= 2 && (g === term || (term.length >= 3 && (g.includes(term) || term.includes(g)) && g.length >= 2))) {
        for (const id of set) if (!hitCount.has(id)) hitCount.set(id, 1);
      }
    }
  }
  // ④ 称呼直查：老人问"老张是谁来着"，而人物名可能没被抽出来 —— 直接按字面捞
  const nameProbe = [];
  for (const m of String(query).matchAll(/[老小][\u4e00-\u9fa5]|[\u4e00-\u9fa5](?:师傅|大夫|老师|会计)/g)) nameProbe.push(m[0]);
  for (const n of [...new Set(nameProbe)]) {
    for (const row of listSentences({ limit: 5000 })) {
      if (row.statement.includes(n)) {
        if (!hitCount.has(row.id)) hitCount.set(row.id, 1);
        nameHits.set(row.id, (nameHits.get(row.id) || 0) + 1);
      }
    }
  }

  const scored = [];
  for (const id of hitCount.keys()) {
    const row = getSentence(id);
    if (!row) continue;

    const dGrams = docGrams.get(id) || new Set();
    // 字面重合度 = 这句话的片段有多少真的出现在**这一条**记录里。
    // 两点必须守住，否则会凭空"对上"：
    //   ① 只看这一条的片段集合（不是"只要索引里有就算"，那是别条的内容）
    //   ② 权重按稀有度，满库都有的片段（"我在""在纺"）计 0 分
    let inter = 0;
    let weightSum = 0;
    for (const g of qGrams) {
      const df = inverted.get(g)?.size || 0;
      const common = docTotal > 2 && df / docTotal > 0.5;
      const w = common ? 0 : g.length >= 3 ? 1 : 0.7;
      weightSum += w;
      if (w > 0 && dGrams.has(g)) inter += w;
    }
    const overlap = weightSum ? inter / weightSum : 0;

    // 关键词命中
    const stmt = row.statement;
    const kwHit = qKw.filter((k) => k.length >= 2 && stmt.includes(k)).length;

    // 实体命中
    const p = qPersons.filter((x) => row.persons.some((y) => y === x || y.includes(x) || x.includes(y))).length;
    const l = qPlaces.filter((x) => row.places.some((y) => y === x || y.includes(x) || x.includes(y))).length;
    const e = qEvents.filter((x) => row.events.some((y) => y === x || y.includes(x) || x.includes(y))).length;

    // 疑问形式相似：老人问法 vs 这条的疑问形式
    const aG = askGrams(row.asks);
    let askInter = 0;
    for (const g of qGrams) if (aG.has(g)) askInter += 1;
    const askSim = aG.size ? Math.min(0.3, (askInter / aG.size) * 1.2) : 0;

    // 时间命中
    let timeScore = 0;
    for (const t of qTimes) {
      if (t.year && row.year && Number(t.year) === Number(row.year)) timeScore += 0.1;
      else if (t.raw && row.time_raw && (row.time_raw.includes(t.raw) || t.raw.includes(row.time_raw))) timeScore += 0.08;
    }

    // 反向证据：问了地点，这条里没有
    let penalty = 0;
    for (const pl of qPlaces) {
      if (!stmt.includes(pl) && !row.places.some((y) => y.includes(pl) || pl.includes(y))) penalty += 0.12;
    }

    // 话题类别：老人问的是"干过什么工作"，这条讲的是"当挡车工" → 靠类别对上
    let kindScore = 0;
    if (qKinds.length) {
      const sk = kindCache.get(id) || sentenceKinds(row);
      kindCache.set(id, sk);
      for (const k of qKinds) if (sk.has(k)) kindScore += 1;
    }

    // 称呼命中：问"老张是谁来着"，含"老张"的那条必须排前面
    const nameScore = Math.min(nameHits.get(id) || 0, 2) * 0.22;

    const score = overlap * 1.0 + kindScore * 0.42 + nameScore + Math.min(kwHit, 6) * 0.05 + p * 0.12 + l * 0.06 + e * 0.18 + askSim + timeScore - penalty;

    scored.push({
      id,
      seq: row.seq,
      statement: row.statement,
      asks: row.asks,
      time_label: row.time_label,
      time_raw: row.time_raw,
      year: row.year,
      status: row.status,
      confidence: row.confidence,
      persons: row.persons,
      places: row.places,
      events: row.events,
      told_count: row.told_count,
      asked_count: row.asked_count,
      score: Number(score.toFixed(4)),
      why: {
        overlap: Number(overlap.toFixed(3)),   // 字面重合度（主判据）
        kinds: kindScore,                       // 话题类别命中（"干啥工作的" ↔ 挡车工）
        name: Number(nameScore.toFixed(3)),     // 称呼命中（"老张是谁"）
        keywords: kwHit,
        person: p,
        place: l,
        event: e,
        ask: Number(askSim.toFixed(3)),
        time: Number(timeScore.toFixed(3)),
        penalty: Number(penalty.toFixed(3)),
      },
    });
  }

  scored.sort((a2, b2) => b2.score - a2.score || (b2.told_count || 0) - (a2.told_count || 0) || (b2.seq || 0) - (a2.seq || 0));
  return scored.slice(0, 5).map((h) => ({
    ...h,
    // 这条是怎么被找出来的：字面命中 / 话题类别命中（"干啥工作的" ↔ 挡车工）
    via: h.why.overlap > 0 ? 'literal' : h.why.kinds > 0 ? 'topic' : 'entity',
  }));
}

export function markAsked(ids = []) {
  const now = nowISO();
  for (const id of ids) db.prepare('UPDATE sentences SET asked_count = asked_count + 1, updated_at = ? WHERE id = ?').run(now, id);
}

/* ================================================================== *
 * 待确认队列
 * ================================================================== */

export function addCandidate(sentenceId, question) {
  const id = uid('c');
  db.prepare('INSERT INTO candidates (id, sentence_id, question, status, created_at) VALUES (?,?,?,?,?)')
    .run(id, sentenceId, question, 'open', nowISO());
  return id;
}

export function openCandidates(limit = 5) {
  return db.prepare("SELECT * FROM candidates WHERE status = 'open' ORDER BY created_at DESC LIMIT ?").all(limit);
}

export function resolveCandidate(id, accepted) {
  const row = db.prepare('SELECT * FROM candidates WHERE id = ?').get(id);
  if (!row) return null;
  db.prepare('UPDATE candidates SET status = ?, resolved_at = ? WHERE id = ?').run(accepted ? 'accepted' : 'rejected', nowISO(), id);
  if (row.sentence_id) {
    db.prepare('UPDATE sentences SET status = ?, confidence = ?, updated_at = ? WHERE id = ?')
      .run(accepted ? 'confirmed' : 'pending', accepted ? 0.95 : 0.4, nowISO(), row.sentence_id);
  }
  return { ...row, status: accepted ? 'accepted' : 'rejected' };
}

/* ================================================================== *
 * 原话 / 实体 / 话题 / 统计
 * ================================================================== */

export function logUtterance({ session, role, text }) {
  const id = uid('u');
  db.prepare('INSERT INTO utterances (id, session, role, text, created_at) VALUES (?,?,?,?,?)')
    .run(id, session || 'default', role, String(text ?? ''), nowISO());
  return id;
}

export function recentUtterances(limit = 30) {
  return db.prepare('SELECT * FROM utterances ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit).reverse();
}

/** 四个维度里的条目（人物含别名合并；时间含归一化后的区间） */
export function listEntities(kind) {
  const map = { person: 'people', time: 'times', place: 'places', event: 'events' };
  const dims = kind ? [kind] : ['person', 'time', 'place', 'event'];
  const out = {};
  for (const d of dims) {
    const rows = db.prepare(`SELECT * FROM ${map[d]} ORDER BY count DESC, last_seen DESC LIMIT 500`).all();
    out[d] = rows.map((r) => ({
      ...r,
      aliases: JSON.parse(r.aliases || '[]'),
      memories: Number(db.prepare(`SELECT COUNT(*) c FROM ${d}_links WHERE ${d}_id = ?`).get(r.id)?.c || 0),
    }));
  }
  return kind ? out[kind] : out;
}

export function bumpTopic(title, lastSaid, avoid = false) {
  const key = String(title || '').replace(/[^\u4e00-\u9fa5]/g, '').slice(0, 20);
  if (!key) return;
  const now = nowISO();
  const row = db.prepare('SELECT * FROM topics WHERE id = ?').get(key);
  if (!row) {
    db.prepare('INSERT INTO topics (id,title,last_said,ask_count,avoid_count,status,updated_at) VALUES (?,?,?,1,?,?,?)')
      .run(key, title, lastSaid, avoid ? 1 : 0, avoid ? 'paused' : 'open', now);
    return;
  }
  const avoidCount = row.avoid_count + (avoid ? 1 : 0);
  db.prepare('UPDATE topics SET last_said = ?, ask_count = ask_count + 1, avoid_count = ?, status = ?, updated_at = ? WHERE id = ?')
    .run(lastSaid || row.last_said, avoidCount, avoidCount >= 3 ? 'closed' : avoidCount >= 2 ? 'paused' : 'open', now, key);
}

export function listTopics(limit = 10) {
  return db.prepare('SELECT * FROM topics ORDER BY updated_at DESC LIMIT ?').all(limit);
}

export function listSentences({ limit = 200, status } = {}) {
  const rows = status
    ? db.prepare('SELECT * FROM sentences WHERE status = ? ORDER BY seq ASC LIMIT ?').all(status, limit)
    : db.prepare('SELECT * FROM sentences ORDER BY seq ASC LIMIT ?').all(limit);
  return rows.map(hydrate);
}

export function deleteSentence(id) {
  indexRemove(id);
  db.prepare('DELETE FROM candidates WHERE sentence_id = ?').run(id);
  for (const dim of ['person', 'time', 'place', 'event']) db.prepare(`DELETE FROM ${dim}_links WHERE sentence_id = ?`).run(id);
  db.prepare('DELETE FROM sentences WHERE id = ?').run(id);
  pruneDimensions();          // 顺带清掉没人再提到的维度条目
  return true;
}

/** 清掉没有任何记忆挂着的维度条目（删完记忆后不留空壳） */
export function pruneDimensions() {
  let removed = 0;
  for (const dim of ['person', 'time', 'place', 'event']) {
    const table = { person: 'people', time: 'times', place: 'places', event: 'events' }[dim];
    const r = db.prepare(
      `DELETE FROM ${table} WHERE id NOT IN (SELECT ${dim}_id FROM ${dim}_links)`,
    ).run();
    removed += Number(r.changes || 0);
  }
  return removed;
}

/** 改一条记忆（家人端可以直接改文字 / 状态） */
export function updateSentence(id, patch = {}) {
  const row = getSentence(id);
  if (!row) return null;
  const statement = patch.statement !== undefined ? bare(patch.statement) : row.statement;
  const status = patch.status !== undefined ? patch.status : row.status;
  const timeLabel = patch.time_label !== undefined ? patch.time_label : row.time_label;
  /* year 也要能改 —— 大模型判出来的时间是年份，
     只写 time_label 的话时间轴还是按"没有年份"归到"时间未定"。 */
  const year = patch.year !== undefined
    ? (patch.year === null || patch.year === '' ? null : Number(patch.year))
    : row.year;
  const polished = patch.polished !== undefined ? String(patch.polished) : row.polished;
  const lifeEvent = patch.life_event !== undefined ? patch.life_event : row.life_event;
  db.prepare('UPDATE sentences SET statement = ?, status = ?, time_label = ?, year = ?, polished = ?, life_event = ?, updated_at = ? WHERE id = ?')
    .run(statement, status, timeLabel, Number.isFinite(year) ? year : null, polished || '', lifeEvent, nowISO(), id);
  const next = getSentence(id);
  indexRemove(id);
  indexAdd(id, `${next.statement} ${next.asks.join(' ')} ${next.keywords.join(' ')} ${[...next.persons, ...next.places, ...next.events].join(' ')}`);
  return next;
}

/** 删一个维度条目（默认连带删掉关联表里的连线；有记忆挂着时需 force） */
export function deleteDimension(dim, id, { force = false } = {}) {
  const table = { person: 'people', time: 'times', place: 'places', event: 'events' }[dim];
  if (!table) return { ok: false, error: '维度不对' };
  const linked = Number(db.prepare(`SELECT COUNT(*) c FROM ${dim}_links WHERE ${dim}_id = ?`).get(id)?.c || 0);
  if (linked && !force) return { ok: false, linked, error: `还有 ${linked} 条记忆挂着它` };
  db.prepare(`DELETE FROM ${dim}_links WHERE ${dim}_id = ?`).run(id);
  db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
  return { ok: true, linked };
}

export function setMeta(k, v) {
  db.prepare('INSERT INTO meta (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, String(v));
}
export function getMeta(k, dflt = null) {
  const row = db.prepare('SELECT v FROM meta WHERE k = ?').get(k);
  return row ? row.v : dflt;
}

/* ------------------------------------------------------------------ *
 * 最近说过的开场白
 * 智能体每次打开页面都会起个话头，不给它记着就会每次都说同一句。
 * ------------------------------------------------------------------ */

export function recentOpenings(n = 5) {
  try { return JSON.parse(getMeta('recent_openings', '[]')).slice(-n); } catch { return []; }
}

export function pushOpening(text) {
  const t = String(text || '').trim();
  if (!t) return;
  const list = recentOpenings(20);
  list.push(t);
  setMeta('recent_openings', JSON.stringify(list.slice(-20)));
}

export function stats() {
  const c = (sql) => Number(db.prepare(sql).get()?.c || 0);
  return {
    sentences: c('SELECT COUNT(*) c FROM sentences'),
    confirmed: c("SELECT COUNT(*) c FROM sentences WHERE status='confirmed'"),
    pending: c("SELECT COUNT(*) c FROM sentences WHERE status='pending'"),
    utterances: c('SELECT COUNT(*) c FROM utterances'),
    // 四个维度各自的条目数
    persons: c('SELECT COUNT(*) c FROM people'),
    places: c('SELECT COUNT(*) c FROM places'),
    events: c('SELECT COUNT(*) c FROM events'),
    times: c('SELECT COUNT(*) c FROM times'),
    openCandidates: c("SELECT COUNT(*) c FROM candidates WHERE status='open'"),
    indexed: inverted.size,
    dbFile: DB_FILE,
    indexPath: INDEX_FILE,
  };
}

/** 把记忆档案导成可读文件：每条记忆 + 它的四个维度，方便直接查看 */
export function dumpIndex() {
  const items = listSentences({ limit: 5000 });
  const payload = {
    exported_at: nowISO(),
    dbFile: DB_FILE,
    count: items.length,
    dimensions: archiveSummary(db),
    memories: items.map((s) => ({
      seq: s.seq,
      statement: s.statement,
      asks: s.asks,
      time: s.time_label || s.time_raw || '',
      status: s.status,
      confidence: s.confidence,
      told_count: s.told_count,
      asked_count: s.asked_count,
      // 四个维度（取自各自的表，不是塞在句子里的 JSON）
      dims: dimensionMap(s.id),
    })),
  };
  fs.writeFileSync(INDEX_FILE, JSON.stringify(payload, null, 2), 'utf8');
  return { file: INDEX_FILE, count: items.length };
}

/**
 * 人物关系图
 *   - 节点：老人自己（中心）+ 他说到过的每个人
 *   - 连线：这两个人出现在同一条记忆里
 *     · 自己 ↔ 某人：那条记忆里提到了这个人
 *     · 某人 ↔ 某人：两人出现在同一条记忆里
 * @param {{selfName?:string}} opts selfName = 老人自己显示成什么（"我（爷爷）"）
 */
export function graph({ selfName = '' } = {}) {
  const people = db.prepare('SELECT * FROM people ORDER BY count DESC LIMIT 80').all();
  const nodes = people.map((r) => ({
    id: r.id,
    kind: 'person',
    name: r.name,
    aliases: JSON.parse(r.aliases || '[]'),
    memories: Number(db.prepare('SELECT COUNT(*) c FROM person_links WHERE person_id = ?').get(r.id)?.c || 0),
  }));

  // 老人自己：做成一个中心节点。不去动 people 表（那里面存的都是"别人"），
  // 只在返回结果里加一个虚拟节点，id 用 self。
  const selfId = '__self__';
  const selfNode = {
    id: selfId,
    kind: 'self',
    name: selfName || '我',
    aliases: [],
    memories: Number(db.prepare('SELECT COUNT(*) c FROM sentences').get()?.c || 0),
    note: '老人自己',
  };

  const links = [];
  // 自己 ↔ 每个人
  for (const n of nodes) {
    if (!n.memories) continue;
    const sample = db.prepare(
      `SELECT s.statement FROM person_links l JOIN sentences s ON s.id = l.sentence_id
       WHERE l.person_id = ? ORDER BY s.seq LIMIT 1`,
    ).get(n.id);
    links.push({ source: selfId, target: n.id, weight: n.memories, sample: sample?.statement || '', kinds: ['self', 'person'] });
  }

  // 人与人之间（同一条记忆里同时出现）
  const rows = db.prepare(
    `SELECT a.person_id AS x, b.person_id AS y, COUNT(*) AS n, MIN(s.statement) AS sample
     FROM person_links a
     JOIN person_links b ON a.sentence_id = b.sentence_id AND a.person_id < b.person_id
     JOIN sentences s ON s.id = a.sentence_id
     GROUP BY x, y ORDER BY n DESC LIMIT 400`,
  ).all();
  for (const r of rows) {
    links.push({ source: r.x, target: r.y, weight: r.n, sample: r.sample, kinds: ['person', 'person'] });
  }

  // 每个人各自出现在哪些记忆（图谱下面要列出来）
  const solo = {};
  solo[selfId] = db.prepare(
    'SELECT seq, statement, year, time_label FROM sentences ORDER BY seq LIMIT 30',
  ).all();
  for (const n of nodes) {
    solo[n.id] = db.prepare(
      `SELECT s.seq, s.statement, s.year, s.time_label FROM person_links l
       JOIN sentences s ON s.id = l.sentence_id WHERE l.person_id = ? ORDER BY s.seq LIMIT 20`,
    ).all(n.id);
  }

  return { nodes: [selfNode, ...nodes], links, solo, kinds: ['self', 'person'], selfId };
}

export function getDb() {
  return db;
}

/**
 * 网页上的"直接看数据库"：把每张表的内容原样端出去
 * 记忆（sentences）额外挂上它的四个维度，维度行额外挂上"关联几条记忆"
 */
export function dbTables() {
  const out = [];
  const simple = [
    ['sentences', '记忆（主句库）', 'SELECT * FROM sentences ORDER BY seq ASC LIMIT 1000'],
    ['people', '人物', 'SELECT * FROM people ORDER BY count DESC LIMIT 500'],
    ['times', '时间', 'SELECT * FROM times ORDER BY (year IS NULL), year ASC LIMIT 500'],
    ['places', '地点', 'SELECT * FROM places ORDER BY count DESC LIMIT 500'],
    ['events', '事件', 'SELECT * FROM events ORDER BY count DESC LIMIT 500'],
    ['utterances', '老人原话', 'SELECT * FROM utterances ORDER BY rowid DESC LIMIT 300'],
    ['candidates', '待核对队列', 'SELECT * FROM candidates ORDER BY created_at DESC LIMIT 200'],
    ['topics', '话题断点', 'SELECT * FROM topics ORDER BY updated_at DESC LIMIT 100'],
    ['meta', '设置（人设等）', 'SELECT * FROM meta'],
  ];
  for (const [table, label, sql] of simple) {
    let rows = [];
    try {
      rows = db.prepare(sql).all();
    } catch (e) {
      log(`读表 ${table} 失败：${e.message}`);
      continue;
    }
    out.push({
      table,
      label,
      count: Number(db.prepare(`SELECT COUNT(*) c FROM ${table}`).get()?.c || 0),
      columns: rows[0] ? Object.keys(rows[0]) : [],
      rows: rows.map((r) => {
        const o = { ...r };
        if (table === 'sentences' && r.id) {
          o._dims = dimensionMap(r.id);
          o._links = {
            persons: db.prepare('SELECT person_id FROM person_links WHERE sentence_id = ?').all(r.id).map((x) => x.person_id),
            times: db.prepare('SELECT time_id FROM time_links WHERE sentence_id = ?').all(r.id).map((x) => x.time_id),
            places: db.prepare('SELECT place_id FROM place_links WHERE sentence_id = ?').all(r.id).map((x) => x.place_id),
            events: db.prepare('SELECT event_id FROM event_links WHERE sentence_id = ?').all(r.id).map((x) => x.event_id),
          };
        }
        if (['people', 'times', 'places', 'events'].includes(table) && r.id) {
          const dim = { people: 'person', times: 'time', places: 'place', events: 'event' }[table];
          o._memories = Number(db.prepare(`SELECT COUNT(*) c FROM ${dim}_links WHERE ${dim}_id = ?`).get(r.id)?.c || 0);
        }
        return o;
      }),
    });
  }
  return { tables: out, stats: stats(), dbFile: DB_FILE };
}

/**
 * 小改表结构：老库缺列就补上（不重建表、不动数据）
 * 例：places 表后来加了 label（展示名，如"沈阳·纺织厂"）
 */
export function ensureColumns() {
  const want = {
    places: {
      label: "TEXT NOT NULL DEFAULT ''",
      year: 'INTEGER',
      year_from: 'INTEGER',
      year_to: 'INTEGER',
    },
    people: { relation: "TEXT NOT NULL DEFAULT ''" },
    times: { note: "TEXT NOT NULL DEFAULT ''" },
    events: { note: "TEXT NOT NULL DEFAULT ''" },
    /* 时间轴上显示的是**润色后**的话，不是原话。
       statement 留着原汁原味（检索、记忆库、给模型看都要用它），
       polished 只给家人端时间轴看 —— 一行行读下来像小传，不像聊天记录。 */
    sentences: {
      polished: "TEXT NOT NULL DEFAULT ''",
      /* 值不值得上"人生时间轴"。NULL = 还没判过（先当值得）。
         时间轴是人生大事的索引，不是流水账 —— 今天腰疼、今天想起点事
         这种不进时间轴，但记忆库里照样留着。 */
      life_event: 'INTEGER',
    },
  };
  const added = [];
  /* 时间轴上一个时间段的多条记忆，要合成**一句话**读起来才像回事
     （"我在那边开餐馆 / 三点就要起来 / 买的人很多" → 一句）。
     合成结果按"这一组有哪些话"做键缓存起来，别每次开页面都重新问模型。 */
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS place_geo (
      name TEXT PRIMARY KEY,
      city TEXT NOT NULL DEFAULT '',
      geo INTEGER,
      why TEXT NOT NULL DEFAULT ''
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS timeline_notes (
      k TEXT PRIMARY KEY,
      text TEXT NOT NULL DEFAULT '',
      updated_at TEXT
    )`);
  } catch (e) { log(`建 timeline_notes 失败：${e.message}`); }
  for (const [table, cols] of Object.entries(want)) {
    const has = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    if (!has.size) continue;
    for (const [col, decl] of Object.entries(cols)) {
      if (has.has(col)) continue;
      try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
        added.push(`${table}.${col}`);
      } catch (e) {
        log(`加列失败 ${table}.${col}：${e.message}`);
      }
    }
  }
  return added;
}

/**
 * 用当前的抽取规则，把已有的记忆重新抽一遍四维
 * （改了抽取规则、或想把老数据补齐时用）
 */
export function reextractAll(analyzeFn, { birthYear = null } = {}) {
  const rows = db.prepare('SELECT id, statement, year, time_raw FROM sentences ORDER BY seq').all();
  let touched = 0;
  for (const r of rows) {
    const a = analyzeFn(r.statement);
    if (r.year) a.times = [{ raw: r.time_raw || '', label: `${r.year} 年`, kind: 'abs', year: r.year }, ...(a.times || [])];
    if (!a.places?.length && !a.persons?.length && !a.events?.length && !a.times?.length) continue;
    // 先清掉旧的关联，再按新结果重挂
    for (const dim of ['person', 'time', 'place', 'event']) db.prepare(`DELETE FROM ${dim}_links WHERE sentence_id = ?`).run(r.id);
    attachDimensions(db, r.id, a, { birthYear });
    db.prepare('UPDATE sentences SET persons = ?, places = ?, events = ? WHERE id = ?')
      .run(JSON.stringify(a.persons || []), JSON.stringify(a.places || []), JSON.stringify(a.events || []), r.id);
    touched += 1;
  }
  pruneDimensions();
  dumpIndex();
  return { total: rows.length, touched };
}

export function resetAll({ keepPersona = true } = {}) {
  const persona = keepPersona ? getMeta('persona') : null;
  const tables = [
    'utterances', 'candidates', 'sentences', 'topics',
    'person_links', 'time_links', 'place_links', 'event_links',
    'people', 'times', 'places', 'events',
  ];
  for (const t of tables) db.exec(`DELETE FROM ${t}`);
  inverted.clear();
  docGrams.clear();
  kindCache.clear();
  if (persona) setMeta('persona', persona);
  dumpIndex();
  return stats();
}

export { DB_FILE, INDEX_FILE, ROOT };

/* ---- 时间轴上的"合并叙述"缓存 ---- */
export function getNote(k) {
  try {
    return db.prepare('SELECT text FROM timeline_notes WHERE k = ?').get(k)?.text || '';
  } catch { return ''; }
}
export function putNote(k, text) {
  try {
    db.prepare('INSERT INTO timeline_notes (k, text, updated_at) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET text=excluded.text, updated_at=excluded.updated_at')
      .run(k, String(text || ''), nowISO());
  } catch (e) { log(`写 timeline_notes 失败：${e.message}`); }
}
/* ---- 地名归属的缓存（哪个城市）---- */
export function getPlaceGeo(name) {
  try {
    return db.prepare('SELECT city, geo, why FROM place_geo WHERE name = ?').get(name) || null;
  } catch { return null; }
}
export function putPlaceGeo(name, { city = '', geo = null, why = '' } = {}) {
  try {
    db.prepare('INSERT INTO place_geo (name, city, geo, why) VALUES (?,?,?,?) ON CONFLICT(name) DO UPDATE SET city=excluded.city, geo=excluded.geo, why=excluded.why')
      .run(String(name), String(city || ''), geo === null ? null : (geo ? 1 : 0), String(why || ''));
  } catch (e) { log(`写 place_geo 失败：${e.message}`); }
}
export function allPlaceNames() {
  try {
    return db.prepare('SELECT DISTINCT name FROM places WHERE name IS NOT NULL').all().map((r) => r.name);
  } catch { return []; }
}