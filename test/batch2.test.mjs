/**
 * 第二批端到端：对话列表/历史/改名/删除，“允许/拒绝”确认框，沙箱里跑命令。
 * 真的 Agent SDK + 假模型 + 真的 HTTP 服务；沙箱部分需要本机有 bubblewrap，没有时跳过并说明原因。
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
import { blockedHint, runAgent, sandboxStatus } from '../server/agentRunner.mjs';
import { createSessions, useConfigDir } from '../server/sessions.mjs';

const PASSWORD = 'batch2-password';
const KEY = 'THE-REAL-LOOKING-KEY';
const SANDBOX = sandboxStatus();
const HAS_SANDBOX = SANDBOX === 'ok';
const SKIP_WHY = SANDBOX === 'missing' ? '本机沙箱没装齐（apt install bubblewrap socat）' : blockedHint();
let model, proxy, server, base, cfg, token, ws;

before(async () => {
  model = await startFakeModel();
  proxy = await startLoggingProxy();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-b2-'));
  cfg = { dataDir, password: PASSWORD, apiKey: KEY, baseUrl: model.url, model: 'deepseek-flash', commands: HAS_SANDBOX };
  ws = path.join(dataDir, 'workspace');
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ apiKey: 'SECRET-IN-CONFIG' }));
  useConfigDir(cfg);
  const extraEnv = { HTTPS_PROXY: proxy.url, HTTP_PROXY: proxy.url, https_proxy: proxy.url, http_proxy: proxy.url, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
  const tasks = createTasks({ run: (o) => runAgent(cfg, { ...o, extraEnv }) });
  server = createHttpServer({ auth: createAuth({ password: PASSWORD, dataDir }), tasks, cfg, sessions: createSessions(cfg) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  token = (await (await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) })).json()).token;
});
after(() => { server?.close(); model?.server.close(); proxy?.server.close(); });

const H = () => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + token });
const call = (p, { method = 'GET', body } = {}) => fetch(base + p, { method, headers: H(), body: body && JSON.stringify(body) });

/** 发消息并边收边处理：碰到确认框时按 decide(ev) 回答 */
async function ask(text, { sessionId, decide } = {}) {
  const res = await fetch(base + '/api/tasks', { method: 'POST', headers: { ...H(), Accept: 'text/event-stream' }, body: JSON.stringify({ text, sessionId }) });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const evs = [];
  let buf = '';
  let taskId = null;
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
      if (ev.type === 'task_created') taskId = ev.id;
      if (ev.type === 'permission' && decide) {
        const decision = decide(ev);
        if (decision === 'stop') await call(`/api/tasks/${taskId}/stop`, { method: 'POST' });
        else assert.equal((await call(`/api/tasks/${taskId}/permission`, { method: 'POST', body: { requestId: ev.requestId, decision } })).status, 200);
      }
    }
  }
  return { evs, taskId, end: evs.at(-1), text: evs.filter((e) => e.type === 'text').map((e) => e.delta).join(''), sessionId: evs.find((e) => e.type === 'session')?.sessionId };
}

test('改文件：弹确认框；允许才写，拒绝不写；写到工作文件夹外面直接拒绝、不弹框', async () => {
  const yes = await ask('写文件 hello.txt 你好世界', { decide: () => 'allow' });
  const p = yes.evs.find((e) => e.type === 'permission');
  assert.equal(p?.name, 'Write');
  assert.equal(p.input.file_path, 'hello.txt');
  assert.ok(yes.evs.some((e) => e.type === 'permission_answered' && e.decision === 'allow'));
  assert.equal(yes.end.type, 'done');
  assert.equal(fs.readFileSync(path.join(ws, 'hello.txt'), 'utf8'), '你好世界');

  const no = await ask('写文件 nope.txt 不该写', { decide: () => 'deny' });
  assert.equal(no.end.type, 'done');
  assert.match(no.text, /工具失败/);
  assert.equal(fs.existsSync(path.join(ws, 'nope.txt')), false, '拒绝后没有写');

  const out = await ask('写文件 ../escape.txt 越界', { decide: () => 'allow' });
  assert.ok(!out.evs.some((e) => e.type === 'permission'), '越界的不问，直接拒');
  assert.match(out.text, /工具失败/);
  assert.equal(fs.existsSync(path.join(cfg.dataDir, 'escape.txt')), false);
});

test('确认框等待中点停止：任务停下，确认按拒绝处理，文件没写', async () => {
  const r = await ask('写文件 stopped.txt 不该写', { decide: () => 'stop' });
  assert.equal(r.end.type, 'stopped');
  assert.ok(r.evs.some((e) => e.type === 'permission_answered' && e.decision === 'deny'));
  assert.equal(fs.existsSync(path.join(ws, 'stopped.txt')), false);
  // 已回答过的确认不能再答
  const p = r.evs.find((e) => e.type === 'permission');
  assert.equal((await call(`/api/tasks/${r.taskId}/permission`, { method: 'POST', body: { requestId: p.requestId, decision: 'allow' } })).status, 409);
});

