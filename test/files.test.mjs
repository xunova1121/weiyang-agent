/**
 * 工作文件夹的文件接口：上传、列目录、下载、删除，以及各种想跳出工作文件夹的路径都被拒绝。
 * 不需要模型，只起真的 HTTP 服务。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAuth } from '../server/auth.mjs';
import { createTasks } from '../server/tasks.mjs';
import { createHttpServer } from '../server/http.mjs';
import { createFiles, MAX_UPLOAD } from '../server/files.mjs';

let server, base, token, dataDir, ws;
before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-files-'));
  ws = path.join(dataDir, 'workspace');
  fs.mkdirSync(ws);
  fs.writeFileSync(path.join(dataDir, 'config.json'), '{"apiKey":"SECRET"}');
  fs.symlinkSync(path.join(dataDir, 'config.json'), path.join(ws, 'sneaky-link.json'));
  const auth = createAuth({ password: 'files-password', dataDir });
  server = createHttpServer({ auth, tasks: createTasks({ run: async () => {} }), cfg: { model: 'm' }, sessions: {}, files: createFiles(ws) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  token = (await (await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'files-password' }) })).json()).token;
});
after(() => server?.close());

const auth = () => ({ Authorization: 'Bearer ' + token });
const up = (dir, name, body) => fetch(`${base}/api/files/upload?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(name)}`, { method: 'POST', headers: auth(), body });
const list = async (p = '') => fetch(`${base}/api/files?path=${encodeURIComponent(p)}`, { headers: auth() });
const dl = (p) => fetch(`${base}/api/files/download?path=${encodeURIComponent(p)}`, { headers: auth() });

test('没登录都不能用', async () => {
  for (const r of [await fetch(base + '/api/files'), await fetch(base + '/api/files/download?path=a'), await fetch(base + '/api/files/upload?name=a', { method: 'POST', body: 'x' })]) assert.equal(r.status, 401);
});

test('上传、列目录、下载（中文名）；重名不覆盖，自动加序号；子文件夹', async () => {
  const r1 = await up('', '报告.txt', '第一版');
  assert.equal(r1.status, 200);
  assert.equal((await r1.json()).path, '报告.txt');
  const r2 = await up('', '报告.txt', '第二版');
  assert.equal((await r2.json()).path, '报告(2).txt', '重名加序号');
  assert.equal(fs.readFileSync(path.join(ws, '报告.txt'), 'utf8'), '第一版', '原文件没被覆盖');
  assert.equal((await up('资料/2026', 'a.md', '# hi')).status, 200);
  const root = await (await list()).json();
  assert.deepEqual(root.items.map((i) => i.name), ['资料', '报告.txt', '报告(2).txt'], '文件夹在前、按名字排；指向外面的链接不列出');
  assert.equal(root.items[0].dir, true);
  const sub = await (await list('资料/2026')).json();
  assert.deepEqual(sub.items.map((i) => i.path), ['资料/2026/a.md']);
  const d = await dl('报告.txt');
  assert.equal(d.status, 200);
  assert.equal(await d.text(), '第一版');
  assert.match(d.headers.get('content-disposition'), /filename\*=UTF-8''%E6%8A%A5%E5%91%8A\.txt/);
  assert.equal(d.headers.get('content-type'), 'application/octet-stream', '一律当下载，不在浏览器里直接打开');
});

test('跳出工作文件夹的路径一律拒绝：../、绝对路径、指向外面的链接；坏文件名拒绝', async () => {
  for (const p of ['../config.json', '/etc/passwd', path.join(dataDir, 'config.json'), 'sneaky-link.json', '资料/../../config.json']) {
    const r = await dl(p);
    assert.equal(r.status, 404, p);
    assert.doesNotMatch(await r.text(), /SECRET/);
  }
  assert.equal((await list('..')).status, 404);
  assert.equal((await list('/')).status, 200, '“/”按工作文件夹根目录处理');
  for (const [dir, name] of [['..', 'x.txt'], ['', '../x.txt'], ['', 'a/b.txt'], ['', '..'], ['', '']]) {
    assert.equal((await up(dir, name, 'x')).status, 400, `${dir} ${name}`);
  }
  assert.equal(fs.existsSync(path.join(dataDir, 'x.txt')), false);
  const del = await fetch(`${base}/api/files?path=${encodeURIComponent('../config.json')}`, { method: 'DELETE', headers: auth() });
  assert.equal(del.status, 404);
  assert.ok(fs.existsSync(path.join(dataDir, 'config.json')), '外面的文件没被删');
});

test('太大的文件拒绝，不留半截文件', async () => {
  const big = Buffer.alloc(MAX_UPLOAD + 1, 1);
  const r = await up('', 'big.bin', big);
  assert.equal(r.status, 413);
  assert.ok(!fs.readdirSync(ws).some((n) => n.startsWith('big.bin')), '没留下文件或临时文件');
});

test('删除文件和文件夹；删工作文件夹本身不行', async () => {
  await up('', 'tmp.txt', 'x');
  assert.equal((await fetch(`${base}/api/files?path=tmp.txt`, { method: 'DELETE', headers: auth() })).status, 200);
  assert.equal(fs.existsSync(path.join(ws, 'tmp.txt')), false);
  assert.equal((await fetch(`${base}/api/files?path=${encodeURIComponent('资料')}`, { method: 'DELETE', headers: auth() })).status, 200);
  assert.equal(fs.existsSync(path.join(ws, '资料')), false);
  assert.equal((await fetch(`${base}/api/files?path=`, { method: 'DELETE', headers: auth() })).status, 404);
  assert.ok(fs.existsSync(ws));
});
