/**
 * 对话引擎
 *
 * 一轮对话：
 *   ① 听懂      analyze(老人原话) → 主句 / 疑问形式 / 人物地点时间事件 / 意图 / 情绪
 *   ② 查主句库  search()          字面 n-gram 重合度 + 实体 + 问法相似 + 时间
 *   ③ 细心作答  compose()         接住情绪 → 用库里的记忆回答 → 最多问一件小事
 *   ④ 整理入库  distill()         整理简化成主句 → 存进独立数据库（待确认）
 *   ⑤ 请老人确认                   老人点头/纠正，才算正式档案
 * 库里没有的，一律说记不清 —— 绝不编造。
 */
import {
  analyze, bare, splitClauses, askForms, isNonContent, mildMood, keywords as kwOf, simplify,
  healthSigns, isRequest,
} from './text.mjs';
import { contentQuestion, contentRemark, matchReaction } from './reactions.mjs';
import { understand } from './understand.mjs';
import { log } from './util.mjs';
import { llmConfig } from './llm.mjs';
import { reply as agentReply, opening as agentOpening, checkIn as agentCheckIn, guessTimes as agentGuessTimes } from './agent.mjs';
import {
  due as watchDue, markSpoken as watchMarkSpoken, claimSpoken as watchClaim, releaseSpoken as watchRelease, noteSpokenText as watchNoteText,
  noteActivity as watchActivity,
  setMood as watchSetMood, snapshot as watchSnapshot, configure as watchConfigure, clearLog as watchClearLog,
  notePoll, ackSpoken, pendingId as watchPendingId, noteOpening as watchNoteOpening,
} from './watch.mjs';
import {
  addSentence, search, markAsked,
  logUtterance, bumpTopic, listTopics, stats, getMeta, setMeta, listSentences, deleteSentence,
  recentOpenings, pushOpening, updateSentence, getSentence,
} from './store.mjs';

/* ================================================================== *
 * 人设
 * ================================================================== */

export const DEFAULT_PERSONA = {
  agent_name: '岁语',
  self_ref: '小孙子',
  elder_call: '爷爷',
  elder_name: '',
  birth_year: null,
  hometown: '',
  max_chars: 60,
};

export function getPersona() {
  try {
    return { ...DEFAULT_PERSONA, ...JSON.parse(getMeta('persona', '{}')) };
  } catch {
    return { ...DEFAULT_PERSONA };
  }
}

export function setPersona(patch = {}) {
  const next = { ...getPersona(), ...patch };
  setMeta('persona', JSON.stringify(next));
  return next;
}

/* ================================================================== *
 * 会话状态
 * ================================================================== */

const sessions = new Map();
const COMPANION_MS = 10 * 60 * 1000;

export function session(id = 'default') {
  if (!sessions.has(id)) {
    sessions.set(id, {
      id,
      turns: 0,

      lastOpener: '',
      moodScore: 0,
      companionUntil: 0,
      /** 最近聊过的话（对话上下文） */
      history: [],
      /** 正在讲的这件事：老人一句一句补充，都并到这一件上 */
      story: newStory(null, '', {}),
      /** 本次会话里讲过的几件事（短句归并时要知道它能并进哪一件） */
      recentStories: [],
      /** 我刚问出去的那句、以及它问的是哪一格 */
      lastAsk: null,
      /** 安全兜底：老人说过身体不舒服的记录（只在本会话内存里，不落库） */
      healthLog: [],
      /** 上次提醒"跟儿女说一声 / 去医院看看"的时间，免得唠叨 */
      lastHealthNudge: 0,
    });
  }
  return sessions.get(id);
}

/** 记一句进对话上下文 */
export function remember(sess, role, text) {
  if (!text) return;
  sess.history.push({ role, text: String(text).slice(0, 120), at: Date.now() });
  if (sess.history.length > 16) sess.history.shift();
}

/** 新建"正在讲的这件事" */
export function newStory(id, statement, a = {}) {
  return {
    id,
    statement: statement || '',
    seed: '',                 // 开场式问题的前半句（"我小时候在"）
    enriched: null,
    asked: [],
    lastQ: '',
    lastRemark: '',           // 上一句"听懂了"的话，同一个话题不重复用
    turns: 0,
  };
}

/** 记住这次讲过的几件事（最多 5 件），供短句归并时判断该并进哪一件 */
export function pushStory(sess, story) {
  if (!story?.id || !story.statement) return;
  // 同一件事只留最新、最完整的那一版
  sess.recentStories = (sess.recentStories || []).filter((s) => s.id !== story.id && s.statement !== story.statement);
  sess.recentStories.push({ id: story.id, statement: story.statement });
  if (sess.recentStories.length > 5) sess.recentStories.shift();
}

/* ------------------------------------------------------------------ *
 * "这一格"是什么：老人这句短回答在补哪一格
 *   时间 / 地点 / 人物 / 事件 / 其他
 * ------------------------------------------------------------------ */

export function detectSlot(a) {
  if (a.times?.length) return 'when';
  if (a.places?.length) return 'where';
  if (a.persons?.length) return 'who';
  if (a.events?.length) return 'what';
  return 'other';
}

/** 问句在问哪一格 */
export function slotOfQuestion(q = '') {
  if (!q) return '';
  if (/(哪一年|哪年|什么时候|几年|多大|多少岁|来岁|哪阵子)/.test(q)) return 'when';
  if (/(在哪儿|哪里|啥地方|什么地方|住的地方)/.test(q)) return 'where';
  if (/(是谁|谁呀|哪个人|跟谁|谁一块)/.test(q)) return 'who';
  if (/(干什么|干啥|干吗|做啥|咋回事|怎么回事|发生了什么)/.test(q)) return 'what';
  return '';
}

/** 问的是"哪一格"，老人答的就只并那一格；答的不是这一格就别硬塞 */
function askedSlotBlocked(askedSlot, slotKind) {
  if (!askedSlot) return false;
  if (askedSlot === 'other') return false;
  return slotKind !== askedSlot && slotKind !== 'other';
}

/** 开场式问题的"前半句"（"您小时候是在哪儿长大的呀？" → "我小时候在"） */
export function openSeed(question = '') {
  if (/小时候/.test(question)) return '我小时候在';
  if (/年轻时候/.test(question)) return '我年轻时候在';
  if (/老家|哪儿长大/.test(question)) return '我小时候在';
  if (/在哪儿|哪里/.test(question)) return '我在';
  return '';
}

/* ------------------------------------------------------------------ *
 * 碎片合并：老人回答"在北京""1950年"时，把它并进正在讲的这件事
 * —— 这是"一直在问同一个问题"的根因：碎片没被记下来，格子永远空着。
 * ------------------------------------------------------------------ */

/** 明显是在补充细节的短句（人称开头或带明确时间的不算） */
const FRAGMENT = /^(在|到|去|回|从|是|有|没有|叫|住|干|做|当|跟|和|给|因为|大概|应该|后来)?[\u4e00-\u9fa5A-Za-z0-9]{1,14}$/;
const NOT_FRAGMENT = /^(我|咱|俺|我们|他|她|他们|你们|你)/;
const HAS_TIME = /(年|年代|时候|那会儿|月|号|岁|解放|文革)/;

