/**
 * 语义理解 —— 交给大模型判
 * ==========================================================================
 * 以前这些全是正则硬判：
 *
 *   classify()      意图：tell / ask / mood / ack / recall
 *   mood()          情绪：几个负面词 + 叹气次数
 *   healthSigns()   健康：一堆身体部位词
 *   isRequest()     是不是让岁语干活："帮我倒杯水"
 *   isNonContent()  是不是废话："嗯""挺好的"
 *   FRAGMENT/       是不是在补充细节、补的是哪一格
 *   detectSlot()      （when / where / who / what / how）
 *   AVOID           是不是不想聊了
 *   substantial     "这句话够不够格当记忆"
 *
 * 正则能覆盖常见说法，但说法太活了：
 *   "我这两天腰不得劲"        —— 没命中"腰疼"
 *   "你帮我把窗户关上吧"      —— 不是"帮我"开头
 *   "那会儿啊，还没到八八年"  —— 不是补细节，是改口
 *
 * 所以全部交给模型判，一次调用出全部结论。正则留着当**兜底**：
 * 没配模型 / 调不通的时候（包括离线自检）还是走原来那套。
 * ========================================================================== */
import { speak, llmConfig } from './llm.mjs';
import { parseJsonArray } from './json.mjs';

/** 从模型输出里取一个干净的字符串数组 */
function strList(v, max = 8) {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x == null ? '' : x).trim()).filter(Boolean).slice(0, max);
}

export const INTENTS = ['tell', 'ask', 'mood', 'ack', 'recall', 'command'];
export const SLOTS = ['when', 'where', 'who', 'what', 'how'];
export const MOOD_LEVELS = ['low', 'uneasy', 'flat', 'warm'];

/** 从模型输出里抠 JSON 对象（它常输出不带引号的 {intent:tell}） */
function parseJsonObject(text) {
  const s = String(text || '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  const slice = s.slice(a, b + 1);
  try {
    const v = JSON.parse(slice);
    if (v && typeof v === 'object') return v;
  } catch { /* 走修复 */ }
  const t = slice
    .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
    .replace(/(:\s*)([^\s"'{[\],}][^,}\]]*)/g, (m, pre, raw) => {
      const v = String(raw).trim();
      if (/^-?\d+(\.\d+)?$/.test(v)) return pre + v;
      if (/^(true|false|null|\[\])$/i.test(v)) return pre + v.toLowerCase();
      if (!v) return `${pre}""`;
      return pre + JSON.stringify(v);
    })
    .replace(/:\s*([,}\]])/g, ':""$1')
    /* **数组里没加引号的裸元素**：places:[杭州] → places:["杭州"]
       上面那条只管冒号后面的值，数组元素前面没有冒号，所以管不着。
       漏了这条的后果：`places:[杭州]` 解不开 → 整个对象 parse 失败 →
       understand 返回 null → 连改口识别都跟着失效。 */
    .replace(/\[([^\[\]{}"]*)\]/g, (m, inner) => {
      const parts = String(inner).split(',').map((x) => x.trim()).filter(Boolean);
      if (!parts.length) return '[]';
      return '[' + parts.map((v) => {
        if (/^-?\d+(\.\d+)?$/.test(v)) return v;
        if (/^(true|false|null)$/i.test(v)) return v.toLowerCase();
        return JSON.stringify(v);
      }).join(',') + ']';
    })
    .replace(/,\s*([\]}])/g, '$1');
  try {
    const v = JSON.parse(t);
    return v && typeof v === 'object' ? v : null;
  } catch { return null; }
}

