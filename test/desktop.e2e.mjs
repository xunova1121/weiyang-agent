/**
 * Windows 程序（apps/desktop，Electron）端到端：真的启动 Electron（Linux 上用 xvfb-run 当屏幕），连本机的测试服务器。
 * 要先 cd apps/desktop && npm install。运行：xvfb-run -a node test/desktop.e2e.mjs
 * 检查：网页拿不到 Node；壳功能只有那几个；外部链接交给系统浏览器；关窗口藏到托盘；
 * 回复做完、窗口不在前面时弹通知（在前面时不弹）；改服务器地址只能在设置页里改、只认 https。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startFakeModel } from './fakeModel.mjs';
import { createAuth } from '../server/auth.mjs';
import { createTasks } from '../server/tasks.mjs';
import { createHttpServer } from '../server/http.mjs';
import { runAgent } from '../server/agentRunner.mjs';
import { createSessions, useConfigDir } from '../server/sessions.mjs';

const require = createRequire(import.meta.url);
const { _electron: electron } = require('playwright');
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../apps/desktop');
const electronBin = createRequire(path.join(APP, 'package.json'))('electron');

const model = await startFakeModel();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-desk-'));
fs.mkdirSync(path.join(dataDir, 'workspace'), { recursive: true });
const cfg = { dataDir, password: 'desktop-pass-1', apiKey: 'fake', baseUrl: model.url, model: 'deepseek-flash', commands: false };
useConfigDir(cfg);
const server = createHttpServer({ auth: createAuth({ password: cfg.password, dataDir }), tasks: createTasks({ run: (o) => runAgent(cfg, o) }), cfg, sessions: createSessions(cfg) });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

let failed = 0, passed = 0;
const check = (name, ok) => { if (ok) passed++; else failed++; console.log(`${ok ? '✓' : '✗'} ${name}`); if (!ok) throw new Error(name); };

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-desk-home-'));
const app = await electron.launch({
  executablePath: electronBin,
  args: [APP, '--no-sandbox'],
  env: { ...process.env, WEIYANG_SERVER_URL: base, XDG_CONFIG_HOME: home, HOME: home, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }
});
try {
  // 记下系统通知、交给系统浏览器的链接（不真的弹、不真的开）
  await app.evaluate(({ Notification, shell }) => {
    globalThis.__shown = [];
    globalThis.__external = [];
    Notification.isSupported = () => true; // Linux 虚拟屏幕上没有通知服务；Windows 上本来就支持
    Notification.prototype.show = function () { globalThis.__shown.push(this.title); };
    shell.openExternal = async (url) => { globalThis.__external.push(url); };
  });
  const page = await app.firstWindow();
  await page.waitForSelector('#login-form');
  check('打开就是服务器的登录页', page.url().startsWith(base));
  check('网页拿不到 Node（require、process 都没有）', await page.evaluate(() => typeof require === 'undefined' && typeof process === 'undefined'));
  check('壳只给了那几个功能', JSON.stringify(await page.evaluate(() => Object.keys(window.weiyangShell).sort())) === JSON.stringify(['changeServer', 'notify', 'platform', 'setServer']));

  await page.fill('#password', cfg.password);
  await page.click('#login-form button');
  await page.waitForSelector('#chat:not([hidden])');
  check('设置里不显示浏览器通知开关（由壳负责通知）', await page.evaluate(() => document.querySelector('.notify-row').hidden));

  // 外部链接
  await page.evaluate(() => window.open('https://example.com/a'));
  await page.evaluate(() => { location.href = 'https://example.org/b'; });
  await page.waitForTimeout(500);
  const ext = await app.evaluate(() => globalThis.__external);
  check('新窗口和跳到别的网站都交给系统浏览器', ext.includes('https://example.com/a') && ext.includes('https://example.org/b'));
  check('窗口还停在服务器上', page.url().startsWith(base));
  await page.goto(base); // 被拦下的跳转在 Playwright 看来还“没结束”，重新打开一次服务器页
  await page.waitForSelector('#chat:not([hidden])');

  // 窗口在前面时：回复做完不弹通知
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.show(); w.focus(); });
  await page.fill('#prompt', '前台说句话');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => [...document.querySelectorAll('.msg.agent')].some((n) => n.textContent.includes('收到：前台说句话')));
  await page.waitForTimeout(300);
  const focused = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused());
  if (focused) check('窗口在前面时，回复做完不弹通知', (await app.evaluate(() => globalThis.__shown)).length === 0);
  else console.log('（这台机器的虚拟屏幕不给窗口焦点，跳过“前台不弹”这一项）');

  // 关窗口：藏到托盘，程序不退出；回复做完弹通知
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  check('关窗口只是藏起来，程序还在', await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length === 1 && !BrowserWindow.getAllWindows()[0].isVisible()));
  await page.evaluate(() => { document.querySelector('#prompt').value = '后台说句话'; document.querySelector('#composer').requestSubmit(); });
  // 窗口藏起来后页面不按屏幕刷新走，按时间间隔检查
  await page.waitForFunction(() => [...document.querySelectorAll('.msg.agent')].some((n) => n.textContent.includes('收到：后台说句话')), null, { polling: 200 });
  await page.waitForTimeout(300);
  check('窗口藏起来时，回复做完弹系统通知', (await app.evaluate(() => globalThis.__shown)).includes('未央回复好了'));

  // 改服务器地址：服务器的网页不能直接改；设置页只认 https（本机测试地址除外）
  check('服务器的网页不能直接改地址', (await page.evaluate(() => window.weiyangShell.setServer('https://evil.example'))).error === '只能在设置页里改');
  await page.evaluate(() => window.weiyangShell.changeServer());
  await page.waitForURL(/setup\.html/);
  await page.fill('#url', 'http://evil.example');
  await page.click('button[type=submit]');
  await page.waitForFunction(() => document.querySelector('#err').textContent.includes('https://'));
  check('设置页：非 https 地址拒绝', true);
  await page.fill('#url', base);
  await page.click('button[type=submit]');
  await page.waitForURL((u) => u.href.startsWith(base));
  check('设置页：改好地址后打开服务器', true);
  const userData = await app.evaluate(({ app }) => app.getPath('userData'));
  const saved = JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8'));
  check('地址存进了用户目录', saved.serverUrl === base);
} finally {
  await app.close().catch(() => {});
  server.close();
  model.server.close();
}
console.log(`Windows 程序端到端 ${passed}/${passed + failed} 通过`);
if (failed) process.exit(1);
