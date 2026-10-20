/**
 * 模型返回的 JSON 数组解析（宽松版）
 * ==========================================================================
 * 模型经常输出 **JS 对象字面量**而不是 JSON —— 键和字符串都不带引号：
 *
 *   [{i:1,year:1968,label:1968 年前后},{i:2,year:null,label:}]
 *
 * 提示词里明明写了"严格 JSON"，它还是这么回。所以先按标准 JSON 试，
 * 解析不了就补引号、收掉尾逗号再试。
 *
 * 这段逻辑原来在 agent.mjs 和 understand.mjs 里各抄了一份（understand 里还有 4 处
 * 几乎一样的），现在合成这一份。
 */

/** 把不合法的地方修一修，再解析。返回数组或 null。 */
export function repairJsonArray(text) {
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
export function parseJsonArray(text) {
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
