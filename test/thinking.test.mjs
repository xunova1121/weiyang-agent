/**
 * 回答慢的两处修复：
 *  - OpenAI 格式的服务商（经本机翻译服务）：深度思考没开时叫上游别先思考；上游不认这个参数就去掉重试，并记下这家以后不带
 *  - 上游先思考时，思考过程翻成 thinking 块：网页能看到“正在思考”，不再像卡住
 * 以及每条回复的用时（第一个字、共多久、调了几次模型、先想了多少字）。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFakeOpenAI } from './fakeOpenAI.mjs';
import { createAuth } from '../server/auth.mjs';
import { createTasks } from '../server/tasks.mjs';
import { createHttpServer } from '../server/http.mjs';
import { runAgent } from '../server/agentRunner.mjs';
import { createSessions, useConfigDir } from '../server/sessions.mjs';
import { createSettings } from '../server/settings.mjs';
import { createStreamTranslator, startOpenAIBridge, THINK_OFF, toOpenAIRequest } from '../server/openaiBridge.mjs';

/* ---------- 单元 ---------- */

test('请求翻译：没开深度思考就带“别思考”参数；开了不带；这家不认时不带', () => {
  const base = { model: 'm', messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 };
  assert.deepEqual(toOpenAIRequest(base, { model: 'm' }).thinking, { type: 'disabled' });
  assert.equal(toOpenAIRequest(base, { model: 'm' }).enable_thinking, false);
  const deep = toOpenAIRequest({ ...base, thinking: { type: 'adaptive' } }, { model: 'm' });
  assert.ok(!('thinking' in deep) && !('enable_thinking' in deep), '开了深度思考就让模型自己想');
  const plain = toOpenAIRequest(base, { model: 'm', offParams: false });
  assert.ok(!('thinking' in plain) && !('enable_thinking' in plain));
  assert.deepEqual(Object.keys(THINK_OFF).sort(), ['enable_thinking', 'thinking']);
});

test('流式翻译：reasoning_content 翻成 thinking 块，正文开始前关掉；记下先想了多少字', () => {
  const out = [];
  const tr = createStreamTranslator('m', (s) => out.push(s));
  tr.push({ choices: [{ delta: { reasoning_content: '想一想' } }] });
  tr.push({ choices: [{ delta: { reasoning: '再想想' } }] });
  tr.push({ choices: [{ delta: { content: '答案' } }] });
  tr.push({ choices: [{ delta: {}, finish_reason: 'stop' }] });
  tr.end();
  const evs = out.map((s) => JSON.parse(s.split('\ndata: ')[1]));
  const kinds = evs.map((e) => e.type + (e.content_block ? ':' + e.content_block.type : '') + (e.delta?.type ? ':' + e.delta.type : ''));
  assert.deepEqual(kinds, ['message_start', 'content_block_start:thinking', 'content_block_delta:thinking_delta', 'content_block_delta:thinking_delta',
    'content_block_delta:signature_delta', 'content_block_stop', 'content_block_start:text', 'content_block_delta:text_delta', 'content_block_stop', 'message_delta', 'message_stop']);
  assert.equal(evs[1].index, 0);
  assert.equal(evs[6].index, 1, '正文是下一块');
  assert.equal(tr.stats.thinkingChars, 6);
  assert.ok(tr.stats.firstThinkingAt && tr.stats.firstTextAt >= tr.stats.firstThinkingAt);
});

/* ---------- 真的 SDK + 本机翻译服务 ---------- */

