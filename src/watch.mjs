/**
 * 陪伴守望 —— 什么时候该主动开口
 * ==========================================================================
 * 三个输入：
 *   ① 摄像头看出来的情绪（视觉模型，可选，默认关闭 —— 涉及隐私）
 *   ② 对话文字里的情绪（text.mjs 的 mood / mildMood，已有）
 *   ③ 多久没人说话了
 *
 * 两个触发：
 *   · 老人情绪低落        → 主动安慰（不问事）
 *   · 超过 2 小时没对话   → 主动搭话
 *
 * 这里只做"该不该开口、因为什么"，具体说什么由 agent.mjs 的提示词决定。
 * ========================================================================== */
import { nowISO } from './util.mjs';
import { getMeta, setMeta } from './store.mjs';

/**
 * 连续几次「非消极」读数才算这一波真的过去了。
 *
 * 模型逐帧是抖的 —— 同一张脸连测几次，会 angry 42% ↔ 34% 来回跳。
 * 只按 1 次判的话，恰好那一帧是 normal 就把"难过"抹掉了，
 * 而摄像头每 5 秒喂一次、页面每 12 秒问一次，撞上的概率还不低。
 * 3 次（约 15~45 秒）既不会被单帧噪音骗，也不会"看到一次正常就忘了刚才难过"。
 */
const NEG_CLEAR_STREAK = 3;

const DEFAULTS = {
  enabled: true,
  idleMs: 5 * 60 * 1000,           // 【测试期】5 分钟；正式改回 2 * 60 * 60 * 1000
  /**
   * ★「主动开口」的最小间隔 —— 这是**说话**的节奏，跟**看脸**的节奏是两回事。
   *
   * 一定要跟 cameraIntervalMs / cameraFastMs 分开看：
   *   看脸    盯着表情，看多勤都不打扰人（只管看，不说话）
   *   开口    真的张嘴说话 —— 由这个值兜底
   *
   * 原来这里是 15 秒，跟看脸的间隔一模一样，结果：
   *   ① 看上去像是"每 15 秒就可能说一句"，其实不是（还要过其它闸门）
   *   ② 15 秒确实太密了 —— 老人会觉得这孙子一直在旁边念叨
   *
   * 现在 5 分钟：**主动说的话，最快也就 5 分钟一句**。
   * 另有更严的两档压在它上面：
   *   闲置搭话   minGapMs（10 分钟）
   *   一直难过   sadRepeatMs（10 分钟）
   */
  debounceMs: 5 * 60 * 1000,
  /**
   * 「第一次发现情绪不对」用的防抖 —— 设成 0，**马上说**。
   *
   * 上面那个 5 分钟防抖是为了别唠叨，但**第一次**看出老人情绪不对，
   * 恰恰是最该立刻开口的时候。岁语刚回答完一句话、摄像头紧接着就看出
   * 他脸色不对，难道还要干等 5 分钟？所以这一档单独拎出来，默认不等。
   *
   * 注意它只对"新的一波"生效；同一波里再说，仍然受 debounceMs 管。
   * 不怕并发说两句：engine 里在调大模型**之前**就把这次开口"占"掉了，
   * 后进来的请求会看到已经说过。详见 watchCheck()。
   */
  firstMoodDebounceMs: 0,
  /**
   * 情绪低落时的节奏。
   *
   * 老人难过 → **马上说**，不等任何冷却。
   * 一直难过着 → 每 10 分钟再说一句（不是唠叨，是"我一直在这儿"）。
   * 缓过来了 → 这一波结束；再难过 → 又是马上说。
   *
   * 之前这里是个"安慰过一次就锁 N 分钟"的冷却，结果老人一直闷着，
   * 它安慰一句之后就再也不吭声了 —— 那不对。
   */
  sadRepeatMs: 10 * 60 * 1000,
  minGapMs: 10 * 60 * 1000,        // 两次"闲置搭话"之间至少隔 10 分钟
  cameraEnabled: true,             // 摄像头默认打开（前端也是默认自动开，两边要一致）
  /**
   * 安静模式（页面上那个「🤝 只想有人陪」）。
   *
   * 打开之后**一句主动的话都不说** —— 不管看出他情绪不好，还是两个钟头没动静，
   * 都不开口。老人什么时候想说话，自己按话筒或者打字，那时候照常回。
   *
   * 这个模式是老人自己选的，所以压过所有其它触发：
   * 「只想有人陪」的意思就是"你在这儿待着就行，别说话"。
   *
   * 注意别跟 quietFrom/quietTo（夜间静默）搞混 —— 那个是到点自动静音，
   * 这个是老人手动开的。
   */
  companion: false,
  /**
   * 多久看一眼脸 —— 自适应两档。
   *
   * 一开始写死 2 分钟，两个毛病：
   *   ① 太慢。他刚皱眉，得等快 2 分钟才被发现
   *   ② 更要命的是**恢复也慢** —— "他缓过来了"是靠看到非消极读数判断的，
   *      2 分钟一次就意味着这一波最多要拖 2 分钟才算结束
   *
   * 现在：平常 15 秒扫一眼（CPU 只占 2% 左右），
   *      一旦看到情绪不对就 5 秒看一次 —— 尽快分清他是真难受，
   *      还是只是刚好那个表情。
   */
  cameraIntervalMs: 15 * 1000,     // 平常
  cameraFastMs: 5 * 1000,          // 情绪不对时
  quietFrom: 22,                   // 晚上 22 点后不主动打扰
  quietTo: 7,                      // 早上 7 点前不主动打扰
};

