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

/** 发消息，碰到确认框时等 delayMs 再点允许（模拟用户看一眼再点） */
async function askWithApproval(text, delayMs) {
  const res = await fetch(base + '/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, Accept: 'text/event-stream' }, body: JSON.stringify({ text }) });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const evs = [];
  let buf = '', id = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const data = buf.slice(0, i).split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
      buf = buf.slice(i + 2);
      if (!data) continue;
      const ev = JSON.parse(data);
      evs.push(ev);
      if (ev.type === 'task_created') id = ev.id;
      if (ev.type === 'permission') {
        await new Promise((r) => setTimeout(r, delayMs));
        await fetch(`${base}/api/tasks/${id}/permission`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ requestId: ev.requestId, decision: 'allow' }) });
      }
    }
  }
  return evs.at(-1);
}

test('用时里记下每个工具花了多久、等确认花了多久（排查“慢在工具还是慢在模型”）', async () => {
  const quick = await askWithApproval('调用工具 mcp__weiyang__current_time {}', 0);
  assert.equal(quick.type, 'done');
  assert.equal(quick.timing.calls, 2, '用工具前后各一次模型');
  assert.deepEqual(quick.timing.tools.map((t) => [t.name, t.n]), [['current_time', 1]]);
  assert.ok(quick.timing.waitMs < 500, '查资料的工具不用等确认');
  const slow = await askWithApproval('调用工具 mcp__weiyang__remember {"text":"用户喜欢喝茶"}', 1200);
  assert.equal(slow.type, 'done');
  const r = slow.timing.tools.find((t) => t.name === 'remember');
  assert.ok(r && r.ms >= 1200, `工具用时含等确认：${JSON.stringify(slow.timing)}`);
  assert.ok(slow.timing.waitMs >= 1100, '等确认的时间单独记');
});
