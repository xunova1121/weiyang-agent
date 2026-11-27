/**
 * HTTP 接口（手机和网页都走这里）：
 *   POST /api/login                {password} → {token}
 *   POST /api/logout
 *   POST /api/tasks                {text, sessionId?}；带 Accept: text/event-stream 时同一连接直接推事件
 *   GET  /api/tasks/:id/events?after=N   断线后按序号续接（事件流）
 *   POST /api/tasks/:id/stop
 *   POST /api/tasks/:id/permission   {requestId, decision: allow|always|deny}  回答“允许/拒绝”确认框
 *   GET  /api/sessions                对话列表
 *   GET  /api/sessions/:id            一段对话的历史
 *   POST /api/sessions/:id/rename     {title}
 *   DELETE /api/sessions/:id
 *   GET  /api/files?path=             工作文件夹里列目录
 *   GET  /api/files/download?path=    下载
 *   POST /api/files/upload?dir=&name= 上传（请求体就是文件内容，最多 20MB；重名自动加序号）
 *   DELETE /api/files?path=
 *   GET  /api/health                  不用登录，只回 {ok:true}
 *   GET  /api/settings                设置（密钥只显示尾号）；GET /api/models 可选的模型
 *   POST /api/settings/providers      {id?, name, format, baseUrl, apiKey?, models}  加或改服务商（apiKey 留空=不变）
 *   DELETE /api/settings/providers/:id
 *   POST /api/settings/default        {model}
 *   POST /api/settings/services/:id   {key}（key 为 null 表示清除）
 *   GET  /api/memory                  长期记忆；POST {text} 加一条；PUT /api/memory/:id {text} 改；DELETE /api/memory/:id 删
 *   GET  /api/status
 * 其余 GET 请求返回 web/ 下的静态网页。除登录和网页外都要 Authorization: Bearer <令牌>。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_UPLOAD } from './files.mjs';

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
const MAX_BODY = 256 * 1024;
const PING_MS = 20_000;

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw Object.assign(new Error('内容太长'), { status: 413 });
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('请求格式不对'), { status: 400 }); }
}

function bearer(req) {
  const h = String(req.headers.authorization || '');
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

/** 把任务事件推成 SSE：先补 after 之后的，再实时推；每 20 秒一次心跳，客户端据此判断连接没“半死” */
function streamTask(req, res, tasks, id, after, first = null) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
  res.socket?.setNoDelay?.(true);
  res.flushHeaders?.();
  if (first) res.write(`data: ${JSON.stringify(first)}\n\n`);
  let closed = false;
  const ping = setInterval(() => res.write(': ping\n\n'), PING_MS);
  let unsubscribe = null; // 补发旧事件时可能当场就结束，所以先声明再赋值
  const finish = () => { if (closed) return; closed = true; clearInterval(ping); unsubscribe?.(); res.end(); };
  unsubscribe = tasks.subscribe(id, after, (ev) => {
    if (closed) return;
    if (!ev) return finish();
    res.write(`id: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`);
  });
  req.on('close', () => { closed = true; clearInterval(ping); unsubscribe?.(); });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.resolve(WEB_DIR, rel);
  if (!file.startsWith(WEB_DIR + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return json(res, 404, { error: '找不到' });
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
  fs.createReadStream(file).pipe(res);
}

/** 下载文件名：中文名用 RFC 5987 写法，老浏览器看到的是去掉非 ASCII 的名字 */
function attachment(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export function createHttpServer({ auth, tasks, cfg, sessions, files, settings = null, memory = null }) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    const { pathname } = url;
    try {
      if (pathname === '/api/login' && req.method === 'POST') {
        const body = await readJson(req);
        const r = auth.login(req.socket.remoteAddress || '', body.password);
        return r.ok ? json(res, 200, { token: r.token }) : json(res, r.status, { error: r.error });
      }
      // 健康检查（安装脚本、监控用）：不用登录，只说活着没有，不透露任何配置
      if (pathname === '/api/health' && req.method === 'GET') return json(res, 200, { ok: true, service: 'weiyang-agent' });
      if (pathname.startsWith('/api/')) {
        const token = bearer(req);
        if (!auth.check(token)) return json(res, 401, { error: '登录已失效，请重新登录' });
        if (pathname === '/api/logout' && req.method === 'POST') { auth.logout(token); return json(res, 200, { ok: true }); }
        if (pathname === '/api/status' && req.method === 'GET') {
          const running = tasks.running && tasks.get(tasks.running);
          return json(res, 200, { ok: true, model: settings ? settings.defaultModel() : cfg.model, commands: Boolean(cfg.commands), running: running ? { id: running.id, sessionId: running.sessionId, text: running.text } : null });
        }
        if (pathname === '/api/sessions' && req.method === 'GET') return json(res, 200, await sessions.list());
        if (memory && (pathname === '/api/memory' || pathname.startsWith('/api/memory/'))) {
          if (pathname === '/api/memory' && req.method === 'GET') return json(res, 200, { items: memory.list() });
          if (pathname === '/api/memory' && req.method === 'POST') { const r = memory.add((await readJson(req)).text); return r.error ? json(res, 400, r) : json(res, 200, r); }
          const mm = pathname.match(/^\/api\/memory\/([0-9a-f]{8})$/);
          if (mm && req.method === 'PUT') { const r = memory.update(mm[1], (await readJson(req)).text); return r.error ? json(res, r.error === '没有这条记忆' ? 404 : 400, r) : json(res, 200, r); }
          if (mm && req.method === 'DELETE') return memory.remove(mm[1]) ? json(res, 200, { ok: true }) : json(res, 404, { error: '没有这条记忆' });
          return json(res, 404, { error: '没有这个接口' });
        }
        if (settings && pathname.startsWith('/api/settings') || settings && pathname === '/api/models') {
          if (pathname === '/api/models' && req.method === 'GET') return json(res, 200, { models: settings.models().map(({ ref, provider, model }) => ({ ref, provider, model })), default: settings.defaultModel() });
          if (pathname === '/api/settings' && req.method === 'GET') return json(res, 200, settings.publicView());
          if (pathname === '/api/settings/providers' && req.method === 'POST') { const r = settings.saveProvider(await readJson(req)); return r.error ? json(res, 400, r) : json(res, 200, r); }
          const pm = pathname.match(/^\/api\/settings\/providers\/([\w-]{1,40})$/);
          if (pm && req.method === 'DELETE') return settings.removeProvider(pm[1]) ? json(res, 200, { ok: true }) : json(res, 404, { error: '没有这个服务商（服务器配置的 DeepSeek 不能删）' });
          if (pathname === '/api/settings/default' && req.method === 'POST') return settings.setDefault(String((await readJson(req)).model ?? '')) ? json(res, 200, { ok: true }) : json(res, 400, { error: '没有这个模型' });
          const sm2 = pathname.match(/^\/api\/settings\/services\/([\w-]{1,40})$/);
          if (sm2 && req.method === 'POST') { const r = settings.setService(sm2[1], (await readJson(req)).key); return r.error ? json(res, 400, r) : json(res, 200, r); }
        }
        if (pathname === '/api/files' && req.method === 'GET') {
          const r = files.list(url.searchParams.get('path') || '');
          return r ? json(res, 200, r) : json(res, 404, { error: '没有这个文件夹' });
        }
        if (pathname === '/api/files' && req.method === 'DELETE') {
          return files.remove(url.searchParams.get('path') || '') ? json(res, 200, { ok: true }) : json(res, 404, { error: '没有这个文件' });
        }
        if (pathname === '/api/files/download' && req.method === 'GET') {
          const f = files.file(url.searchParams.get('path') || '');
          if (!f) return json(res, 404, { error: '没有这个文件' });
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': f.size, 'Content-Disposition': attachment(f.name), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
          return fs.createReadStream(f.abs).pipe(res);
        }
        if (pathname === '/api/files/upload' && req.method === 'POST') {
          if (Number(req.headers['content-length'] || 0) > MAX_UPLOAD) return json(res, 413, { error: `文件太大（最多 ${MAX_UPLOAD / 1024 / 1024}MB）` });
          const r = await files.save(url.searchParams.get('dir') || '', url.searchParams.get('name') || '', req);
          return r.error ? json(res, r.status, { error: r.error }) : json(res, 200, r);
        }
        const sm = pathname.match(/^\/api\/sessions\/([\w-]+)(\/rename)?$/);
        if (sm) {
          const [, id, rename] = sm;
          if (!rename && req.method === 'GET') { const s = await sessions.get(id); return s ? json(res, 200, s) : json(res, 404, { error: '找不到这段对话' }); }
          if (rename && req.method === 'POST') return (await sessions.rename(id, (await readJson(req)).title ?? '')) ? json(res, 200, { ok: true }) : json(res, 404, { error: '找不到这段对话' });
          if (!rename && req.method === 'DELETE') {
            if (tasks.running && tasks.get(tasks.running)?.sessionId === id) return json(res, 409, { error: '这段对话正在回复，先停止再删' });
            return (await sessions.remove(id)) ? json(res, 200, { ok: true }) : json(res, 404, { error: '找不到这段对话' });
          }
        }
        if (pathname === '/api/tasks' && req.method === 'POST') {
          const body = await readJson(req);
          const text = String(body.text ?? '').trim();
          if (!text) return json(res, 400, { error: '消息是空的' });
          if (text.length > 20_000) return json(res, 413, { error: '消息太长（最多 2 万字）' });
          const sessionId = typeof body.sessionId === 'string' && /^[\w-]{1,80}$/.test(body.sessionId) ? body.sessionId : null;
          // 选的模型（provider/model）；不认识的就用默认模型，由 settings.resolve 兜底
          const model = typeof body.model === 'string' && body.model.length <= 160 ? body.model : null;
          const r = tasks.start({ text, sessionId, model });
          if (r.error) return json(res, r.status, { error: r.error });
          if (/text\/event-stream/.test(String(req.headers.accept || ''))) return streamTask(req, res, tasks, r.task.id, 0, { type: 'task_created', id: r.task.id });
          return json(res, 200, r.task);
        }
        const m = pathname.match(/^\/api\/tasks\/([\w-]+)\/(events|stop|permission)$/);
        if (m) {
          if (!tasks.get(m[1])) return json(res, 404, { error: '找不到这个任务（可能服务器重启过）' });
          if (m[2] === 'events' && req.method === 'GET') return streamTask(req, res, tasks, m[1], Math.max(0, Number(url.searchParams.get('after')) || 0));
          if (m[2] === 'stop' && req.method === 'POST') { tasks.stop(m[1]); return json(res, 200, { ok: true }); }
          if (m[2] === 'permission' && req.method === 'POST') {
            const body = await readJson(req);
            return tasks.answer(m[1], String(body.requestId ?? ''), String(body.decision ?? ''))
              ? json(res, 200, { ok: true })
              : json(res, 409, { error: '这个确认已经回答过或已过期' });
          }
        }
        return json(res, 404, { error: '没有这个接口' });
      }
      if (req.method === 'GET') return serveStatic(req, res, pathname);
      return json(res, 405, { error: '不支持' });
    } catch (e) {
      if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : '服务器出错了' });
      else res.end();
    }
  });
}