/** 页面问了一次「该不该开口」—— 记下来，界面上要显示。
 *  不然"该开口"却没声音的时候，分不清是没触发、还是页面根本没在问。 */
export function notePoll() {
  state.polls += 1;
  state.lastPollAt = Date.now();
}

/** 现在该多久看一次脸（客户端每次拍完会问一次） */
export function cameraEveryMs() {
  const cfg = state.config;
  const m = state.lastMood;
  const bad = m && (m.level === 'low' || m.level === 'uneasy');
  const want = bad ? cfg.cameraFastMs : cfg.cameraIntervalMs;
  return Math.max(1000, Number(want) || 15000);
}

function loadConfig() {
  try { return { ...DEFAULTS, ...JSON.parse(getMeta('watch_config', '{}')) }; } catch { return { ...DEFAULTS }; }
}
export function configure(patch = {}) {
  const next = { ...loadConfig(), ...patch };
  setMeta('watch_config', JSON.stringify(next));
  state.config = next;
  return next;
}

/** 恢复默认节奏（清掉之前调试时存进库里的奇怪数值） */
export function resetConfig() {
  try { setMeta('watch_config', null); } catch { /* 没库也能用 */ }
  state.config = { ...DEFAULTS };
  return state.config;
}

export const state = {
  config: loadConfig(),
  lastActivity: Date.now(),      // 上次"有人说话"（老人或岁语）
  lastMood: null,                // { level, score, note, source, at }
  lastSpokenAt: 0,               // 上次主动开口
  lastMoodSpokenAt: 0,           // 上次因为情绪低落而安慰
  lastComfortedMoodAt: 0,        // 上次安慰时对应的那条情绪读数
  /**
   * 这一波低落安慰过了没有。
   *
   * 比"按时间冷却"更符合直觉：老人一直闷着 → 只安慰一次，不反复打扰；
   * 等他缓过来了（出现非低落读数）→ 这一波结束；之后再闷 → 再安慰。
   * 这样"难过就说话"才成立 —— 不用等 15 分钟才有下一次。
   */
  sadEpisode: false,
  camera: { on: false, lastFrameAt: 0, lastResult: null, error: '' },
  log: [],                 // 情绪读数流水（家人端可以看）
  spokeLog: [],            // 主动开口历史（给界面看的）
  polls: 0,                // 页面问过多少次「该不该开口」（排查用）
  lastPollAt: 0,
  // 消极情绪的"确认"状态 —— 模型逐帧会抖，不能靠单帧下结论
  negSince: 0,             // 这一波消极从什么时候开始（0 = 当前没有）
  negAt: 0,                // 最近一次**消极**读数是什么时候
  negLevel: '',            // 最近一次消极读数的档位（low / uneasy）
  negStreak: 0,            // 从上次消极之后，连续收到几次非消极读数
  // 刚说过的这句 —— 谁问都给，页面按 id 去重。
  // 这样"后台标签页先把消息领走、正在看的页面什么都收不到"就不会再发生了。
  pending: null,
  pendingSeq: 0,
};

/* ------------------------------------------------------------------ *
 * 输入
 * ------------------------------------------------------------------ */

/** 有人说话了（老人说的，或岁语回的都算）—— 重置闲置计时 */
export function noteActivity() {
  state.lastActivity = Date.now();
}