/** 用"正在讲的这件事 + 刚补的碎片"重新分析：位置、时间、人物一起抽出来 */
function analyzeMerged(statement, fragment) {
  const merged = `${statement}，${fragment}`;
  const a = analyze(merged);
  const fa = analyze(fragment);
  if (fa.times.length) a.times = [...fa.times, ...a.times.filter((t) => t.label !== fa.times[0].label)];
  if (fa.places.length) a.places = [...new Set([...fa.places, ...a.places])];
  if (fa.persons.length) a.persons = [...new Set([...fa.persons, ...a.persons])];
  return { a, merged: bare(a.statement) };
}

/** 建一条新故事，直接入库（不再请老人核对） */
function createStory(sessionId, a, statement, birthYear = null) {
  const res = addSentence({ ...a, statement, confidence: confidenceOf(a, statement) }, { status: 'confirmed', source: a.raw, session: sessionId, birthYear });
  if (res.action !== 'created') return { action: res.action, id: res.id, statement };
  return { action: 'created', id: res.id, statement, confidence: confidenceOf(a, statement) };
}

/** 置信度：证据越全越可信 */
function confidenceOf(a, statement) {
  let c = 0.5;
  if (a.times.length) c += 0.15;
  if (a.places.length) c += 0.1;
  if (a.persons.length) c += 0.12;
  if (a.events.length) c += 0.12;
  if (statement.length >= 6 && statement.length <= 34) c += 0.05;
  return Number(Math.min(0.95, c).toFixed(2));
}

/* ================================================================== *
 * 由主句拆出"主体-关系-时间"，供时间轴使用
 * ================================================================== */

function predicateOf(statement = '', a = {}) {
  const s = statement;
  const has = (re) => re.test(s);
  if (has(/住宿舍|住厂|住在|分房|盖房|买房|搬家/)) return '居住';
  if (has(/当兵|参军|入伍|退伍|转业|复员/)) return '从军';
  if (has(/上学|念书|读书|考大学|上大学|高考|中专|辍学/)) return '求学';
  if (has(/参加工作|进厂|学徒|上班|下岗|退休|学手艺|种地|挣工分|开机床|跑长途|开车/)) return '工作';
  if (has(/结婚|出嫁|成家|娶|嫁人/)) return '婚姻';
  if (has(/生孩子|生儿子|生女儿|抱孙/)) return '生育';
  if (has(/当班长|当队长|当厂长|入党|提干|评先进|立功|得奖/)) return '荣誉';
  if (has(/生病|住院|做手术/)) return '健康';
  if (has(/去世|过世|走了|没了/)) return '离别';
  if ((a.persons || []).length) return '人物';
  return '经历';
}

/* ================================================================== *
 * 整理简化 → 入库
 * ================================================================== */

/**
 * 老人改口 → 改库
 * ==========================================================================
 * "那是1987年不是88年" 不是一条新记忆，是对**已有记忆**的修改。
 * 原来直接当新事存了 —— 时间轴上冒出"1987 年 · 那是1987年不是88年"，
 * 而原来的 1988 纹丝不动，看着莫名其妙。
 *
 * 改法：
 *   kind='year' → 把年份等于 from 的那些记忆改成 to
 *                 （from 没提时，改"刚讲到的那件事"所在的年份）
 *   kind='word' → 把最近记忆里说错的词换成对的
 *
 * @returns {{changed:number, kind:string, from:any, to:any}}
 */
export function applyCorrection(fix, { sessionId = 'default' } = {}) {
  if (!fix) return { changed: 0 };
  const alive = listSentences({ limit: 400 });
  if (!alive.length) return { changed: 0, kind: fix.kind };

  if (fix.kind === 'year' && fix.to) {
    const label = fix.to + ' 年';
    // 优先按"错的年份"定位；没提就按刚讲到的那件事所在的年份
    let targets = fix.from ? alive.filter((r) => Number(r.year) === Number(fix.from)) : [];
    if (!targets.length) {
      const storyId = session(sessionId).story?.id;
      const row = storyId ? alive.find((r) => r.id === storyId) : null;
      const anchorRow = row || alive[alive.length - 1];
      if (anchorRow && anchorRow.year) targets = alive.filter((r) => Number(r.year) === Number(anchorRow.year));
      else if (anchorRow) targets = [anchorRow];
    }
    for (const r of targets) updateSentence(r.id, { year: fix.to, time_label: label });
    if (targets.length) log('改口：' + (fix.from || '?') + ' → ' + fix.to + '，改了 ' + targets.length + ' 条');
    return { changed: targets.length, kind: 'year', from: fix.from, to: fix.to };
  }

  if (fix.kind === 'word' && fix.from && fix.to) {
    // 只改最近讲过的几条，别误伤整库
    const recent = alive.slice(-8).filter((r) => String(r.statement).includes(fix.from));
    for (const r of recent) {
      updateSentence(r.id, { statement: String(r.statement).split(fix.from).join(fix.to) });
    }
    if (recent.length) log('改口：' + fix.from + ' → ' + fix.to + '，改了 ' + recent.length + ' 条');
    return { changed: recent.length, kind: 'word', from: fix.from, to: fix.to };
  }

  /* 让他删掉：同样只动最近几条 */
  if (fix.kind === 'delete' && fix.from) {
    const recent = alive.slice(-10).filter((r) => String(r.statement).includes(fix.from));
    for (const r of recent) deleteSentence(r.id);
    if (recent.length) log('改口（删掉）：' + fix.from + '，删了 ' + recent.length + ' 条');
    return { changed: recent.length, kind: 'delete', from: fix.from };
  }

  return { changed: 0, kind: fix.kind };
}

/**
 * 让大模型判断这些记忆各发生在哪一年，补进时间轴
 * ==========================================================================
 * 为什么需要这个：text.mjs 的 TIME_WORDS 只能认明确的说法（"文革""八十年代"
 * "年轻时候"）。老人说话常常是**前后一起说**的：
 *
 *   "我进厂那年刚满二十，一个月挣十八块五"
 *   "那会儿还没结婚呢，住厂里的集体宿舍"
 *   "过了两年才调回城里"
 *
 * 时间是"那年""那会儿""过了两年"—— 规则认不出绝对年份，
 * 整件事就掉进时间轴的"时间未定"。让模型结合上下文判，比规则强得多：
 * 它知道"那年"指的是前面刚说的那一年，也能用出生年份把年龄倒推成年代。
 *
 * 规则：
 *   · 已经有年份的**不动**（规则的明确结果比模型猜的可靠）
 *   · 模型说拿不准（year=null）就只补 label，别硬给年份
 *   · 判完失败的也不清空原来的 time_label
 *
 * @returns {Promise<{changed:number, items:Array}>}
 */
