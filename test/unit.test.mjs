import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkConfig, loadConfig } from '../server/config.mjs';
import { createAuth } from '../server/auth.mjs';
import { checkToolPaths, insideWorkspace } from '../server/pathGuard.mjs';
import { agentEnv, QUIET_ENV } from '../server/agentRunner.mjs';
import { createTasks } from '../server/tasks.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wa-'));

test('配置：密码太短、缺密钥、地址以 /v1 结尾都拒绝启动', () => {
  const p = checkConfig({ password: 'short', apiKey: '', baseUrl: 'https://x/v1', port: 8787 });
  assert.equal(p.length, 3);
  assert.throws(() => loadConfig({ DATA_DIR: tmp() }), /配置不完整/);
  const ok = loadConfig({ DATA_DIR: tmp(), WEIYANG_PASSWORD: '12345678', DEEPSEEK_API_KEY: 'k' });
  assert.equal(ok.baseUrl, 'https://api.deepseek.com/anthropic');
});

test('登录：错密码 401，连错 5 次锁定；令牌能用、退出后失效；文件里不存令牌原文', () => {
  let t = 1_000_000;
  const dir = tmp();
  const auth = createAuth({ password: 'right-password', dataDir: dir, now: () => t });
  for (let i = 0; i < 5; i++) assert.equal(auth.login('ip1', 'wrong').status, 401);
  assert.equal(auth.login('ip1', 'right-password').status, 429, '锁定期内对的密码也不行');
  assert.equal(auth.login('ip2', 'right-password').ok, true, '别的来源不受影响');
  t += 11 * 60_000;
  const r = auth.login('ip1', 'right-password');
  assert.equal(r.ok, true, '锁定期过了可以登录');
  assert.equal(auth.check(r.token), true);
  assert.ok(!fs.readFileSync(path.join(dir, 'tokens.json'), 'utf8').includes(r.token), '只存哈希');
  auth.logout(r.token);
  assert.equal(auth.check(r.token), false);
  assert.equal(auth.check(''), false);
});

test('路径守卫：工作文件夹内放行；../、绝对路径、~、指向外面的符号链接都拒绝', () => {
  const root = tmp();
  const ws = path.join(root, 'workspace');
  fs.mkdirSync(ws);
  fs.writeFileSync(path.join(root, 'config.json'), '{"apiKey":"secret"}');
  fs.writeFileSync(path.join(ws, 'a.txt'), 'hi');
  fs.symlinkSync(path.join(root, 'config.json'), path.join(ws, 'link.json'));
  assert.equal(insideWorkspace(ws, 'a.txt'), true);
  assert.equal(insideWorkspace(ws, path.join(ws, 'a.txt')), true);
  assert.equal(insideWorkspace(ws, 'new/not-yet.txt'), true, '还不存在的文件也按所在目录判断');
  assert.equal(insideWorkspace(ws, '../config.json'), false);
  assert.equal(insideWorkspace(ws, path.join(root, 'config.json')), false);
  assert.equal(insideWorkspace(ws, '/etc/passwd'), false);
  assert.equal(insideWorkspace(ws, '~/.ssh/id_rsa'), false);
  assert.equal(insideWorkspace(ws, 'link.json'), false, '符号链接按真实位置判断');
  assert.equal(insideWorkspace(ws, '**/../../*'), false);
  assert.match(checkToolPaths(ws, 'Read', { file_path: '../config.json' }), /工作文件夹/);
  assert.match(checkToolPaths(ws, 'Grep', { pattern: 'x', path: '/etc' }), /工作文件夹/);
  assert.equal(checkToolPaths(ws, 'Glob', { pattern: '**/*.txt' }), null);
});

test('SDK 环境变量：只给必需项、带上关闭外连开关，不继承服务器环境（如登录密码）', () => {
  process.env.WEIYANG_PASSWORD = 'should-not-leak';
  const env = agentEnv({ baseUrl: 'http://m', apiKey: 'k', model: 'deepseek-flash' }, { home: '/h' });
  delete process.env.WEIYANG_PASSWORD;
  assert.equal(env.WEIYANG_PASSWORD, undefined);
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://m');
  for (const [k, v] of Object.entries(QUIET_ENV)) assert.equal(env[k], v);
});

test('任务：同一时间只跑一个；事件带序号，可从任意序号之后补发；停止会传到执行方', async () => {
  let release;
  const tasks = createTasks({ run: ({ emit, signal }) => new Promise((resolve) => {
    emit({ type: 'text', delta: 'a' });
    release = () => { emit({ type: 'done', text: 'a' }); resolve(); };
    signal.addEventListener('abort', () => { emit({ type: 'stopped' }); resolve(); });
  }) });
  const { task } = tasks.start({ text: 'x' });
  await new Promise((r) => setImmediate(r));
  assert.equal(tasks.start({ text: 'y' }).status, 409);
  const seen = [];
  tasks.subscribe(task.id, 1, (ev) => seen.push(ev?.type ?? 'END'));
  release();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen, ['text', 'done', 'END']);
  const again = [];
  tasks.subscribe(task.id, 2, (ev) => again.push(ev?.type ?? 'END'));
  assert.deepEqual(again, ['done', 'END'], '结束后按序号补发并立即收尾');
  const second = tasks.start({ text: 'z' }).task;
  await new Promise((r) => setImmediate(r));
  tasks.stop(second.id);
  await new Promise((r) => setImmediate(r));
  assert.equal(tasks.get(second.id).status, 'stopped');
});
