/**
 * 记忆档案库 —— 按文档的"四个维度"落库
 *
 * 产品说明里要求（类别 2 / 类别 4）：
 *   · 抽取 **人物 / 时间 / 地点 / 事件**
 *   · **模糊时间归一化**："二十来岁那年"归一为区间，同时保留原始说法
 *   · **人物实体合并**："老李 / 李师傅 / 李国强"是同一个人
 *   · 记忆档案库可按 **人物 / 时间 / 地点 / 事件** 四个维度筛选浏览
 *
 * 所以这里四个维度各有自己的表和 id，用关联表挂到"记忆"（一条主句即一段记忆）上，
 * 而不是把四个字段塞在一条记录的 JSON 里 —— 那样没法按维度查，也没法合并同一个人。
 */
import { uid, nowISO } from './util.mjs';
import { personKey } from './text.mjs';
import { getNote } from './store.mjs';


/* ------------------------------------------------------------------ *
 * 归属：把时间区间按出生年落到具体年份（"二十来岁" + 出生年 1948 → 1974 年前后）
 * ------------------------------------------------------------------ */

export function resolveTime(t, birthYear) {
  const y = Number(birthYear) || null;
  const range = (a, b) => (!y ? { from: null, to: null } : { from: y + a, to: y + b });
  const era = (a, b, label) => ({ from: a, to: b, label, circa: true });
  const r = { ...t, from: t.from ?? null, to: t.to ?? null, circa: t.circa ?? false, basis: y ? `按 ${y} 年出生推算` : '未填出生年，只能保留原说法' };

  if (t.kind === 'age' && y) {
    const m = String(t.approx || t.raw).match(/(二十|三十|四十|五十|六十)/);
    const base = { 二十: 20, 三十: 30, 四十: 40, 五十: 50, 六十: 60 }[m?.[1]] || 20;
    const span = range(base - 2, base + 2);
    return { ...r, ...span, label: r.label || `${y + base} 年前后` };
  }
  if (t.kind === 'life' && y) {
    if (/童年|小时候/.test(t.raw)) return { ...r, ...range(5, 12), label: `${y + 5}—${y + 12} 年（童年）` };
    if (/青年|年轻|刚参加工作/.test(t.raw)) return { ...r, ...range(18, 25), label: `${y + 18}—${y + 25} 年（青年）` };
    if (/结婚/.test(t.raw)) return { ...r, label: '结婚前后' };
    if (/退休/.test(t.raw)) return { ...r, ...range(58, 62), label: `${y + 58}—${y + 62} 年（退休）` };
  }
  if (t.kind === 'era') {
    const s = `${t.approx || ''} ${t.label || ''}`;
    const before = /(\d{4})\s*年以前/.exec(s);
    const after = /(\d{4})\s*年以后/.exec(s);
    const span = /(1[89]\d{2})\s*[—\-~至到]\s*(1[89]\d{2})/.exec(s);
    const around = /(1[89]\d{2})\s*年前后/.exec(s);
    if (before) return { ...r, to: Number(before[1]) - 1, circa: true };
    if (after) return { ...r, from: Number(after[1]) + 1, circa: true };
    if (span) return { ...r, from: Number(span[1]), to: Number(span[2]), circa: true };
    if (around) return { ...r, from: Number(around[1]) - 1, to: Number(around[1]) + 1, circa: true };
  }
  // 明确的某一年：也给出区间，方便时间轴排序
  if (t.year) return { ...r, from: t.year, to: t.year };
  return r;
}

/* ================================================================== *
 * 四个维度
 * ================================================================== */

/**
 * 记一个时间维度
 * @param {object} t  analyze() 里的 times 项：{ raw, label, kind, year? }
 * @param {number} birthYear
 */
export function saveTime(dbi, t, birthYear) {
  const info = resolveTime(t, birthYear);
  const key = t.year ? `abs:${t.year}` : `${t.kind}:${t.raw}`;
  const now = nowISO();
  const row = dbi.prepare('SELECT * FROM times WHERE key = ?').get(key);
  if (row) {
    dbi.prepare('UPDATE times SET count = count + 1, year = COALESCE(?, year), from_year = COALESCE(?, from_year), to_year = COALESCE(?, to_year), last_seen = ? WHERE id = ?')
      .run(info.year ?? null, info.from ?? null, info.to ?? null, now, row.id);
    return { id: row.id, label: row.label, raw: t.raw };
  }
  const id = uid('t');
  dbi.prepare(
    `INSERT INTO times (id,key,raw,label,kind,year,from_year,to_year,circa,basis,count,created_at,last_seen)
     VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)`,
  ).run(
    id, key, t.raw || '', info.label || t.label || t.raw || '', t.kind || 'other',
    info.year ?? t.year ?? null, info.from ?? null, info.to ?? null,
    info.circa ? 1 : 0, info.basis || '', now, now,
  );
  return { id, label: info.label || t.label || t.raw, raw: t.raw };
}