export async function judgeTimes(ids, { sessionId = 'default', history = [] } = {}) {
  const persona = getPersona();
  const birthYear = Number(persona.birth_year) || null;
  const thisYear = new Date().getFullYear();

  // 只挑"真的缺时间"的：没有年份、而且 label 也是空的或只是"时期"没年份
  const need = [];
  for (const id of ids) {
    const row = getSentence(id);
    if (!row) continue;
    if (row.year) continue;                       // 已经有年份，别覆盖
    const label = String(row.time_label || '').trim();
    if (/\d{4}/.test(label)) continue;            // label 里已经有年份了
    need.push({ id: row.id, statement: row.statement });
  }
  if (!need.length) return { changed: 0, items: [] };

  const hist = history.length
    ? history.map((h) => ({ role: h.role === 'elder' ? 'user' : 'agent', content: h.text }))
    : [];

  const out = await agentGuessTimes({ persona, items: need, history: hist, birthYear, thisYear });
  if (out?.error) return { changed: 0, items: [], error: out.error };

  let changed = 0;
  for (const it of out.items || []) {
    if (!it?.id) continue;
    const patch = {};
    if (it.year) {
      patch.year = it.year;
      patch.time_label = it.label || `${it.year} 年`;
    } else if (it.label) {
      // 判不出年份，但说得出是什么时期 —— 至少时间轴上不是"未定"
      patch.time_label = it.label;
    }
    if (!Object.keys(patch).length) continue;
    updateSentence(it.id, patch);
    changed += 1;
  }
  if (changed) log(`补时间：${changed} 条（${need.length} 条待判）`);
  return { changed, items: out.items || [] };
}

/**
 * 把老人讲的一段话整理成若干条主句，存进独立数据库
 * @returns {{created:Array, merged:Array, skipped:number}}
 */
export function distill(rawText, { sessionId = 'default', status = 'confirmed', source = '', birthYear = null, polished = '', lifeEvent = null, entities = null } = {}) {
  const created = [];
  const merged = [];
  let skipped = 0;

  for (const clause of splitClauses(rawText)) {
    const a = analyze(clause);
    /* 实体优先用**大模型抽的** —— 正则抽出来常是碎片：
         "我小时候在杭州长大，那时候穷" → 人物"时候穷"、地点"杭州长大"、年份 1853
       注意：模型给了**空数组**也要照用（它是在说"这里没有人名"），
       只有它根本没给 entities 时才退回 analyze 的正则结果 ——
       否则 "时候穷" 这种碎片会漏过来。 */
    if (entities && typeof entities === 'object') {
      if (Array.isArray(entities.persons)) a.persons = entities.persons;
      if (Array.isArray(entities.places)) a.places = entities.places;
      if (Array.isArray(entities.events)) a.events = entities.events;
      if (Array.isArray(entities.times) && entities.times.length) a.times = entities.times;
    }
    const statement = bare(a.statement);
    if (statement.length < 4) { skipped += 1; continue; }

    // 判断"值不值得存"。
    // 原来只认"有落脚点"（人/地/事/时），但实体词表再全也挂一漏万 ——
    // "我在国棉三厂当挡车工"里的厂名不在词表里，整句就被扔了。
    // 所以补一条：**第一人称的完整叙述也算数**。
    const hasEntity = a.persons.length + a.places.length + a.events.length + a.times.length > 0;
    // 第一人称兜底只认"在讲事"的（tell）——
    // "我今天挺高兴的"这种纯粹说心情的，不该当记忆存进去（那是情绪，不是事实）。
    const firstPerson = /^(我|咱|俺|我们)/.test(statement)
      && statement.length >= 6
      && a.intent.type === 'tell';
    /* 第三条兜底：**够长又在讲事**也算。
       原来只有前两条，于是"今天天气不错""我天天早上去公园"这类
       既没抽到实体、又不是纯粹第一人称讲事的，全被扔了。
       现在只要在讲事（tell）、句子够长、不是应声，就让进 —— 宁可多记一条，
       也不能让老人说了半天库里什么都没落下。 */
    const longEnough = statement.length >= 6 && a.intent.type === 'tell';
    if (!hasEntity && !firstPerson && !longEnough) { skipped += 1; continue; }

    // 置信度：证据越多越可信
    let conf = 0.5;
    if (a.times.length) conf += 0.15;
    if (a.places.length) conf += 0.1;
    if (a.persons.length) conf += 0.12;
    if (a.events.length) conf += 0.12;
    if (hasEntity) conf += 0.05;             // 有明确落脚点，更放心
    if (statement.length >= 6 && statement.length <= 34) conf += 0.05;
    conf = Number(Math.min(0.95, conf).toFixed(2));

    const res = addSentence(
      // 润色版只挂在第一句上（一次讲话通常就是一个子句，多子句时剩下的后面补）
      { ...a, statement, confidence: conf, polished: created.length === 0 ? polished : '', lifeEvent: created.length === 0 ? lifeEvent : null },
      { status, source, session: sessionId, birthYear },
    );

    if (res.action === 'created') {
      created.push({
        id: res.id,
        statement,
        asks: a.askForms,
        confidence: conf,
        persons: a.persons,
        places: a.places,
        events: a.events,
        time: (a.times[0] || {}).label || '',
        predicate: predicateOf(statement, a),
      });
    } else if (res.action === 'merged') {
      merged.push({ id: res.id, statement, overlap: res.overlap });
    } else {
      skipped += 1;
    }
  }

  return { created, merged, skipped };
}

/* 核对流程已砍掉。
   原来这里有一整套 confirmPhrase / stripConfirmPhrase，
   会在回话末尾缀一句"我记着了：…没记错吧？"，等老人点头才转正。
   现在不问了：老人说什么，整理简化之后直接入库。 */

/* ================================================================== *
 * 措辞
 * ================================================================== */

const pick = (arr, avoid) => {
  const bag = arr.filter((x) => x !== avoid);
  const list = bag.length ? bag : arr;
  return list[Math.floor(Math.random() * list.length)];
};

const OPENER = {
  爷爷: {
    hear: ['嗯嗯。', '哎。', '您说。', '哦——', '嗯，我听着呢。'],
    seen: ['哎哟，这事儿我记得。', '嗯，我想起来了。', '对，这个我记着。'],
    like: ['这个我爱听。', '说得好。', '这段有意思。'],
    hard: ['那时候是真难。', '苦日子，您熬过来了。'],
    warm: ['听着心里暖。', '这画面我能想出来。'],
    vague: ['好像是……', '我记着个大概，'],
    unknown: ['这个我还真没听您说过。', '这事儿我记不清了，'],
    recall: ['我记得呢，', '您说过，', '这个我记着，'],
  },
  奶奶: {
    hear: ['嗯嗯。', '哎。', '奶奶您说。', '哦——', '嗯，我听着呢。'],
    seen: ['哎哟，这事儿我记得。', '嗯，我想起来了。', '对，这个我记着。'],
    like: ['奶奶您讲得真好。', '这话我爱听。', '听着就跟看见似的。'],
    hard: ['那时候是真难。', '奶奶您受苦了。'],
    warm: ['听着心里暖。', '这画面我能想出来。'],
    vague: ['好像是……', '我记着个大概，'],
    unknown: ['这个我还真没听奶奶说过。', '这事儿我记不清了，'],
    recall: ['我记得呢，', '奶奶您说过，', '这个我记着，'],
  },
};
function openers(call) {
  return { ...OPENER.爷爷, ...(OPENER[call] || {}) };
}