/** 摄像头 / 文字来的情绪读数 */
export function setMood({ level, score = 0, note = '', source = 'camera', why = null, expression = '', face = null }) {
  // 摄像头给的档位有四个：low(难过) uneasy(看着不太对劲) normal happy。
  // 文字情绪只给 low/soft/flat，这里一并归到四档里。
  const lv = ['low', 'uneasy', 'normal', 'happy'].includes(level) ? level : 'normal';
  const reading = {
    level: lv,
    score: Number(score) || 0,
    note: String(note || '').slice(0, 120),
    source,
    at: Date.now(),
    // 判定依据（P(sad)/消极/积极），页面上要说明"为什么是这个心情"
    why: why || null,
    expression: String(expression || '').slice(0, 20),
    face,
  };
  state.lastMood = reading;
  state.log.push({ ...reading, at: nowISO() });
  if (state.log.length > 200) state.log.shift();
  if (source === 'camera') {
    state.camera.lastResult = reading;
    state.camera.error = '';
  }
  /* ★ 消极要"确认得住"，不能被一两帧噪音抹掉。
     模型逐帧是抖的：同一张脸连测几次，会 angry 42% ↔ 34% 来回跳。
     摄像头每 5 秒喂一次、页面每 12 秒问一次 —— 只要问的那一瞬间恰好是 normal，
     这一波就被判成"没事"，永远等不到。所以：
       · 消极读数   → 记下 negSince/negAt/negLevel，清空 negStreak
       · 非消极读数 → negStreak++，**连续 negClearStreak 次**才算这一波过去
     这样既不会被单帧噪音骗，也不会"看到一次正常就忘了刚才难过"。 */
  if (lv === 'low' || lv === 'uneasy') {
    state.negStreak = 0;
    state.negAt = reading.at;
    state.negLevel = lv;
    if (!state.negSince) state.negSince = reading.at;   // 这一波从什么时候开始
  } else {
    state.negStreak += 1;
    if (state.negStreak >= NEG_CLEAR_STREAK) {
      state.negSince = 0;          // 这一波真的过去了
      state.negLevel = '';
      state.sadEpisode = false;    // 之后再消极算新的一波，可以重新关心
    }
  }
  return reading;
}

/* ------------------------------------------------------------------ *
 * 判断：现在该主动开口吗
 * ------------------------------------------------------------------ */

const MOOD_CN = { low: '难过', uneasy: '看着不太对劲', normal: '正常', happy: '心情不错' };

/** 深夜不打扰 */
function inQuietHours(cfg) {
  const h = new Date().getHours();
  if (cfg.quietFrom === cfg.quietTo) return false;
  return cfg.quietFrom < cfg.quietTo
    ? (h >= cfg.quietFrom && h < cfg.quietTo)
    : (h >= cfg.quietFrom || h < cfg.quietTo);
}

/**
 * 现在该主动开口吗？
 *
 * 除了结论，还返回一份 **trace**：逐个闸门的放行/拦下情况。
 * 「内部过程 → 陪伴守望」会把这份 trace 摊开，
 * 到底有没有在检测，一眼就能确认，不用猜。
 *
 * @returns {{speak:boolean, reason:string, trace:Array, mood?:object, silentMs?:number}}
 */
