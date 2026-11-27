// 假的 Anthropic 格式模型服务器 + 记录外连的代理（只做实验，不进正式代码）
import http from 'node:http';
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const model = http.createServer(async (req, res) => {
  let body = ''; for await (const c of req) body += c;
  let j = {}; try { j = JSON.parse(body || '{}'); } catch {}
  log('MODEL', req.method, req.url, 'model=' + j.model, 'stream=' + j.stream, 'tools=' + (j.tools?.length ?? 0), 'auth=' + (req.headers.authorization ? 'bearer' : req.headers['x-api-key'] ? 'x-api-key' : 'none'));
  if (!req.url.startsWith('/v1/messages') || req.url.includes('count_tokens')) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"type":"error","error":{"type":"not_found_error","message":"nope"}}'); }
  const msg = { id: 'msg_fake', type: 'message', role: 'assistant', model: j.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } };
  const text = '你好，我是假模型。';
  if (!j.stream) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ...msg, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } })); }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const ev = (t, d) => res.write(`event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`);
  ev('message_start', { message: msg });
  ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text } });
  ev('content_block_stop', { index: 0 });
  ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
  ev('message_stop', {});
  res.end();
});
const proxy = http.createServer((req, res) => { log('PROXY-HTTP', req.method, req.url); res.writeHead(403); res.end(); });
proxy.on('connect', (req, sock) => { sock.on('error', () => {}); log('PROXY-CONNECT', req.url); sock.end('HTTP/1.1 403 Forbidden\r\n\r\n'); });
model.listen(18080, '127.0.0.1', () => log('model on 18080'));
proxy.listen(18081, '127.0.0.1', () => log('proxy on 18081'));
