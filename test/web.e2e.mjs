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
import { createSessions, useConfigDir } from '../server/sessions.mjs';
import { createFiles } from '../server/files.mjs';
import { createSettings } from '../server/settings.mjs';
import { createMemory } from '../server/memory.mjs';
import { startOpenAIBridge } from '../server/openaiBridge.mjs';
import { startFakeOpenAI } from './fakeOpenAI.mjs';
import { startFakeDeepseek } from './fakeDeepseek.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const out = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'wa-shots-'));
fs.mkdirSync(out, { recursive: true });

const model = await startFakeModel();
const ds = await startFakeDeepseek({ key: 'fake' });
const proxy = await startLoggingProxy();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-web-'));
fs.mkdirSync(path.join(dataDir, 'workspace'), { recursive: true });
fs.writeFileSync(path.join(dataDir, 'workspace', 'note.txt'), '浏览器里读到的笔记');
const cfg = { dataDir, password: 'web-password-1', apiKey: 'fake', baseUrl: model.url, model: 'deepseek-flash', deepseekApi: ds.api };
const extraEnv = { HTTPS_PROXY: proxy.url, HTTP_PROXY: proxy.url, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
useConfigDir(cfg);
const settings = createSettings(cfg);
const bridge = await startOpenAIBridge({ getProvider: (id) => settings.provider(id) });
const oai = await startFakeOpenAI();
const server = createHttpServer({ auth: createAuth({ password: cfg.password, dataDir }), tasks: createTasks({ run: (o) => runAgent(cfg, { ...o, extraEnv, settings, bridge }) }), cfg, settings, memory: createMemory(dataDir), sessions: createSessions(cfg), files: createFiles(path.join(dataDir, 'workspace')) });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
// 假麦克风（Chromium 自带，会发出提示音），测语音输入用
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
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
    await page.waitForFunction(() => [...document.querySelectorAll('.msg.user')].some((n) => n.textContent === '你好') && document.querySelector('.tool'));
    check(`${label} 刷新后之前的消息和工具步骤还在`, true);
    await page.fill('#prompt', '还记得吗');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => [...document.querySelectorAll('.msg.agent')].some((n) => /收到：还记得吗（历史 [3-9] 条）/.test(n.textContent)));
    check(`${label} 刷新后接着同一段对话`, true);
    // 改文件要确认：点“允许”才写
    const file = `${label}-made.txt`;
    await page.fill('#prompt', `写文件 ${file} 网页里写的`);
    await page.keyboard.press('Enter');
    await page.waitForSelector('.ask .actions button');
    check(`${label} 改文件前弹出确认框，写清要写哪个文件`, (await page.textContent('.ask')).includes(file));
    await page.click('.ask .actions button:has-text("允许")');
    await page.waitForFunction(() => document.querySelector('.ask .answered')?.textContent.includes('已允许') && [...document.querySelectorAll('.msg.agent')].some((n) => n.textContent.includes('工具成功')));
    check(`${label} 点允许后文件真的写好了`, fs.readFileSync(path.join(dataDir, 'workspace', file), 'utf8') === '网页里写的');
    await page.fill('#prompt', `写文件 ${label}-no.txt 不该写`);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('.ask').length === 2 && document.querySelectorAll('.ask')[1].querySelector('.actions button'));
    await page.locator('.ask').nth(1).locator('button', { hasText: '拒绝' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.ask')[1]?.querySelector('.answered')?.textContent.includes('已拒绝'));
    await page.waitForSelector('#send:not([hidden])');
    check(`${label} 点拒绝后文件没写`, !fs.existsSync(path.join(dataDir, 'workspace', `${label}-no.txt`)));
    // 文件面板：看到未央写的文件、下载、上传、删除
    await page.click('#open-files');
    await page.waitForSelector(`#file-list li[data-path="${file}"]`);
    check(`${label} 文件面板里有未央刚写的文件`, true);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click(`#file-list li[data-path="${file}"] button.name`)]);
    check(`${label} 点文件能下载，内容对`, fs.readFileSync(await dl.path(), 'utf8') === '网页里写的' && dl.suggestedFilename() === file);
    await page.setInputFiles('#upload', { name: `${label}-上传.txt`, mimeType: 'text/plain', buffer: Buffer.from('我传上去的') });
    await page.waitForSelector(`#file-list li[data-path="${label}-上传.txt"]`);
    check(`${label} 上传的文件出现在列表里、存进了工作文件夹`, fs.readFileSync(path.join(dataDir, 'workspace', `${label}-上传.txt`), 'utf8') === '我传上去的');
    await page.click(`#file-list li[data-path="${label}-上传.txt"] button.mini`);
    await page.click(`#file-list li[data-path="${label}-上传.txt"] button.mini`);
    await page.waitForFunction((p) => !document.querySelector(`#file-list li[data-path="${p}"]`), `${label}-上传.txt`);
    check(`${label} 点两次删除，文件没了`, !fs.existsSync(path.join(dataDir, 'workspace', `${label}-上传.txt`)));
    const panelOverflow = await page.evaluate(() => { const r = document.querySelector('.files-panel').getBoundingClientRect(); return r.left < 0 || r.right > innerWidth; });
    check(`${label} 文件面板不超出屏幕`, !panelOverflow);
    await page.screenshot({ path: path.join(out, `${label}-files.png`) });
    await page.click('#close-files');
    check(`${label} 文件面板能关上`, await page.isHidden('#files'));
    // 对话列表：手机上要先打开抽屉
    const openSide = async () => {
      if (label !== 'phone') return;
      await page.click('#toggle-side');
      await page.waitForFunction(() => Math.round(document.querySelector('#side').getBoundingClientRect().left) === 0);
    };
    await openSide();
    await page.waitForSelector('#sessions li.active');
    check(`${label} 对话列表里有当前对话并高亮`, await page.isVisible('#sessions li.active'));
    await page.click('#sessions li.active button.mini[title="改名"]');
    await page.fill('#sessions li input', `${label} 的测试对话`);
    await page.keyboard.press('Enter');
    await page.waitForFunction((t) => document.querySelector('#sessions li.active .title')?.textContent === t, `${label} 的测试对话`);
    check(`${label} 改名生效`, (await page.textContent('#chat-title')) === `${label} 的测试对话`);
    await page.click('#new-chat');
    check(`${label} 新对话清空了聊天区`, (await page.$$('#transcript > *')).length === 0);
    await openSide();
    await page.locator('#sessions li', { hasText: `${label} 的测试对话` }).locator('button.open').click();
    await page.waitForFunction(() => [...document.querySelectorAll('.msg.agent')].some((n) => /还记得吗/.test(n.textContent)));
    check(`${label} 从列表打开旧对话，历史回来了`, true);
    await openSide();
    const before = (await page.$$('#sessions li')).length;
    await page.click('#sessions li.active button.mini[title="删除"]');
    await page.click('#sessions li.active button.mini[title="删除"]');
    await page.waitForFunction((n) => document.querySelectorAll('#sessions li').length === n - 1, before);
    check(`${label} 点两次删除，对话从列表里没了，聊天区清空`, (await page.$$('#transcript > *')).length === 0);
    if (label === 'phone') { await page.click('#scrim', { position: { x: 370, y: 400 } }); check('phone 点抽屉外面能关上抽屉', await page.isHidden('#scrim')); }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    check(`${label} 没有横向溢出`, !overflow);
    await page.screenshot({ path: path.join(out, `${label}.png`) });
    check(`${label} 没有页面脚本错误`, errors.length === 0);
    await page.close();
  }
  // 确认框等着时刷新页面：回复接上，确认框还在，还能点
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(base);
    await page.fill('#password', cfg.password);
    await page.click('#login-form button');
    await page.waitForSelector('#chat:not([hidden])');
    await page.fill('#prompt', '写文件 after-reload.txt 刷新后写的');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.ask .actions button');
    await page.screenshot({ path: path.join(out, 'ask-card.png') });
    await page.reload();
    await page.waitForSelector('.ask .actions button');
    check('刷新后正在等的确认框还在', (await page.textContent('.ask')).includes('after-reload.txt') && await page.isVisible('#stop'));
    await page.click('.ask .actions button:has-text("允许")');
    await page.waitForSelector('#send:not([hidden])');
    check('刷新后点允许，文件照样写好', fs.readFileSync(path.join(dataDir, 'workspace', 'after-reload.txt'), 'utf8') === '刷新后写的');
    check('刷新后接上时提问只显示一次', (await page.$$eval('.msg.user', (ns) => ns.filter((n) => n.textContent.includes('after-reload.txt')).length)) === 1);
    await page.close();
  }
  // 设置：加一个 OpenAI 格式的服务商，选它的模型聊天；密钥不出现在页面上
  for (const [label, viewport] of [['desktop', { width: 1280, height: 800 }], ['phone', { width: 390, height: 844 }]]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base);
    if (await page.isVisible('#login-form')) { await page.fill('#password', cfg.password); await page.click('#login-form button'); }
    await page.waitForSelector('#chat:not([hidden])');
    await page.waitForFunction(() => document.querySelector('#model').options.length >= 1);
    check(`${label} 模型选择里有服务器配置的 DeepSeek`, (await page.textContent('#model')).includes('deepseek-flash'));
    if (label === 'phone') { await page.click('#toggle-side'); await page.waitForFunction(() => Math.round(document.querySelector('#side').getBoundingClientRect().left) === 0); }
    await page.click('#open-settings');
    await page.waitForSelector('#settings:not([hidden]) #providers li');
    const name = `${label}测试服务商`;
    if (!(await page.textContent('#providers')).includes(name)) {
      await page.click('#provider-form-box summary');
      await page.selectOption('#pf-preset', 'openai');
      check(`${label} 选常用服务商自动填好格式和地址`, (await page.inputValue('#pf-format')) === 'openai' && (await page.inputValue('#pf-url')).startsWith('https://'));
      check(`${label} 未核实的预设地址有提示`, (await page.textContent('#pf-hint')).includes('官方文档'));
      await page.fill('#pf-name', name);
      await page.fill('#pf-url', oai.url);
      await page.fill('#pf-key', 'sk-openai-test-key');
      await page.click('#pf-fetch');
      await page.waitForSelector('#pf-fetched:not([hidden]) input');
      check(`${label} 从服务商拉到模型列表`, (await page.textContent('#pf-fetch-note')).includes('拉到 3 个') && (await page.$$('#pf-fetched input')).length === 3);
      await page.check(`#pf-fetched input[value="gpt-${label}"]`);
      check(`${label} 勾选的型号写进了型号栏`, (await page.inputValue('#pf-models')) === `gpt-${label}`);
      await page.click('#provider-form button[type=submit]');
      await page.waitForFunction((n) => document.querySelector('#providers').textContent.includes(n), name);
    }
    check(`${label} 服务商加上了，页面上只看得到密钥尾号`, (await page.textContent('#providers')).includes('尾号 -key') && !(await page.content()).includes('sk-openai-test-key'));
    const note = `${label}：回答简短点`;
    await page.fill('#memory-new', note);
    await page.click('#memory-form button[type=submit]');
    await page.waitForFunction((n) => [...document.querySelectorAll('#memories input')].some((i) => i.value === n), note);
    check(`${label} 长期记忆能加上`, true);
    const memRow = page.locator('#memories li').filter({ has: page.locator('input') }).last();
    check(`${label} 新加的记忆在列表最后`, (await memRow.locator('input').inputValue()) === note);
    await memRow.locator('button[aria-label="删除这条记忆"]').click();
    await page.waitForFunction((n) => ![...document.querySelectorAll('#memories input')].some((i) => i.value === n), note);
    check(`${label} 长期记忆能删掉`, true);
    const gaps = await page.evaluate(() => ['#providers', '#services', '#memories', '#episodes'].map((q) => { const ul = document.querySelector(q); const items = [...ul.children].reduce((h, li) => h + li.getBoundingClientRect().height, 0); return ul.getBoundingClientRect().height - items; }));
    check(`${label} 设置里的列表不留空白、不被截断`, gaps.every((g) => Math.abs(g) < 8));
    const panelOverflow = await page.evaluate(() => { const r = document.querySelector('#settings .files-panel').getBoundingClientRect(); return r.left < 0 || r.right > innerWidth; });
    check(`${label} 设置面板不超出屏幕`, !panelOverflow);
    await page.screenshot({ path: path.join(out, `${label}-settings.png`) });
    await page.click('#close-settings');
    if (label === 'phone' && await page.isVisible('#scrim')) await page.click('#scrim', { position: { x: 370, y: 400 } });
    await page.waitForFunction((m) => [...document.querySelector('#model').options].some((o) => o.textContent.startsWith(m)), `gpt-${label}`);
    const ref = await page.evaluate((m) => [...document.querySelector('#model').options].find((o) => o.textContent.startsWith(m)).value, `gpt-${label}`);
    await page.selectOption('#model', ref);
    await page.click('#new-chat').catch(() => {});
    await page.fill('#prompt', '用新模型说句话');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => [...document.querySelectorAll('.msg.agent')].some((n) => n.textContent.includes('OpenAI收到：用新模型说句话')));
    check(`${label} 选了 OpenAI 格式的模型，回复真的来自它`, true);
    await page.reload();
    await page.waitForSelector('#chat:not([hidden])');
    await page.waitForFunction(() => document.querySelector('#model').options.length >= 2);
    check(`${label} 刷新后还记得选的模型`, (await page.inputValue('#model')) === ref);
    check(`${label} 设置相关没有页面脚本错误`, errors.length === 0);
    await page.close();
  }
  // 上传附件、语音输入、朗读
  for (const [label, viewport] of [['desktop', { width: 1280, height: 800 }], ['phone', { width: 390, height: 844 }]]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base);
    if (await page.isVisible('#login-form')) { await page.fill('#password', cfg.password); await page.click('#login-form button'); }
    await page.waitForSelector('#chat:not([hidden])');
    await page.click('#new-chat').catch(() => {});
    await page.waitForSelector('#mic:not([hidden])');
    check(`${label} 服务器有 DeepSeek 密钥时显示麦克风`, true);
    await page.setInputFiles('#attach', { name: `${label}照片.png`, mimeType: 'image/png', buffer: Buffer.from('PNG') });
    await page.waitForFunction((n) => document.querySelector('#prompt').value.includes(`（我上传了：上传/${n}照片.png）`), label);
    check(`${label} 📎 上传后输入框里写上了文件路径`, fs.readFileSync(path.join(dataDir, 'workspace', '上传', `${label}照片.png`), 'utf8') === 'PNG');
    const asrBefore = ds.requests.filter((r) => r.url === '/v1/tools/asr').length;
    await page.click('#mic');
    await page.waitForSelector('#mic.recording');
    await page.waitForTimeout(1200);
    await page.click('#mic');
    await page.waitForFunction(() => document.querySelector('#prompt').value.includes('今天天气怎么样'), null, { timeout: 15000 });
    const asrReq = ds.requests.filter((r) => r.url === '/v1/tools/asr').at(-1);
    check(`${label} 🎤 录音转成 16kHz wav 交给识别，文字填进输入框`, ds.requests.filter((r) => r.url === '/v1/tools/asr').length === asrBefore + 1 && asrReq.audioName === 'speech.wav' && asrReq.audioSize > 16000);
    check(`${label} 识别后麦克风回到待命`, !(await page.isVisible('#mic.recording')));
    check(`${label} 输入框跟着内容长高，第一行没被挤出去`, await page.evaluate(() => { const p = document.querySelector('#prompt'); return p.scrollTop === 0 && p.scrollHeight <= p.clientHeight + 2; }));
    await page.screenshot({ path: path.join(out, `${label}-composer.png`) });
    check(`${label} “深度思考”默认关`, !(await page.isChecked('#think')));
    check(`${label} 模型一栏的字不被挤成竖排`, await page.evaluate(() => { const l = document.querySelector('.model-bar > label[for=model]'); return l.getBoundingClientRect().height < 24; }));
    await page.check('#think');
    await page.fill('#prompt', '你好');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.msg.agent + .speak:not([hidden])');
    const thinkReq = model.requests.filter((r) => r.url.startsWith('/v1/messages')).at(-1).body;
    check(`${label} 打开“深度思考”后，发给模型的请求真的带上思考`, thinkReq.thinking?.type === 'adaptive');
    await page.reload();
    await page.waitForSelector('#chat:not([hidden])');
    check(`${label} 刷新后还记得“深度思考”的选择`, await page.isChecked('#think'));
    await page.uncheck('#think');
    await page.fill('#prompt', '你好');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.msg.agent + .speak:not([hidden])');
    check(`${label} 发送后输入框缩回一行`, await page.evaluate(() => document.querySelector('#prompt').getBoundingClientRect().height < 60));
    const ttsBefore = ds.requests.filter((r) => r.url === '/v1/tools/tts').length;
    await page.click('.speak >> nth=-1');
    await page.waitForFunction(() => [...document.querySelectorAll('.speak')].at(-1).textContent === '🔊 朗读' && !document.querySelector('#status').textContent.includes('失败'), null, { timeout: 15000 });
    const ttsReq = ds.requests.filter((r) => r.url === '/v1/tools/tts');
    check(`${label} 🔊 朗读：服务器转给 DeepSeek，放完回到“朗读”`, ttsReq.length === ttsBefore + 1 && ttsReq.at(-1).body.voice_id === 'stella' && ttsReq.at(-1).body.text.length > 0);
    check(`${label} 上传、语音没有页面脚本错误`, errors.length === 0);
    await page.close();
  }
  // 装成应用（PWA）：说明文件和图标、Chromium 的“能不能安装”检查、后台脚本接管后聊天照样实时出字、不缓存 /api、断网还能打开页面
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const man = await fetch(base + '/manifest.webmanifest');
    const manifest = await man.json();
    check('应用说明文件：类型对，名字、启动页、独立窗口、图标都有', man.headers.get('content-type') === 'application/manifest+json' && manifest.short_name === '未央' && manifest.start_url === '/' && manifest.display === 'standalone' && manifest.icons.some((i) => i.purpose === 'maskable'));
    for (const ic of manifest.icons) {
      const buf = Buffer.from(await (await fetch(base + ic.src)).arrayBuffer());
      const [w, h] = [buf.readUInt32BE(16), buf.readUInt32BE(20)];
      check(`图标 ${ic.src} 是 ${ic.sizes} 的 PNG`, buf.subarray(1, 4).toString() === 'PNG' && `${w}x${h}` === ic.sizes);
    }
    await page.goto(base);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    check('后台脚本已接管页面', await page.evaluate(() => Boolean(navigator.serviceWorker.controller)));
    const cdp = await ctx.newCDPSession(page);
    const inst = await cdp.send('Page.getInstallabilityErrors');
    check(`Chromium 检查：能装成应用（问题：${JSON.stringify(inst.installabilityErrors)}）`, inst.installabilityErrors.length === 0);
    if (await page.isVisible('#login-form')) { await page.fill('#password', cfg.password); await page.click('#login-form button'); }
    await page.waitForSelector('#chat:not([hidden])');
    check('普通电脑浏览器里不多显示“装到桌面”说明', !(await page.isVisible('#install-hint')));
    await page.click('#new-chat').catch(() => {});
    await page.fill('#prompt', '装成应用后说句话');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => [...document.querySelectorAll('.msg.agent')].some((n) => n.textContent.includes('收到：装成应用后说句话')));
    check('后台脚本接管后，聊天照样实时出字', true);
    const cached = await page.evaluate(async () => (await (await caches.open('weiyang-shell-v1')).keys()).map((r) => new URL(r.url).pathname));
    check(`缓存里只有网页本身，没有 /api（${cached.join(' ')}）`, cached.includes('/') && !cached.some((u) => u.startsWith('/api')));
    await ctx.setOffline(true);
    await page.reload().catch(() => {});
    check('断网时还能打开页面（用上次存下的）', await page.evaluate(() => Boolean(document.querySelector('#chat') && document.querySelector('#login'))));
    await ctx.setOffline(false);
    check('装成应用相关没有页面脚本错误', errors.length === 0);
    await ctx.close();
  }
  for (const [who, ua, want] of [
    ['苹果手机 Safari', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', '分享'],
    ['微信里', 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36 MicroMessenger/8.0.50', '在浏览器打开']
  ]) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: ua });
    const page = await ctx.newPage();
    await page.goto(base);
    if (await page.isVisible('#login-form')) { await page.fill('#password', cfg.password); await page.click('#login-form button'); }
    await page.waitForSelector('#chat:not([hidden])');
    await page.click('#toggle-side');
    await page.waitForSelector('#install:not([hidden])');
    await page.click('#install');
    check(`${who}：“装到桌面”给出手动步骤`, (await page.textContent('#install-hint')).includes(want));
    await ctx.close();
  }
  ds.server.close();
  oai.server.close(); bridge.close();
  check('全程没有往外连', proxy.attempts.length === 0);
  console.log(`网页端到端 ${results.length}/${results.length} 通过；截图在 ${out}`);
} finally {
  await browser.close();
  server.close(); model.server.close(); proxy.server.close();
}
