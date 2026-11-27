/**
 * 安卓 App / Windows 程序的配置自检（不需要安卓 SDK、不需要 Windows）：
 * 两个壳连的服务器地址和 apps/shell.json 一致；安卓清单里有“分享 → 未央”、通知、麦克风；
 * 网页用到的壳功能两边都提供；Windows 打包清单里的文件都在；签名密钥不进仓库。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const shell = JSON.parse(read('apps/shell.json'));

test('服务器地址：apps/shell.json 是 https；安卓配置由它生成、两边一致', () => {
  assert.match(shell.serverUrl, /^https:\/\/[^/]+$/);
  const cap = JSON.parse(read('apps/android/capacitor.config.json'));
  assert.equal(cap.server.url, shell.serverUrl, '改了 apps/shell.json 要在 apps/android 里跑 npm run config');
  assert.equal(cap.server.errorPath, 'offline.html');
  assert.ok(fs.existsSync(path.join(ROOT, 'apps/android/www/offline.html')));
  assert.equal(cap.android.webContentsDebuggingEnabled, false, '正式版不开网页调试');
  assert.equal(cap.android.allowMixedContent, false);
});

test('安卓清单：分享进来（单个、多个）、通知、麦克风；插件已注册', () => {
  const m = read('apps/android/android/app/src/main/AndroidManifest.xml');
  for (const a of ['android.intent.action.SEND"', 'android.intent.action.SEND_MULTIPLE"']) assert.ok(m.includes(a), a);
  for (const p of ['POST_NOTIFICATIONS', 'RECORD_AUDIO', 'INTERNET']) assert.ok(m.includes(`android.permission.${p}`), p);
  const main = read('apps/android/android/app/src/main/java/com/xunova/weiyang2/MainActivity.java');
  assert.match(main, /registerPlugin\(WeiyangShellPlugin\.class\)/);
  const plugin = read('apps/android/android/app/src/main/java/com/xunova/weiyang2/WeiyangShellPlugin.java');
  assert.match(plugin, /@CapacitorPlugin\(name = "WeiyangShell"\)/);
  for (const fn of ['notify', 'saveFile']) assert.match(plugin, new RegExp(`@PluginMethod\\s+public void ${fn}\\(`), fn);
  assert.match(plugin, /notifyListeners\("shared", data, true\)/, '网页还没打开时分享的内容先留着');
  const gradle = read('apps/android/android/app/build.gradle');
  assert.match(gradle, /System\.getenv\("WEIYANG_KEYSTORE"\)/, '签名密钥从环境变量来');
});

test('网页用到的壳功能，两边都提供', () => {
  const web = read('web/app.js');
  const preload = read('apps/desktop/preload.cjs');
  for (const fn of ['notify', 'setServer', 'changeServer']) assert.match(preload, new RegExp(`${fn}:`), `Windows 壳提供 ${fn}`);
  assert.match(web, /window\.weiyangShell\.notify/);
  assert.match(web, /Plugins\.WeiyangShell\.notify\(/);
  assert.match(web, /addListener\('shared'/);
  assert.match(web, /cap\.saveFile\(/);
});

test('Windows 打包：清单里的文件都在；单实例、托盘、权限只给服务器网站', () => {
  const pkg = JSON.parse(read('apps/desktop/package.json'));
  for (const f of pkg.build.files) if (f !== 'shell.json') assert.ok(fs.existsSync(path.join(ROOT, 'apps/desktop', f)), f);
  assert.equal(pkg.build.publish.repo, 'weiyang-agent');
  assert.match(pkg.scripts.predist, /sync/, '打包前把 apps/shell.json 复制进去');
  for (const v of Object.values({ ...pkg.dependencies, ...pkg.devDependencies })) assert.match(v, /^\d+\.\d+\.\d+$/, '版本写死');
  const main = read('apps/desktop/main.cjs');
  assert.match(main, /requestSingleInstanceLock/);
  assert.match(main, /contextIsolation: true, sandbox: true, nodeIntegration: false/);
  assert.match(main, /setPermissionRequestHandler/);
});

test('仓库里没有签名密钥文件', () => {
  const bad = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (['node_modules', '.git', 'build', '.gradle'].includes(e.name)) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (/\.(keystore|jks|p12|pfx)$/i.test(e.name)) bad.push(p);
  } };
  walk(path.join(ROOT, 'apps'));
  assert.deepEqual(bad, []);
});
