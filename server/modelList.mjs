/**
 * 从服务商那里拉取可用的模型列表（设置页“拉取模型”按钮用），省得照文档一个个敲型号名。
 *
 * - OpenAI 格式：GET <地址>/models
 * - Anthropic 格式：先试 GET <地址>/v1/models；不行再按 OpenAI 的方式试同一家的兼容地址
 *   （国内几家都是两种接口一起开：把地址末尾的 /anthropic 换掉，见 candidates()）
 * 只读、不保存；密钥只放在请求头里，报错里不带服务商原文（里面可能回显密钥）。
 */
import { validBaseUrl } from './settings.mjs';

const MAX_MODELS = 300;
const TIMEOUT_MS = 15_000;

/** 依次尝试的地址：[{ url, style }]，style 决定请求头 */
export function candidates(format, baseUrl) {
  const base = baseUrl.replace(/\/+$/, '');
  if (format === 'openai') return [{ url: `${base}/models`, style: 'openai' }];
  const list = [{ url: `${base}/v1/models`, style: 'anthropic' }];
  const root = base.replace(/\/(?:apps\/|api\/)?anthropic$/, '');
  const special = [
    // 通义千问：Anthropic 在 /apps/anthropic，OpenAI 兼容在 /compatible-mode/v1
    [/dashscope\.aliyuncs\.com/, `${root}/compatible-mode/v1/models`],
    // 智谱：Anthropic 在 /api/anthropic，OpenAI 兼容在 /api/paas/v4
    [/bigmodel\.cn/, `${root}/api/paas/v4/models`]
  ].find(([re]) => re.test(base));
  if (special) list.push({ url: special[1], style: 'openai' });
  if (root !== base) list.push({ url: `${root}/v1/models`, style: 'openai' }, { url: `${root}/models`, style: 'openai' });
  return list;
}

/** 各家返回的格式略有不同：{data:[{id}]} / {models:[{id|name}]} / [{id}] */
export function parseModelList(json) {
  const arr = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : null;
  if (!arr) return null;
  const ids = arr.map((m) => (typeof m === 'string' ? m : m?.id || m?.name || m?.model)).map((s) => String(s ?? '').replace(/^models\//, '').trim());
  return [...new Set(ids.filter((s) => /^[\w.:/\[\]@-]{1,100}$/.test(s)))].sort().slice(0, MAX_MODELS);
}

/**
 * @returns {Promise<{ models: string[], from: string } | { error: string }>}
 */
export async function fetchModels({ format, baseUrl, apiKey }, { fetchImpl = fetch } = {}) {
  const base = validBaseUrl(baseUrl);
  if (!base) return { error: '接口地址不对' };
  if (!apiKey) return { error: '要先填密钥才能拉取' };
  let lastStatus = 0;
  for (const c of candidates(format, base)) {
    const headers = c.style === 'anthropic'
      ? { 'x-api-key': apiKey, authorization: `Bearer ${apiKey}`, 'anthropic-version': '2023-06-01' }
      : { authorization: `Bearer ${apiKey}` };
    try {
      const res = await fetchImpl(c.url, { headers, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
      lastStatus = res.status;
      if (res.status === 401 || res.status === 403) return { error: '服务商说密钥不对或没有权限' };
      if (!res.ok) continue;
      const models = parseModelList(await res.json().catch(() => null));
      if (models?.length) return { models, from: new URL(c.url).pathname };
    } catch { /* 连不上或超时：试下一个 */ }
  }
  return { error: lastStatus ? `服务商没有提供模型列表（HTTP ${lastStatus}），请照官方文档手填型号名` : '连不上服务商（地址不对或网络不通），请检查地址，或照官方文档手填型号名' };
}