const YES = /^(对|是|嗯|是的|对啊|对呀|没错|就是|是这个|对对|可不|可不嘛|差不多|应该是|好|行|中|要得)/;
const NO = /^(不对|不是|没有|不是的|没那事|记错了|错|不|哪有|瞎说|你记错)/;
const AVOID = /(不想说|别问了|以后再说|算了吧|不提这个|换个话题|不说这个|过会儿再说|等会儿|回头再说)/;

/**
 * 追问：一次只问一件小事，缺哪一格问哪一格。
 * 关键：老人刚补充过的那一格不再问第二遍（否则会出现"一直问地点"的死循环）。
 */
export function nextQuestion(a, story, call) {
  const t = a.cleaned;
  const who = a.persons[0] || '';
  const hasTime = Boolean(a.times[0]?.raw) || (analyze(story.statement || '').times.length > 0);
  const where = a.places[0] || analyze(story.statement || '').places[0] || '';
  const asked = new Set(story.asked || []);
  const okToAsk = (q) => q && q !== story.lastQ && !asked.has(q);

  // ① 还有没填的格子 → 按 谁 → 何时 → 何地 → 后来 的顺序补（问过的、已经有的都不再问）
  if (!who && /(一起|跟着|带着|和|跟|同)/.test(t) && okToAsk('那时候是跟谁一块儿呀？')) return '那时候是跟谁一块儿呀？';
  if (!hasTime && okToAsk('那大概是哪一年的事呀？')) return '那大概是哪一年的事呀？';
  if (who && !/后来/.test(t) && okToAsk(`${who}后来怎么样啦？`)) return `${who}后来怎么样啦？`;
  if (!where && okToAsk('那是在哪儿的事呀？')) return '那是在哪儿的事呀？';

  // ② 格子齐了或都问过 → 顺着内容往下问
  const pool = [
    '那时候日子过得咋样呀？',
    '这事儿您还记得最清楚的是哪一点呀？',
    '旁边的人都怎么说呀？',
    '那后来还有联系吗？',
    '您那时候心里是咋想的呀？',
    '这事儿家里人知道吗？',
  ].filter(okToAsk);  if (pool.length) return pool[0];

  // ③ 这个话题问得差不多了 → 换个话题
  const switches = [
    '咱换个事儿说说，您小时候最要好的伙伴是谁呀？',
    '那咱说说别的，您年轻时最要好的朋友是谁呀？',
    '这事儿我记下了。您还记得那时候家里都吃些什么吗？',
    '咱说说别的吧，您那会儿最盼着的是什么呀？',
  ].filter(okToAsk);
  return switches[0] || '您接着说，我听着呢。';
}

/** 库里没有时，把话头接住，请老人讲 */
function probe(a, call) {
  if (a.persons.length) return `${a.persons[0]}的事儿，我这会儿还没记全，您给我讲讲？`;
  if (a.places.length) return `${a.places[0]}那会儿的事，我这儿还是空白，您说给我听？`;
  const t = a.times[0];
  if (t) return `您${t.raw}的事，我还没听您讲过呢，您说说？`;
  return `${call}，这事儿我一时想不起来了，您给我讲讲，我记下来。`;
}

/**
 * 起草回答
 * @returns {{text:string, strategy:string, used:Array, ask:boolean}}
 */
export function compose({ persona, a, hits, sess, companion }) {
  const call = persona.elder_call || '爷爷';
  const o = openers(call);
  const top = hits[0];
  // 算不算"我确实记得"：要么字面重合够，要么靠话题类别对上（老人换了说法问同一件事）
  const confident = top && (top.score >= 0.45 || (top.via === 'topic' && top.score >= 0.4));
  const partial = top && top.score >= 0.3;
  const useOpener = (arr) => {
    const w = pick(arr, sess.lastOpener);
    sess.lastOpener = w;
    return w;
  };

  /* ---- 陪伴模式：不问、不采集、不复述 ---- */
  if (companion) {
    const base = /没事|挺好|算了|不想说/.test(a.cleaned)
      ? pick([`${call}，那咱就不说这些了。`, `${call}，我在呢，就这么坐着也行。`], sess.lastOpener)
      : pick([`${call}，我陪您待着。`, `${call}，不急，慢慢来。`], sess.lastOpener);
    sess.lastOpener = base;
    return { text: base, strategy: 'companion', used: [], ask: false };
  }

  /* ---- 讲述往事 / 补充细节：接住 + 顺着内容追问 ---- */
  if (a.intent.type === 'tell' || a.intent.type === 'mood' || sess.story.enriched) {
    const got = sess.story.enriched;
    const remark = contentRemark(a, sess.story);          // 先按内容说一句"听懂了"
    const ack = remark || useOpener(o.hear);

    // 老人刚补的那一格，先把它说出来，让他知道"我听见了"
    const echo = got?.place ? `${got.place}那地方，`
      : got?.year ? `${String(got.year).replace(/ 年$/, '')} 年，`
        : got?.person ? `您说的${got.person}，`
          : a.places.length ? `${a.places[0]}那地方，`
            : a.persons.length ? `您说的${a.persons[0]}，` : '';

    // 追问优先按内容（讲住宿舍问舍友、讲当兵问部队），没有对应内容再按"缺哪一格"
    const q = contentQuestion(a, sess.story, call) || nextQuestion(a, sess.story, call);
    return { text: `${ack}${echo}${q}`, strategy: remark ? 'tell_content' : got ? 'follow' : 'tell', used: [], ask: true, question: q, draftAsk: q };
  }

  /* ---- 只是应了一声 ---- */
  if (a.intent.type === 'ack') {
    // 一晚上问过一次"后来呢"就不再问；否则老人只答一个"嗯"会被反复追问
    const acknowledged = (sess.story.asked || []).length >= 2;
    if (confident && !acknowledged) return { text: `对了${call}，上回您说${brief(top.statement, 22)}，后来呢？`, strategy: 'ack_recall', used: [top], ask: true, question: '后来呢？' };
    const t = pick([`嗯，${call}，我在呢。`, `${call}，您接着说，我听着呢。`, `哎，${call}。`], sess.lastOpener);
    sess.lastOpener = t;
    return { text: t, strategy: 'ack', used: [], ask: false };
  }

  /* ---- 问智能体自己 ---- */
  if (a.intent.type === 'agent') {
    return { text: `我是${persona.agent_name}呀，${call}您的${persona.self_ref}。您说的事儿我都给您记着呢。`, strategy: 'self', used: [], ask: false };
  }

  /* ---- 询问 / 考记性：★搜索主句库作答 ---- */
  if (confident) {
    const extra = hits[1] && hits[1].score >= 0.5 && hits[1].id !== top.id ? `还有${brief(hits[1].statement, 20)}。` : '';
    return { text: `${useOpener(o.recall)}${brief(top.statement, 34)}。${extra}`, strategy: 'answer', used: hits.slice(0, 2), ask: false };
  }
  if (partial) {
    const q = '别的细节您再给我补补？';
    return { text: `${useOpener(o.vague)}我记得是${brief(top.statement, 28)}，${q}`, strategy: 'answer_vague', used: [top], ask: true, question: q };
  }
  const tail = probe(a, call);
  return { text: `${useOpener(o.unknown)}${tail}`, strategy: 'probe', used: [], ask: true, question: tail };
}

