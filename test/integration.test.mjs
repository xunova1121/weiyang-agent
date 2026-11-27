/**
 * 端到端：真的 Agent SDK + 假模型 + 真的 HTTP 服务。
 * 核对：能登录、发消息逐段收到回复、接着上一轮对话、读工作文件夹里的文件、
 * 读不到外面的配置（含密钥）、不能跑命令、断线按序号续接，以及全程没有往外连（比如 Anthropic 的服务器）。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFakeModel, startLoggingProxy } from './fakeModel.mjs';
import { createAuth } from '../server/auth.mjs';
import { createTasks } from '../server/tasks.mjs';
import { createHttpServer } from '../server/http.mjs';
import { runAgent } from '../server/agentRunner.mjs';

const PASSWORD = 'test-password-123';
let model, proxy, server, base, cfg, token;

before(async () => {
  model = await startFakeModel();
  proxy = await startLoggingProxy();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-it-'));
  cfg = { dataDir, password: PASSWORD, apiKey: 'fake-key-not-real', baseUrl: model.url, model: 'deepseek-flash' };
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ apiKey: 'SECRET-IN-CONFIG' }));
  fs.mkdirSync(path.join(dataDir, 'workspace'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'workspace', 'note.txt'), '工作文件夹里的笔记');
  // 所有非本机的外连都走记录代理（只记录、一律拒绝），本机的假模型直连
  const extraEnv = { HTTPS_PROXY: proxy.url, HTTP_PROXY: proxy.url, https_proxy: proxy.url, http_proxy: proxy.url, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
  const auth = createAuth({ password: PASSWORD, dataDir });
  const tasks = createTasks({ run: (o) => runAgent(cfg, { ...o, extraEnv }) });
  server = createHttpServer({ auth, tasks, cfg });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server?.close(); model?.server.close(); proxy?.server.close(); });

async function post(p, body, headers = {}) {
  return fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token && { Authorization: 'Bearer ' + token }), ...headers }, body: JSON.stringify(body) });
}

async function events(res) {
  const text = await res.text();
  return text.split('\n\n').map((f) => f.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('')).filter(Boolean).map((d) => JSON.parse(d));
}

async function ask(text, sessionId) {
  const res = await post('/api/tasks', { text, sessionId }, { Accept: 'text/event-stream' });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const evs = await events(res);
  const end = evs.at(-1);
  return { evs, end, text: evs.filter((e) => e.type === 'text').map((e) => e.delta).join(''), sessionId: evs.find((e) => e.type === 'session')?.sessionId };
}

test('没登录不能用；错密码不给令牌；对的密码拿到令牌', async () => {
  assert.equal((await post('/api/tasks', { text: 'hi' })).status, 401);
  assert.equal((await post('/api/login', { password: 'nope' })).status, 401);
  const r = await post('/api/login', { password: PASSWORD });
  token = (await r.json()).token;
  assert.ok(token);
});

test('发消息：同一连接先回任务编号，再逐段推回复；模型请求带的是配置的密钥和型号', async () => {
  const first = await ask('你好');
  assert.equal(first.evs[0].type, 'task_created');
  assert.equal(first.end.type, 'done', JSON.stringify(first.end));
  assert.equal(first.text, '收到：你好（历史 1 条）');
  assert.ok(first.evs.filter((e) => e.type === 'text').length >= 2, '逐段推送');
  assert.ok(first.sessionId);
  const req = model.requests.find((r) => r.url.startsWith('/v1/messages') && !r.url.includes('count_tokens'));
  assert.equal(req.auth, 'Bearer fake-key-not-real');
  assert.equal(req.body.model, 'deepseek-flash');
  // DeferredToolPlaceholder 是 SDK 自带的内部占位项（工具延迟加载用），不是能读写的工具
  const allNames = (req.body.tools || []).map((t) => t.name).filter((n) => n !== 'DeferredToolPlaceholder');
  // 自定义工具（mcp__weiyang__…）另外核对；内置工具仍然必须正好是这几样
  const toolNames = allNames.filter((n) => !n.startsWith('mcp__')).sort();
  assert.deepEqual(allNames.filter((n) => n.startsWith('mcp__')).sort(), ['mcp__weiyang__ask_file', 'mcp__weiyang__create_document', 'mcp__weiyang__current_time', 'mcp__weiyang__deepseek_search', 'mcp__weiyang__forget', 'mcp__weiyang__read_document', 'mcp__weiyang__read_image', 'mcp__weiyang__read_url', 'mcp__weiyang__remember'], '自定义工具正好是登记过的这些');
  // 第二批起：只读 + 改文件（改文件每次要确认）；没开放跑命令时不给 Bash
  assert.deepEqual(toolNames, ['Edit', 'Glob', 'Grep', 'Read', 'Write'], '没开放跑命令时只给读写文件的工具');
  // 接着上一轮
  const second = await ask('再说一句', first.sessionId);
  assert.equal(second.end.type, 'done');
  assert.equal(second.text, '收到：再说一句（历史 2 条）', '带上了上一轮的历史');
  assert.equal(second.sessionId, first.sessionId);
});

test('工具：能读工作文件夹里的文件；读不到外面的配置（含密钥）；不能跑命令', async () => {
  const inside = await ask('读文件 note.txt');
  assert.equal(inside.end.type, 'done');
  assert.match(inside.text, /工具成功：.*工作文件夹里的笔记/);
  const outside = await ask('读文件 ../config.json');
  assert.equal(outside.end.type, 'done');
  assert.match(outside.text, /工具失败/);
  assert.doesNotMatch(JSON.stringify(outside.evs), /SECRET-IN-CONFIG/, '密钥没有被读出来');
  const absolute = await ask(`读文件 ${path.join(cfg.dataDir, 'config.json')}`);
  assert.doesNotMatch(JSON.stringify(absolute.evs), /SECRET-IN-CONFIG/);
  const bash = await ask('跑命令');
  assert.equal(bash.end.type, 'done');
  assert.match(bash.text, /工具失败/, '没开放跑命令时命令没有被执行');
  assert.ok(!bash.evs.some((e) => e.type === 'permission'), '没开放的工具不弹确认框，直接拒绝');
});

test('断线续接：从中途的序号接着收，只补后面的事件', async () => {
  const r = await post('/api/tasks', { text: '续接测试' });
  const { id } = await r.json();
  let res;
  for (let i = 0; i < 50; i++) {
    res = await fetch(`${base}/api/tasks/${id}/events?after=0`, { headers: { Authorization: 'Bearer ' + token } });
    const all = await events(res);
    if (all.at(-1)?.type === 'done') {
      const part = await events(await fetch(`${base}/api/tasks/${id}/events?after=2`, { headers: { Authorization: 'Bearer ' + token } }));
      assert.ok(part.every((e) => e.seq > 2));
      assert.equal(part.at(-1).type, 'done');
      assert.equal(part.length, all.length - 2);
      return;
    }
    await new Promise((s) => setTimeout(s, 100));
  }
  assert.fail('任务没有完成');
});

test('发给模型的每个请求都用配置的型号（包括 SDK 的后台小任务），不会发去 DeepSeek 不认识的 Claude 型号', () => {
  const models = [...new Set(model.requests.filter((r) => r.url.startsWith('/v1/messages')).map((r) => r.body.model))];
  assert.deepEqual(models, ['deepseek-flash']);
});

test('健康检查不用登录，也不透露型号、地址等配置', async () => {
  const r = await fetch(base + '/api/health');
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.deepEqual(JSON.parse(text), { ok: true, service: 'weiyang-agent' });
  assert.doesNotMatch(text, /deepseek|127\.0\.0\.1|fake-key/);
});

test('模型接口出错时不会悄悄卡住：网页收到“正在重试”的提示，点停止能停下', async () => {
  const r = await post('/api/tasks', { text: '模型出错测试' });
  const { id } = await r.json();
  const res = await fetch(`${base}/api/tasks/${id}/events?after=0`, { headers: { Authorization: 'Bearer ' + token } });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let notice = null;
  const deadline = Date.now() + 60_000;
  while (!notice && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const m = buf.match(/"type":"notice","text":"([^"]+)"/);
    if (m) notice = m[1];
  }
  assert.match(notice || '', /模型那边出错（状态码 500）.*重试/);
  await post(`/api/tasks/${id}/stop`, {});
  for (;;) { const { done, value } = await reader.read(); if (done) break; buf += dec.decode(value); }
  assert.match(buf, /"type":"stopped"/);
});

test('密钥不对：马上停下并说清楚，不重试几分钟（用户在服务器上遇到过“一直卡着”）', async () => {
  const t0 = Date.now();
  const r = await ask('密钥错测试');
  assert.ok(Date.now() - t0 < 30_000, `用了 ${Math.round((Date.now() - t0) / 1000)} 秒`);
  assert.equal(r.end.type, 'error');
  assert.match(r.end.error, /密钥不对（401）/);
});

test('全程没有往外连（关掉了统计、上报、自动更新）', () => {
  assert.deepEqual(proxy.attempts, [], '外连尝试：' + proxy.attempts.join(', '));
});