test('对话列表：刚聊的出现在列表里；能读出历史（含工具步骤）；能改名；能删除', async () => {
  const first = await ask('你好，列表测试');
  await ask('第二句', { sessionId: first.sessionId });
  const list = await (await call('/api/sessions')).json();
  const mine = list.find((s) => s.id === first.sessionId);
  assert.ok(mine, '列表里有刚才的对话');
  const hist = await (await call(`/api/sessions/${first.sessionId}`)).json();
  assert.deepEqual(hist.items.filter((i) => i.role === 'user').map((i) => i.text), ['你好，列表测试', '第二句']);
  assert.ok(hist.items.some((i) => i.role === 'agent' && i.text.includes('收到：第二句')));
  const withTool = await (await call(`/api/sessions/${list.find((s) => s.title.includes('hello.txt'))?.id ?? list.at(-1).id}`)).json();
  assert.ok(withTool.items.some((i) => i.role === 'tool' && i.name === 'Write'), '历史里能看到工具步骤');
  assert.equal((await call(`/api/sessions/${first.sessionId}/rename`, { method: 'POST', body: { title: '改过的名字' } })).status, 200);
  assert.equal((await (await call('/api/sessions')).json()).find((s) => s.id === first.sessionId).title, '改过的名字');
  assert.equal((await call(`/api/sessions/${first.sessionId}`, { method: 'DELETE' })).status, 200);
  assert.ok(!(await (await call('/api/sessions')).json()).some((s) => s.id === first.sessionId), '删除后不在列表里');
  assert.equal((await call(`/api/sessions/${first.sessionId}`)).status, 404);
  assert.equal((await call('/api/sessions/not-a-real-id')).status, 404, '乱填的编号不出错');
});

test('跑命令（沙箱）：要确认；只能写工作文件夹；看不到配置和密钥；不能联网', { skip: HAS_SANDBOX ? false : SKIP_WHY }, async () => {
  const run = async (command) => {
    const r = await ask('跑命令 ' + command, { decide: () => 'allow' });
    assert.ok(r.evs.some((e) => e.type === 'permission' && e.name === 'Bash' && e.input.command === command), '跑命令前弹了确认框');
    return r.text;
  };
  assert.match(await run('echo ok > made.txt && cat made.txt'), /工具成功：ok/);
  assert.equal(fs.readFileSync(path.join(ws, 'made.txt'), 'utf8').trim(), 'ok');
  assert.doesNotMatch(await run('cat ../config.json'), /SECRET-IN-CONFIG/);
  await run('touch ../escaped.txt');
  assert.equal(fs.existsSync(path.join(cfg.dataDir, 'escaped.txt')), false, '工作文件夹外面没写成');
  assert.doesNotMatch(await run('env; ls -a ../home 2>&1'), new RegExp(KEY), '命令看不到模型密钥');
  assert.match(await run(`curl -s -m 3 ${model.url}/v1/x || echo NET_BLOCKED`), /NET_BLOCKED/, '不能联网');
  const denied = await ask('跑命令 echo should-not-run > denied.txt', { decide: () => 'deny' });
  assert.match(denied.text, /工具失败/);
  assert.equal(fs.existsSync(path.join(ws, 'denied.txt')), false, '拒绝后命令没跑');
});

test('要求沙箱的环境里（GitHub 自动测试装了 AppArmor 规则）沙箱必须真能用，不能悄悄跳过', { skip: process.env.REQUIRE_SANDBOX === '1' ? false : '没要求' }, () => {
  assert.equal(SANDBOX, 'ok', SKIP_WHY);
});

test('“本次对话都允许”：同一段对话里同一类操作都不再问（换个文件名、换条命令也不问）；只点“允许”的不算；开新对话重新问', async () => {
  const first = await ask('写文件 grant-1.txt 一', { decide: () => 'allow' });
  const again = await ask('写文件 grant-2.txt 二', { sessionId: first.sessionId, decide: () => 'always' });
  assert.ok(again.evs.some((e) => e.type === 'permission'), '只点过“允许”的，下次照样问');
  const third = await ask('写文件 grant-3.txt 三', { sessionId: first.sessionId, decide: () => 'deny' });
  assert.ok(!third.evs.some((e) => e.type === 'permission'), '点过“本次对话都允许”后，换个文件也不再问');
  assert.equal(fs.readFileSync(path.join(ws, 'grant-3.txt'), 'utf8'), '三');
  const other = await ask('写文件 grant-4.txt 四', { decide: () => 'deny' });
  assert.ok(other.evs.some((e) => e.type === 'permission'), '新对话重新问');
  assert.ok(!fs.existsSync(path.join(ws, 'grant-4.txt')));
  if (!HAS_SANDBOX) return;
  const cmd1 = await ask('跑命令 echo a > grant-a.txt', { sessionId: first.sessionId, decide: () => 'always' });
  assert.ok(cmd1.evs.some((e) => e.type === 'permission' && e.name === 'Bash'), '跑命令是另一类，第一次照样问');
  const cmd2 = await ask('跑命令 echo b > grant-b.txt', { sessionId: first.sessionId, decide: () => 'deny' });
  assert.ok(!cmd2.evs.some((e) => e.type === 'permission'), '换了一条命令也不再问');
  assert.equal(fs.readFileSync(path.join(ws, 'grant-b.txt'), 'utf8').trim(), 'b');
});

test('全程没有往外连', () => {
  assert.deepEqual(proxy.attempts, [], '外连尝试：' + proxy.attempts.join(', '));
});