function brief(s = '', n = 30) {
  const t = bare(s);
  if (t.length <= n) return t;
  const parts = t.split(/[，,]/);
  let out = '';
  for (const p of parts) {
    if ((out + p).length > n) break;
    out += (out ? '，' : '') + p;
  }
  return out || t.slice(0, n);
}

/* ================================================================== *
 * 一轮对话
 * ================================================================== */

export async function handleTurn({ text, sessionId = 'default' } = {}) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('内容为空');

  const persona = getPersona();
  const call = persona.elder_call || '爷爷';
  const sess = session(sessionId);
  sess.turns += 1;

  logUtterance({ session: sessionId, role: 'elder', text: raw });
  let a = analyze(raw);

  // 情绪：本句信号 + 会话累计（看脸色知进退）
  sess.moodScore = Math.max(0, sess.moodScore * 0.7 + a.mood.score + mildMood(raw) * 0.7);
  if (a.mood.level === 'low' || sess.moodScore >= 2) sess.companionUntil = Date.now() + COMPANION_MS;
  const companion = Date.now() < sess.companionUntil;

  // 告诉守望模块：①有人说话了 ②这轮文字里的情绪
  watchActivity();
  if (a.mood.level && a.mood.level !== 'normal') {
    watchSetMood({ level: a.mood.level, score: a.mood.score, note: a.mood.hits?.join('/') || '', source: 'text' });
  }

  /* 安全兜底：老人说身体不舒服时记一笔。
     目的只是"要不要提醒他跟儿女说一声 / 去看看医生"，
     引擎不做医学判断，也不往提示词里塞症状名让模型猜。 */
  const sign = healthSigns(raw);
  let healthHint = '';
  if (sign.hit) {
    sess.healthLog = (sess.healthLog || []).filter((h) => Date.now() - h.at < 24 * 3600 * 1000);
    sess.healthLog.push({ at: Date.now(), phrase: sign.phrase, severe: sign.severe });

    const recent = sess.healthLog.filter((h) => Date.now() - h.at < 8 * 3600 * 1000);
    const severeSeen = recent.some((h) => h.severe);
    // 反复说（8 小时内 ≥2 次）或说过一次"厉害/好几天"这种 → 该提醒了
    const shouldNudge = (recent.length >= 2 || severeSeen)
      && Date.now() - (sess.lastHealthNudge || 0) > 12 * 3600 * 1000;   // 半天最多提一次，别唠叨

    if (shouldNudge) {
      sess.lastHealthNudge = Date.now();
      healthHint = recent.length >= 2
        ? `他今天已经提了 ${recent.length} 次身体不舒服（"${recent.map((h) => h.phrase).join('""')}"）。`
        : `他说身体不舒服，而且听着不轻（"${sign.phrase}"）。`;
    }
  }

  /* ① 核对流程已砍掉。
        原来这里会判断老人上一轮是点头还是否认，再决定那条记忆转正还是退回。
        现在不问了 —— 老人说什么就直接入库，见下面的 distill。 */

  /* ② 老人这句是"补充细节"吗？是就并进正在讲的这件事
        —— 关键：**我问哪一格，就只并哪一格**（问"在哪儿"时，答"1950年"不该被塞进去） */
  sess.story.enriched = null;

  /* ==================================================================
     语义判断：全交给大模型（understand.mjs）
     ------------------------------------------------------------------
     这里以前是一堆正则：
         isRequest()      是不是让岁语干活
         是不是改口（例如"那是1987年不是88年"）
         FRAGMENT /       是不是在补充细节、补哪一格
         detectSlot()
         intent           在讲事 / 在问 / 在说心情 / 只是应声
         mood             情绪
         healthSigns      身体哪儿不舒服
     说法太活，正则覆盖不全（"我这两��腰不得劲""你帮我把窗户关窗吧"）。
     现在一次模型调用全判完，正则只在**没配模型 / 调不通**时兜底（含离线自检）。
     ================================================================== */
  const said = await understand({ persona, text: raw, history: sess.history.slice(-6) });

  /* 请求句不是记忆 —— 是他这会儿的需求。不排除的话会被并进上一条正在讲的事，把正经记忆改坏。 */
  const request = said ? said.request : isRequest(a.cleaned);

  /* 改口：不是新记忆，是对已有记忆的修改 */
  const correction = said ? said.correction : null;
  const fixResult = correction ? applyCorrection(correction, { sessionId }) : null;

  /* 补充细节（"在北京""1950 年""我老伴也去了"）并进正在讲的那件事。
     **改口不算片段** —— 它已经在上面改进库了，再当片段并一次会把原句改坏
     （"我一九七五年……，不对，那不是75年，是1976年" 就是这么被拼进去的）。 */
  const isFragment = said
    ? (said.fragment && !request && !correction)
    : (!request && !correction && FRAGMENT.test(a.cleaned) && !NOT_FRAGMENT.test(a.cleaned));
  const slotKind = said ? (said.slot || detectSlot(a)) : detectSlot(a);

  const askedSlot = sess.lastAsk?.slot || '';     // 上一轮问的是哪一格
  let fragmentAbsorbed = false;                   // 这句是否已被并进"正在讲的这件事"
  let touchedMerged = null;                       // 补充细节并进故事之后，这一轮碰到的句子

  if (!companion && isFragment) {
    // 老人说的是补充细节（在哪儿、哪一年、谁），并进正在讲的这件事
    const la = sess.lastAsk;

    // 情况一：我刚问了个"开场式"的问题（在哪儿长大），老人答一句短语 → 合成一件事
    if (la && la.kind === 'open' && la.about) {
      const statement = bare(simplify(`${la.about}${a.cleaned}`));
      if (statement.replace(/[^\u4e00-\u9fa5]/g, '').length >= 4) {
        const all = analyze(statement);
        const story = createStory(sessionId, all, statement, Number(persona.birth_year) || null);
        if (story.action === 'created') {
          sess.story = newStory(story.id, statement, all);
          sess.story.enriched = { place: a.places[0], year: a.times[0]?.label, person: a.persons[0], fragment: a.cleaned };
          pushStory(sess, sess.story);
          a = { ...all, intent: { type: 'tell' } };
          sess.lastAsk = null;
          // 这句也要走统一的核对流程（下面 ⑥ 会拼上问句），
                touchedMerged = { id: story.id, statement };
        }
      }
    } else if (sess.story.id && sess.story.statement && !askedSlotBlocked(askedSlot, slotKind)) {
      // 情况二：正在讲一件事，老人补一格
      const { a: merged, merged: mergedStatement } = analyzeMerged(sess.story.statement, a.cleaned);
      const before = analyze(sess.story.statement);
      const gainedTime = merged.times.length > before.times.length;
      const gainedPlace = merged.places.some((p) => !before.places.includes(p));
      const gainedPerson = merged.persons.some((p) => !before.persons.includes(p));
      if (gainedTime || gainedPlace || gainedPerson) {
        sess.story.enriched = { place: gainedPlace ? a.places[0] : '', year: gainedTime ? a.times[0]?.label : '', person: gainedPerson ? a.persons[0] : '', fragment: a.cleaned };
        sess.story.statement = mergedStatement;
        fragmentAbsorbed = true;              // 这句已经被并进那件事，别再当新事存一遍
        a = merged;
        a.intent = { type: 'tell' };
        const upd = addSentence({ ...a, statement: mergedStatement, confidence: confidenceOf(a, mergedStatement) }, { status: 'confirmed', source: raw, session: sessionId, birthYear: Number(persona.birth_year) || null });
        if (upd.id) sess.story.id = upd.id;
        pushStory(sess, sess.story);
        sess.lastAsk = null;
        // 事情变完整了 —— 也要请他核对一遍（"我记着了：……这样对吧？"）。
        // 之前这里漏了，所以"老人补充细节"这条最常见的路一次都不核对。
        touchedMerged = { id: sess.story.id, statement: mergedStatement };
      }
    }
  }

  /* ③ 检索主句库 —— 分两次查、再合并：
        ① 只用老人这一句查（主判据，防止"没问的事"被答上来）
        ② 把"正在讲的这件事"接在后面查（帮老人用短句追问时也能对上）
        之前问过的问句**不进上下文**：那些是提问不是事实，混进来只会让判断跑偏。 */
  const ctxText = sess.story.statement && sess.story.turns > 0 ? sess.story.statement : '';
  const own = search(raw, a);
  const withCtx = ctxText ? search(`${raw} ${ctxText}`, analyze(`${raw} ${ctxText}`)) : [];
  const merged = new Map();
  for (const h of own) merged.set(h.id, { ...h, score: h.score, ownScore: h.score, ctxScore: 0 });
  for (const h of withCtx) {
    const cur = merged.get(h.id);
    if (cur) cur.ctxScore = h.score;
    else merged.set(h.id, { ...h, ownScore: 0, ctxScore: h.score });
  }
  const all = [...merged.values()];
  // 上下文只在"这句话本身跟库沾边"时才作数：
  //   · 字面 ≥ 3% 重合，或
  //   · 这句话提到的关键词/人物/地点/事件，真的出现在那条记录里
  // 否则（比如问"我小学在哪儿念"，而库里只有纺织厂的事）就不许拿上下文顶上。
  const queryTouches = (h) => {
    const probe = [...(a.keywords || []), ...a.persons, ...a.places, ...a.events].filter((k) => k && k.length >= 2);
    return probe.some((k) => h.statement.includes(k) || (h.persons || []).concat(h.places || [], h.events || []).some((x) => x.includes(k) || k.includes(x)));
  };
  const hits = all
    .map((h) => {
      const allowed = (h.why?.overlap || 0) >= 0.03 || queryTouches(h);
      return { ...h, score: Number((h.ownScore + (allowed ? 0.3 * h.ctxScore : 0)).toFixed(4)) };
    })
    .sort((x, y) => y.score - x.score)
    .slice(0, 5);
  const good = hits.filter((h) => h.score >= 0.45);
  if (good.length) markAsked(good.slice(0, 2).map((h) => h.id));

  /* ④ 作答：交给智能体工作流（src/agent.mjs）
        它把"全部记忆"直接放进提示词，由模型自己决定怎么接、怎么答、答什么。
        原来那套"阈值分流 + compose 拼句子"退到两条后路：
          · 模型没配 / 调不通 → compose 兜底
          · 模型该记得却说记不清 → 用库里那条记忆替换掉它的措辞 */
  let out = compose({ persona, a, hits, sess, companion });
  let text2 = out.text;
  let usedLLM = null;

  if (!fragmentAbsorbed && llmConfig().available) {
    // 全部记忆都给模型 —— 不再只喂检索命中的那几条，
    // 因为"该不该想起来"由模型判断，比打分阈值准。
    const rows = listSentences({ limit: 400 });
    // 核对流程砍掉之后就没有"待确认"这一档了 —— 老人说的直接入库，全是已确认
    const confirmed = rows.slice(-160);

    const giveHits = hits.filter((h) => h.score >= 0.22).slice(0, 5);
    const modelOut = await agentReply({
      persona,
      confirmed,
      story: sess.story.id ? sess.story.statement : '',
      history: sess.history.slice(-8).map((h) => ({
        role: h.role === 'elder' ? 'user' : 'assistant',
        content: h.text,
      })),
      text: raw,
      companion,
      healthHint,
    });
    if (modelOut?.text) {
      usedLLM = { model: modelOut.model, ms: modelOut.ms, usage: modelOut.usage };
      text2 = modelOut.text;
      out.strategy = companion ? 'companion_llm' : 'llm';
      out.ask = /[？?]/.test(text2);
      out.question = (text2.match(/[^。！？]*[？]/g) || []).pop()?.trim() || '';

      // 兜底：明明查到了他问的事，模型却说"记不清" —— 不能出现这种情况，
      //       直接用库里那条记忆替换掉模型的答复（记忆是事实，模型只是措辞）。
      const askedMemory = a.intent.type === 'ask' || a.intent.type === 'recall';
      const refusing = /(记不清|不记得|没听.{0,3}说过|想不起来|没跟我讲)/.test(text2);
      const strong = giveHits.find((h) => h.score >= 0.4);
      if (askedMemory && refusing && strong) {
        const ack = pick(openers(call).recall);
        text2 = `${ack}${brief(strong.statement, 34)}。`;
        usedLLM = { ...usedLLM, patched: true, reason: '模型说记不清，但库里查到了' };
        out.strategy = 'answer_patched';
        out.ask = false;
        out.question = '';
      }
    } else if (modelOut?.error) {
      usedLLM = { error: modelOut.error };
    }
  }

  // （核对分支已砍掉：原来这里会处理老人"点头/否认"，现在不问了）

  // 防复读：这一轮要问的句子，上一轮刚问过就换一句
  if (out.ask && out.question === sess.story.lastQ) {
    const alt = nextQuestion(a, { ...sess.story, lastQ: out.question, asked: [...sess.story.asked, out.question] }, call);
    if (alt && alt !== out.question) text2 = text2.replace(out.question, alt);
    out.question = alt;
  }
  if (out.ask && out.question) {
    sess.story.lastQ = out.question;
    sess.story.asked.push(out.question);
    if (sess.story.asked.length > 12) sess.story.asked.shift();
  }
  // 记下"我刚问的是哪一格"，下一句碎片才知道该不该并进来
  sess.lastAsk = out.ask
    ? {
      question: out.question || '',
      about: sess.story.id ? '' : (sess.story.seed || openSeed(out.question)),
      kind: sess.story.id ? 'slot' : 'open',
      slot: slotOfQuestion(out.question),
    }
    : null;

  /* ⑤ 整理入库：老人讲出一件事，就整理简化存进库 */
  /* "是不是在讲事" —— 有大模型的判断就用它的，没有再退回正则分类 */
  const intentType = said ? said.intent : a.intent.type;
  const tellable = intentType === 'tell' || intentType === 'mood';
  /* "值不值得存" —— 大模型直接给结论（memorable）；
     正则兜底时才看长度。这一层管"值不值得存"，distill 那层管"有没有内容"。 */
  const bodyLen = a.cleaned.replace(/[，。！？、；：\s]/g, '').length;
  const substantial = said ? said.memorable : bodyLen >= 5;
  const declined = said ? intentType === 'ack' && !substantial : AVOID.test(a.cleaned);
  const pieces = [];
  const touched = new Map();          // 这一轮被记进库里的句子：id → 说法
  if (touchedMerged?.id && touchedMerged.statement) touched.set(touchedMerged.id, touchedMerged.statement);

  if (tellable && substantial && !declined && !fragmentAbsorbed && !request && !correction) {
    const distilled = distill(raw, { sessionId, status: 'confirmed', source: raw, birthYear: Number(persona.birth_year) || null, polished: said ? said.polished : '', entities: said ? said.entities : null, lifeEvent: said ? (said.scope === 'major' ? 2 : (said.scope === 'detail' ? 1 : 0)) : null });
    for (const m of distilled.merged) touched.set(m.id, m.statement);
    const first = distilled.created[0];
    if (first) {
      // 这句是不是"正在讲的某件事"的一部分？
      //   "想起和老张去买苹果" ⊂ "我小时候住在西城区的胡同里，想起和老张去买苹果"
      // 是就并回那件事（顺带把上下文提到那件更完整的事上），不再单独存碎句
      const neu = bare(first.statement).replace(/[^\u4e00-\u9fa5]/g, '');
      // 从上一件往更早找：如果这句是**先前那件事**的一部分，就并回去（不看本句刚更新的那条）
      const earlier = (sess.recentStories || []).filter(
        (s) => s.statement.replace(/[^\u4e00-\u9fa5]/g, '') !== neu,
      );
      const host = earlier.find((s) => {
        const cur = bare(s.statement).replace(/[^\u4e00-\u9fa5]/g, '');
        return cur.length > neu.length + 2 && cur.includes(neu);
      });
      if (host) {
        deleteSentence(first.id);
        sess.story = { ...host };                 // 把当前这件事换回更完整的那条，后面的补充才并得对
        sess.story.enriched = sess.story.enriched || null;
        touched.set(host.id, host.statement);
      } else {
        sess.story = newStory(first.id, first.statement, a);
        pushStory(sess, sess.story);
        pieces.push(...distilled.created.map((c) => ({ statement: c.statement, confidence: c.confidence, time: c.time, persons: c.persons, places: c.places, events: c.events })));
        for (const c of distilled.created) touched.set(c.id, c.statement);
      }
    } else if (sess.story.id) {
      sess.story.turns += 1;
      touched.set(sess.story.id, sess.story.statement);
    }
  }

  /* ⑥ 核对流程已砍掉 —— 不再在回话后面缀"我记着了：…没记错吧？"。
        老人说什么就直接入库（上面 distill 用的 status 已经是 confirmed）。 */

  /* ⑥·⑤ 让大模型补时间。
     规则表认得出"文革""八十年代"，但认不出"那年""那会儿""过了两年"——
     老人偏偏最爱这么说话，于是整件事掉进时间轴的"时间未定"。
     这里把这一轮新存/合并过的句子交给模型，结合上下文判年份。

     **不 await**：这是背景补数据，别让老人等着听回复。
     补完家人端刷新就能看到，晚一两秒无所谓。 */
  if (touched.size) {
    judgeTimes([...touched.keys()], { sessionId, history: sess.history.slice(-8) })
      .catch((e) => log(`补时间失败：${e.message}`));
  }

  // 话题断点
  if (pieces.length) bumpTopic(pieces[0].statement.slice(0, 12), pieces[0].statement, false);

  text2 = tidy(text2, (persona.max_chars || 60) + 40);
  logUtterance({ session: sessionId, role: 'agent', text: text2 });
  remember(sess, 'elder', raw);
  remember(sess, 'agent', text2);

  return {
    reply: text2,
    mode: companion ? 'companion' : 'normal',
    by: usedLLM && !usedLLM.error ? 'llm' : 'rules',
    llm: usedLLM,
    strategy: out.strategy,
    context: {
      story: sess.story.id ? sess.story.statement : '',
      recent: sess.history.slice(-6).map((h) => `${h.role === 'elder' ? '老人' : '岁语'}：${h.text}`),
      searchedWith: ctxText || '（只有这一句）',
      askedSlot: sess.lastAsk?.slot || '',
    },
    heard: {
      cleaned: a.cleaned,
      statement: a.statement,
      intent: a.intent.type,
      persons: a.persons,
      places: a.places,
      times: a.times.map((t) => ({ raw: t.raw, label: t.label })),
      events: a.events,
      keywords: a.keywords.slice(0, 12),
      mood: { level: a.mood.level, hits: a.mood.hits, score: Number(sess.moodScore.toFixed(2)) },
    },
    recall: hits.slice(0, 3).map((h) => ({
      seq: h.seq, statement: h.statement, score: h.score, why: h.why, status: h.status, time: h.time_label || h.time_raw,
    })),
    stored: {
      created: pieces,
      merged: touched.size ? [...touched.values()].map((statement) => ({ statement })) : [],
      skipped: 0,
      story: sess.story.id ? { id: sess.story.id, statement: sess.story.statement, enriched: sess.story.enriched } : null,
    },
    stats: stats(),
  };
}