/** 记一个地点维度（label 是展示名："沈阳·纺织厂"）—— 同名不同城算两个地方 */
export function savePlace(dbi, name, { label = '' } = {}) {
  const now = nowISO();
  const shown = label || name;
  const row = dbi.prepare('SELECT * FROM places WHERE label = ?').get(shown);
  if (row) {
    dbi.prepare('UPDATE places SET count = count + 1, last_seen = ? WHERE id = ?').run(now, row.id);
    return { id: row.id, name: row.name, label: row.label };
  }
  const id = uid('p');
  dbi.prepare('INSERT INTO places (id,name,label,count,created_at,last_seen) VALUES (?,?,?,1,?,?)')
    .run(id, name, shown, now, now);
  return { id, name, label: shown };
}

/**
 * 记一个人物维度（含实体合并：同一个姓氏/称呼归一个人，别名叫法进 aliases）
 * @param {string} name 本次出现的叫法
 * @param {string} aliasKey personKey() 的结果
 */
export function savePerson(dbi, name, aliasKey) {
  const now = nowISO();
  const row = dbi.prepare('SELECT * FROM people WHERE alias_key = ?').get(aliasKey);
  if (row) {
    const aliases = new Set(JSON.parse(row.aliases || '[]'));
    aliases.add(name);
    // 用更"正式"的叫法当主名：全名 > 姓+称谓 > 老X
    const better = pickPrimary(row.name, name);
    dbi.prepare('UPDATE people SET count = count + 1, aliases = ?, name = ?, last_seen = ? WHERE id = ?')
      .run(JSON.stringify([...aliases]), better, now, row.id);
    return { id: row.id, name: better, merged: better !== name, aliases: [...aliases] };
  }
  const id = uid('n');
  dbi.prepare('INSERT INTO people (id,name,alias_key,aliases,count,created_at,last_seen) VALUES (?,?,?,?,1,?,?)')
    .run(id, name, aliasKey, JSON.stringify([name]), now, now);
  return { id, name, created: true, aliases: [name] };
}

/** 哪个叫法更适合当"主名" */
function pickPrimary(a, b) {
  const score = (s = '') => {
    if (/[\u4e00-\u9fa5]{2,3}$/.test(s) && !/^[老小]/.test(s) && !/(师傅|大夫|老师|会计)$/.test(s)) return 3; // 全名
    if (/(师傅|大夫|老师|会计|班长|厂长)$/.test(s)) return 2;                                              // 姓+称谓
    return 1;                                                                                             // 老X / 称谓
  };
  return score(b) > score(a) ? b : a;
}

/** 记一个事件维度 */
export function saveEvent(dbi, name, raw = '') {
  const now = nowISO();
  const row = dbi.prepare('SELECT * FROM events WHERE name = ?').get(name);
  if (row) {
    dbi.prepare('UPDATE events SET count = count + 1, last_seen = ? WHERE id = ?').run(now, row.id);
    return { id: row.id, name };
  }
  const id = uid('v');
  dbi.prepare('INSERT INTO events (id,name,raw,count,created_at,last_seen) VALUES (?,?,?,1,?,?)').run(id, name, raw, now, now);
  return { id, name };
}

/** 把这条记忆挂到四个维度上 */
export function link(dbi, sentenceId, dim, dimId) {
  if (!dimId) return;
  dbi.prepare(`INSERT OR IGNORE INTO ${dim}_links (sentence_id, ${dim}_id, created_at) VALUES (?,?,?)`)
    .run(sentenceId, dimId, nowISO());
}

/**
 * 一条记忆落库后，把四个维度一并建好、挂好
 * @returns {{persons:Array, times:Array, places:Array, events:Array}} 各维度的 id 与名称
 */