export function buildUnderstandMessages({ persona = {}, text = '', history = [] }) {
  const call = persona.elder_call || '爷爷';
  const hist = history.length
    ? history.map((h) => `${h.role === 'elder' ? call : '你'}：${h.text}`).join('\n')
    : '（没有更早的对话）';

  const system = `你在帮一个陪聊助手理解${call}刚说的话。逐项判断，只输出一个 JSON 对象。

【刚才的对话】
${hist}

【他刚说】
"${String(text).slice(0, 120)}"

【逐项判断】

1. intent —— 他这句话在干什么？只能选一个：
   · "tell"     在讲自己这辈子的事（最常��）
   · "ask"      在问事情（问岁语、问过去的事、确认）
   · "mood"     只在说心情/身体，"唉，没意思""腰疼得厉害"
   · "command"  让岁语去干点什么，"帮我倒杯水""把窗户开开"
   · "ack"      只是应声，"嗯""哦""知道了""挺好的"
   · "recall"   "你还记得我老家在哪儿吗"这种考记忆的

2. memorable —— 这句话值不值得存进他的档案？true / false
   · true  ：讲了一件他这辈子的事（人、地方、年、事、习惯、身体情况）
   · false ：纯应声、纯客套、纯提问、只是让干活、没有实际信息
   · 拿不准就 true —— 宁可多记一条，也比把老人讲的事漏掉强

3. request —— 是不是**让岁语去干活**（真去倒水、真去关窗）？
   是请求就不是记忆 —— 是他这会儿的需求，不是他这辈子的事。

4. correction —— 是不是在**纠正之前记错的地方**？
   · 不是 → null
   · 是  → 三种之一：
     · {"kind":"year","from":1988,"to":1987}   from 是**错的**年份（没说就 null）
     · {"kind":"word","from":"纺织厂","to":"印染厂"}  from 要和原文用词一致
     · {"kind":"delete","from":"挡车工"}        让他删掉相关的

5. fragment / slot —— 他这句是不是在**补充上一条的细节**（而不是讲新事）？
   · 是 → fragment=true，slot 说明补的是哪一格：
     "when" 哪一年 / "where" 在哪儿 / "who" 是谁 / "what" 什么事 / "how" 怎么样
   · 不是 → fragment=false，slot=""（空字符串）

6. mood —— 情绪，只能选一个：
   · "low"     明显低落、难过、想念、孤独
   · "uneasy"  烦躁、担心、害怕、抱怨（不是难过）
   · "flat"    平平常说
   · "warm"    高兴、得意、暖和

7. health —— 提到了哪些身体不舒服？数组，没有就 []。
   用原文的说法，比如 ["腰疼"]、["睡不着"]、["腿没劲"]。

8. statement —— 把这句话整理成一句**干净的陈述句**：
   · 去掉口癖、重复、语气词
   · 保留他原本的说法和用词，别美化成书面语
   · 别加信息，别改事实
   · 最多 40 字

9. scope —— 这句在**人生时间轴**上怎么放？只能选一个：
   · "major"   本身就是一件人生大事，单独成一条：在哪上学、干什么工作、
               结婚、生孩子、搬家、盖房分房、当兵下乡、大病手术、
               亲人过世、退休、去过哪儿
   · "detail"  是某件大事的**细节**，不单独成条，但要并进那件事：
               "三点就要起来""车间噪音大，说话得喊""买的人挺多"
               "八个人挤一间宿舍" —— 这些都是他人生经历的组成部分
   · "none"    眼前的小事、一时的心情、随口一句，时间轴上不要：
               "今天腰疼""这两天睡不好""今天想起点事""天气不错"

   **"detail" 不是丢掉**，是挂到那件事下面当铺垫。别把细节判成 none。

10. entities —— 把这句话里的**人物 / 地点 / 事件 / 时间**抽出来。
   这四样以前是正则+词表抽的，抽出来的常是碎片：
     原话"我小时候在杭州长大，那时候穷，吃不饱"
       → 人物抽成"时候穷"、地点抽成"杭州长大"、年份抽成 1853
   你抽时要是**真正的实体**，不是从原文切下来的字：
   · persons —— 人名或称呼（"张师傅""老伴秀兰""我孙子小明"）。不许出现"时候""穷"这种
   · places  —— 地名或场所（"杭州""国棉三厂""细纱车间""剪子巷"）
   · events  —— 做过的事（"当挡车工""结婚""分房""开餐馆"）
   · times   —— 时间说法，每条三样：
       {"raw":"原话里的说法","label":"能看懂的说法","year":四位年份或 null}
       "我年轻时" → {"raw":"年轻时","label":"青年时期","year":null}
       "六八年"   → {"raw":"六八年","label":"1968 年","year":1968}
       推不出年份就填 null，**别编**。
   · 没有就给空数组 []

11. polished —— 同一件事的**润色版**，给家人读的：
   · 像写小传那样通顺、干净，可以调整语序、合并啰嗦的地方
   · **但不能加信息**：他没说的人、地方、数字、原因，一个都不能添
   · 不要"我记得""那时候"这种口头过渡词
   · 一到两句，最多 50 字
   · 例：原话"我那时候车间里噪音大得很，说话都得喊着说"
        → "车间噪音很大，说话得靠喊"
   · 例：原话"3点就要起来了"
        → "凌晨三点就得起来备料"

12. clauses —— 先把原话切成自然子句，再给**每个子句**单独抽实体。
   · text：保留老人原话的用词，不改写、不合并、不美化，最多 6 句
   · persons / places / events / times：规则同上，但只属于这个子句
   · 没有实体就给空数组 []
   · 例："我小时候在杭州长大，那时候穷，吃不饱"
     → [{"text":"我小时候在杭州长大","persons":[],"places":["杭州"],"events":[],"times":[{"raw":"小时候","label":"童年","year":null}]},
        {"text":"那时候穷，吃不饱","persons":[],"places":[],"events":[],"times":[{"raw":"那时候","label":"那时候","year":null}]}]

【输出格式】
严格只输出一个**合法 JSON**，键和字符串都要加双引号。不要解释、不要代码块。

{"intent":"tell","memorable":true,"request":false,"correction":null,"fragment":false,"slot":"","mood":"flat","health":[],"entities":{"persons":[],"places":["国棉三厂"],"events":["当挡车工"],"times":[{"raw":"年轻时候","label":"青年时期","year":null}]},"clauses":[{"text":"我年轻时候在国棉三厂当挡车工","persons":[],"places":["国棉三厂"],"events":["当挡车工"],"times":[{"raw":"年轻时候","label":"青年时期","year":null}]}],"statement":"我年轻时候在国棉三厂当挡车工","scope":"major","polished":"年轻时在国棉三厂当挡车工"}`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: '只输出 JSON。' },
  ];
}

