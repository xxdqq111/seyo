/**
 * 大模型接口（把"说话"这件事交给现成的模型）
 *
 * 我原来自己写的那套规则引擎只适合"结构化"（抽取、归档、检索、核实），
 * 说话要灵活必须用模型。这里做三件事：
 *   1. 读配置（环境变量 或 data/llm.json）
 *   2. 把"老人这句话 + 主句库里查到的记忆 + 最近几轮对话 + 人设"拼成提示词
 *   3. 调模型拿回复；失败就返回 null，由调用方退回规则引擎（保证离线也能用）
 *
 * 兼容任何 OpenAI /chat/completions 协议的服务：
 *   DeepSeek / 通义千问 / Kimi / 智谱 / OpenAI / 本地 Ollama、vLLM 都行。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, log } from './util.mjs';

const CONFIG_FILE = path.join(DATA_DIR, 'llm.json');

/* ------------------------------------------------------------------ *
 * 配置
 * ------------------------------------------------------------------ */

export function llmConfig() {
  let file = {};
  try {
    if (fs.existsSync(CONFIG_FILE)) file = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    log('llm.json 读不动，忽略：', e.message);
  }
  const env = process.env;
  const cfg = {
    baseUrl: env.SEYO_LLM_BASE_URL || file.baseUrl || '',
    apiKey: env.SEYO_LLM_API_KEY || file.apiKey || '',
    model: env.SEYO_LLM_MODEL || file.model || '',
    temperature: Number(file.temperature ?? 0.8),
    timeoutMs: Number(env.SEYO_LLM_TIMEOUT_MS || file.timeoutMs || 25000),
    maxTokens: Number(file.maxTokens || 300),
  };
  cfg.available = Boolean(cfg.baseUrl && cfg.model) && file.enabled !== false;
  return cfg;
}

export function llmStatus() {
  const c = llmConfig();
  return {
    available: c.available,
    provider: c.baseUrl ? c.baseUrl.replace(/^(https?:\/\/[^/]+).*/, '$1') : '',
    model: c.model || '',
    keySet: Boolean(c.apiKey),
    configFile: CONFIG_FILE,
    note: c.available
      ? `已接大模型：${c.model}（说话由模型负责，记忆仍由本地引擎核实）`
      : '未接大模型：用内置规则引擎应答（能跑，但说话不够灵活）',
  };
}

export function saveLLMConfig(patch = {}) {
  let cur = {};
  try {
    if (fs.existsSync(CONFIG_FILE)) cur = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch { /* 忽略 */ }
  const next = { ...cur, ...patch };
  if (patch.apiKey === '') delete next.apiKey;         // 传空串 = 清除
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8');
  return llmStatus();
}

/** 常见服务商的地址，方便一键填 */
export const PRESETS = {
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  qwen: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  kimi: { baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  zhipu: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  ollama: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' },
};

/* ------------------------------------------------------------------ *
 * 提示词
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * 调用
 *
 * 提示词已经搬到 prompts.mjs（智能体的本体在那里）。
 * 这个文件只负责把 messages 发出去、把文字收回来。
 * ------------------------------------------------------------------ */

/**
 * @param {Array<{role:string,content:string}>} messages 已经拼好的对话
 * @param {{temperature?:number, maxTokens?:number}} opts
 */
export async function speak(messages, opts = {}) {
  const cfg = llmConfig();
  if (!cfg.available) return null;

  // 接口地址可能写成这几种，都要能对上（别拼成 /v1/v1/...）
  const url = `${cfg.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1/chat/completions`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), cfg.timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        temperature: opts.temperature ?? cfg.temperature,
        max_tokens: opts.maxTokens ?? cfg.maxTokens,
        stream: false,
      }),
      signal: ctl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log(`大模型返回 ${res.status}：${body.slice(0, 160)}`);
      return { error: `HTTP ${res.status} ${body.slice(0, 120)}` };
    }
    const data = await res.json();
    let text = String(data?.choices?.[0]?.message?.content || '').trim();
    text = text
      .replace(/^(岁语|小宇|我)[:：]\s*/, '')
      .replace(/["“”]/g, '')
      .replace(/\s*\n+\s*/g, ' ')
      .trim();
    if (!text) return { error: '模型返回空内容' };
    return { text, model: cfg.model, ms: Date.now() - t0, usage: data?.usage || null };
  } catch (e) {
    log('大模型调用失败：', e.message);
    return { error: e.name === 'AbortError' ? '超时' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

/** 连通性自检：随便问一句，看模型是否可用 */
export async function testLLM() {
  const cfg = llmConfig();
  if (!cfg.available) return { ok: false, error: '还没填 baseUrl / model（或 model 为空）' };

  const { buildMessages } = await import('./prompts.mjs');
  const out = await speak(buildMessages({
    persona: { agent_name: '岁语', self_ref: '小孙子', elder_call: '爷爷', max_chars: 40 },
    text: '（这是连通性测试）请用一句家常话跟爷爷打个招呼。',
    confirmed: [],
    pending: [],
    history: [],
  }), { maxTokens: 80 });

  if (out?.error) return { ok: false, error: out.error, provider: llmStatus().provider, model: cfg.model };
  return { ok: true, sample: out.text, model: out.model, ms: out.ms, usage: out.usage, provider: llmStatus().provider };
}