export function due() {
  const cfg = state.config;
  const now = Date.now();
  const trace = [];
  const gate = (name, pass, detail) => { trace.push({ gate: name, pass, detail }); return pass; };
  const stop = (reason) => ({ speak: false, reason, trace });

  if (!gate('总开关', cfg.enabled, cfg.enabled ? '陪伴守望已开启' : '被关掉了')) return stop('未开启');

  /* 安静模式压过其它所有触发 —— 排在夜间静默、情绪判断、闲置判断**前面**。
     老人自己按了「只想有人陪」，那就一句主动的话都不说。
     他要是想说话，自己按话筒或打字，那时候照常回（这条只管"主动开口"）。 */
  if (!gate('安静模式', !cfg.companion, cfg.companion
    ? '「只想有人陪」开着 —— 等您先开口我才接话'
    : '没开（正常主动关心）')) return stop('安静模式：不主动开口');

  const quiet = inQuietHours(cfg);
  gate('夜间静默', !quiet, quiet
    ? `现在是 ${new Date().getHours()} 点，落在静默时段 ${cfg.quietFrom}:00–${cfg.quietTo}:00`
    : `不在静默时段（${cfg.quietFrom}:00–${cfg.quietTo}:00）`);
  if (quiet) return stop('夜间不打扰');

  // ⚠️ 情绪判断要排在防抖**前面** —— 因为"第一次发现情绪不对"用的是另一档防抖。
  //
  // 原来的顺序是"防抖 → 情绪"，防抖写死 15 秒，结果：
  // 岁语刚回答完老人一句话，摄像头马上就看出他情绪不对，却还得干等 15 秒。
  // 第一次发现不对是**最该立刻开口**的时候，不该被上一句的时间卡住。
  //
  // ⚠️ 而且判据是 hasNeg（"最近确认过消极"），**不是** lastMood.level。
  //
  // 这是个真踩到的坑：模型逐帧在抖（同一张脸反复测，angry 42% ↔ 34%），
  // 摄像头每 5 秒喂一次，页面每 12 秒问一次 —— 只要问的那一瞬间恰好是 normal，
  // 这一波就被判成"没事"，永远等不到。所以消极一旦确认过，
  // 就不能被一两帧噪音抹掉，要连续 negClearStreak 次正常才算真的缓过来。
  const m = state.lastMood;
  const badMood = state.negSince > 0;
  const moodFresh = badMood && now - state.negAt < 30 * 60 * 1000;
  const firstOfEpisode = !state.sadEpisode;
  const firstNegative = badMood && moodFresh && firstOfEpisode;
  const levelCN = { low: '难过', uneasy: '看着不太对劲' }[state.negLevel] || '情绪不对';

  const gap = now - state.lastSpokenAt;
  const needGap = firstNegative ? cfg.firstMoodDebounceMs : cfg.debounceMs;
  const debounceOk = !state.lastSpokenAt || gap >= needGap;
  gate('防抖', debounceOk, !state.lastSpokenAt
    ? '还没主动开口过'
    : firstNegative
      ? `第一次发现情绪不对 → 不等（要求 ≥ ${fmtGap(needGap)}，实际隔了 ${fmtGap(gap)}）`
      : `距上次主动开口 ${fmtGap(gap)}，要求 ≥ ${fmtGap(cfg.debounceMs)}`);
  if (!debounceOk) return stop('刚说过');

  /* ① 情绪不对 —— 看到就说，**不等任何冷却**。
        之前把"搭话最小间隔"排在情绪判断前面，结果刚说完话就算看出低落
        也安慰不了；后来又加了个"安慰过一次锁 N 分钟"，结果老人一直闷着
        它也不吭声了。都不对。现在只剩两条：
           · 这一波还没安慰过  → 马上说（连防抖都不等）
           · 这一波安慰过了、但他还闷着 → 每隔 sadRepeatMs 再说一句

        low 和 uneasy 都算"不对"，但回话方式不一样：
          low   难过     → 安慰，说得出那个滋味
          uneasy 不太对劲 → 关心，别猜原因（他只是生气/烦躁，未必是难过） */
  if (!badMood) {
    gate('情绪读数', false, m
      ? `最近一次：${MOOD_CN[m.level] || m.level}（${m.source}，${fmtGap(now - m.at)}前）${m.note ? ` · ${m.note}` : ''}`
      : '还没有任何情绪读数（摄像头没开、聊天里也没听出情绪）');
  } else {
    const fresh = moodFresh;
    const repeatDue = state.lastMoodSpokenAt > 0 && now - state.lastMoodSpokenAt >= cfg.sadRepeatMs;
    const shouldComfort = firstOfEpisode || repeatDue;
    gate('情绪读数', true, `最近确认过"${levelCN}"（${fmtGap(now - state.negAt)}前）${
      m && !badMood ? '' : ''}${state.negStreak ? `，之后有 ${state.negStreak} 次非消极读数但还不够翻案` : ''}`);
    gate('读数够新', fresh, fresh ? '30 分钟内的读数' : `这条已经 ${fmtGap(now - state.negAt)}了，太旧不作数`);
    gate('该不该关心', shouldComfort, firstOfEpisode
      ? `这一波刚出现"${levelCN}" → 马上说`
      : (repeatDue
        ? `他一直这样，距上次开口 ${fmtGap(now - state.lastMoodSpokenAt)}，够 ${fmtGap(cfg.sadRepeatMs)} 了 → 再说一句`
        : `这一波刚关心过（${fmtGap(now - state.lastMoodSpokenAt)}前），他还这样，再过 ${fmtGap(cfg.sadRepeatMs - (now - state.lastMoodSpokenAt))} 再说`));
    if (fresh && shouldComfort) {
      return { speak: true, reason: 'low_mood', mood: m, level: state.negLevel, trace };
    }
  }

  /* ② 太久没人说话 —— 用 minGapMs（搭话之间别太密） */
  const minGapOk = !state.lastSpokenAt || gap >= cfg.minGapMs;
  gate('搭话间隔', minGapOk, state.lastSpokenAt
    ? `距上次主动开口 ${fmtGap(gap)}，要求 ≥ ${fmtGap(cfg.minGapMs)}`
    : '还没主动开口过');
  if (!minGapOk) return stop('刚搭过话');

  const silent = now - state.lastActivity;
  const idleOk = silent >= cfg.idleMs;
  gate('闲置时长', idleOk, `已经 ${fmtGap(silent)} 没人说话，阈值 ${fmtGap(cfg.idleMs)}${idleOk ? '' : `（还差 ${fmtGap(cfg.idleMs - silent)}）`}`);
  if (idleOk) return { speak: true, reason: 'idle', silentMs: silent, trace };

  /* ② 刚说过的这句，如果还没被**正在看的那个页面**显示出来，再给它一次。
        踩过的坑：老人可能开着好几个标签页（或者后台还挂着一个）。
        主动开口的消息原来是"谁先问归谁" —— 先问到的那个后台标签页把它领走了，
        老人正在看的页面上就永远什么都不出现，可服务端日志里明明写了"主动开口"。
        现在不消费了：60 秒内的这句谁问都给，页面自己按 id 去重。 */
  const pd = state.pending;
  if (pd && now - pd.at < 60 * 1000) {
    gate('补发未显示的开口', true, `${fmtGap(now - pd.at)}前说过一句，还没确认显示，再给一次`);
    // at 是给客户端判断用的：页面刚打开的话，不该把**打开之前**说过的那句
    // 又显示一遍 —— 那会和开场问候一起冒出来，一次看到两条。
    return {
      speak: true, reason: pd.reason, text: pd.text, id: pd.id, at: pd.at,
      replay: true, mood: pd.mood, trace,
    };
  }

  return stop('还不到时候');
}