/**
 * 让模型理解一句话。
 * @returns {Promise<null | {
 *   intent:string, memorable:boolean, request:boolean,
 *   correction:null|{kind:string,from:any,to?:any},
 *   fragment:boolean, slot:string, mood:string, health:string[], statement:string
 * }>}
 * 返回 null 表示模型不可用或没给出能用的结果 —— 调用方应该退回本地规则。
 */
export async function understand({ persona, text = '', history = [] }) {
  if (!llmConfig().available) return null;
  const raw = String(text || '').trim();
  if (!raw) return null;

  const out = await speak(buildUnderstandMessages({ persona, text: raw, history }), {
    temperature: 0.1,        // 判断任务，别发挥
    maxTokens: 600,
  });
  if (out?.error) return null;

  const o = parseJsonObject(out.text);
  if (!o) return null;

  const intent = INTENTS.includes(String(o.intent)) ? String(o.intent) : 'tell';
  const slot = SLOTS.includes(String(o.slot)) ? String(o.slot) : '';
  const mood = MOOD_LEVELS.includes(String(o.mood)) ? String(o.mood) : 'flat';
  const health = Array.isArray(o.health) ? o.health.map((x) => String(x).trim()).filter(Boolean).slice(0, 4) : [];

  /* correction 要仔细校验 —— 判错了会改坏老人的档案 */
  let correction = null;
  const c = o.correction;
  if (c && typeof c === 'object' && c.kind) {
    if (c.kind === 'year') {
      const to = Number(c.to);
      const from = c.from === null || c.from === undefined ? null : Number(c.from);
      if (Number.isFinite(to) && to >= 1900 && to <= new Date().getFullYear()) {
        correction = { kind: 'year', from: Number.isFinite(from) ? from : null, to };
      }
    } else if (c.kind === 'word') {
      const from = String(c.from || '').trim();
      const to = String(c.to || '').trim();
      if (from && to && from !== to) correction = { kind: 'word', from, to };
    } else if (c.kind === 'delete') {
      const from = String(c.from || '').trim();
      if (from) correction = { kind: 'delete', from };
    }
  }

  const normTimes = (src) => (Array.isArray(src) ? src : [])
    .filter((x) => x && (x.label || x.raw))
    .slice(0, 4)
    .map((x) => {
      const y = Number(x.year);
      const ok = Number.isFinite(y) && y >= 1900 && y <= new Date().getFullYear();
      return {
        raw: String(x.raw || x.label).trim().slice(0, 20),
        label: String(x.label || x.raw).trim().slice(0, 20),
        year: ok ? Math.round(y) : null,
        kind: ok ? 'abs' : 'era',
      };
    });

  const clauses = Array.isArray(o.clauses)
    ? o.clauses.map((x) => {
      if (typeof x === 'string') return { text: x.trim().slice(0, 100), persons: [], places: [], events: [], times: [] };
      if (!x || typeof x !== 'object') return null;
      return {
        text: String(x.text || '').trim().slice(0, 100),
        persons: strList(x.persons),
        places: strList(x.places),
        events: strList(x.events),
        times: normTimes(x.times),
      };
    }).filter((x) => x && x.text).slice(0, 6)
    : [];

  return {
    intent,
    // 改口本身不是记忆 —— 哪怕它讲得像个陈述句
    memorable: correction ? false : o.memorable !== false,
    request: o.request === true,
    correction,
    fragment: o.fragment === true,
    slot: o.fragment === true ? slot : '',
    mood,
    health,
    /* 实体：模型抽的比正则准得多（正则会把"时候穷"当人物、年份抽成 1853）。
       抽不出来就给空数组，engine 那边会退回 analyze() 的正则结果。 */
    entities: {
      persons: strList(o.entities && o.entities.persons),
      places: strList(o.entities && o.entities.places),
      events: strList(o.entities && o.entities.events),
      times: normTimes(o.entities && o.entities.times),
    },
    /* 切句也由模型做：每个子句带自己的实体，避免把整句实体硬塞给每一句 */
    clauses,
    statement: String(o.statement || '').trim().slice(0, 60),
    scope: ['major', 'detail', 'none'].includes(String(o.scope)) ? String(o.scope) : 'major',
    polished: String(o.polished || '').trim().slice(0, 80),
  };
}

