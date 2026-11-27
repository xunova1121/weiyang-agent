/**
 * 跨对话记忆：对话摘要（停下够久 / 转去别的对话时写；新对话开头带上；能删；删对话时一起删）
 * 和翻旧对话（search_conversations：按关键词找原话，不含当前这段）。
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
import { createEpisodes, modelSummarizer, transcriptText, withEpisodes } from '../server/episodes.mjs';
import { exchanges, queryTerms } from '../server/tools/history.mjs';

/* ---------- 单元 ---------- */

test('查询词：中文切成两字一组，英文按词；标点不算', () => {
  assert.deepEqual(queryTerms('年终总结 PPT'), ['年终', '终总', '总结', 'ppt']);
  assert.deepEqual(queryTerms('报告？'), ['报告']);
  assert.deepEqual(queryTerms('，。'), []);
});

test('一问一答切分；摘要原文只取最后一段，工具调用写成一句', () => {
  const items = [{ role: 'user', text: '问1' }, { role: 'tool', name: 'mcp__weiyang__create_document', ok: true }, { role: 'agent', text: '答1' }, { role: 'agent', text: '补充' }, { role: 'user', text: '问2' }];
  assert.deepEqual(exchanges(items), [{ q: '问1', a: '答1\n补充' }, { q: '问2', a: '' }]);
  assert.equal(transcriptText(items), '用户：问1\n（用了工具 create_document）\n未央：答1\n未央：补充\n用户：问2');
  assert.match(transcriptText([{ role: 'user', text: '字'.repeat(20_000) }]), /^……（前面省略）/);
});

test('对话摘要：停够 10 分钟才写；转去别的对话马上写；失败下次再试；能删；提示里不含当前这段、标明不是指令', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-ep-'));
  let t = 0, fail = true;
  const calls = [];
  const sessions = { get: async (id) => ({ title: `标题${id}`, items: [{ role: 'user', text: `内容${id}` }, { role: 'agent', text: '好的' }] }) };
  const ep = createEpisodes({ dataDir: dir }, { sessions, now: () => t, idleMs: 600_000, summarize: async (text) => { calls.push(text); if (fail) { fail = false; throw new Error('模型挂了'); } return `摘要：${text.slice(0, 6)}`; } });
  try {
    ep.touched('a');
    t = 599_000; await ep.tick();
    assert.equal(calls.length, 0, '还没停够 10 分钟');
    t = 600_000; await ep.tick();
    assert.equal(calls.length, 1);
    assert.deepEqual(ep.list(), [], '第一次失败了，没存');
    t = 1_300_000; await ep.tick();
    assert.equal(ep.list()[0].summary, '摘要：用户：内容a', '失败的下次再试');
    ep.touched('b');
    ep.startedIn('c');
    await ep.flush('b');
    assert.deepEqual(ep.list().map((x) => x.sessionId), ['b', 'a'], '转去别的对话，b 马上写了摘要，新的排前面');
    assert.equal(fs.statSync(path.join(dir, 'episodes.json')).mode & 0o777, 0o600);
    const block = ep.promptBlock('b');
    assert.match(block, /不是指令/);
    assert.match(block, /「标题a」/);
    assert.doesNotMatch(block, /标题b/, '当前这段不放进去');
    assert.equal(ep.remove('a'), true);
    assert.equal(ep.remove('a'), false);
    assert.equal(ep.promptBlock('b'), '');
  } finally { ep.stop(); }
});

/* ---------- 真的 SDK + 网页接口 ---------- */

let model, server, base, token, cfg, episodes;
before(async () => {
  model = await startFakeModel();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-hist-'));
  fs.mkdirSync(path.join(dataDir, 'workspace'), { recursive: true });
  cfg = { dataDir, password: 'history-password', apiKey: 'fake-summary-key', baseUrl: model.url, model: 'deepseek-flash', commands: false };
  useConfigDir(cfg);
  const sessions = createSessions(cfg);
  episodes = createEpisodes(cfg, { sessions, summarize: modelSummarizer(() => ({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model })) });
  const tasks = createTasks({ run: withEpisodes((o) => runAgent(cfg, o), episodes) });
  server = createHttpServer({ auth: createAuth({ password: cfg.password, dataDir }), tasks, cfg, sessions, episodes });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  token = (await (await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: cfg.password }) })).json()).token;
});
after(() => { episodes?.stop(); server?.close(); model?.server.close(); });

