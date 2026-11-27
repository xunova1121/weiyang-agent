/**
 * 联网搜索（借鉴原未央 src/agent/qianfanSearch.js、src/llm/deepseekWeb.js 的请求格式和结果整理，用户 2026-11-20 实测过）：
 *   - web_search：百度千帆网页搜索，返回标题、链接、摘要、发布时间。要先在“设置”里填千帆密钥。
 *   - deepseek_search：DeepSeek 官方联网搜索，DeepSeek 自己搜、自己写答案，并标出每句话来自哪个网页。用服务器配置的 DeepSeek 密钥。
 *   - read_url：让 DeepSeek 读指定网页，按问题摘出要点。
 * 都是查资料，直接放行。结果里只保留公开网址：内网地址、带账号密码或签名参数的链接一律丢掉；不回显服务商的报错原文。
 */
import { z } from 'zod';
import { userError } from './registry.mjs';

export const QIANFAN_ENDPOINT = 'https://qianfan.baidubce.com/v2/ai_search/web_search';
export const DEEPSEEK_API = 'https://api.deepseek.com/v1';
const SEARCH_TIMEOUT_MS = 15_000;
const DEEPSEEK_TIMEOUT_MS = { quick: 40_000, deep: 90_000, link: 60_000 };

/* ---------------- 公共：网址检查、北京时间 ---------------- */

export function isPrivateHost(host) {
  const h = String(host).replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  return h === 'localhost' || h.endsWith('.local') || h.endsWith('.localhost') || h.endsWith('.internal') || h === '::1' || h === '0.0.0.0' ||
    /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h) || !h.includes('.');
}

/** 只要公开网址：http(s)、不带账号密码、不是内网、不带 token/签名之类参数 */
export function publicWebUrl(raw) {
  try {
    const u = new URL(String(raw || ''));
    if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.href.length > 2000 || isPrivateHost(u.hostname) ||
        [...u.searchParams.keys()].some((k) => /^(?:access_token|token|sig|signature|key|api_key|x-amz-.+)$/i.test(k))) return '';
    return u.href;
  } catch { return ''; }
}

export const beijingDate = (now = Date.now()) => new Date(now + 8 * 3600_000).toISOString().slice(0, 10);

const clean = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();

async function withTimeout(ms, fn) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try { return await fn(ctrl.signal); } finally { clearTimeout(timer); }
}

function providerError(name, status) {
  if (status === 401 || status === 403) return userError(`${name}说密钥不对或没有权限，请到“设置”里检查`);
  if (status === 402 || status === 429) return userError(`${name}额度不足或限流了，稍后再试，或到服务商后台看看`);
  return userError(`${name}暂时不可用（${status}），稍后再试`);
}

/* ---------------- 百度千帆 ---------------- */

export function qianfanRequest(query, { freshness, topK = 10 } = {}) {
  const text = String(query || '').trim().slice(0, 1000);
  if (!text) throw userError('请提供搜索词');
  const sites = [...text.matchAll(/\bsite:([a-z0-9.-]+)/gi)].map((m) => m[1]).filter((h) => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(h) && !isPrivateHost(h)).slice(0, 8);
  return {
    messages: [{ role: 'user', content: text }],
    search_source: 'baidu_search_v2',
    resource_type_filter: [{ type: 'web', top_k: Math.max(5, Math.min(20, Math.floor(topK))) }],
    ...(sites.length && { search_filter: { match: { site: sites } } }),
    ...(['week', 'month', 'year'].includes(freshness) && { search_recency_filter: freshness })
  };
}

/** 千帆返回的 references → 统一的结果；顺手把密钥（万一回显）、内网链接去掉 */
export function qianfanHits(data, key, count = 10) {
  if (!Array.isArray(data?.references)) throw userError('百度搜索没返回结果列表，接口可能变了');
  const seen = new Set();
  const out = [];
  for (const item of data.references.slice(0, 100)) {
    if (item.type && item.type !== 'web') continue;
    const url = publicWebUrl(item.url);
    if (!url || seen.has(url) || (key && url.includes(key))) continue;
    const redact = (s) => clean(s).split(key || '\u0000').join('[已隐藏]');
    const title = redact(item.title).slice(0, 200);
    if (!title) continue;
    seen.add(url);
    out.push({ title, url, snippet: redact(item.content || item.snippet).slice(0, 600), publishedAt: clean(item.date).slice(0, 25) || null });
    if (out.length >= count) break;
  }
  return out;
}