/** 收尾整理标点：一次只有一个问号，不留"？。"这种重叠 */
function tidy(text = '', max = 100) {
  let s = String(text)
    .replace(/([。！？!?，,；;：:])\s*[。！？!?，,；;：:]+/g, '$1')
    .replace(/[？?]。/g, '？');
  if (s.length > max) {
    const cut = s.slice(0, max);
    const i = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('？'), cut.lastIndexOf('！'));
    s = i > max * 0.5 ? cut.slice(0, i + 1) : cut;
  }
  return s.trim();
}

/* ================================================================== *
 * 主动开口
 * ================================================================== */

/**
 * 主动开口。
 *
 * 关键：开场白**必须记进对话历史**。
 * 不记的话，老人回答"您跟秀兰奶奶是在厂里认识的吧"时，
 * 模型只看到一句孤零零的"在厂里认识的"，看不到被回答的那个问题，
 * 于是答得牛头不对马嘴。这个 bug 之前一直在。
 */
export async function opening({ sessionId = 'default', reason = 'auto' } = {}) {
  const sess = session(sessionId);
  const r = await buildOpening({ sessionId, reason });
  if (r?.text) {
    remember(sess, 'agent', r.text);
    // ★ 告诉守望"我刚说过话"。
    //   不这么做的话：开场问候刚出来，1.5 秒后守望又判定"很久没人说话"再搭一句，
    //   老人一次看到两条。开场白本身就已经是"我来了"。
    watchNoteOpening();
  }
  return r;
}

