/**
 * 识图、看文件、语音：接口格式照原未央 src/llm/deepseekSuite.js；假 DeepSeek 会真的解析上传的表单。
 * 单元（结果校验、报错不回显）+ 真的 SDK 调工具 + 网页用的语音接口。
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
import { askFile, checkSpeech, ocr, tts } from '../server/deepseekMedia.mjs';
import { startFakeDeepseek } from './fakeDeepseek.mjs';

/* ---------- 单元 ---------- */

let ds;
const PASSWORD = 'media-password';
let model, server, base, token, cfg, ws;

test('识别文字：按页码排好；表单 purpose 和文件名对；layout 换成保留版式', async () => {
  const cfg = { apiKey: 'sk-media-test', deepseekApi: ds.api };
  const r = await ocr(cfg, { name: '照片/发票.png', buffer: Buffer.from('PNGDATA') });
  assert.equal(r.text, '第一页：发票\n\n第二页：合计 128 元');
  const req = ds.requests.at(-1);
  assert.equal(req.form.get('purpose'), 'text_recognition');
  assert.equal(req.form.get('file').name, '发票.png');
  assert.equal(req.fileText, 'PNGDATA');
  await ocr(cfg, { name: 'a.pdf', buffer: Buffer.from('x'), layout: true });
  assert.equal(ds.requests.at(-1).form.get('purpose'), 'rich_layout_recognition');
  await assert.rejects(ocr(cfg, { name: 'a.exe', buffer: Buffer.from('x') }), /不支持/);
  await assert.rejects(ocr(cfg, { name: 'a.png', buffer: Buffer.alloc(0) }), /空/);
});

test('看文件回答：上传 → 问 → 用完删掉；审核不过说人话，也会删', async () => {
  const cfg = { apiKey: 'sk-media-test', deepseekApi: ds.api };
  const a = await askFile(cfg, { name: '猫.jpg', buffer: Buffer.from('JPG'), question: '图里是什么' });
  assert.match(a, /一只猫（文件 file-abc123）/);
  const up = ds.requests.find((r) => r.url === '/v1/files' && r.method === 'POST');
  assert.equal(up.form.get('expires_after[seconds]'), '3600', '上传时就设一小时过期');
  const chat = ds.requests.findLast((r) => r.url === '/v1/chat/completions').body;
  assert.equal(chat.model, 'deepseek-flash');
  assert.deepEqual(chat.safety_check, { level: 'high' });
  assert.equal(ds.files.size, 0, '删掉了');
  await assert.rejects(askFile(cfg, { name: '猫.jpg', buffer: Buffer.from('JPG'), question: '审核测试' }), /内容审核没通过/);
  assert.equal(ds.files.size, 0, '出错也删掉了');
  await askFile(cfg, { name: '表.xlsx', buffer: Buffer.from('X'), question: '合计' });
  assert.equal(ds.requests.findLast((r) => r.url === '/v1/files' && r.method === 'POST').form.get('purpose'), 'user_data');
});

test('密钥不对：说人话，不回显服务商原文（里面带密钥尾号）', async () => {
  const cfg = { apiKey: 'sk-wrong', deepseekApi: ds.api };
  await assert.rejects(ocr(cfg, { name: 'a.png', buffer: Buffer.from('x') }), (e) => e.message === 'DeepSeek 说密钥不对或没有权限' && e.userFacing);
  await assert.rejects(ocr({}, { name: 'a.png', buffer: Buffer.from('x') }), /没有配置 DeepSeek 密钥/);
});

test('朗读：字数和音色检查；返回的必须是 wav', async () => {
  assert.throws(() => checkSpeech('', 'stella'), /没有要朗读/);
  assert.throws(() => checkSpeech('字'.repeat(5001), 'stella'), /太长/);
  assert.throws(() => checkSpeech('你好', 'bad'), /音色/);
  const wav = await tts({ apiKey: 'sk-media-test', deepseekApi: ds.api }, { text: '你好' });
  assert.equal(wav.toString('latin1', 0, 4), 'RIFF');
  assert.deepEqual(ds.requests.at(-1).body, { text: '你好', voice_id: 'stella', format: 'wav', filter_markdown: true });
  const notWav = async () => new Response('hello', { status: 200, headers: { 'content-type': 'audio/wav' } });
  await assert.rejects(tts({ apiKey: 'k' }, { text: '你好' }, { fetchImpl: notWav }), /格式不对/);
});

/* ---------- 真的 SDK + 网页接口 ---------- */


