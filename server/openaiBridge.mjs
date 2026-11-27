/**
 * OpenAI 格式翻译：Agent SDK 只会说 Anthropic Messages 格式，这里把它的请求翻译成 OpenAI Chat Completions，
 * 把回复（含流式文字、工具调用）翻回 Anthropic 格式。这样只提供 OpenAI 格式接口的模型（OpenAI、各种中转站、
 * 部分国产模型）也能用。
 *
 * 只在本机 127.0.0.1 上开一个随机端口；每个服务商一条路径 /p/<编号>/v1/messages；
 * 调用方必须带内部访问码（每次启动随机生成），别的本机程序拿不到服务商的密钥。
 * 服务商的真实密钥只在这里加到上游请求里，不进 SDK 进程的环境变量。
 */
import crypto from 'node:crypto';
import http from 'node:http';

const MAX_BODY = 32 * 1024 * 1024; // 带图片的请求可能比较大

/* ---------------- 请求：Anthropic → OpenAI ---------------- */

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

function imagePart(block) {
  const src = block.source || {};
  if (src.type === 'base64') return { type: 'image_url', image_url: { url: `data:${src.media_type};base64,${src.data}` } };
  if (src.type === 'url') return { type: 'image_url', image_url: { url: src.url } };
  return null;
}

export function toOpenAIRequest(body, { model }) {
  const messages = [];
  const system = typeof body.system === 'string' ? body.system : textOf(body.system);
  if (system) messages.push({ role: 'system', content: system });
  for (const m of body.messages || []) {
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content || [];
    if (m.role === 'assistant') {
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const calls = blocks.filter((b) => b.type === 'tool_use').map((b) => ({
        id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) }
      }));
      // 思考过程（thinking）不往回送：OpenAI 格式没有对应字段
      if (!text && !calls.length) continue;
      messages.push({ role: 'assistant', content: text || null, ...(calls.length && { tool_calls: calls }) });
    } else {
      // 工具结果在 OpenAI 里是单独的 tool 消息，而且必须紧跟在发起调用的那条后面：先放工具结果，再放其余内容
      for (const b of blocks.filter((x) => x.type === 'tool_result')) {
        const content = typeof b.content === 'string' ? b.content : textOf(b.content);
        messages.push({ role: 'tool', tool_call_id: b.tool_use_id, content: (b.is_error ? '[出错] ' : '') + (content || '') });
      }
      const parts = [];
      for (const b of blocks) {
        if (b.type === 'text' && b.text) parts.push({ type: 'text', text: b.text });
        else if (b.type === 'image') { const p = imagePart(b); if (p) parts.push(p); }
      }
      if (parts.length) messages.push({ role: 'user', content: parts.every((p) => p.type === 'text') ? parts.map((p) => p.text).join('\n') : parts });
    }
  }
  const tools = (body.tools || []).filter((t) => t.input_schema).map((t) => ({
    type: 'function', function: { name: t.name, description: t.description || '', parameters: t.input_schema }
  }));
  const choice = body.tool_choice;
  const toolChoice = !choice || !tools.length ? undefined
    : choice.type === 'any' ? 'required' : choice.type === 'tool' ? { type: 'function', function: { name: choice.name } } : choice.type === 'none' ? 'none' : 'auto';
  return {
    model,
    messages,
    ...(tools.length && { tools }),
    ...(toolChoice && { tool_choice: toolChoice }),
    ...(body.max_tokens && { max_tokens: body.max_tokens }),
    ...(typeof body.temperature === 'number' && { temperature: body.temperature }),
    ...(typeof body.top_p === 'number' && { top_p: body.top_p }),
    ...(Array.isArray(body.stop_sequences) && body.stop_sequences.length && { stop: body.stop_sequences.slice(0, 4) }),
    stream: Boolean(body.stream),
    ...(body.stream && { stream_options: { include_usage: true } })
  };
}

/* ---------------- 回复：OpenAI → Anthropic ---------------- */

const STOP = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', function_call: 'tool_use', content_filter: 'refusal' };
const newId = () => 'msg_' + crypto.randomBytes(12).toString('hex');
const parseArgs = (s) => { try { return s ? JSON.parse(s) : {}; } catch { return {}; } };

export function fromOpenAIResponse(data, model) {
  const choice = data.choices?.[0] || {};
  const msg = choice.message || {};
  const content = [];
  if (msg.content) content.push({ type: 'text', text: msg.content });
  for (const c of msg.tool_calls || []) content.push({ type: 'tool_use', id: c.id || 'toolu_' + crypto.randomBytes(8).toString('hex'), name: c.function?.name, input: parseArgs(c.function?.arguments) });
  return {
    id: newId(), type: 'message', role: 'assistant', model, content,
    stop_reason: (msg.tool_calls?.length ? 'tool_use' : STOP[choice.finish_reason]) || 'end_turn', stop_sequence: null,
    usage: { input_tokens: data.usage?.prompt_tokens ?? 0, output_tokens: data.usage?.completion_tokens ?? 0 }
  };
}

