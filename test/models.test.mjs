/**
 * 多模型：设置的存取与校验、OpenAI 格式翻译（单元），以及真的 SDK 经翻译服务和假 OpenAI 模型、
 * 经另一家 Anthropic 格式服务商跑通（端到端）。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFakeModel } from './fakeModel.mjs';
import { startFakeOpenAI } from './fakeOpenAI.mjs';
import { createAuth } from '../server/auth.mjs';
import { createTasks } from '../server/tasks.mjs';
import { createHttpServer } from '../server/http.mjs';
import { runAgent } from '../server/agentRunner.mjs';
import { createSessions, useConfigDir } from '../server/sessions.mjs';
import { createSettings, validBaseUrl } from '../server/settings.mjs';
import { createStreamTranslator, fromOpenAIResponse, startOpenAIBridge, toOpenAIRequest } from '../server/openaiBridge.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wa-models-'));

/* ---------- 单元：翻译 ---------- */

test('翻译请求：系统提示、工具定义、工具调用与结果的顺序、图片、工具选择', () => {
  const out = toOpenAIRequest({
    system: [{ type: 'text', text: '你是未央' }],
    max_tokens: 100, stream: true,
    tools: [{ name: 'Read', description: '读文件', input_schema: { type: 'object', properties: { file_path: { type: 'string' } } } }, { type: 'web_search_20250305', name: 'web_search' }],
    tool_choice: { type: 'any' },
    messages: [
      { role: 'user', content: [{ type: 'text', text: '看看' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: '想', signature: 's' }, { type: 'text', text: '好' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.txt' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: '内容' }] }, { type: 'text', text: '继续' }] }
    ]
  }, { model: 'gpt-x' });
  assert.equal(out.model, 'gpt-x');
  assert.deepEqual(out.messages[0], { role: 'system', content: '你是未央' });
  assert.deepEqual(out.messages[1].content[1], { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } });
  assert.equal(out.messages[2].content, '好', '思考过程不往回送');
  assert.deepEqual(out.messages[2].tool_calls, [{ id: 't1', type: 'function', function: { name: 'Read', arguments: '{"file_path":"a.txt"}' } }]);
  assert.deepEqual(out.messages[3], { role: 'tool', tool_call_id: 't1', content: '内容' }, '工具结果紧跟在调用后面');
  assert.deepEqual(out.messages[4], { role: 'user', content: '继续' });
  assert.equal(out.tools.length, 1, '没有参数定义的服务端工具（如 web_search）不送');
  assert.equal(out.tool_choice, 'required');
  assert.deepEqual(out.stream_options, { include_usage: true });
});

test('翻译回复：非流式；流式里文字分段、工具参数分段都能拼回去', () => {
  const r = fromOpenAIResponse({ choices: [{ message: { content: null, tool_calls: [{ id: 'c1', function: { name: 'Read', arguments: '{"file_path":"x"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 3, completion_tokens: 4 } }, 'm');
  assert.equal(r.stop_reason, 'tool_use');
  assert.deepEqual(r.content, [{ type: 'tool_use', id: 'c1', name: 'Read', input: { file_path: 'x' } }]);
  const out = [];
  const tr = createStreamTranslator('m', (s) => out.push(s));
  tr.push({ choices: [{ delta: { content: '你' } }] });
  tr.push({ choices: [{ delta: { content: '好' } }] });
  tr.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c2', function: { name: 'Read', arguments: '{"file_' } }] } }] });
  tr.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'path":"y"}' } }] }, finish_reason: 'tool_calls' }] });
  tr.end();
  const evs = out.map((s) => JSON.parse(s.split('\ndata: ')[1]));
  assert.deepEqual(evs.map((e) => e.type), ['message_start', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
  assert.equal(evs.filter((e) => e.delta?.type === 'text_delta').map((e) => e.delta.text).join(''), '你好');
  assert.equal(evs.filter((e) => e.delta?.type === 'input_json_delta').map((e) => e.delta.partial_json).join(''), '{"file_path":"y"}');
  assert.equal(evs.at(-2).delta.stop_reason, 'tool_use');
});

/* ---------- 单元：设置 ---------- */

test('设置：校验地址和必填项；密钥只进不出；留空不改密钥；服务器配置的 DeepSeek 不能改不能删；文件权限 600', () => {
  const dir = tmp();
  const cfg = { dataDir: dir, baseUrl: 'https://api.deepseek.com/anthropic', apiKey: 'sk-env', model: 'deepseek-flash' };
  const s = createSettings(cfg);
  assert.equal(validBaseUrl('ftp://x'), null);
  assert.equal(validBaseUrl('https://u:p@x.com'), null);
  assert.match(s.saveProvider({ name: 'K', format: 'anthropic', baseUrl: 'https://x.com/v1', apiKey: 'k', models: 'a' }).error, /不要以 \/v1 结尾/);
  assert.match(s.saveProvider({ name: 'K', format: 'anthropic', baseUrl: 'https://x.com', apiKey: 'k', models: '' }).error, /模型名/);
  assert.match(s.saveProvider({ name: 'K', format: 'anthropic', baseUrl: 'https://x.com', models: 'a' }).error, /密钥/);
  assert.match(s.saveProvider({ id: 'env', name: 'x', format: 'anthropic', baseUrl: 'https://x.com', apiKey: 'k', models: 'a' }).error, /不能在网页上改/);
  const { id } = s.saveProvider({ name: 'Kimi', format: 'anthropic', baseUrl: 'https://api.moonshot.cn/anthropic/', apiKey: 'sk-kimi-secret-9876', models: 'kimi-a, kimi-b' });
  const view = JSON.stringify(s.publicView());
  assert.doesNotMatch(view, /sk-kimi-secret|sk-env/, '网页看不到密钥原文');
  assert.match(view, /尾号 9876/);
  s.saveProvider({ id, name: 'Kimi2', format: 'anthropic', baseUrl: 'https://api.moonshot.cn/anthropic', apiKey: '', models: 'kimi-a' });
  assert.equal(s.resolve(`${id}/kimi-a`).apiKey, 'sk-kimi-secret-9876', '密钥留空表示不变');
  assert.equal(s.resolve(`${id}/kimi-a`).baseUrl, 'https://api.moonshot.cn/anthropic');
  assert.equal(s.resolve('乱填/的').ref, 'env/deepseek-flash', '不认识的模型用默认');
  assert.equal(s.setDefault(`${id}/kimi-a`), true);
  assert.equal(createSettings(cfg).defaultModel(), `${id}/kimi-a`, '重启后还在');
  assert.equal(s.removeProvider('env'), false);
  assert.equal((fs.statSync(path.join(dir, 'settings.json')).mode & 0o777).toString(8), '600');
  assert.equal(s.setService('qianfan', 'bce-v3/abc').ok, true);
  assert.equal(s.service('qianfan'), 'bce-v3/abc');
  assert.doesNotMatch(JSON.stringify(s.publicView()), /bce-v3\/abc/);
  s.setService('qianfan', null);
  assert.equal(s.service('qianfan'), '');
});

/* ---------- 端到端 ---------- */

let anth, oai, bridge, server, base, token, cfg, settings;
before(async () => {
  anth = await startFakeModel();
  oai = await startFakeOpenAI();
  const dataDir = tmp();
  fs.mkdirSync(path.join(dataDir, 'workspace'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'workspace', 'note.txt'), '经OpenAI读到的笔记');
  cfg = { dataDir, password: 'models-pass', apiKey: 'sk-env-key', baseUrl: anth.url, model: 'deepseek-flash', commands: false };
  useConfigDir(cfg);
  settings = createSettings(cfg);
  bridge = await startOpenAIBridge({ getProvider: (id) => settings.provider(id) });
  const tasks = createTasks({ run: (o) => runAgent(cfg, { ...o, settings, bridge }) });
  server = createHttpServer({ auth: createAuth({ password: 'models-pass', dataDir }), tasks, cfg, settings, sessions: createSessions(cfg) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  token = (await (await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'models-pass' }) })).json()).token;
});
after(() => { server?.close(); bridge?.close(); anth?.server.close(); oai?.server.close(); });

const H = () => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + token });
const call = (p, method = 'GET', body) => fetch(base + p, { method, headers: H(), body: body && JSON.stringify(body) });
async function ask(text, model) {
  const res = await fetch(base + '/api/tasks', { method: 'POST', headers: { ...H(), Accept: 'text/event-stream' }, body: JSON.stringify({ text, model }) });
  const raw = await res.text();
  const evs = raw.split('\n\n').map((f) => f.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('')).filter(Boolean).map((d) => JSON.parse(d));
  return { evs, end: evs.at(-1), text: evs.filter((e) => e.type === 'text').map((e) => e.delta).join('') };
}

test('设置接口：要登录；加服务商；密钥不回给网页；模型列表里有它', async () => {
  assert.equal((await fetch(base + '/api/settings')).status, 401);
  const r = await call('/api/settings/providers', 'POST', { name: '测试 OpenAI', format: 'openai', baseUrl: oai.url, apiKey: 'sk-openai-test-key', models: 'gpt-test' });
  assert.equal(r.status, 200);
  const body = await (await call('/api/settings')).text();
  assert.doesNotMatch(body, /sk-openai-test-key/);
  const models = await (await call('/api/models')).json();
  assert.ok(models.models.some((m) => m.model === 'gpt-test'));
  assert.equal(models.default, 'env/deepseek-flash');
  const bad = await call('/api/settings/providers', 'POST', { name: 'x', format: 'openai', baseUrl: 'not a url', apiKey: 'k', models: 'a' });
  assert.equal(bad.status, 400);
});

test('OpenAI 格式：经翻译服务正常回话、工具调用来回都通；真实密钥只发给服务商，SDK 拿到的是内部访问码', async () => {
  const ref = (await (await call('/api/models')).json()).models.find((m) => m.model === 'gpt-test').ref;
  const hi = await ask('你好', ref);
  assert.equal(hi.end.type, 'done', JSON.stringify(hi.end));
  assert.equal(hi.text, 'OpenAI收到：你好');
  assert.ok(hi.evs.filter((e) => e.type === 'text').length >= 2, '逐段推送');
  const tool = await ask('读文件 note.txt', ref);
  assert.equal(tool.end.type, 'done');
  assert.match(tool.text, /工具结果：.*经OpenAI读到的笔记/);
  assert.ok(oai.requests.every((r) => r.auth === 'Bearer sk-openai-test-key'), '上游拿到的是服务商的真实密钥');
  assert.ok(oai.requests.every((r) => r.body.model === 'gpt-test'));
  assert.ok(oai.requests.some((r) => r.body.messages.some((m) => m.role === 'tool')), '工具结果按 OpenAI 格式送回');
  // 不带内部访问码直接打翻译服务：拒绝
  const direct = await fetch(bridge.url + '/p/whatever/v1/messages', { method: 'POST', headers: { 'x-api-key': 'guess' }, body: '{}' });
  assert.equal(direct.status, 401);
});

test('OpenAI 格式：密钥错时报错能看懂，回显的密钥被遮住', async () => {
  const { id } = await (await call('/api/settings/providers', 'POST', { name: '错密钥', format: 'openai', baseUrl: oai.url, apiKey: 'sk-wrong', models: 'gpt-test' })).json();
  const t0 = Date.now();
  const r = await ask('你好', `${id}/gpt-test`);
  assert.ok(Date.now() - t0 < 30_000, `不让人干等（用了 ${Math.round((Date.now() - t0) / 1000)} 秒）`);
  const all = JSON.stringify(r.evs);
  assert.doesNotMatch(all, /sk-openai-WRONG-1234/, '服务商回显的密钥被遮住');
  assert.equal(r.end.type, 'error');
  assert.match(r.end.error, /密钥不对（401）/, '直接说清楚是密钥问题');
});

test('另一家 Anthropic 格式服务商：请求发到它的地址、用它的密钥和型号', async () => {
  const other = await startFakeModel();
  try {
    const { id } = await (await call('/api/settings/providers', 'POST', { name: '另一家', format: 'anthropic', baseUrl: other.url, apiKey: 'sk-other-key', models: 'other-model' })).json();
    const r = await ask('你好', `${id}/other-model`);
    assert.equal(r.end.type, 'done');
    assert.match(r.text, /收到：你好/);
    const reqs = other.requests.filter((x) => x.url.startsWith('/v1/messages'));
    assert.ok(reqs.length > 0 && reqs.every((x) => x.auth === 'Bearer sk-other-key' && x.body.model === 'other-model'));
    assert.equal(await call('/api/settings/default', 'POST', { model: `${id}/other-model` }).then((x) => x.status), 200);
    const before = other.requests.length;
    await ask('不选模型就用默认');
    assert.ok(other.requests.length > before, '不选模型时用设好的默认模型');
  } finally { other.server.close(); }
});