/* ======================================================================
   批量润色：给以前存的记忆补上 polished
   ----------------------------------------------------------------------
   新的记忆在入库时就有润色版了。老的那批没有，时间轴会先退回原句 ——
   看着还是"我那时候车间里噪音大得很，说话都得喊着说"这种聊天体。
   这个把缺的补上。
   ====================================================================== */
export async function polishMany({ persona = {}, rows = [] } = {}) {
  if (!llmConfig().available || !rows.length) return [];
  const list = rows.map((r, i) => `${i + 1}. ${r.statement}`).join('\n');
  const system = `你帮一位老人的回忆录做文字润色。

【要求】
· 每条改成通顺、干净的书面表达，像小传，不要聊天体
· 去掉"我那时候""那会儿""你知道吗"这种口头过渡词
· **绝对不能加信息** —— 他没说的人、地方、年份、数字、原因，一个都不能添
· 每条不超过 50 字，一到两句
· 一个人称：第一人称"我"

【要润色的句子】
${list}

【输出】
严格只输出一个**合法 JSON** 数组，键和字符串都要加双引号：
[{"i":1,"text":"车间噪音很大，说话得靠喊"}]`;

  const out = await speak([
    { role: 'system', content: system },
    { role: 'user', content: '只输出 JSON 数组。' },
  ], { temperature: 0.3, maxTokens: 900 });
  if (out?.error) return [];

  const arr = parseJsonArray(out.text);
  if (!arr) return [];

  const out2 = [];
  for (const o of arr) {
    const i = Number(o && o.i);
    if (!Number.isFinite(i) || i < 1 || i > rows.length) continue;
    const text = String((o && o.text) || '').trim().slice(0, 80);
    if (text) out2.push({ id: rows[i - 1].id, text });
  }
  return out2;
}
/* ======================================================================
   把一个时间段里的几条记忆 → 合成一句话
   ----------------------------------------------------------------------
   老人是一句一句说的，同一件事常散成好几条：
       "我在那边开餐馆" / "三点就要起来" / "是的，买的人很多"
   时间轴上逐条列出来像流水账。合成一句才像回事：
       "我在杭州开餐馆，每天三点就得起来备料，生意挺好"

   **不许加信息** —— 他没说的人、地方、年份、数字都不能添。
   ====================================================================== */