export function attachDimensions(dbi, sentenceId, a, { birthYear = null } = {}) {
  const out = { persons: [], times: [], places: [], events: [] };
  // 先清掉这条记忆的旧关联，再按当前的四维重挂 —— 免得越挂越多、留下重复
  for (const dim of ['person', 'time', 'place', 'event']) {
    dbi.prepare(`DELETE FROM ${dim}_links WHERE sentence_id = ?`).run(sentenceId);
  }

  for (const t of a.times || []) {
    const rec = saveTime(dbi, t, birthYear);
    link(dbi, sentenceId, 'time', rec.id);
    out.times.push(rec);
  }
  for (const p of a.places || []) {
    // 地点行就存本位地名（"纺织厂"），落在哪个城市由 geo.mjs 统一推算 —— 只算一处，免得存重
    const rec = savePlace(dbi, p);
    link(dbi, sentenceId, 'place', rec.id);
    out.places.push(rec);
  }
  for (const name of a.persons || []) {
    // 统一用 personKey 归一：「老张 / 张师傅 / 张建国」落到同一个人
    const rec = savePerson(dbi, name, a.personKeys?.[name] || personKey(name));
    link(dbi, sentenceId, 'person', rec.id);
    out.persons.push(rec);
  }
  for (const e of a.events || []) {
    const rec = saveEvent(dbi, e, a.cleaned || '');
    link(dbi, sentenceId, 'event', rec.id);
    out.events.push(rec);
  }
  return out;
}

/* ================================================================== *
 * 按维度浏览（记忆档案库）
 * ------------------------------------------------------------------ */

const DIM_LABEL = { person: '人物', time: '时间', place: '地点', event: '事件' };
/** 维度 → 表名（person 那张表叫 people） */
const DIM_TABLE = { person: 'people', time: 'times', place: 'places', event: 'events' };
const DIMS = ['person', 'time', 'place', 'event'];

/** 四个维度各有哪些条目，各挂了多少条记忆 */
export function archiveSummary(dbi) {
  const dims = {};
  for (const dim of DIMS) {
    const rows = dbi.prepare(
      `SELECT d.*, (SELECT COUNT(*) FROM ${dim}_links l WHERE l.${dim}_id = d.id) AS memories
       FROM ${DIM_TABLE[dim]} d ORDER BY d.count DESC, d.last_seen DESC LIMIT 200`,
    ).all();
    dims[dim] = { label: DIM_LABEL[dim], items: rows.map((r) => ({ ...r, aliases: safe(r.aliases) })) };
  }
  return dims;
}

/** 按维度筛出记忆（可按已确认 / 待确认过滤） */
export function browseArchive(dbi, { dim, id, status } = {}) {
  if (dim && id && DIM_TABLE[dim]) {
    const where = [`l.${dim}_id = ?`];
    const args = [id];
    if (status) {
      where.push('s.status = ?');
      args.push(status);
    }
    const rows = dbi.prepare(
      `SELECT s.* FROM sentences s JOIN ${dim}_links l ON l.sentence_id = s.id
       WHERE ${where.join(' AND ')}
       ORDER BY (s.year IS NULL), s.year ASC, s.seq ASC LIMIT 500`,
    ).all(...args);
    const item = dbi.prepare(`SELECT * FROM ${DIM_TABLE[dim]} WHERE id = ?`).get(id);
    return {
      dim,
      dimLabel: DIM_LABEL[dim],
      item: item ? { ...item, aliases: safe(item.aliases) } : null,
      sentences: rows.map(hydrateRow),
    };
  }
  // 不给维度就返回四个维度的总览 + 时间轴分组
  return { summary: archiveSummary(dbi), timeline: timelineOf(dbi, status) };
}

const safe = (s) => {
  try {
    return JSON.parse(s || '[]');
  } catch {
    return [];
  }
};

function hydrateRow(r) {
  return { ...r, asks: safe(r.asks), keywords: safe(r.keywords) };
}

/**
 * 时间轴：按"这件事大概发生在什么时候"排
 * ==========================================================================
 * 关键在于**没有年份的那些也得排进该在的位置**。
 *
 * 原来的写法是 `ORDER BY (s.year IS NULL), s.year ASC, s.seq ASC` ——
 * 结果就是"前面一堆年份 + 末尾一堆没有年份的"，人生顺序完全看不出来：
 *
 *   1956 年 → 1968 年 → 1969 年 → 1978 年 → 2023 年 → 2026 年
 *            → 去杭州后中年时期 → 杭州开餐馆那几年 → 时间未定
 *
 * 可"杭州开餐馆"明明发生在 1978 年去杭州之后、老伴走之前。
 *
 * 现在给每条算一个**排序用的年份**：
 *   · 有 year 的直接用
 *   · 没有的，按老人讲述的先后（seq），**插在前后两个有年份的邻居之间**
 *       —— "在 1978 和 2023 之间讲的" → 落在 1978~2023 中间
 *   · 前前后后一条有年份的都没有 → 只能按 seq 排
 *
 * 分组本身不变（按 time_label），但每组带一个 order，前端按它排。
 */
