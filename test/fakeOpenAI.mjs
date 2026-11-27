/**
 * 测试用的假 OpenAI 格式模型（/v1/chat/completions，流式和非流式都支持）。
 *   - 最后一条是工具结果 → 回“工具结果：<内容>”
 *   - 用户说“读文件 X” → 调用 Read 工具（参数分两段流式发出，验证翻译能拼起来）
 *   - 其他 → 回“OpenAI收到：<原话>”
 */
import http from 'node:http';

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'tool') return { tool: m.content };
    if (m.role !== 'user') continue;
    const t = typeof m.content === 'string' ? m.content : (m.content || []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
    // SDK 会把环境信息（# Environment …）接在用户原话后面，只取原话
    const plain = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').split(/\n?# Environment\b/)[0].trim();
    if (plain) return { text: plain };
  }
  return { text: '' };
}

export function startFakeOpenAI() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const j = body ? JSON.parse(body) : {};
    requests.push({ url: req.url, auth: req.headers.authorization || '', body: j });
    if (req.url !== '/v1/chat/completions') { res.writeHead(404); return res.end('{"error":{"message":"no"}}'); }
    if (req.headers.authorization !== 'Bearer sk-openai-test-key') { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"Incorrect API key provided: sk-openai-WRONG-1234"}}'); }
    const last = lastUserText(j.messages || []);
    let text = null, call = null;
    if (last.tool !== undefined) text = `工具结果：${String(last.tool).slice(0, 200)}`;
    else if (/读文件 (\S+)/.test(last.text)) call = { id: 'call_' + requests.length, name: 'Read', args: JSON.stringify({ file_path: last.text.match(/读文件 (\S+)/)[1] }) };
    else text = `OpenAI收到：${last.text}`;
    const usage = { prompt_tokens: 12, completion_tokens: 7 };
    if (!j.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      const message = call ? { role: 'assistant', content: null, tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: call.args } }] } : { role: 'assistant', content: text };
      return res.end(JSON.stringify({ id: 'x', choices: [{ index: 0, message, finish_reason: call ? 'tool_calls' : 'stop' }], usage }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    if (call) {
      const half = Math.ceil(call.args.length / 2);
      send({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: call.id, type: 'function', function: { name: call.name, arguments: call.args.slice(0, half) } }] } }] });
      send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: call.args.slice(half) } }] } }] });
      send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      const half = Math.ceil(text.length / 2);
      send({ choices: [{ index: 0, delta: { role: 'assistant', content: text.slice(0, half) } }] });
      send({ choices: [{ index: 0, delta: { content: text.slice(half) } }] });
      send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    }
    send({ choices: [], usage });
    res.write('data: [DONE]\n\n');
    res.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}/v1` })));
}