/**
 * 打开页面时岁语自己起的那句话。
 *
 * 为什么单独一个函数：开场那句**不是**守望触发的主动开口（不记进开口史、
 * 也不进待补发队列），但它确实"刚说过话"。
 *
 * 不记的话会怎样 —— 真实踩到：
 *   页面一打开，开场问候刚冒出来，1.5 秒后守望判定"已经很久没人说话"，
 *   又主动搭了一句，老人一次看到两条。开场白本身就够了。
 *
 * 情绪那一波也一并算"已处理"：开场那句就是"我来了"，
 * 紧接着再安慰一遍是重复的。但**要记 lastMoodSpokenAt** —— 这样他要是一直闷着，
 * 过 sadRepeatMs 还会正经安慰一句，不会彻底哑掉。
 */
export function noteOpening() {
  const now = Date.now();
  state.lastSpokenAt = now;
  state.lastActivity = now;
  if (state.negSince > 0) {
    state.sadEpisode = true;
    state.lastMoodSpokenAt = now;
  }
}

/** 把毫秒说成人话：1小时23分 / 5 分钟 / 45 秒 */
export function fmtGap(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 === 0 ? `${m} 分钟` : `${m} 分 ${s % 60} 秒`;
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? `${h} 小时` : `${h} 小时 ${m % 60} 分`;
}

/** 已经主动开口了 */
export function markSpoken(reason, text = '') {
  const now = Date.now();
  state.lastSpokenAt = now;
  if (reason === 'low_mood') {
    state.lastMoodSpokenAt = now;
    state.sadEpisode = true;     // 这一波安慰过了，等他缓过来再算新的一波
  }
  // 主动说过话也算"有过交流"，闲置计时重新开始，
  // 否则它会每隔 minGap 就再问一遍，变成唠叨。
  state.lastActivity = now;

  // 单独记一份"主动开口史"。
  // 页面上的「陪伴守望」会显示它 —— 不然"到底自己开过口没有"只能靠猜：
  // 分不清是没触发、触发了没显示、还是浏览器把页面冻住了。
  state.spokeLog.push({ at: now, reason, text: String(text || '').slice(0, 60) });
  if (state.spokeLog.length > 50) state.spokeLog.shift();

  /* 记住"刚说的这句"，好让没显示过的页面补上。
     文本是后补的（noteSpokenText），所以这里先占个位，id 立刻就有。 */
  state.pending = {
    id: `p${++state.pendingSeq}`,
    text: String(text || ''),
    reason,
    at: now,
  };
}