/** 把 OpenAI 的流式片段一段段翻成 Anthropic 的流式事件 */
export function createStreamTranslator(model, write) {
  const ev = (type, data) => write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  let started = false, index = -1, textOpen = false, finished = false;
  const tools = new Map(); // OpenAI 工具调用序号 → 我们的块序号
  let stop = null, usage = { input_tokens: 0, output_tokens: 0 };
  const start = () => {
    if (started) return;
    started = true;
    ev('message_start', { message: { id: newId(), type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } });
  };
  const closeText = () => { if (textOpen) { ev('content_block_stop', { index }); textOpen = false; } };
  return {
    push(chunk) {
      start();
      if (chunk.usage) usage = { input_tokens: chunk.usage.prompt_tokens ?? 0, output_tokens: chunk.usage.completion_tokens ?? 0 };
      const choice = chunk.choices?.[0];
      if (!choice) return;
      const d = choice.delta || {};
      if (d.content) {
        if (!textOpen) { index++; textOpen = true; ev('content_block_start', { index, content_block: { type: 'text', text: '' } }); }
        ev('content_block_delta', { index, delta: { type: 'text_delta', text: d.content } });
      }
      for (const c of d.tool_calls || []) {
        const key = c.index ?? 0;
        if (!tools.has(key)) {
          closeText();
          index++;
          tools.set(key, index);
          ev('content_block_start', { index, content_block: { type: 'tool_use', id: c.id || 'toolu_' + crypto.randomBytes(8).toString('hex'), name: c.function?.name || '', input: {} } });
        }
        if (c.function?.arguments) ev('content_block_delta', { index: tools.get(key), delta: { type: 'input_json_delta', partial_json: c.function.arguments } });
      }
      if (choice.finish_reason) stop = choice.finish_reason;
    },
    end() {
      if (finished) return;
      finished = true;
      start();
      closeText();
      for (const i of tools.values()) ev('content_block_stop', { index: i });
      ev('message_delta', { delta: { stop_reason: (tools.size ? 'tool_use' : STOP[stop]) || 'end_turn', stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
      ev('message_stop', {});
    }
  };
}

/* ---------------- 本机翻译服务 ---------------- */

const ERROR_TYPE = { 400: 'invalid_request_error', 401: 'authentication_error', 403: 'permission_error', 404: 'not_found_error', 429: 'rate_limit_error' };
function anthropicError(res, status, message) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type: ERROR_TYPE[status] || 'api_error', message } }));
}

/**
 * @param {{ getProvider: (id: string) => ({ baseUrl, apiKey } | null), fetchImpl?: Function }} o
 * @returns {Promise<{ url: string, token: string, close: () => void }>}
 */
export async function startOpenAIBridge({ getProvider, fetchImpl = globalThis.fetch }) {
  const token = crypto.randomBytes(24).toString('base64url');
  const server = http.createServer(async (req, res) => {
    try {
      const m = new URL(req.url, 'http://local').pathname.match(/^\/p\/([\w-]{1,40})\/v1\/messages(\/count_tokens)?$/);
      if (!m || req.method !== 'POST') return anthropicError(res, 404, 'not found');
      const auth = String(req.headers['x-api-key'] || req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (auth.length !== token.length || !crypto.timingSafeEqual(Buffer.from(auth), Buffer.from(token))) return anthropicError(res, 401, '内部访问码不对');
      if (m[2]) return anthropicError(res, 404, '这个服务商不支持数 token'); // SDK 会自己估算
      const provider = getProvider(m[1]);
      if (!provider) return anthropicError(res, 404, '没有这个服务商');
      let size = 0;
      const chunks = [];
      for await (const c of req) { size += c.length; if (size > MAX_BODY) return anthropicError(res, 413, '请求太大'); chunks.push(c); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const upstreamBody = toOpenAIRequest(body, { model: body.model });
      const ctrl = new AbortController();
      res.on('close', () => { if (!res.writableEnded) ctrl.abort(); });
      let up;
      try {
        up = await fetchImpl(provider.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
          method: 'POST', signal: ctrl.signal,
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + provider.apiKey },
          body: JSON.stringify(upstreamBody)
        });
      } catch (e) {
        return anthropicError(res, 502, `连不上模型服务商（${e.cause?.code || e.name}）`);
      }
      if (!up.ok) {
        // 上游报错原文可能很长或带请求编号，截短后转给 SDK；不会带我们的密钥（密钥只在请求头里）
        const detail = (await up.text().catch(() => '')).slice(0, 300).replace(/(sk-|Bearer\s+)[\w.-]{4,}/gi, '$1***');
        return anthropicError(res, up.status, `模型服务商返回 ${up.status}：${detail}`);
      }
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(fromOpenAIResponse(await up.json(), body.model)));
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const tr = createStreamTranslator(body.model, (s) => res.write(s));
      const dec = new TextDecoder();
      let buf = '';
      for await (const part of up.body) {
        buf += dec.decode(part, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          try { tr.push(JSON.parse(data)); } catch { /* 坏的一行跳过 */ }
        }
      }
      tr.end();
      res.end();
    } catch (e) {
      if (!res.headersSent) anthropicError(res, 500, '翻译出错：' + String(e?.message || e).slice(0, 200));
      else res.end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, token, close: () => server.close() };
}