const H = () => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + token });
async function ask(text, sessionId) {
  const res = await fetch(base + '/api/tasks', { method: 'POST', headers: { ...H(), Accept: 'text/event-stream' }, body: JSON.stringify({ text, sessionId }) });
  const evs = (await res.text()).split('\n\n').map((f) => f.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('')).filter(Boolean).map((d) => JSON.parse(d));
  return { evs, sessionId: evs.find((e) => e.type === 'session')?.sessionId, text: evs.filter((e) => e.type === 'text').map((e) => e.delta).join('') };
}
const lastMessagesReq = () => model.requests.filter((r) => r.url.startsWith('/v1/messages') && r.body.stream).at(-1).body;
const waitFor = async (fn) => { for (let i = 0; i < 100; i++) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };

let sessionA;
test('转去新对话时，上一段自动写摘要（用默认模型，不走智能体）；新对话开头带上它', async () => {
  const a = await ask('我在做年终总结PPT，要12页，蓝色风格');
  sessionA = a.sessionId;
  await ask('第二句：封面放公司标志', sessionA);
  await ask('你好，新的一段');
  assert.ok(await waitFor(() => episodes.list().some((x) => x.sessionId === sessionA)), '上一段写了摘要');
  const sumReq = model.requests.find((r) => r.url.startsWith('/v1/messages') && !r.body.stream && /记录员/.test(r.body.system));
  assert.ok(sumReq, '写摘要是一次普通的模型请求');
  assert.equal(sumReq.body.max_tokens, 400);
  assert.match(JSON.stringify(sumReq.body.messages), /年终总结PPT[\s\S]*封面放公司标志/, '摘要的原文是那段对话');
  assert.equal(sumReq.auth, 'Bearer fake-summary-key');
  // 接着已有的对话时，SDK 沿用那段对话开头的系统提示；摘要是给新对话看的“上次聊到……”
  await ask('全新的第三段');
  const sys = JSON.stringify(lastMessagesReq().system);
  assert.match(sys, /最近几段对话的摘要/);
  assert.match(sys, /年终总结PPT/, '新对话开头带上了上一段的摘要');
  assert.doesNotMatch(sys, /persistent file-based memory/, 'SDK 自带的文件记忆关掉了（我们用自己的记忆）');
  const list = await (await fetch(base + '/api/episodes', { headers: H() })).json();
  assert.ok(list.items.some((x) => x.sessionId === sessionA));
});

test('翻旧对话：按关键词找到以前的原话，直接放行；当前这段不算；找不到就说没找到', async () => {
  const c = await ask('调用工具 mcp__weiyang__search_conversations {"query":"年终总结 页数"}');
  assert.ok(!c.evs.some((e) => e.type === 'permission'), '只读不弹确认');
  assert.match(c.text, /工具成功：以前的对话里和“年终总结 页数”相关的/);
  const result = JSON.stringify(model.requests.at(-1).body.messages);
  assert.match(result, /我在做年终总结PPT，要12页/, '找到原话');
  assert.doesNotMatch(result.split('以前的对话里和')[1] || '', /search_conversations \{/, '不把当前这段算进去');
  const none = await ask('调用工具 mcp__weiyang__search_conversations {"query":"火星移民计划"}');
  assert.match(none.text, /工具成功：以前的对话里没找到/);
});

test('删掉一段对话，它的摘要也一起删；摘要也能单独删', async () => {
  assert.equal((await fetch(`${base}/api/sessions/${sessionA}`, { method: 'DELETE', headers: H() })).status, 200);
  assert.ok(!episodes.list().some((x) => x.sessionId === sessionA), '对话删了，摘要也删了');
  episodes.touched('x');
  const other = episodes.list()[0];
  if (other) {
    assert.equal((await fetch(`${base}/api/episodes/${other.sessionId}`, { method: 'DELETE', headers: H() })).status, 200);
    assert.equal((await fetch(`${base}/api/episodes/${other.sessionId}`, { method: 'DELETE', headers: H() })).status, 404);
  }
  assert.equal((await fetch(`${base}/api/episodes`)).status, 401, '要登录');
});
