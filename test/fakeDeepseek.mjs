/**
 * 假 DeepSeek（识图、看文件、语音）：返回格式照原未央 src/llm/deepseekSuite.js 的测试；会真的解析上传的表单。
 */
import http from 'node:http';

/** 0.2 秒的静音 wav（浏览器能真的播放） */
export function silentWav(rate = 16000, seconds = 0.2) {
  const n = Math.round(rate * seconds);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8, 'latin1'); b.write('fmt ', 12, 'latin1');
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36, 'latin1'); b.writeUInt32LE(n * 2, 40);
  return b;
}

/** 假 DeepSeek：记录请求，按原未央测试里的返回格式回复 */
export async function startFakeDeepseek({ key = 'sk-media-test' } = {}) {
  const requests = [];
  const files = new Map();
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const form = /multipart/.test(req.headers['content-type'] || '') ? await new Response(raw, { headers: { 'content-type': req.headers['content-type'] } }).formData() : null;
    const body = !form && raw.length && /json/.test(req.headers['content-type'] || '') ? JSON.parse(raw) : null;
    const r = { method: req.method, url: req.url, auth: req.headers.authorization, form, body, raw };
    requests.push(r);
    const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (req.headers.authorization !== 'Bearer ' + key) return send(401, { error: { message: 'Authentication Fails, Your api key: ****oops is invalid', code: 'invalid_request_error' } });
    if (req.url === '/v1/tools/ocr') {
      const file = form.get('file');
      r.fileText = Buffer.from(await file.arrayBuffer()).toString();
      return send(200, { page_count: 2, pages: [{ index: 1, text: '第二页：合计 128 元', finish_reason: 'stop' }, { index: 0, text: '第一页：发票', finish_reason: 'stop' }] });
    }
    if (req.url === '/v1/files' && req.method === 'POST') { const id = 'file-abc123'; files.set(id, form.get('file').name); return send(200, { id }); }
    if (req.url.startsWith('/v1/files/') && req.method === 'DELETE') { files.delete(req.url.split('/').pop()); return send(200, { deleted: true }); }
    if (req.url === '/v1/chat/completions') {
      if (String(body.messages.at(-1).content.at(-1).text).includes('审核')) return send(200, { choices: [{ finish_reason: 'content_filter', message: { content: '' } }] });
      return send(200, { choices: [{ finish_reason: 'stop', message: { content: `图里是一只猫（文件 ${body.messages[1].content[0].file_id}）` } }] });
    }
    if (req.url === '/v1/tools/asr') { r.audioName = form.get('file').name; r.audioSize = form.get('file').size; return send(200, { text: ' 今天天气怎么样 ' }); }
    if (req.url === '/v1/tools/tts') {
      res.writeHead(200, { 'content-type': 'audio/wav' }); return res.end(silentWav());
    }
    send(404, { error: { message: 'no route' } });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, requests, files, api: `http://127.0.0.1:${server.address().port}/v1` };
}