before(async () => {
  ds = await startFakeDeepseek();
  model = await startFakeModel();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-media-'));
  ws = path.join(dataDir, 'workspace');
  fs.mkdirSync(path.join(ws, '上传'), { recursive: true });
  fs.writeFileSync(path.join(ws, '上传', '发票.png'), 'PNG-IN-WORKSPACE');
  fs.writeFileSync(path.join(dataDir, 'secret.png'), 'OUTSIDE');
  cfg = { dataDir, password: PASSWORD, apiKey: 'sk-media-test', baseUrl: model.url, model: 'deepseek-flash', commands: false, deepseekApi: ds.api };
  useConfigDir(cfg);
  const tasks = createTasks({ run: (o) => runAgent(cfg, o) });
  server = createHttpServer({ auth: createAuth({ password: PASSWORD, dataDir }), tasks, cfg, sessions: createSessions(cfg) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  token = (await (await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) })).json()).token;
});
after(() => { server?.close(); model?.server.close(); ds?.server.close(); });

const H = (extra = {}) => ({ Authorization: 'Bearer ' + token, ...extra });
async function ask(text) {
  const res = await fetch(base + '/api/tasks', { method: 'POST', headers: H({ 'Content-Type': 'application/json', Accept: 'text/event-stream' }), body: JSON.stringify({ text }) });
  const evs = (await res.text()).split('\n\n').map((f) => f.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('')).filter(Boolean).map((d) => JSON.parse(d));
  return { evs, text: evs.filter((e) => e.type === 'text').map((e) => e.delta).join('') };
}

test('识图工具：读工作文件夹里的图片，直接放行；工作文件夹外面的不读', async () => {
  const r = await ask('调用工具 mcp__weiyang__read_image {"path":"上传/发票.png"}');
  assert.ok(!r.evs.some((e) => e.type === 'permission'), '只读不弹确认');
  assert.match(r.text, /工具成功：“上传\/发票.png”识别出的文字（共 2 页）/);
  assert.equal(ds.requests.findLast((x) => x.url === '/v1/tools/ocr').fileText, 'PNG-IN-WORKSPACE');
  const n = ds.requests.length;
  const out = await ask('调用工具 mcp__weiyang__read_image {"path":"../secret.png"}');
  assert.match(out.text, /工具失败：只能访问工作文件夹里的文件/);
  assert.equal(ds.requests.length, n, '没有把外面的文件发出去');
  const missing = await ask('调用工具 mcp__weiyang__ask_file {"path":"没有.png","question":"是什么"}');
  assert.match(missing.text, /工具失败：工作文件夹里没有“没有.png”/);
});

test('看文件工具：回答带上文件名', async () => {
  const r = await ask('调用工具 mcp__weiyang__ask_file {"path":"上传/发票.png","question":"图里是什么"}');
  assert.match(r.text, /工具成功：关于“上传\/发票.png”：\s+图里是一只猫/);
});

test('语音接口：要登录；录音转文字；朗读返回 wav；状态里说明语音可用', async () => {
  assert.equal((await fetch(base + '/api/voice/asr', { method: 'POST', body: 'x' })).status, 401);
  assert.equal((await (await fetch(base + '/api/status', { headers: H() })).json()).voice, true);
  const wav = Buffer.alloc(1000); wav.write('RIFF', 0, 'latin1');
  const asr = await fetch(base + '/api/voice/asr', { method: 'POST', headers: H({ 'Content-Type': 'audio/wav' }), body: wav });
  assert.deepEqual(await asr.json(), { text: '今天天气怎么样' });
  const sent = ds.requests.findLast((x) => x.url === '/v1/tools/asr');
  assert.equal(sent.audioName, 'speech.wav');
  assert.equal(sent.audioSize, 1000);
  const big = await fetch(base + '/api/voice/asr', { method: 'POST', headers: H({ 'Content-Type': 'audio/wav' }), body: Buffer.alloc(8 * 1024 * 1024 + 1) });
  assert.equal(big.status, 413);
  const speak = await fetch(base + '/api/voice/tts', { method: 'POST', headers: H({ 'Content-Type': 'application/json' }), body: JSON.stringify({ text: '你好' }) });
  assert.equal(speak.headers.get('content-type'), 'audio/wav');
  assert.equal(Buffer.from(await speak.arrayBuffer()).toString('latin1', 8, 12), 'WAVE');
  const bad = await fetch(base + '/api/voice/tts', { method: 'POST', headers: H({ 'Content-Type': 'application/json' }), body: JSON.stringify({ text: '你好', voice: 'x' }) });
  assert.equal(bad.status, 502);
  assert.equal((await bad.json()).error, '没有这个音色');
});

test('服务器没配 DeepSeek 密钥：不给识图工具', async () => {
  const { createToolBox } = await import('../server/tools/index.mjs');
  const box = createToolBox({ ...cfg, apiKey: '' });
  assert.ok(!box.names.includes('read_image') && !box.names.includes('ask_file'));
  assert.ok(createToolBox(cfg).names.includes('read_image'));
});
