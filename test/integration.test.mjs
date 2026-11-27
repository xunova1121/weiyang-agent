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
  const toolNames = (req.body.tools || []).map((t) => t.name).filter((n) => n !== 'DeferredToolPlaceholder').sort();
  assert.deepEqual(toolNames, ['Glob', 'Grep', 'Read'], '第一版只给只读工具');
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
  assert.match(bash.text, /工具失败/, '命令没有被执行');
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

test('全程没有往外连（关掉了统计、上报、自动更新）', () => {
  assert.deepEqual(proxy.attempts, [], '外连尝试：' + proxy.attempts.join(', '));
});
