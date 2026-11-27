/**
 * 回复速度：默认不深度思考（网页上能打开）；发给模型的开头（系统提示 + 工具说明）在不同对话之间完全一样，
 * 模型服务商的“重复开头缓存”才命中得了。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFakeModel } from './fakeModel.mjs';
import { createAuth } from '../server/auth.mjs';
import { createTasks } from '../server/tasks.mjs';
import { createHttpServer } from '../server/http.mjs';
import { runAgent } from '../server/agentRunner.mjs';
import { createSessions, useConfigDir } from '../server/sessions.mjs';

let model, server, base, token, cfg;
before(async () => {
  model = await startFakeModel();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-speed-'));
  fs.mkdirSync(path.join(dataDir, 'workspace'), { recursive: true });
  cfg = { dataDir, password: 'speed-password', apiKey: 'fake', baseUrl: model.url, model: 'deepseek-flash', commands: false };
  useConfigDir(cfg);
  server = createHttpServer({ auth: createAuth({ password: cfg.password, dataDir }), tasks: createTasks({ run: (o) => runAgent(cfg, o) }), cfg, sessions: createSessions(cfg) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  token = (await (await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: cfg.password }) })).json()).token;
});
after(() => { server?.close(); model?.server.close(); });

async function ask(body) {
  const res = await fetch(base + '/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, Accept: 'text/event-stream' }, body: JSON.stringify(body) });
  await res.text();
  return model.requests.filter((r) => r.url.startsWith('/v1/messages')).at(-1).body;
}

test('默认不深度思考；网页上打开“深度思考”才让模型先想再答', async () => {
  const fast = await ask({ text: '你好' });
  // 关掉思考时 SDK 不发 thinking 字段（Anthropic 接口里不发就是不思考），思考强度降到最低
  assert.ok(fast.thinking === undefined || fast.thinking.type === 'disabled', JSON.stringify(fast.thinking));
  assert.equal(fast.output_config?.effort, 'low');
  const deep = await ask({ text: '难题', think: true });
  assert.equal(deep.thinking?.type, 'adaptive');
  assert.equal(deep.output_config?.effort, 'high');
  const odd = await ask({ text: '乱填', think: 'yes' });
  assert.ok(odd.thinking === undefined || odd.thinking.type === 'disabled', '只认 true');
  assert.equal(odd.output_config?.effort, 'low');
});

test('系统提示开头没有按对话变化的标记；两段不同的新对话，发给模型的开头（系统提示 + 工具说明）一字不差', async () => {
  const a = await ask({ text: '第一段对话' });
  const b = await ask({ text: '完全不同的另一段对话，内容也不一样' });
  const sys = JSON.stringify(a.system);
  assert.doesNotMatch(sys, /x-anthropic-billing-header|cc_version/);
  assert.equal(JSON.stringify(b.system), sys, '系统提示一样');
  assert.equal(JSON.stringify(b.tools), JSON.stringify(a.tools), '工具说明一样');
});