function timelineOf(dbi, status) {
  const rows = dbi.prepare(
    /* 时间轴是**人生大事的索引**，不是流水账。
       life_event 三档：
         2 = major  本身就是大事，单独成一条
         1 = detail 是某件大事的细节 —— **不单独成条，但要并进那件事**
         0 = none   眼前小事/一时心情，时间轴上不要（记忆库里照样留着）
       NULL = 还没判过，先按 major 处理 */
    `SELECT s.id, s.seq, s.statement, s.polished, s.year, s.time_label, s.status,
            COALESCE(s.life_event, 2) AS life_event
     FROM sentences s
     WHERE COALESCE(s.life_event, 2) > 0 ${status ? 'AND s.status = ?' : ''}
     ORDER BY s.seq ASC LIMIT 500`,
  ).all(...(status ? [status] : []));

  /* ---- 1. 给每条算排序年份（eff） ----
     重点是**连续没年份的那一串要落在同一个点上**。
     老人是一口气讲完一段往事的："我在那边开餐馆""3点就要起来了""买的人老多了"
     连着说，中间没插别的年份。如果按每条在序列里的位置逐条插值，
     它们会被摊成 1980 / 1982 / 1984 三个点，看着像三件事。

     所以按"连续的没有年份的段"（run）来算：整段取中点插一次值，
     段里每条都用这个数 —— 一串连着讲的话本来就属于同一个时期。 */
  const known = rows.map((r) => (Number(r.year) || null));
  const eff = known.slice();

  // 找出每一段连续没有年份的 [start, end]
  const runs = [];
  for (let i = 0; i < rows.length; i += 1) {
    if (known[i]) continue;
    let e = i;
    while (e + 1 < rows.length && !known[e + 1]) e += 1;
    runs.push([i, e]);
    i = e;
  }

  for (const [s, e] of runs) {
    const mid = (s + e) / 2;                       // 整段的代表位置
    let li = -1;
    for (let k = s - 1; k >= 0; k -= 1) if (known[k]) { li = k; break; }
    let ri = -1;
    for (let k = e + 1; k < rows.length; k += 1) if (known[k]) { ri = k; break; }

    let val;
    if (li >= 0 && ri >= 0) {
      val = known[li] + (known[ri] - known[li]) * ((mid - li) / (ri - li));
    } else if (li >= 0) {
      val = known[li] + 0.5;                       // 都在末尾 → 紧跟最后一个
    } else if (ri >= 0) {
      val = known[ri] - 0.5;                       // 都在开头 → 紧挨第一个之前
    } else {
      val = null;                                  // 一条有年份的都没有
    }
    for (let k = s; k <= e; k += 1) eff[k] = val;
  }

  /* ---- 2. 分组 ----
     detail（life_event=1）**不按自己的 time_label 单独成组**，
     而是并到"时间上最近的那件大事"里。
     不然"三点就要起来""买的人挺多"会各自占一张卡，看着像好几件事。 */
  const majors = rows
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => Number(r.life_event) !== 1 && (Number(r.year) || eff[rows.indexOf(r)] !== null));
  const majorAnchor = majors.map(({ r, i }) => ({ year: Number(r.year) || eff[i], label: r.year ? `${r.year} 年` : (r.time_label || '时间未定') }));

  /** 找时间上离这条最近的那件大事 */
  const nearestMajorLabel = (effValue, seq) => {
    if (!majorAnchor.length) return null;
    const v = effValue === null ? null : Number(effValue);
    if (v === null) return majorAnchor[majorAnchor.length - 1].label;
    let best = null;
    for (const a of majorAnchor) {
      if (a.year === null) continue;
      const d = Math.abs(a.year - v);
      if (!best || d < best.d) best = { d, label: a.label };
    }
    return best ? best.label : majorAnchor[majorAnchor.length - 1].label;
  };

  const groups = new Map();
  rows.forEach((r, i) => {
    const selfLabel = r.year ? `${r.year} 年` : (r.time_label || '时间未定');
    const isDetail = Number(r.life_event) === 1;
    const label = isDetail ? (nearestMajorLabel(eff[i], r.seq) || selfLabel) : selfLabel;
    if (!groups.has(label)) groups.set(label, { label, order: null, firstSeq: r.seq, items: [] });
    const g = groups.get(label);
    /* 显示**润色后**的话，不是原话；没润色过的先退回原句。原话留在 raw 里。 */
    g.items.push({
      seq: r.seq,
      statement: r.polished || r.statement,
      raw: r.statement,
      polished: Boolean(r.polished),
      detail: isDetail,
      status: r.status,
    });
    // 一组的"时间位置"取组里最早的那条 —— 事件从哪儿开始，就排哪儿
    if (eff[i] !== null && (g.order === null || eff[i] < g.order)) g.order = eff[i];
    if (r.seq < g.firstSeq) g.firstSeq = r.seq;
  });

  /* ---- 3. 有 order 的按 order 排；没有的（整库都没年份）按讲述先后兜底 ---- */
  const out = [...groups.values()]
    .sort((a, b) => {
      if (a.order !== null && b.order !== null) return a.order - b.order || a.firstSeq - b.firstSeq;
      if (a.order !== null) return -1;
      if (b.order !== null) return 1;
      return a.firstSeq - b.firstSeq;
    });

  /* ---- 4. 兜底标签改掉 ----
     "时间未定" 挂在一个已经算好位置、排在 1978 和 2023 之间的节点上，
     读起来自相矛盾。既然位置是推算出来的，就用"约"把这个推算年份说出来，
     视觉上（虚线圆点）已经标明它不是确切年份。 */
  for (const g of out) {
    if (g.label === '时间未定' && g.order !== null) {
      g.label = `约 ${Math.round(g.order)} 年`;
      g.estimated = true;
    }
  }

  /* ---- 5. 同一件事不要摊成好几张卡 ----
     大模型给每句话的 time_label 不一定一样，同一件事会被它标成好几个时期：

       "1978 年"              → 我后来去杭州了
       "去杭州后中年时期"      → 我在那边开餐馆
       "杭州开餐馆那几年"      → 3点就要起来了
       "约 1978 年"           → 是的，买的人老多了

     明明是同一件事（去杭州开餐馆、半夜起来备货），却摊成四张卡，
     看着像四件不相干的事。

     合并规则两条，满足其一就并：
       (a) 推算年份相差不到 1 年 —— 就是同一年
       (b) **两块都没有确切年份** —— 都是"某个时期"，本来就说不清，
           凑在一起读比散着读强；而且插值会被中间夹的别的事拉开
           （曾经出现 1980 / 1982 / 1984 三张卡，全是同一件事）

     合并后标签取"更确定"的那个：确切年份 > 估算年份 > 模糊标签。 */
  const nearYear = (a, b) => a.order !== null && b.order !== null && Math.abs(a.order - b.order) < 1;
  const isSolidYear = (s) => /^\d{4}\s*年$/.test(s);
  const weight = (g) => (isSolidYear(g.label) ? 2 : (g.estimated ? 1 : 0));

  const merged = [];
  for (const g of out) {
    const last = merged[merged.length - 1];
    const bothVague = last && weight(last) < 2 && weight(g) < 2;
    if (!last || (!nearYear(last, g) && !bothVague)) {
      merged.push({ ...g, items: [...g.items] });
      continue;
    }
    // 并进上一张：条目合在一起，重复的说法去掉
    const seen = new Set(last.items.map((i) => i.statement));
    for (const it of g.items) if (!seen.has(it.statement)) { last.items.push(it); seen.add(it.statement); }
    if (g.firstSeq < last.firstSeq) last.firstSeq = g.firstSeq;
    // 标签取更确定的那个
    if (weight(g) > weight(last)) {
      last.label = g.label;
      last.estimated = g.estimated;
    }
  }

  return merged.map(({ label, order, items, estimated }) => {
    /* 多条记忆 → 合成一句话（模型生成，缓存在 timeline_notes）。
       没合成过时 note 是空串，前端退回逐条显示。 */
    const key = noteKey(items);
    return {
      label,
      order: order === null ? null : Number(order.toFixed(2)),
      estimated: Boolean(estimated),
      key,
      note: getNote(key),
      items,
    };
  });
}

/** 一组合并叙述的缓存键：这一组有哪些话（排序拼起来），变了就重新合成 */
function noteKey(items) {
  return items.map((i) => i.raw || i.statement).slice().sort().join('|').slice(0, 400);
}