/** 生成完了，把说的话补进去（claim 时还不知道要说什么） */
export function noteSpokenText(text) {
  const last = state.spokeLog[state.spokeLog.length - 1];
  if (last) last.text = String(text || '').slice(0, 60);
  if (state.pending) {
    state.pending.text = String(text || '');
    state.pending.at = Date.now();
  }
}

/** 当前待补发那句的 id（生成成功后调，让客户端能按 id 去重） */
export function pendingId() {
  return state.pending?.id || '';
}

/**
 * 某个页面已经把这句显示出来了。
 * 全部页面都确认过就可以把它撤掉，免得一直补发。
 * （其实留着也无害 —— 页面自己会按 id 去重；这里只是别让它无限期挂着。）
 */
export function ackSpoken(id) {
  if (state.pending && state.pending.id === id) {
    state.pending.acked = (state.pending.acked || 0) + 1;
  }
  return { ok: true };
}

/**
 * 抢占一次开口机会 —— 和 markSpoken 做的一样，但**在生成回话之前**调用。
 *
 * 为什么需要：`due()` 通过之后还要调大模型（一两秒）。这期间如果客户端
 * 又轮询进来（或开着两个页面），第二个请求会看到 `sadEpisode` 还是 false，
 * 于是也判定"该安慰"，两边各生成一句 —— 老人连听两遍。
 * 先把状态改了，第二个请求就进不来了。
 *
 * @returns {object} 快照，生成失败时用 watchRelease 还原
 */
export function claimSpoken(reason) {
  const snap = {
    lastSpokenAt: state.lastSpokenAt,
    lastMoodSpokenAt: state.lastMoodSpokenAt,
    sadEpisode: state.sadEpisode,
    lastActivity: state.lastActivity,
    spokeLen: state.spokeLog.length,          // 失败时把多记的那条撤掉
    pending: state.pending,                   // 失败时连同"待补发"一起撤掉
  };
  markSpoken(reason);
  return snap;
}

/** 生成失败 → 把刚才占掉的还回去 */
export function releaseSpoken(snap) {
  if (!snap) return;
  state.lastSpokenAt = snap.lastSpokenAt;
  state.lastMoodSpokenAt = snap.lastMoodSpokenAt;
  state.sadEpisode = snap.sadEpisode;
  state.lastActivity = snap.lastActivity;
  // 占位时往开口史里塞了一条，还回去的时候得把它撤掉
  if (snap.spokeLen != null && state.spokeLog.length > snap.spokeLen) state.spokeLog.pop();
  state.pending = snap.pending;
}

/** 生成完了，把说的话补进刚才那条记录（claim 的时候还不知道要说什么） */

/** 给接口 / 页面上那栏「陪伴守望」看的状态 */
export function snapshot() {
  const cfg = state.config;
  const now = Date.now();
  return {
    config: cfg,
    enabled: cfg.enabled,
    cameraOn: cfg.cameraEnabled,
    lastActivity: new Date(state.lastActivity).toISOString(),
    silentMinutes: Math.round((now - state.lastActivity) / 60000),
    nextIdleInMinutes: Math.max(0, Math.round((cfg.idleMs - (now - state.lastActivity)) / 60000)),
    lastMood: state.lastMood,
    sadEpisode: state.sadEpisode,     // 这一波低落安慰过了没
    minuteSinceComfort: state.lastMoodSpokenAt ? Math.round((now - state.lastMoodSpokenAt) / 60000) : null,
    camera: state.camera,
    // 客户端每次拍完会读这个值来决定下次隔多久 —— 情绪不对时自动变快
    cameraNextMs: cameraEveryMs(),
    due: due(),
    log: state.log.slice(-40),
    neg: { since: state.negSince, at: state.negAt, level: state.negLevel, streak: state.negStreak, clearStreak: NEG_CLEAR_STREAK },
    spokeLog: state.spokeLog.slice(-20),
    polls: state.polls,
    lastPollAgoSec: state.lastPollAt ? Math.round((now - state.lastPollAt) / 1000) : null,
    spokeCount: state.spokeLog.length,
  };
}

/** 清掉情绪记录（页面上有按钮） */
export function clearLog() {
  state.log = [];
  state.lastMood = null;
  state.camera.lastResult = null;
  state.lastMoodSpokenAt = 0;
  state.sadEpisode = false;
}