async function buildOpening({ sessionId = 'default', reason = 'auto' } = {}) {
  const persona = getPersona();
  const call = persona.elder_call || '爷爷';
  const hour = new Date().getHours();
  const part = hour < 6 ? '这么早就醒了' : hour < 11 ? '早上好' : hour < 14 ? '中午了' : hour < 18 ? '下午好' : '晚上好';
  const st = stats();
  const sess = session(sessionId);

  /** 记下"这句话是问什么的"，老人下一句短回答才能并进一件事 */
  const askWith = (text, kind, about) => {
    sess.lastAsk = { question: text, kind, about: about || '', slots: ['base'] };
    return text;
  };

  if (reason === 'companion') return { text: `${call}，我不问了，就陪您坐会儿。`, why: '陪伴模式' };

  /* 优先让智能体起话头 —— 它拿着全部记忆，比"待核对 → 话题 → 空白年份"
     这套固定优先级自然得多。下面是它起不出来时的兜底。 */
  if (llmConfig().available) {
    const rows = listSentences({ limit: 400 });
    const confirmed = rows.slice(-60);
    const out = await agentOpening({ persona, confirmed, recent: recentOpenings(5) });
    if (out?.text) {
      const text = tidy(out.text, Number(persona.max_chars) || 45);
      sess.lastAsk = { question: text, kind: 'open', about: openSeed(text), slots: ['base'] };
      pushOpening(text);
      return { text, why: '智能体起的话头', by: 'llm', ms: out.ms };
    }
    log('智能体起话头失败，退回规则：', out?.error || '空');
  }

  // （原来这里会挑一条"待老人核对"的记录去问 —— 核对流程已砍掉，不再问了）

  const topics = listTopics(3).filter((t) => t.status === 'open' && t.last_said);
  if (topics.length) {
    const text = `${call}，${part}。上回您说${brief(topics[0].last_said, 16)}，后来怎么样啦？`;
    return { text: askWith(text, 'slot', topics[0].last_said), why: '接续上次没讲完的' };
  }

  if (st.sentences === 0) {
    return {
      text: askWith(`${call}，${part}。我是${persona.agent_name}，您的${persona.self_ref}。您小时候是在哪儿长大的呀？`, 'open', '我小时候在'),
      why: '第一次见面，从童年问起',
    };
  }

  // 有空缺就问问空缺那几年
  const rows = listSentences({ limit: 300 }).filter((s) => s.year);
  if (rows.length >= 2) {
    const years = rows.map((r) => Number(r.year)).sort((x, y) => x - y);
    const birth = Number(persona.birth_year) || years[0] - 20;
    for (let y = birth + 16; y < (years[years.length - 1] || birth + 60); y += 4) {
      if (!years.some((v) => v >= y && v < y + 4)) {
        const text = `${call}，${y} 年到 ${y + 4} 年那阵子，您在做什么呀？`;
        return { text: askWith(text, 'slot', `我${y} 年`), why: '时间轴上这段还是空白' };
      }
    }
  }
  const last = listSentences({ limit: 300 }).slice(-1)[0];
  const text = `${call}，${part}。您再给我讲讲${last ? `${brief(last.statement, 12)}之后` : '您年轻时候'}的事吧？`;
  return { text: askWith(text, 'slot', last ? last.statement : ''), why: '顺着上次往下问' };
}