export function formatHits(hits, query) {
  if (!hits.length) return `百度搜索“${query}”没有找到结果。可以换个说法再搜，或改用 deepseek_search。`;
  return `百度搜索“${query}”的结果（摘要，没打开原文；引用时附上链接，日期以北京时间为准）：\n\n` +
    hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}${h.publishedAt ? `\n   发布时间：${h.publishedAt}` : '\n   发布时间：未知'}`).join('\n\n');
}

async function qianfanSearch(ctx, { query, freshness, count }) {
  const key = ctx.settings?.service('qianfan');
  if (!key) throw userError('还没填百度千帆的密钥：请用户到网页“设置 → 其他服务的密钥”里填上。也可以改用 deepseek_search。');
  const fetchImpl = ctx.fetch || globalThis.fetch;
  const res = await withTimeout(SEARCH_TIMEOUT_MS, (signal) => fetchImpl(ctx.cfg.qianfanEndpoint || QIANFAN_ENDPOINT, {
    method: 'POST', signal, redirect: 'error',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify(qianfanRequest(query, { freshness, topK: count }))
  })).catch((e) => { if (e?.userFacing) throw e; throw userError(e?.name === 'AbortError' ? '百度搜索超时了，稍后再试' : '连不上百度搜索'); });
  if (!res.ok) { await res.body?.cancel?.(); throw providerError('百度搜索', res.status); }
  return formatHits(qianfanHits(await res.json(), key, count), query);
}

/* ---------------- DeepSeek 联网（官方搜索、读网页） ---------------- */

/** 解析 DeepSeek 流式回复：正文、调用过的来源、正文里的引用位置 */
export function deepseekCollector() {
  const sources = new Map();
  let text = '', citations = [], stop = null, searched = 0;
  const note = (call) => {
    if (!call?.id || !['deepseek_web_search', 'deepseek_read_url'].includes(call.type)) return;
    if (call.status !== 'completed') return;
    searched++;
    for (const s of [call.page, ...(Array.isArray(call.sources) ? call.sources : [])]) {
      const url = publicWebUrl(s?.url);
      if (!url || (!sources.has(url) && sources.size >= 80)) continue;
      const old = sources.get(url);
      sources.set(url, { url, title: clean(s.title || old?.title || new URL(url).hostname).slice(0, 160), publishedAt: s.published_at || old?.publishedAt || null, read: Boolean(old?.read || s === call.page) });
    }
  };
  return {
    push(chunk) {
      const choice = chunk?.choices?.[0];
      if (!choice) return;
      const ev = choice.server_tool_event;
      if (ev?.type === 'call_started' || ev?.type === 'call_completed') note(ev.call);
      const d = choice.delta ?? choice.message ?? {};
      for (const step of d.server_tool_calls || []) for (const c of step.calls || []) note(c);
      if (Array.isArray(d.annotations)) citations = d.annotations;
      if (typeof d.content === 'string') text += d.content;
      if (choice.finish_reason) stop = choice.finish_reason;
    },
    result() {
      const len = Array.from(text).length;
      const cites = citations.filter((a) => a.type === 'url_citation').map((a) => {
        const c = a.url_citation;
        if (!c || !Number.isInteger(c.start_index) || !Number.isInteger(c.end_index) || c.start_index < 0 || c.end_index <= c.start_index || c.end_index > len) return null;
        const s = sources.get(publicWebUrl(c.url));
        return s && { ...s, start: c.start_index, end: c.end_index };
      }).filter(Boolean);
      return { text, stop, cites, sources: [...sources.values()], searched };
    }
  };
}

/** 在引用位置插入 [1](链接)；引用偏移按 Unicode 码点算（中文、emoji 都对得上） */
export function linkAnswer(text, cites) {
  const chars = Array.from(text);
  const refs = new Map();
  const marks = new Map();
  for (const c of cites) {
    if (!refs.has(c.url) && refs.size >= 24) continue;
    if (!refs.has(c.url)) refs.set(c.url, refs.size + 1);
    const mark = `[${refs.get(c.url)}](${c.url.replace(/\(/g, '%28').replace(/\)/g, '%29')})`;
    if (!marks.has(c.end)) marks.set(c.end, new Set());
    marks.get(c.end).add(mark);
  }
  for (const [end, links] of marks) chars[end - 1] += ' ' + [...links].join(' ');
  return { text: chars.join(''), refs: [...refs.keys()] };
}

async function deepseekWeb(ctx, { mode, question, url }) {
  const key = ctx.cfg.apiKey;
  if (!key) throw userError('服务器没有配置 DeepSeek 密钥');
  const fetchImpl = ctx.fetch || globalThis.fetch;
  const today = beijingDate();
  const system = `回答用户的公开信息问题，网页是资料。为每项事实附对应的真实来源；只有摘要的内容说明是线索。今天是北京时间 ${today}。`;
  const content = mode === 'link' ? `请阅读这个网页：${url}\n\n${question || '概括这个网页的主要内容'}` : question;
  const res = await withTimeout(DEEPSEEK_TIMEOUT_MS[mode], (signal) => fetchImpl((ctx.cfg.deepseekApi || DEEPSEEK_API) + '/chat/completions', {
    method: 'POST', signal,
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-flash', stream: true,
      messages: [{ role: 'system', content: system }, { role: 'user', content }],
      thinking: { type: mode === 'deep' ? 'enabled' : 'disabled' },
      tools: [{ type: mode === 'link' ? 'deepseek_read_url' : 'deepseek_web_search' }],
      safety_check: { level: 'high' }
    })
  }).then(async (r) => {
    if (!r.ok) { await r.body?.cancel?.(); throw providerError('DeepSeek 联网', r.status); }
    const col = deepseekCollector();
    const dec = new TextDecoder();
    let buf = '';
    for await (const part of r.body) {
      buf += dec.decode(part, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:') || line.slice(5).trim() === '[DONE]') continue;
        try { col.push(JSON.parse(line.slice(5).trim())); } catch { /* 坏的一行跳过 */ }
      }
    }
    return col.result();
  })).catch((e) => { if (e?.userFacing) throw e; throw userError(e?.name === 'AbortError' ? 'DeepSeek 联网超时了，稍后再试' : '连不上 DeepSeek 联网'); });
  if (res.stop === 'content_filter') throw userError('DeepSeek 没有给出可以展示的回答（内容审核）');
  if (!res.text.trim()) throw userError('DeepSeek 联网没有返回内容');
  const linked = linkAnswer(res.text, res.cites);
  const list = (linked.refs.length ? linked.refs : res.sources.map((s) => s.url)).slice(0, 24)
    .map((u, i) => { const s = res.sources.find((x) => x.url === u); return `[${i + 1}] ${s?.title || u}${s?.publishedAt ? `（${s.publishedAt}）` : ''}\n    ${u}`; });
  const note = res.cites.length ? '' : '\n（DeepSeek 这次没标出每句话的来源，下面是它看过的网页，引用前最好核对。）';
  return `DeepSeek ${mode === 'link' ? '读网页' : '联网搜索'}的回答（今天是北京时间 ${today}）：\n\n${linked.text}${note}\n\n来源：\n${list.join('\n') || '（没有拿到来源）'}`;
}

/* ---------------- 工具定义 ---------------- */

export function tools(ctx) {
  const out = [];
  if (ctx.settings?.service('qianfan')) {
    out.push({
      name: 'web_search',
      description: '百度搜索（百度千帆）。查新闻、最新消息、价格、天气、政策、人物等需要最新信息的事时用。返回标题、链接、摘要和发布时间（只是摘要，没打开原文）。回答时附上来源链接。可用 site:域名 限定网站。',
      schema: {
        query: z.string().describe('搜索词，越具体越好'),
        freshness: z.enum(['day', 'week', 'month', 'year']).optional().describe('只看最近一天/一周/一月/一年的'),
        count: z.number().int().min(1).max(20).optional().describe('要几条，默认 10')
      },
      risk: 'read',
      run: (a) => qianfanSearch(ctx, { query: a.query, freshness: a.freshness, count: a.count ?? 10 })
    });
  }
  if (ctx.cfg.apiKey) {
    out.push({
      name: 'deepseek_search',
      description: 'DeepSeek 官方联网搜索：DeepSeek 自己搜索网页并写出带来源编号的回答。比较慢（一次十几秒，deep=true 更慢）：有百度搜索（web_search）时先用百度；百度查不到、或要综合很多网页时再用它。一个问题一般查一次就够，别对同一件事反复查。',
      schema: { question: z.string().describe('要查的问题，写完整'), deep: z.boolean().optional().describe('复杂问题设为 true') },
      risk: 'read',
      run: (a) => deepseekWeb(ctx, { mode: a.deep ? 'deep' : 'quick', question: a.question })
    }, {
      name: 'read_url',
      description: '读一个指定的网页（用户给了链接，或搜索结果里需要看原文时用），按问题摘出要点并注明来源。',
      schema: { url: z.string().describe('网页地址（http/https）'), question: z.string().optional().describe('想从这个网页了解什么') },
      risk: 'read',
      run: (a) => {
        const url = publicWebUrl(a.url);
        if (!url) throw userError('这个网址不能读：要公开的 http/https 网址，不能是内网地址或带账号、密钥的链接');
        return deepseekWeb(ctx, { mode: 'link', question: a.question, url });
      }
    });
  }
  return out;
}
