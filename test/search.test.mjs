/**
 * 联网搜索：结果整理（单元），以及真的 SDK 经工具调用假千帆、假 DeepSeek 联网（端到端）。
 * 假 DeepSeek 的流式格式照原未央 tests/deepseekNativeWeb.test.js（用户实测过的格式）。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startFakeModel } from './fakeModel.mjs';
import { createAuth } from '../server/auth.mjs';
import { createTasks } from '../server/tasks.mjs';
import { createHttpServer } from '../server/http.mjs';
import { runAgent } from '../server/agentRunner.mjs';
import { createSessions, useConfigDir } from '../server/sessions.mjs';
import { createSettings } from '../server/settings.mjs';
import { deepseekCollector, linkAnswer, publicWebUrl, qianfanHits, qianfanRequest } from '../server/tools/search.mjs';

/* ---------- 单元 ---------- */

test('网址检查：只要公开 http(s)；内网、带账号密码、带签名参数的都不要', () => {
  assert.equal(publicWebUrl('https://news.example.com/a?id=1'), 'https://news.example.com/a?id=1');
  for (const bad of ['http://127.0.0.1/x', 'http://192.168.1.2/', 'http://localhost/', 'http://intranet/', 'https://u:p@x.com/', 'https://x.com/?token=abc', 'ftp://x.com/', 'javascript:alert(1)']) assert.equal(publicWebUrl(bad), '', bad);
});

test('千帆请求：site: 限定网站、最近一周；结果去重、丢内网链接、密钥回显被遮住', () => {
  const r = qianfanRequest('华为 新闻 site:news.cn site:127.0.0.1', { freshness: 'week', topK: 50 });
  assert.deepEqual(r.search_filter.match.site, ['news.cn']);
  assert.equal(r.search_recency_filter, 'week');
  assert.equal(r.resource_type_filter[0].top_k, 20);
  const hits = qianfanHits({ references: [
    { url: 'https://a.example.com/1', title: '<b>标题一</b>', content: '摘要 KEY-123 在这', date: '2026-11-27 08:00:00' },
    { url: 'https://a.example.com/1', title: '重复', content: 'x' },
    { url: 'http://10.0.0.1/x', title: '内网', content: 'x' },
    { url: 'https://b.example.com/2', title: '', content: '没标题' },
    { url: 'https://c.example.com/3', title: '图片', type: 'image' }
  ] }, 'KEY-123');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].title, '标题一');
  assert.equal(hits[0].snippet, '摘要 [已隐藏] 在这');
  assert.throws(() => qianfanHits({ oops: 1 }, 'k'), /没返回结果列表/);
});

test('DeepSeek 回复解析：来源、引用位置按 Unicode 码点（中文、emoji）插入链接', () => {
  const col = deepseekCollector();
  const page = { url: 'https://news.example.com/x', title: '新闻页', published_at: '2026-11-27' };
  col.push({ choices: [{ server_tool_event: { type: 'call_completed', call: { id: 's1', type: 'deepseek_web_search', status: 'completed', sources: [page, { url: 'http://192.168.0.1/' }] } }, delta: {} }] });
  const text = '今天😀有雨。';
  col.push({ choices: [{ delta: { content: text } }] });
  col.push({ choices: [{ finish_reason: 'stop', delta: { annotations: [{ type: 'url_citation', url_citation: { url: page.url, start_index: 0, end_index: Array.from(text).length } }] } }] });
  const r = col.result();
  assert.equal(r.sources.length, 1, '内网来源丢掉');
  assert.equal(r.stop, 'stop');
  assert.equal(linkAnswer(r.text, r.cites).text, '今天😀有雨。 [1](https://news.example.com/x)');
});

/* ---------- 端到端 ---------- */

let model, server, base, token, cfg, settings, qf, ds;
const qfRequests = [], dsRequests = [];

function sse(res, chunks) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.end('data: [DONE]\n\n');
}

before(async () => {
  qf = http.createServer(async (req, res) => {
    let b = ''; for await (const c of req) b += c;
    qfRequests.push({ auth: req.headers.authorization, body: JSON.parse(b) });
    if (req.headers.authorization !== 'Bearer bce-v3/test-key') { res.writeHead(401); return res.end('{"code":"InvalidKey","message":"bce-v3/test-key wrong"}'); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ references: [{ url: 'https://news.example.com/today', title: '今日要闻', content: '这是今天的新闻摘要', date: '2026-11-27 09:00:00' }] }));
  });
  ds = http.createServer(async (req, res) => {
    let b = ''; for await (const c of req) b += c;
    const body = JSON.parse(b);
    dsRequests.push({ auth: req.headers.authorization, body });
    const read = body.tools?.[0]?.type === 'deepseek_read_url';
    const page = { url: read ? 'https://site.example.com/page' : 'https://news.example.com/ds', title: read ? '指定网页' : 'DeepSeek 找到的网页', published_at: '2026-11-27' };
    const call = { id: 'srv-1', type: read ? 'deepseek_read_url' : 'deepseek_web_search', status: 'completed', ...(read ? { page } : { sources: [page] }) };
    const text = read ? '这个网页讲的是测试。' : '北京今天晴。';
    sse(res, [
      { choices: [{ server_tool_event: { type: 'call_started', call: { ...call, status: 'in_progress' } }, delta: {} }] },
      { choices: [{ server_tool_event: { type: 'call_completed', call }, delta: {} }] },
      { choices: [{ delta: { content: text } }] },
      { choices: [{ finish_reason: 'stop', delta: { server_tool_calls: [{ index: 0, calls: [call] }], annotations: [{ type: 'url_citation', url_citation: { url: page.url, title: page.title, start_index: 0, end_index: Array.from(text).length } }] } }] }
    ]);
  });
  for (const s of [qf, ds]) await new Promise((r) => s.listen(0, '127.0.0.1', r));
  model = await startFakeModel();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-search-'));
  fs.mkdirSync(path.join(dataDir, 'workspace'), { recursive: true });
  cfg = { dataDir, password: 'search-pass', apiKey: 'sk-deepseek-test', baseUrl: model.url, model: 'deepseek-flash', commands: false,
    qianfanEndpoint: `http://127.0.0.1:${qf.address().port}/v2/ai_search/web_search`, deepseekApi: `http://127.0.0.1:${ds.address().port}/v1` };
  useConfigDir(cfg);
  settings = createSettings(cfg);
  const tasks = createTasks({ run: (o) => runAgent(cfg, { ...o, settings }) });
  server = createHttpServer({ auth: createAuth({ password: 'search-pass', dataDir }), tasks, cfg, settings, sessions: createSessions(cfg) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  token = (await (await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'search-pass' }) })).json()).token;
});
after(() => { for (const s of [server, qf, ds]) s?.close(); model?.server.close(); });

