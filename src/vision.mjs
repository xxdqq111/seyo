/**
 * 摄像头情绪识别
 * ==========================================================================
 * 两种后端，默认走本地：
 *
 *   local （默认）  你自己训练的那个 FER 模型（ResNet18+CBAM，
 *                   见 model/fer_service.py）。照片一个字节都不出这台机器。
 *
 *   cloud          任何 OpenAI 兼容的多模态接口（通义千问 / 智谱 / …）。
 *                   照片会被传到外面，所以默认不开。
 *
 * 不开摄像头也完全不影响：闲置主动搭话、从聊天文字里听情绪，那两条本来就有。
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, log } from './util.mjs';
import { ferLookAt, ensureFer, ferHealth, ferDebug, stopFer } from './fer.mjs';

const FILE = path.join(DATA_DIR, 'vision.json');

/** 你自己训练的那份模型放哪儿 */
export const DEFAULT_MODEL_DIR = 'C:\\Users\\zhang\\Desktop\\x\\lunwen\\lunwen\\FRE_Classroom';

const DEFAULTS = {
  enabled: true,                 // 本地模型不涉及隐私，默认就可以用
  provider: 'local',             // local | cloud
  modelDir: DEFAULT_MODEL_DIR,
  ferPort: 3791,
  python: '',                    // 留空就自动找装了 torch 的那个
  // ---- 下面这些只有 provider=cloud 时才用 ----
  baseUrl: '',
  model: '',
  apiKey: '',
  timeoutMs: 30000,
  prompt: `这是一张独居老人在家的照片。请只判断他此刻的情绪状态。

严格按下面三条来：
1. 只看表情、姿态、精神头，不要识别身份，不要描述长相、穿着、房间
2. 拿不准就判 normal，不要硬猜
3. 注意区分：打瞌睡、发呆 ≠ 情绪低落

只输出 JSON，不要解释：
{"level":"low|normal|happy","confidence":0.0-1.0,"note":"十个字以内，只描述情绪"}`,
};

export const VISION_PRESETS = {
  qwen:   { label: '通义千问 qwen-vl-max（云端）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-vl-max' },
  zhipu:  { label: '智谱 glm-4v（云端）',          baseUrl: 'https://open.bigmodel.cn/api/paas/v4',              model: 'glm-4v' },
  ollama: { label: '本地 Ollama（照片不出门）',     baseUrl: 'http://127.0.0.1:11434/v1',                         model: 'qwen2.5vl:7b' },
};

export function visionConfig() {
  let file = {};
  try { if (fs.existsSync(FILE)) file = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { /* 用默认 */ }
  const cfg = { ...DEFAULTS, ...file };
  cfg.available = Boolean(cfg.enabled && (
    cfg.provider === 'local' ? cfg.modelDir : (cfg.baseUrl && cfg.model)
  ));
  return cfg;
}

export function saveVisionConfig(patch = {}) {
  const next = { ...visionConfig(), ...patch };
  delete next.available;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2), 'utf8');
  return visionConfig();
}

export function visionStatus() {
  const c = visionConfig();
  return {
    enabled: c.enabled,
    available: c.available,
    provider: c.provider,
    // 本地的
    modelDir: c.modelDir,
    ferPort: c.ferPort,
    fer: { ...ferDebug(), defaultModelDir: DEFAULT_MODEL_DIR },
    // 云端的（只有切过去才显示）
    baseUrl: c.baseUrl,
    model: c.model,
    hasKey: Boolean(c.apiKey),
    presets: VISION_PRESETS,
  };
}

/** 服务起来没（给页面显示的） */
export async function visionHealth() {
  const c = visionConfig();
  if (c.provider !== 'local') return { provider: 'cloud', ready: Boolean(c.baseUrl && c.model) };
  const h = await ferHealth(c.ferPort);
  return { provider: 'local', ready: Boolean(h?.ready), health: h || null };
}

/* ------------------------------------------------------------------ *
 * 看一帧
 * ------------------------------------------------------------------ */

/**
 * @param {string} dataUrl 形如 data:image/jpeg;base64,xxxx
 * @returns {Promise<{level:string, score:number, note:string, error?:string, ms?:number}>}
 */
export async function lookAt(dataUrl) {
  const c = visionConfig();
  if (!c.available) return { level: 'normal', score: 0, note: '', error: '摄像头情绪识别没开启' };
  if (!/^data:image\/(jpeg|png|webp);base64,/.test(String(dataUrl || ''))) {
    return { level: 'normal', score: 0, note: '', error: '图片格式不对' };
  }

  const t0 = Date.now();
  const rec = { at: new Date().toISOString(), provider: c.provider, raw: '', parsed: null, error: null, ms: 0 };
  
  const out = c.provider === 'local'
    ? await localLook(c, dataUrl)
    : await cloudLook(c, dataUrl);

  rec.ms = out.ms || (Date.now() - t0);
  rec.raw = out.raw || out.note || '';
  rec.parsed = out;
  rec.error = out.error || null;
  if (out.error) log('表情识别失败：', out.error);
  return out;
}

/* ---------------- 本地：自己训练的模型 ---------------- */
async function localLook(c, dataUrl) {
  const r = await ferLookAt(c, dataUrl);
  if (r.error) return { level: 'normal', score: 0, note: '', error: r.error, ms: r.ms };
  return {
    level: r.level,
    score: r.confidence || 0,
    note: r.note,
    expression: r.expression,
    expressions: r.expressions,
    why: r.why,                    // 让页面能说明"为什么判成这个心情"
    face: r.face,
    ms: r.ms,
    provider: 'local',
  };
}


/* ---------------- 云端：OpenAI 兼容的多模态接口 ---------------- */
async function cloudLook(c, dataUrl) {
  const root = String(c.baseUrl).replace(/\/+$/, '').replace(/\/v1$/, '');
  const body = {
    model: c.model,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: c.prompt },
        { type: 'image_url', image_url: { url: dataUrl } },
      ],
    }],
    temperature: 0.1,
    max_tokens: 200,
  };

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), c.timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(`${root}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const ms = Date.now() - t0;
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      log(`视觉模型返回 ${res.status}：${t.slice(0, 140)}`);
      return { level: 'normal', score: 0, note: '', error: `HTTP ${res.status}`, ms, raw: t.slice(0, 300) };
    }
    const data = await res.json();
    const text = String(data?.choices?.[0]?.message?.content || '');
    const j = parseLooseJSON(text);
    if (!j || !j.level) return { level: 'normal', score: 0, note: '', error: '模型没按格式返回', ms, raw: text.slice(0, 300) };
    const level = ['low', 'normal', 'happy'].includes(j.level) ? j.level : 'normal';
    return {
      level,
      score: Number(j.confidence) || 0,
      note: String(j.note || '').slice(0, 60),
      ms,
      provider: 'cloud',
      raw: text.slice(0, 300),
    };
  } catch (e) {
    return { level: 'normal', score: 0, note: '', error: e?.name === 'AbortError' ? '超时' : String(e?.message || e), ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

function parseLooseJSON(text) {
  let s = String(text || '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  try { return JSON.parse(s); } catch { /* 往下试 */ }
  const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch { /* 放弃 */ } }
  return null;
}

/** 预热：把 Python 服务提前拉起来，别等第一次要用才慢 */
export function warmUp() {
  const c = visionConfig();
  if (c.enabled && c.provider === 'local') {
    ensureFer(c).then((r) => {
      if (!r.ok) log('本地表情服务没能起来：', r.error);
    }).catch(() => {});
  }
}

export { stopFer };
