/**
 * 按 apps/shell.json 生成 capacitor.config.json：App 打开就是你的服务器（server.url），
 * 别的网站的链接交给系统浏览器；连不上时显示 www/offline.html。
 */
import fs from 'node:fs';
const shell = JSON.parse(fs.readFileSync(new URL('../shell.json', import.meta.url), 'utf8'));
const url = new URL(shell.serverUrl);
if (url.protocol !== 'https:') throw new Error('apps/shell.json 里的 serverUrl 要 https:// 开头');
const config = {
  appId: 'com.xunova.weiyang2',
  appName: shell.appName || '未央',
  webDir: 'www',
  backgroundColor: '#f6f4ee',
  server: { url: url.origin, errorPath: 'offline.html' },
  android: { allowMixedContent: false, webContentsDebuggingEnabled: false },
  plugins: { CapacitorHttp: { enabled: false } }
};
fs.writeFileSync(new URL('./capacitor.config.json', import.meta.url), JSON.stringify(config, null, 2) + '\n');
console.log('capacitor.config.json：', url.origin);