let normal, strict, bridge, server, base, token, settings, ids;
before(async () => {
  normal = await startFakeOpenAI();
  strict = await startFakeOpenAI({ strict: true });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-think-'));
  fs.mkdirSync(path.join(dataDir, 'workspace'), { recursive: true });
  const cfg = { dataDir, password: 'think-password', apiKey: 'unused', baseUrl: 'http://127.0.0.1:1', model: 'deepseek-flash', commands: false };
  useConfigDir(cfg);
  settings = createSettings(cfg);
  ids = {
    normal: settings.saveProvider({ name: '普通', format: 'openai', baseUrl: normal.url, apiKey: 'sk-openai-test-key', models: 'gpt-n' }).id,
    strict: settings.saveProvider({ name: '严格', format: 'openai', baseUrl: strict.url, apiKey: 'sk-openai-test-key', models: 'gpt-s' }).id
  };
  bridge = await startOpenAIBridge({ getProvider: (id) => settings.provider(id) });
  server = createHttpServer({ auth: createAuth({ password: cfg.password, dataDir }), tasks: createTasks({ run: (o) => runAgent(cfg, { ...o, settings, bridge }) }), cfg, settings, sessions: createSessions(cfg) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  token = (await (await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: cfg.password }) })).json()).token;
});
after(() => { server?.close(); bridge?.close(); normal?.server.close(); strict?.server.close(); });

async function ask(body) {
  const res = await fetch(base + '/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, Accept: 'text/event-stream' }, body: JSON.stringify(body) });
  const evs = (await res.text()).split('\n\n').map((f) => f.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('')).filter(Boolean).map((d) => JSON.parse(d));
  return { evs, end: evs.at(-1), text: evs.filter((e) => e.type === 'text').map((e) => e.delta).join('') };
}
const chatReqs = (fake) => fake.requests.filter((r) => r.url === '/v1/chat/completions' && r.body.stream);

test('没开深度思考：发给上游的请求叫它别思考；开了就不带', async () => {
  await ask({ text: '你好', model: `${ids.normal}/gpt-n` });
  const off = chatReqs(normal).at(-1).body;
  assert.deepEqual(off.thinking, { type: 'disabled' });
  assert.equal(off.enable_thinking, false);
  await ask({ text: '难题', model: `${ids.normal}/gpt-n`, think: true });
  const on = chatReqs(normal).at(-1).body;
  assert.ok(!('thinking' in on) && !('enable_thinking' in on));
});

test('上游先思考时：网页收到“正在思考”，正文照常出；做完带用时（先想了多少字、调了几次模型）', async () => {
  const r = await ask({ text: '先思考 再回答', model: `${ids.normal}/gpt-n`, think: true });
  assert.equal(r.end.type, 'done', JSON.stringify(r.end));
  assert.ok(r.evs.some((e) => e.type === 'thinking' && e.chars > 0), '有“正在思考”');
  assert.equal(r.text, 'OpenAI收到：先思考 再回答', '思考过程不混进正文');
  assert.equal(r.end.timing.calls, 1);
  assert.equal(r.end.timing.thinkingChars, '让我想想……想好了'.length);
  assert.ok(r.end.timing.first > 0 && r.end.timing.total >= r.end.timing.first);
  // 下一轮接着聊（SDK 会把带 thinking 块的历史发回来）也不出错
  const again = await ask({ text: '接着说', model: `${ids.normal}/gpt-n`, sessionId: r.evs.find((e) => e.type === 'session').sessionId });
  assert.equal(again.end.type, 'done', JSON.stringify(again.end));
  assert.equal(again.text, 'OpenAI收到：接着说');
});

test('上游不认“别思考”参数（回 400）：去掉重试能用；记下这家，以后第一次就不带', async () => {
  const r = await ask({ text: '你好', model: `${ids.strict}/gpt-s` });
  assert.equal(r.end.type, 'done', JSON.stringify(r.end));
  assert.equal(r.text, 'OpenAI收到：你好');
  const reqs = chatReqs(strict);
  assert.equal(reqs.length, 2, '第一次带参数被拒，第二次不带');
  assert.ok('enable_thinking' in reqs[0].body && !('enable_thinking' in reqs[1].body));
  await ask({ text: '再来', model: `${ids.strict}/gpt-s` });
  assert.equal(chatReqs(strict).length, 3, '记住了：这次一次就成');
  assert.ok(!('enable_thinking' in chatReqs(strict).at(-1).body));
});
