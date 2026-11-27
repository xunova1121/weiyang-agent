/**
 * 自定义工具底座：真的 SDK + 假模型。核对模型能看到并调用工具、查资料类直接放行、改东西类先问用户、
 * 出错只给模型一句人话、工具碰文件也只许在工作文件夹里。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { startFakeModel } from './fakeModel.mjs';
import { createAuth } from '../server/auth.mjs';
import { createTasks } from '../server/tasks.mjs';
import { createHttpServer } from '../server/http.mjs';
import { runAgent } from '../server/agentRunner.mjs';
import { createSessions, useConfigDir } from '../server/sessions.mjs';
import { buildToolServer, workspaceResolver } from '../server/tools/registry.mjs';
import * as basic from '../server/tools/basic.mjs';

const PASSWORD = 'tools-password';
let model, server, base, token, cfg, ws;

// 测试用的模块：一个改文件的工具（要确认）、一个必定出错的工具、一个想越界读文件的工具
const testModule = {
  tools: (ctx) => [
    { name: 'save_note', description: '把一句话存进 notes.txt', schema: { text: z.string() }, risk: 'write',
      run: async ({ text }) => { fs.writeFileSync(ctx.resolve('notes.txt'), text); return '已存好'; } },
    { name: 'always_fails', description: '测试：必定出错', schema: {}, risk: 'read',
      run: async () => { throw new Error('内部细节 /secret/path token=abc'); } },
    { name: 'read_any', description: '测试：读任意路径', schema: { p: z.string() }, risk: 'read',
      run: async ({ p }) => fs.readFileSync(ctx.resolve(p), 'utf8') }
  ]
};

before(async () => {
  model = await startFakeModel();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-tools-'));
  ws = path.join(dataDir, 'workspace');
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.json'), '{"apiKey":"SECRET-IN-CONFIG"}');
  cfg = { dataDir, password: PASSWORD, apiKey: 'fake', baseUrl: model.url, model: 'deepseek-flash', commands: false };
  useConfigDir(cfg);
  const tasks = createTasks({ run: (o) => runAgent(cfg, { ...o, toolModules: [basic, testModule] }) });
  server = createHttpServer({ auth: createAuth({ password: PASSWORD, dataDir }), tasks, cfg, sessions: createSessions(cfg) });
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

test('模型能看到自定义工具（常驻，不藏在工具搜索后面）', async () => {
  await ask('你好');
  const req = model.requests.find((r) => r.url.startsWith('/v1/messages'));
  const names = (req.body.tools || []).map((t) => t.name);
  for (const n of ['mcp__weiyang__current_time', 'mcp__weiyang__save_note']) assert.ok(names.includes(n), `模型请求里有 ${n}：${names.join(',')}`);
  const t = req.body.tools.find((x) => x.name === 'mcp__weiyang__current_time');
  assert.notEqual(t.defer_loading, true, '不延迟加载');
});

test('查资料类工具直接放行：现在几点（北京时间）', async () => {
  const r = await ask('调用工具 mcp__weiyang__current_time {}');
  assert.ok(!r.evs.some((e) => e.type === 'permission'), '不弹确认框');
  assert.match(r.text, /工具成功：现在是北京时间 \d{4}年\d{1,2}月\d{1,2}日/);
});

test('改东西类工具先问用户：允许才做，拒绝不做', async () => {
  const yes = await ask('调用工具 mcp__weiyang__save_note {"text":"记一下"}', () => 'allow');
  const p = yes.evs.find((e) => e.type === 'permission');
  assert.equal(p?.name, 'mcp__weiyang__save_note');
  assert.equal(fs.readFileSync(path.join(ws, 'notes.txt'), 'utf8'), '记一下');
  fs.rmSync(path.join(ws, 'notes.txt'));
  const no = await ask('调用工具 mcp__weiyang__save_note {"text":"不该存"}', () => 'deny');
  assert.match(no.text, /工具失败/);
  assert.equal(fs.existsSync(path.join(ws, 'notes.txt')), false);
});

test('工具出错：模型只拿到一句人话，不带内部细节', async () => {
  const r = await ask('调用工具 mcp__weiyang__always_fails {}');
  assert.match(r.text, /工具失败：工具“always_fails”出错了/);
  const sent = JSON.stringify(model.requests.at(-1).body.messages);
  assert.match(sent, /always_fails/);
  assert.doesNotMatch(sent, /at .*registry\.mjs/, '没把出错位置（堆栈）交给模型');
  assert.doesNotMatch(sent, /secret\/path|token=abc|内部细节/, '没把原始报错（可能带路径、密钥）交给模型');
});

test('工具碰文件也只许在工作文件夹里', async () => {
  const r = await ask('调用工具 mcp__weiyang__read_any {"p":"../config.json"}');
  assert.match(r.text, /工具失败：只能访问工作文件夹里的文件/);
  assert.doesNotMatch(JSON.stringify(r.evs), /SECRET-IN-CONFIG/);
});

test('工具定义写错（名字不合规、重名、没写 risk）启动时就报错', () => {
  const ctx = { resolve: workspaceResolver(ws) };
  const ok = { name: 'a_tool', description: 'x', schema: {}, risk: 'read', run: async () => '' };
  assert.throws(() => buildToolServer([{ ...ok, name: 'Bad-Name' }], ctx), /工具名/);
  assert.throws(() => buildToolServer([ok, ok], ctx), /重复/);
  assert.throws(() => buildToolServer([{ ...ok, risk: undefined }], ctx), /risk/);
  const box = buildToolServer([ok], ctx);
  assert.equal(box.riskOf('mcp__weiyang__a_tool'), 'read');
  assert.equal(box.riskOf('Bash'), null);
});

test('北京时间格式', () => {
  assert.equal(basic.beijingNow(new Date('2026-01-01T00:30:00Z')), '2026年1月1日星期四 08:30');
});