/* ================================================================== *
 * 陪伴守望：情绪低落 / 太久没说话 → 主动关心
 * ================================================================== */

/**
 * 客户端每隔一会儿问一次：现在该主动开口吗？
 * 该的话就把话说出来，并记进历史（跟开场白一样，不记的话老人一回答就接不上）。
 */
export async function watchCheck({ sessionId = 'default' } = {}) {
  const d = watchDue();
  if (!d.speak) return { speak: false, reason: d.reason, watch: watchSnapshot() };

  /* 补发：这句是刚才已经生成过的（有页面还没显示出来），直接把它给出去。
     千万别再调一次大模型 —— 补发不是"重新说一句"，内容必须是同一句，
     否则两个页面会显示两句不同的话。 */
  if (d.replay && d.text) {
    return {
      speak: true, replay: true, id: d.id, at: d.at, reason: d.reason, text: d.text,
      mood: d.mood || null, watch: watchSnapshot(),
    };
  }

  const persona = getPersona();
  const sess = session(sessionId);

  /* ⚠️ 先把这次开口"占"掉，再去调大模型。
     生成要一两秒，期间客户端可能又轮询进来一次（或者开着多个页面），
     两边都会看到"这一波还没安慰过"，于是各说一句 —— 老人连着听到两句。
     所以标记要提前：第二个请求一进来就会发现已经说过了。
     生成失败再还回去，别把机会白白吃掉。 */
  const claim = watchClaim(d.reason);

  // 把最近几句对话也带上 —— 安慰的时候知道他在为什��难过，话才说得进去
  const out = await agentCheckIn({
    persona,
    reason: d.reason,
    // low = 确实难过；uneasy = 只是看着不对劲（生气/烦躁/害怕），别硬当成难过
    moodLevel: d.mood?.level || '',
    recent: recentOpenings(5),
    history: sess.history.slice(-6).map((h) => ({ role: h.role === 'elder' ? 'user' : 'agent', content: h.text })),
  });

  if (!out?.text) {
    watchRelease(claim);
    return { speak: false, reason: `生成失败：${out?.error || '空'}` , watch: watchSnapshot() };
  }

  const text = tidy(out.text, Number(persona.max_chars) || 45);
  remember(sess, 'agent', text);
  pushOpening(text);

  // 打到终端上 —— 不然"到底有没有主动开口过"只能靠猜
  const why = d.reason === 'low_mood'
    ? `${d.mood?.level === 'uneasy' ? '看着不太对劲' : '情绪低落'}${d.mood?.note ? `（${d.mood.note}）` : ''}`
    : `已经 ${Math.round((d.silentMs || 0) / 60000)} 分钟没人说话`;
  watchNoteText(text);       // 把说的话补进"主动开口史"（claim 时还不知道要说什么）
  log(`陪伴守望：主动开口（${why}）→ ${text}`);

  // 情绪不对时顺手进陪伴模式：接下来几轮不问事、只陪着
  if (d.reason === 'low_mood') sess.companionUntil = Date.now() + COMPANION_MS;

  return {
    speak: true, reason: d.reason, text, ms: out.ms, mood: d.mood || null,
    id: watchPendingId(),            // 页面按这个 id 去重，避免多标签页重复显示
    watch: watchSnapshot(),
  };
}

export {
  watchSnapshot as watchState, notePoll, ackSpoken, watchConfigure, watchClearLog, watchSetMood,
};

export { analyze, search, stats, listSentences };
