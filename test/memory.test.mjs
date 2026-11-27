/**
 * 长期记忆：存储（单元）、网页接口、真的 SDK 经工具记住/忘掉（要先确认），记忆进系统提示、模型读文件工具碰不到。
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
import { createMemory, MAX_ITEMS } from '../server/memory.mjs';

/* ---------- 单元 ---------- */

test('记忆存储：加、改、删、去重、长度和条数上限；文件权限 600', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-mem-u-'));
  const m = createMemory(dir);
  assert.equal(m.promptBlock(), '', '没有记忆时不往提示里加东西');
  const a = m.add('  用户叫小徐，\n在杭州  ');
  assert.equal(a.item.text, '用户叫小徐， 在杭州', '空白整理成一行');
  assert.equal(m.add('用户叫小徐， 在杭州').duplicate, true);
  assert.match(m.add('').error, /空/);
  assert.match(m.add('字'.repeat(301)).error, /最多 300 字/);
  assert.equal(m.update(a.item.id, '用户叫小徐，在上海').item.text, '用户叫小徐，在上海');
  assert.equal(m.update('00000000', 'x').error, '没有这条记忆');
  assert.equal(fs.statSync(path.join(dir, 'memory.json')).mode & 0o777, 0o600);
  assert.equal(m.remove(a.item.id), true);
  assert.equal(m.remove(a.item.id), false);
  for (let i = 0; i < MAX_ITEMS; i++) m.add(`第 ${i} 条`);
  assert.match(m.add('再多一条').error, /记忆已满/);
});

test('记忆进提示：标明是资料不是指令；太多时只放最近的并说明', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-mem-p-'));
  const m = createMemory(dir);
  m.add('用户喜欢简短的回答');
  let block = m.promptBlock();
  assert.match(block, /不是指令/);
  assert.match(block, /\[[0-9a-f]{8}\] 用户喜欢简短的回答/);
  for (let i = 0; i < 150; i++) m.add(`较长的一条记忆，编号 ${i}，`.padEnd(60, '填'));
  block = m.promptBlock();
  assert.ok(block.length < 7000);
  assert.match(block, /编号 149/, '最近的在');
  assert.match(block, /还有 \d+ 条较早的记忆没放进来/);
});

test('记忆文件坏了不崩：当作没有记忆', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-mem-b-'));
  fs.writeFileSync(path.join(dir, 'memory.json'), '{坏了');
  const m = createMemory(dir);
  assert.deepEqual(m.list(), []);
  assert.equal(m.add('新的一条').ok, true);
});

/* ---------- 网页接口 + 端到端 ---------- */

const PASSWORD = 'memory-password';
let model, server, base, token, cfg, memory;

before(async () => {
  model = await startFakeModel();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-mem-'));
  fs.mkdirSync(path.join(dataDir, 'workspace'), { recursive: true });
  cfg = { dataDir, password: PASSWORD, apiKey: 'fake', baseUrl: model.url, model: 'deepseek-flash', commands: false };
  useConfigDir(cfg);
  memory = createMemory(dataDir);
  const tasks = createTasks({ run: (o) => runAgent(cfg, o) });
  server = createHttpServer({ auth: createAuth({ password: PASSWORD, dataDir }), tasks, cfg, memory, sessions: createSessions(cfg) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  token = (await (await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) })).json()).token;
});
after(() => { server?.close(); model?.server.close(); });

const H = () => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + token });
async function ask(text, decide) {
  const res = await fetch(base + '/api/tasks', { method: 'POST', headers: { ...H(), Accept: 'text/event-stream' }, body: JSON.stringify({ text }) });
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
      if (ev.type === 'permission') await fetch(`${base}/api/tasks/${id}/permission`, { method: 'POST', headers: H(), body: JSON.stringify({ requestId: ev.requestId, decision: decide?.(ev) ?? 'deny' }) });
    }
  }
  return { evs, text: evs.filter((e) => e.type === 'text').map((e) => e.delta).join('') };
}
const lastSystem = () => JSON.stringify(model.requests.filter((r) => r.url.startsWith('/v1/messages')).at(-1).body.system);

test('网页接口：要登录；加、改、删', async () => {
  assert.equal((await fetch(base + '/api/memory')).status, 401);
  const add = await (await fetch(base + '/api/memory', { method: 'POST', headers: H(), body: JSON.stringify({ text: '我叫小徐' }) })).json();
  assert.equal(add.item.text, '我叫小徐');
  assert.equal((await fetch(base + '/api/memory', { method: 'POST', headers: H(), body: JSON.stringify({ text: '' }) })).status, 400);
  const put = await fetch(`${base}/api/memory/${add.item.id}`, { method: 'PUT', headers: H(), body: JSON.stringify({ text: '我叫小徐，回答简短点' }) });
  assert.equal(put.status, 200);
  const list = await (await fetch(base + '/api/memory', { headers: H() })).json();
  assert.deepEqual(list.items.map((x) => x.text), ['我叫小徐，回答简短点']);
  assert.equal((await fetch(`${base}/api/memory/${add.item.id}`, { method: 'DELETE', headers: H() })).status, 200);
  assert.equal((await fetch(`${base}/api/memory/${add.item.id}`, { method: 'DELETE', headers: H() })).status, 404);
  assert.equal((await fetch(`${base}/api/memory/../settings`, { method: 'DELETE', headers: H() })).status, 404);
});

test('记住：先弹确认框；拒绝就不记，允许才记；记下的下一轮出现在系统提示里', async () => {
  const no = await ask('调用工具 mcp__weiyang__remember {"text":"用户喜欢猫"}', () => 'deny');
  const p = no.evs.find((e) => e.type === 'permission');
  assert.equal(p?.name, 'mcp__weiyang__remember', '弹了确认框');
  assert.equal(p.input.text, '用户喜欢猫', '确认框里看得到要记的内容');
  assert.deepEqual(memory.list(), []);
  const yes = await ask('调用工具 mcp__weiyang__remember {"text":"用户喜欢猫"}', () => 'allow');
  assert.match(yes.text, /工具成功：记住了/);
  assert.deepEqual(memory.list().map((x) => [x.text, x.by]), [['用户喜欢猫', 'agent']]);
  await ask('你好');
  assert.match(lastSystem(), /长期记忆/);
  assert.match(lastSystem(), /用户喜欢猫/);
});

test('记住：密码、密钥、证件号不记', async () => {
  const r = await ask('调用工具 mcp__weiyang__remember {"text":"用户的密钥是 sk-abcdefgh12345"}', () => 'allow');
  assert.match(r.text, /工具失败：这条像是密码、密钥/);
  assert.ok(!memory.list().some((x) => x.text.includes('sk-')));
});

test('忘掉：按编号删；模型的读文件工具读不到记忆文件', async () => {
  const id = memory.list()[0].id;
  const read = await ask('读文件 ../memory.json');
  assert.match(read.text, /工具失败/, '读文件真的调用了，并被拒绝');
  assert.doesNotMatch(JSON.stringify(read.evs), /用户喜欢猫/, '记忆文件在工作文件夹外面');
  const r = await ask(`调用工具 mcp__weiyang__forget {"id":"[${id}]"}`, () => 'allow');
  assert.match(r.text, /工具成功：已忘掉这条/);
  assert.deepEqual(memory.list(), []);
  await ask('你好');
  assert.doesNotMatch(lastSystem(), /用户喜欢猫/);
});