export async function narrateGroups({ persona = {}, groups = [] } = {}) {
  if (!llmConfig().available || !groups.length) return [];
  const call = persona.elder_call || '爷爷';

  const blocks = groups.map((g, i) => {
    const lines = g.items.map((it) => '· ' + it.statement).join('\n');
    return '第 ' + (i + 1) + ' 段（' + g.label + '）\n' + lines;
  }).join('\n\n');

  const system = `你帮${call}整理回忆录。下面每一段里，是他讲的**互相关联的几件事**
（可能是同一段时间，也可能是同一个地方）。请把每段合成**一到两句通顺的话**，像小传，不要流水账。

【规矩】
· 第一人称"我"
· **绝对不能加信息**：他没说的人、地方、年份、数字、原因，一个都不能添
· 可以调语序、合并重复、把碎片连成因果或先后关系
· 每段不超过 60 字
· 只有一件事实在没法再合并，就照原样润色一下

【要合成的段】
${blocks}

【输出】
严格只输出一个**合法 JSON** 数组，键和字符串都要加双引号：
[{"i":1,"text":"我在杭州开餐馆，每天三点就得起来备料。"}]`;

  const out = await speak([
    { role: 'system', content: system },
    { role: 'user', content: '只输出 JSON 数组。' },
  ], { temperature: 0.35, maxTokens: 1200 });
  if (out?.error) return [];

  const arr = parseJsonArray(out.text);
  if (!arr) return [];

  const res = [];
  for (const o of arr) {
    const i = Number(o && o.i);
    if (!Number.isFinite(i) || i < 1 || i > groups.length) continue;
    const text = String((o && o.text) || '').trim().slice(0, 120);
    if (text) res.push({ key: groups[i - 1].key, text });
  }
  return res;
}
/* ======================================================================
   批量判断：这些记忆值不值得上"人生时间轴"
   ----------------------------------------------------------------------
   时间轴是他的**人生大事索引**，不是流水账。
   今天腰疼、今天想起点事 —— 留在记忆库里，但不进时间轴。
   ====================================================================== */
export async function curateEvents({ persona = {}, rows = [] } = {}) {
  if (!llmConfig().available || !rows.length) return [];
  const list = rows.map((r, i) => `${i + 1}. ${r.polished || r.statement}`).join('\n');

  const system = `你在帮一位老人整理"人生时间轴"。时间轴只放**这辈子的重要经历**，不是流水账。

【要判断的句子】
${list}

【怎么判】
· "major"  —— 本身就是人生大事，单独成一条：在哪上学、干什么工作、结婚、
                生孩子、搬家、盖房分房、当兵下乡、大病手术、亲人过世、
                退休、去过哪儿、家里什么情况
· "detail" —— 是某件大事的**细节**，不单独成条但要并进那件事：
                "三点就要起来""车间噪音大说话得喊""八个人挤一间宿舍"
                "买的人挺多" —— 细节**不是丢掉**，是挂到那件事下面当铺垫
· "none"   —— 眼前小事、一时心情、随口一句："今天腰疼""这两天睡不好"
                "今天想起点事""天气不错""嗯挺好的"

【输出】
严格只输出一个**合法 JSON** 数组，键和字符串都要加双引号：
[{"i":1,"scope":"major"},{"i":2,"scope":"none"}]`;

  const out = await speak([
    { role: 'system', content: system },
    { role: 'user', content: '只输出 JSON 数组。' },
  ], { temperature: 0.1, maxTokens: 600 });
  if (out?.error) return [];

  const arr = parseJsonArray(out.text);
  if (!arr) return [];

  const res = [];
  for (const o of arr) {
    const i = Number(o && o.i);
    if (!Number.isFinite(i) || i < 1 || i > rows.length) continue;
    const sc = ['major', 'detail', 'none'].includes(String(o.scope)) ? String(o.scope) : 'major';
    res.push({ id: rows[i - 1].id, scope: sc });
  }
  return res;
}

/* ======================================================================
   地名归属：这个地名是哪儿的
   ----------------------------------------------------------------------
   原来靠坐标表 + 城市名表做**字面匹配**（geo.mjs 的 lookup/cityIn）。
   老人说的地名不一定是地名：
       "国棉三厂""细纱车间""八个人挤一间宿舍"  —— 是地方，但不是地名
       "城西""剪子巷"                          —— 是地名，但表里没有
   字面匹配两个都处理不了。交给模型判：先判**是不是地名**，
   是的话**归到哪个城市**（要能落到地图上的那种）。
   ====================================================================== */
