/**
 * 从服务商拉取模型列表：地址推算、各家返回格式、Anthropic 地址没有列表时换 OpenAI 兼容地址、
 * 密钥不对说人话、网页接口留空密钥时用已存的（密钥不经过网页）。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { candidates, fetchModels, parseModelList } from '../server/modelList.mjs';
import { createAuth } from '../server/auth.mjs';
import { createTasks } from '../server/tasks.mjs';
import { createHttpServer } from '../server/http.mjs';
import { createSettings } from '../server/settings.mjs';
import { createSessions, useConfigDir } from '../server/sessions.mjs';

test('地址推算：OpenAI 只试 /models；Anthropic 先 /v1/models，再试同一家的 OpenAI 兼容地址', () => {
  assert.deepEqual(candidates('openai', 'https://relay.example.com/v1').map((c) => c.url), ['https://relay.example.com/v1/models']);
  assert.deepEqual(candidates('anthropic', 'https://api.deepseek.com/anthropic').map((c) => c.url),
    ['https://api.deepseek.com/anthropic/v1/models', 'https://api.deepseek.com/v1/models', 'https://api.deepseek.com/models']);
  assert.ok(candidates('anthropic', 'https://dashscope.aliyuncs.com/apps/anthropic').some((c) => c.url === 'https://dashscope.aliyuncs.com/compatible-mode/v1/models'));
  assert.ok(candidates('anthropic', 'https://open.bigmodel.cn/api/anthropic').some((c) => c.url === 'https://open.bigmodel.cn/api/paas/v4/models'));
  assert.equal(candidates('anthropic', 'https://api.deepseek.com/anthropic')[0].style, 'anthropic');
});

test('返回格式：{data:[{id}]}、{models:[{name}]}、数组；去重、排序、丢掉怪名字', () => {
  assert.deepEqual(parseModelList({ data: [{ id: 'b' }, { id: 'a' }, { id: 'a' }] }), ['a', 'b']);
  assert.deepEqual(parseModelList({ models: [{ name: 'models/gemini-x' }, { id: 'k2' }] }), ['gemini-x', 'k2']);
  assert.deepEqual(parseModelList(['m1', { id: 'bad name <script>' }]), ['m1']);
  assert.equal(parseModelList({ nope: 1 }), null);
});

let fake, seen = [], server, base, token, settings;
before(async () => {
  fake = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization, xkey: req.headers['x-api-key'] });
    const key = req.headers.authorization?.replace('Bearer ', '');
    const send = (s, b) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (key !== 'sk-good') return send(401, { error: { message: `bad key ${key}` } });
    // 像 DeepSeek：Anthropic 地址下没有模型列表，OpenAI 兼容地址有
    if (req.url === '/anthropic/v1/models') return send(404, { error: 'not found' });
    if (req.url === '/models') return send(200, { object: 'list', data: [{ id: 'ds-flash' }, { id: 'ds-pro' }] });
    if (req.url === '/oai/v1/models') return send(200, { data: [{ id: 'gpt-x' }] });
    send(404, {});
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-models-'));
  const cfg = { dataDir, password: 'models-password', apiKey: 'fake', baseUrl: 'http://127.0.0.1:1', model: 'deepseek-flash', commands: false };
  useConfigDir(cfg);
  settings = createSettings(cfg);
  server = createHttpServer({ auth: createAuth({ password: cfg.password, dataDir }), tasks: createTasks({ run: async () => {} }), cfg, settings, sessions: createSessions(cfg) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  token = (await (await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: cfg.password }) })).json()).token;
});
after(() => { server?.close(); fake?.close(); });
const fakeUrl = (p) => `http://127.0.0.1:${fake.address().port}${p}`;

test('Anthropic 地址没有列表时，换成同一家的 OpenAI 兼容地址拉到', async () => {
  seen = [];
  const r = await fetchModels({ format: 'anthropic', baseUrl: fakeUrl('/anthropic'), apiKey: 'sk-good' });
  assert.deepEqual(r, { models: ['ds-flash', 'ds-pro'], from: '/models' });
  assert.equal(seen[0].url, '/anthropic/v1/models');
  assert.equal(seen[0].xkey, 'sk-good', 'Anthropic 方式带 x-api-key');
  assert.deepEqual((await fetchModels({ format: 'openai', baseUrl: fakeUrl('/oai/v1'), apiKey: 'sk-good' })).models, ['gpt-x']);
});

test('密钥不对说人话，不回显服务商原文；没填密钥、地址不对、连不上都说清楚', async () => {
  const bad = await fetchModels({ format: 'openai', baseUrl: fakeUrl('/oai/v1'), apiKey: 'sk-wrong' });
  assert.deepEqual(bad, { error: '服务商说密钥不对或没有权限' });
  assert.match((await fetchModels({ format: 'openai', baseUrl: fakeUrl('/oai/v1'), apiKey: '' })).error, /要先填密钥/);
  assert.match((await fetchModels({ format: 'openai', baseUrl: 'ftp://x', apiKey: 'k' })).error, /接口地址不对/);
  assert.match((await fetchModels({ format: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k' })).error, /连不上服务商/);
  assert.match((await fetchModels({ format: 'openai', baseUrl: fakeUrl('/nothing'), apiKey: 'sk-good' })).error, /没有提供模型列表（HTTP 404）/);
});

test('网页接口：要登录；改已有服务商时密钥留空就用已存的（密钥不经过网页）', async () => {
  const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
  assert.equal((await fetch(base + '/api/settings/models/fetch', { method: 'POST', body: '{}' })).status, 401);
  const { id } = settings.saveProvider({ name: '测试', format: 'openai', baseUrl: fakeUrl('/oai/v1'), apiKey: 'sk-good', models: 'old' });
  const r = await fetch(base + '/api/settings/models/fetch', { method: 'POST', headers: H, body: JSON.stringify({ id, format: 'openai', baseUrl: fakeUrl('/oai/v1'), apiKey: '' }) });
  assert.deepEqual(await r.json(), { models: ['gpt-x'], from: '/oai/v1/models' });
  const wrong = await fetch(base + '/api/settings/models/fetch', { method: 'POST', headers: H, body: JSON.stringify({ format: 'openai', baseUrl: fakeUrl('/oai/v1'), apiKey: 'sk-wrong' }) });
  assert.equal(wrong.status, 400);
  assert.doesNotMatch(JSON.stringify(await wrong.json()), /sk-wrong/);
});
