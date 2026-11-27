/**
 * 网页端到端：真浏览器登录、发消息、看到逐段回复和工具步骤、刷新后保持登录、接着上一轮对话。
 * 运行：node test/web.e2e.mjs [截图目录]（需要本机有 Playwright 和 Chromium）
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startFakeModel, startLoggingProxy } from './fakeModel.mjs';
import { createAuth } from '../server/auth.mjs';
import { createTasks } from '../server/tasks.mjs';
import { createHttpServer } from '../server/http.mjs';
import { runAgent } from '../server/agentRunner.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const out = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'wa-shots-'));
fs.mkdirSync(out, { recursive: true });

const model = await startFakeModel();
const proxy = await startLoggingProxy();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-web-'));
fs.mkdirSync(path.join(dataDir, 'workspace'), { recursive: true });
fs.writeFileSync(path.join(dataDir, 'workspace', 'note.txt'), '浏览器里读到的笔记');
const cfg = { dataDir, password: 'web-password-1', apiKey: 'fake', baseUrl: model.url, model: 'deepseek-flash' };
const extraEnv = { HTTPS_PROXY: proxy.url, HTTP_PROXY: proxy.url, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
const server = createHttpServer({ auth: createAuth({ password: cfg.password, dataDir }), tasks: createTasks({ run: (o) => runAgent(cfg, { ...o, extraEnv }) }), cfg });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const results = [];
const check = (name, ok) => { results.push(ok); console.log(`${ok ? '✓' : '✗'} ${name}`); if (!ok) throw new Error(name); };
try {
  for (const [label, viewport] of [['desktop', { width: 1280, height: 800 }], ['phone', { width: 390, height: 844 }]]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base);
    check(`${label} 未登录只显示登录框`, await page.isVisible('#login-form') && !(await page.isVisible('#prompt')));
    await page.fill('#password', 'wrong');
    await page.click('#login-form button');
    await page.waitForFunction(() => document.querySelector('#login-error').textContent.includes('密码不对'));
    check(`${label} 错密码有提示`, true);
    await page.fill('#password', cfg.password);
    await page.click('#login-form button');
    await page.waitForSelector('#chat:not([hidden])');
    check(`${label} 登录后登录框真的看不见`, !(await page.isVisible('#login-form')) && await page.isVisible('#prompt'));
    await page.fill('#prompt', '你好');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => [...document.querySelectorAll('.msg.agent')].some((n) => n.textContent.includes('收到：你好') && !n.classList.contains('streaming')));
    check(`${label} 发消息收到回复`, true);
    await page.fill('#prompt', '读文件 note.txt');
    await page.click('#send');
    await page.waitForFunction(() => document.querySelector('.tool')?.textContent.includes('Read') && [...document.querySelectorAll('.msg.agent')].some((n) => n.textContent.includes('浏览器里读到的笔记')));
    check(`${label} 工具步骤和结果显示出来`, true);
    await page.reload();
    await page.waitForSelector('#chat:not([hidden])');
    check(`${label} 刷新后仍是登录状态`, true);
    await page.fill('#prompt', '还记得吗');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => [...document.querySelectorAll('.msg.agent')].some((n) => /收到：还记得吗（历史 [3-9] 条）/.test(n.textContent)));
    check(`${label} 刷新后接着同一段对话`, true);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    check(`${label} 没有横向溢出`, !overflow);
    await page.screenshot({ path: path.join(out, `${label}.png`) });
    check(`${label} 没有页面脚本错误`, errors.length === 0);
    await page.close();
  }
  check('全程没有往外连', proxy.attempts.length === 0);
  console.log(`网页端到端 ${results.length}/${results.length} 通过；截图在 ${out}`);
} finally {
  await browser.close();
  server.close(); model.server.close(); proxy.server.close();
}