async function ask(text) {
  const res = await fetch(base + '/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, Accept: 'text/event-stream' }, body: JSON.stringify({ text }) });
  const raw = await res.text();
  const evs = raw.split('\n\n').map((f) => f.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('')).filter(Boolean).map((d) => JSON.parse(d));
  return { evs, end: evs.at(-1), text: evs.filter((e) => e.type === 'text').map((e) => e.delta).join('') };
}
const offered = () => (model.requests.filter((r) => r.url.startsWith('/v1/messages')).at(-1).body.tools || []).map((t) => t.name);

test('没填千帆密钥时不给百度搜索；DeepSeek 联网和读网页一直有', async () => {
  await ask('你好');
  const names = offered();
  assert.ok(!names.includes('mcp__weiyang__web_search'));
  assert.ok(names.includes('mcp__weiyang__deepseek_search') && names.includes('mcp__weiyang__read_url'));
});

test('百度搜索：填了密钥就能用，直接放行，结果带链接和发布时间；请求用的是千帆密钥', async () => {
  settings.setService('qianfan', 'bce-v3/test-key');
  const r = await ask('调用工具 mcp__weiyang__web_search {"query":"今日新闻","freshness":"day"}');
  assert.ok(!r.evs.some((e) => e.type === 'permission'), '查资料不弹确认');
  assert.match(r.text, /工具成功：百度搜索“今日新闻”的结果/);
  assert.match(r.text, /https:\/\/news\.example\.com\/today/);
  assert.equal(qfRequests.at(-1).auth, 'Bearer bce-v3/test-key');
  assert.equal(qfRequests.at(-1).body.messages[0].content, '今日新闻');
});

test('百度搜索：密钥不对时说人话，不回显服务商报错（里面可能带密钥）', async () => {
  settings.setService('qianfan', 'bce-v3/wrong');
  const r = await ask('调用工具 mcp__weiyang__web_search {"query":"x"}');
  assert.match(r.text, /工具失败：百度搜索说密钥不对或没有权限/);
  assert.doesNotMatch(JSON.stringify(r.evs), /test-key wrong|bce-v3\/wrong/);
  settings.setService('qianfan', 'bce-v3/test-key');
});

test('DeepSeek 联网：带来源编号的回答；请求格式和原未央一致（官方搜索工具、关思考、内容审核）', async () => {
  const r = await ask('调用工具 mcp__weiyang__deepseek_search {"question":"北京今天天气"}');
  assert.match(r.text, /北京今天晴。 \[1\]\(https:\/\/news\.example\.com\/ds\)/);
  const req = dsRequests.at(-1);
  assert.equal(req.auth, 'Bearer sk-deepseek-test');
  assert.deepEqual(req.body.tools, [{ type: 'deepseek_web_search' }]);
  assert.deepEqual(req.body.thinking, { type: 'disabled' });
  assert.deepEqual(req.body.safety_check, { level: 'high' });
  assert.equal(req.body.model, 'deepseek-flash');
  const deep = await ask('调用工具 mcp__weiyang__deepseek_search {"question":"复杂问题","deep":true}');
  assert.match(deep.text, /工具成功/);
  assert.deepEqual(dsRequests.at(-1).body.thinking, { type: 'enabled' });
});

test('读网页：公开网址能读；内网地址直接拒绝、不发请求', async () => {
  const r = await ask('调用工具 mcp__weiyang__read_url {"url":"https://site.example.com/page","question":"讲了什么"}');
  assert.match(r.text, /这个网页讲的是测试。 \[1\]\(https:\/\/site\.example\.com\/page\)/);
  assert.deepEqual(dsRequests.at(-1).body.tools, [{ type: 'deepseek_read_url' }]);
  const n = dsRequests.length;
  const bad = await ask('调用工具 mcp__weiyang__read_url {"url":"http://127.0.0.1:22/"}');
  assert.match(bad.text, /工具失败：这个网址不能读/);
  assert.equal(dsRequests.length, n, '没有发请求');
});