export async function judgePlaces({ persona = {}, names = [] } = {}) {
  if (!llmConfig().available || !names.length) return [];
  const call = persona.elder_call || '爷爷';
  const home = persona.hometown || '';

  const list = names.map((n, i) => (i + 1) + '. ' + n).join('\n');
  const system = `你帮${call}把他说过的地方整理成能在地图上标出来的地名。

【他老家】${home || '（不知道）'}

【要判断的地方】
${list}

【怎么判】
每个地方给三样：
· geo    —— 是不是**真正的地理地名**（能落到地图上的）？
            是：北京、杭州、山东临沂、城西、剪子巷、国棉三厂（能落到城市）
            否：车间、宿舍、屋里、门口、厂里（太大或太小，落了也没意义）
· city   —— 归到哪个**地级市以上**的城市。例：剪子巷 → 北京；国棉三厂 → 北京
            判不出来就空字符串。**别瞎猜**，没线索就空着
· why    —— 十个字以内，说明依据

【输出】
严格只输出一个**合法 JSON** 数组，键和字符串都要加双引号：
[{"i":1,"geo":true,"city":"北京","why":"老家的巷子"}]`;

  const out = await speak([
    { role: 'system', content: system },
    { role: 'user', content: '只输出 JSON 数组。' },
  ], { temperature: 0.1, maxTokens: 900 });
  if (out?.error) return [];

  const arr = parseJsonArray(out.text);
  if (!arr) return [];

  const res = [];
  for (const o of arr) {
    const i = Number(o && o.i);
    if (!Number.isFinite(i) || i < 1 || i > names.length) continue;
    res.push({
      name: names[i - 1],
      geo: o.geo !== false,
      city: String((o && o.city) || '').trim().slice(0, 20),
      why: String((o && o.why) || '').trim().slice(0, 20),
    });
  }
  return res;
}

/**
 * 老人是不是在确认"把刚才那句回给孩子"。
 * 这一步专门交给模型判断，避免"就这样子回"被当成普通闲聊、只嘴上说回了却没真发。
 * 返回 { send, text }；模型不可用/输出不合法时返回 null，由调用方用正则兜底。
 */
export async function judgeFamilyReply({ persona = {}, text = '', history = [], draft = '' } = {}) {
  if (!llmConfig().available || !draft) return null;
  const call = persona.elder_call || '爷爷';
  const system = `你是岁语的意图判断器，只做判断，不聊天。

背景：孩子给${call}发了消息，岁语刚才拟了一句要回给孩子的草稿：
「${draft}」

现在${call}又说了一句话。请判断他是不是在**同意/确认把上面这句草稿发给孩子**。
- 是（例如"就这样子回""行，发给他吧""可以，就这么说"）→ {"send":true,"text":"最终要发的那句话"}
- 不是（例如他在说别的事、否定、改口）→ {"send":false,"text":""}
- 如果他在确认但顺手改了措辞，text 用他改后的说法。
只输出一个合法 JSON 对象，不要解释。`;
  try {
    const out = await speak([
      { role: 'system', content: system },
      { role: 'user', content: `${call}刚说：「${text}」\n只输出 JSON。` },
    ], { temperature: 0, maxTokens: 160 });
    if (out?.error || !out?.text) return null;
    const m = String(out.text).match(/\{[\s\S]*\}/);
    if (!m) return null;
    // 模型经常把键/字符串写成 JS 字面量（{send:true,text:...}），用项目里同一套宽松修复
    const arr = parseJsonArray('[' + m[0] + ']');
    const j = arr && arr[0];
    if (!j) return null;
    const send = j.send === true || String(j.send).toLowerCase() === 'true';
    const say = String(j.text || draft).trim().slice(0, 300);
    return { send, text: say || draft };
  } catch {
    return null;
  }
}

/**
 * 老人直接下指令："那给他回一个你好" / "回他一句我挺好"。
 * 让模型判断这是不是"现在真的要给孩子发一条消息"，并提取内容。
 * 返回 { send, text }；不可用时返回 null，由调用方兜底。
 */
