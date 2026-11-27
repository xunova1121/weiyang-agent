/**
 * 测试用的假模型（Anthropic Messages 接口格式，流式）和“记录外连”的代理。
 * 假模型按最后一条用户消息决定怎么回：
 *   - 含“读文件 X” → 先调用 Read 工具读 X，拿到工具结果后把结果原样复述
 *   - 含“跑命令”   → 调用 Bash（应被拒绝或根本不可用）
 *   - 其他          → 回“收到：<原话>（历史 N 条）”
 */
import http from 'node:http';

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    const c = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content || [];
    const tr = c.find((b) => b.type === 'tool_result');
    if (tr) return { toolResult: tr };
    const t = c.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    // SDK 会在用户消息前后附带系统提醒，取最后一段真正的用户原话
    const plain = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
    if (plain) return { text: plain };
  }
  return { text: '' };
}

function flat(content) {
  if (typeof content === 'string') return content;
  return (content || []).map((b) => (b.type === 'text' ? b.text : '')).join('');
}

export function startFakeModel() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const j = body ? JSON.parse(body) : {};
    requests.push({ method: req.method, url: req.url, auth: req.headers.authorization || '', body: j });
    if (!req.url.startsWith('/v1/messages') || req.url.includes('count_tokens')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end('{"type":"error","error":{"type":"not_found_error","message":"not here"}}');
    }
    const last = lastUserText(j.messages || []);
    let blocks;
    if (last.toolResult) {
      blocks = [{ type: 'text', text: `工具${last.toolResult.is_error ? '失败' : '成功'}：${flat(last.toolResult.content).slice(0, 200)}` }];
    } else if (/读文件 (\S+)/.test(last.text)) {
      blocks = [{ type: 'tool_use', id: 'toolu_' + requests.length, name: 'Read', input: { file_path: last.text.match(/读文件 (\S+)/)[1] } }];
    } else if (/跑命令/.test(last.text)) {
      blocks = [{ type: 'tool_use', id: 'toolu_' + requests.length, name: 'Bash', input: { command: 'cat /etc/hostname' } }];
    } else {
      const users = (j.messages || []).filter((m) => m.role === 'user').length;
      blocks = [{ type: 'text', text: `收到：${last.text}（历史 ${users} 条）` }];
    }
    const stop = blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn';
    const msg = { id: 'msg_' + requests.length, type: 'message', role: 'assistant', model: j.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } };
    if (!j.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ...msg, content: blocks, stop_reason: stop, usage: { input_tokens: 10, output_tokens: 5 } }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const ev = (t, d) => res.write(`event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`);
    ev('message_start', { message: msg });
    blocks.forEach((b, index) => {
      if (b.type === 'text') {
        ev('content_block_start', { index, content_block: { type: 'text', text: '' } });
        // 拆成两段推，验证网页能逐段拼起来
        const half = Math.ceil(b.text.length / 2);
        ev('content_block_delta', { index, delta: { type: 'text_delta', text: b.text.slice(0, half) } });
        ev('content_block_delta', { index, delta: { type: 'text_delta', text: b.text.slice(half) } });
      } else {
        ev('content_block_start', { index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
        ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
      }
      ev('content_block_stop', { index });
    });
    ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } });
    ev('message_stop', {});
    res.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}` })));
}

/** 只记录、一律拒绝的代理：用来证明 SDK 没有往外连（比如 api.anthropic.com） */
export function startLoggingProxy() {
  const attempts = [];
  const server = http.createServer((req, res) => { attempts.push(req.url); res.writeHead(403); res.end(); });
  server.on('connect', (req, sock) => { sock.on('error', () => {}); attempts.push(req.url); sock.end('HTTP/1.1 403 Forbidden\r\n\r\n'); });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, attempts, url: `http://127.0.0.1:${server.address().port}` })));
}
