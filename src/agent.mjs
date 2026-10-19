/**
 * 岁语 · 智能体工作流
 * ==========================================================================
 * 把 prompts.mjs 的提示词串成两次调用：
 *
 *   [节点 1] 主对话   人格 + 全部记忆 + 多轮历史  → 回复老人
 *   [节点 2] 主动开口                           → 一句开场白
 *
 * 原来 engine.mjs 里那套"阈值分流 + YES/NO 正则 + compose 拼句子"
 * 不再参与生成回复。它现在只负责**结构化归档**（给家人端用），
 * 以及模型调不通时的兜底。
 *
 * 这里不做任何"他说了对就怎样"的判断 —— 那是模型的事。
 * ========================================================================== */
import { speak, llmConfig } from './llm.mjs';
import { buildMessages, buildOpeningMessages, buildCheckInMessages, buildTimeMessages } from './prompts.mjs';

/**
 * 从模型输出里把一个 JSON 数组抠出来。
 *
 * 为什么不能直接 JSON.parse：模型经常输出 **JS 对象字面量**而不是 JSON ——
 * 键和字符串都不带引号：
 *
 *   [{i:1,year:1968,label:1968 年前后},{i:2,year:null,label:}]
 *
 * 提示词里明明写了"严格 JSON"，它还是这么回。所以先修一遍再 parse。
 */
function repairJsonArray(text) {
  let t = String(text || '');
  // 只取 [] 里面那一段（前后常裹着 ```json 或"好的，结果如下："）
  const a = t.indexOf('[');
  const b = t.lastIndexOf(']');
  if (a < 0 || b <= a) return null;
  t = t.slice(a, b + 1);

  // 1) 给键加引号：{ i: → {"i":
  t = t.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":');

  // 2) 给没加引号的字符串值加引号。
  //    数字 / true / false / null / 已经带引号的 / 嵌套对象数组 都不动。
  t = t.replace(/(:\s*)([^\s"'{[\],}][^,}\]]*)/g, (m, pre, raw) => {
    const v = String(raw).trim();
    if (/^-?\d+(\.\d+)?$/.test(v)) return pre + v;
    if (/^(true|false|null)$/i.test(v)) return pre + v.toLowerCase();
    if (!v) return `${pre}""`;
    return pre + JSON.stringify(v);
  });

  // 3) 空值补齐：label:} → label:""}
  t = t.replace(/:\s*([,}\]])/g, ':""$1');

  // 4) 收掉尾逗号：[{...},] → [{...}]
  t = t.replace(/,\s*([\]}])/g, '$1');

  try {
    const v = JSON.parse(t);
    return Array.isArray(v) ? v : null;
  } catch { return null; }
}

/** 先按标准 JSON 试，不行再走修复逻辑 */
function parseJsonArray(text) {
  const s = String(text || '');
  const a = s.indexOf('[');
  const b = s.lastIndexOf(']');
  if (a < 0 || b <= a) return null;
  try {
    const v = JSON.parse(s.slice(a, b + 1));
    if (Array.isArray(v)) return v;
  } catch { /* 落到下面的修复逻辑 */ }
  return repairJsonArray(s);
}

/* ----------------------------------------------------------------------
   节点 1：主对话
   ---------------------------------------------------------------------- */
export async function reply({ persona, confirmed = [], story = '', history = [], text = '', companion = false, healthHint = '' }) {
  if (!llmConfig().available) return { error: '还没配大模型' };

  const messages = buildMessages({ persona, confirmed, story, history, text, companion, healthHint });
  return speak(messages, {
    temperature: 1.15,
    maxTokens: Math.max(200, Number(persona?.max_chars || 45) * 6),
  });
}

/* ----------------------------------------------------------------------
   节点 2：主动开口
   ---------------------------------------------------------------------- */
export async function opening({ persona, confirmed = [], recent = [] }) {
  if (!llmConfig().available) return { error: '还没配大模型' };

  const messages = buildOpeningMessages({ persona, confirmed, recent });
  const out = await speak(messages, { temperature: 1.3, maxTokens: 90 });
  if (out?.error) return out;
  return { ...out, text: String(out.text || '').replace(/^["「『]|["」』]$/g, '').trim() };
}

/* ----------------------------------------------------------------------
   节点 3：主动关心（守望触发）
   ---------------------------------------------------------------------- */
export async function checkIn({ persona, reason = 'idle', moodLevel = '', recent = [], history = [] }) {
  if (!llmConfig().available) return { error: '还没配大模型' };

  const messages = buildCheckInMessages({ persona, reason, moodLevel, recent, history });
  // 安慰要说得走心：温度给高些（别每次都一个说法），字数也放宽一点
  const out = await speak(messages, {
    temperature: reason === 'low_mood' ? 1.2 : 1.25,
    maxTokens: reason === 'low_mood' ? 140 : 110,
  });
  if (out?.error) return out;
  const text = String(out.text || '').replace(/^["「『]|["」』]$/g, '').trim();

  // 提示词里说了不许提问，但模型偶尔会不听话 —— 这里再兜一层：
  // 出现了问号就砍掉问句，只留前面那句。
  if (/[？?]/.test(text) && reason === 'low_mood') {
    const first = text.split(/[。！!]/)[0];
    if (first && !/[？?]/.test(first)) return { ...out, text: `${first}。`, questionStripped: true };
  }
  return { ...out, text };
}

/* ----------------------------------------------------------------------
   节点 4：判断"这件事发生在哪一年"
   ----------------------------------------------------------------------
   规则表认不出"那年""那会儿""过了两年"这种相对说法，整件事就掉进
   时间轴的"时间未定"。这里让模型结合上下文判，把年份补上。

   拿不准就返回 null —— 宁可留在"时间未定"，也别编个错年份。
   ---------------------------------------------------------------------- */
export async function guessTimes({ persona, items = [], history = [], birthYear = null, thisYear = null }) {
  if (!llmConfig().available) return { error: '还没配大模型', items: [] };
  if (!items.length) return { items: [] };

  const messages = buildTimeMessages({ persona, items, history, birthYear, thisYear });
  // 这是个抽取任务，不是创作 —— 温度压低，别让它发挥
  const out = await speak(messages, { temperature: 0.2, maxTokens: 400 });
  if (out?.error) return out;

  const arr = parseJsonArray(out.text);
  if (!arr) return { error: '模型没给出合法 JSON', raw: String(out.text || '').slice(0, 200), items: [] };

  const byIndex = new Map();
  for (const o of arr) {
    const i = Number(o?.i);
    if (!Number.isFinite(i) || i < 1 || i > items.length) continue;
    const year = Number(o?.year);
    const ok = Number.isFinite(year) && year >= 1900 && year <= (thisYear || new Date().getFullYear());
    byIndex.set(i, {
      id: items[i - 1].id,
      year: ok ? Math.round(year) : null,
      label: String(o?.label || '').slice(0, 20).trim(),
    });
  }
  return { items: items.map((it, k) => byIndex.get(k + 1) || { id: it.id, year: null, label: '' }), ms: out.ms };
}