export async function judgeFamilyDirectSend({ persona = {}, text = '', family = [] } = {}) {
  if (!llmConfig().available) return null;
  const call = persona.elder_call || '爷爷';
  const recent = (Array.isArray(family) ? family : []).slice(-3).map((m) => {
    if (m.kind === 'like') return '孩子给当天的聊天点了个赞';
    if (m.kind === 'summary_reply') return `孩子回复当天总结：${m.text}`;
    return `孩子：${m.text}`;
  }).join('\n') || '（暂无）';
  const system = `你是岁语的意图判断器，只做判断，不聊天。

背景：${call}在和岁语说话，最近孩子发来的消息：
${recent}

请判断${call}这句话是不是在**直接让你现在给孩子发一条消息**。
- 是（例如"那给他回一个你好""回他一句我挺好""给小陈发个你好"）→ {"send":true,"text":"要发给孩子的原话","to":"收信人的名字或小名"}
- 不是（只是聊天、回忆、问孩子有没有发消息、说以前回过什么）→ {"send":false,"text":"","to":""}
提取 text 时只留真正要发的内容，不要带"就说""给他回"这些指令词。
提取 to 时：老人明确叫了名字/小名（如"小陈""老二""大宝"）就写名字；只说"他/她/孩子/儿子/女儿"就写空字符串。
只输出一个合法 JSON 对象，不要解释。`;
  try {
    const out = await speak([
      { role: 'system', content: system },
      { role: 'user', content: `${call}说：「${text}」\n只输出 JSON。` },
    ], { temperature: 0, maxTokens: 180 });
    if (out?.error || !out?.text) return null;
    const m = String(out.text).match(/\{[\s\S]*\}/);
    if (!m) return null;
    const arr = parseJsonArray('[' + m[0] + ']');
    const j = arr && arr[0];
    if (!j) return null;
    const send = j.send === true || String(j.send).toLowerCase() === 'true';
    const say = String(j.text || '').trim().slice(0, 300);
    let to = String(j.to || '').trim().slice(0, 20);
    if (/^(他|她|孩子|儿子|女儿|家人|娃)$/.test(to)) to = '';
    return { send: send && !!say, text: say, to };
  } catch {
    return null;
  }
}

/**
 * 人物实体归并：模型判断名单里哪些叫法其实是同一个人。
 * 例：["小陈","儿子"] + 记忆"小陈就是我儿子" → [["小陈","儿子"]]
 * 返回数组的数组；模型不可用/不确定时返回空数组（不强行合并）。
 */
export async function judgePeopleAliases({ people = [], sentences = [] } = {}) {
  if (!llmConfig().available) return [];
  const names = (Array.isArray(people) ? people : []).map((x) => String(x)).filter(Boolean).slice(0, 60);
  if (names.length < 2) return [];
  const mem = (Array.isArray(sentences) ? sentences : []).map((x) => `- ${x}`).slice(0, 60).join('\n');
  const system = `你只做人物实体判断，不聊天。

人物名单：
${names.map((n, i) => `${i + 1}. ${n}`).join('\n')}

记忆摘录：
${mem || '（无）'}

判断名单里哪些叫法其实是**同一个人**。特别注意：
- "小陈就是我儿子" → "小陈"和"儿子"是同一个人
- "老张是我师傅" → "老张"和"师傅"是同一个人
- 只是泛称，没有明确"是谁"的证据时，不要合并
- 一个人可以是多个称呼，但不要因为都姓陈就合并

只输出一个合法 JSON 数组，每项是一组同义叫法：
[["小陈","儿子"]]
没有可合并的就输出 []。不要输出别的字。`;
  try {
    const out = await speak([
      { role: 'system', content: system },
      { role: 'user', content: '只输出 JSON 数组。' },
    ], { temperature: 0, maxTokens: 300 });
    if (out?.error || !out?.text) return [];
    let arr = parseJsonArray(out.text);
    if (!arr) {
      // 模型常输出 [[小陈,儿子]]，字符串没引号 —— 直接把内层括号拆开
      arr = [];
      for (const m of String(out.text).matchAll(/\[([^[\]]+)\]/g)) {
        const group = m[1].split(/[,，、]/).map((x) => x.replace(/["'“”\s]/g, '').trim()).filter(Boolean);
        if (group.length > 1) arr.push(group);
      }
    }
    const allowed = new Set(names);
    return arr
      .map((g) => (Array.isArray(g) ? g : []).map((x) => String(x)).filter((x) => allowed.has(x)))
      .filter((g) => g.length > 1);
  } catch {
    return [];
  }
}
