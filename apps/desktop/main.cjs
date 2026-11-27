/**
 * 未央 Agent 版的 Windows 程序：只是一个连你自己服务器的窗口，功能全在服务器的网页里（跟着服务器自动更新）。
 * 壳本身多做这几件事：托盘图标（关窗口不退出）、回复做完时弹系统通知、开机自启、壳自己的自动更新（GitHub Releases）。
 *
 * 安全：网页没有 Node 权限（contextIsolation + sandbox），只拿到 preload.cjs 里那几个函数；
 * 窗口只停留在服务器那个网站上，别的链接一律交给系统浏览器打开；麦克风、通知只给服务器那个网站。
 */
const { app, BrowserWindow, Tray, Menu, Notification, shell, ipcMain, session, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = (() => { try { return require('./shell.json'); } catch { return { serverUrl: '' }; } })();
const ICON = path.join(__dirname, 'build', 'icon.png');
let win = null, tray = null, quitting = false;

/** 只认 https，或本机测试用的 http://127.0.0.1 / localhost */
function cleanUrl(raw) {
  try {
    const u = new URL(String(raw || '').trim());
    const local = ['127.0.0.1', 'localhost'].includes(u.hostname);
    if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) return null;
    if (u.username || u.password) return null;
    return u.origin;
  } catch { return null; }
}

const cfgFile = () => path.join(app.getPath('userData'), 'config.json');
function loadCfg() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(cfgFile(), 'utf8')); } catch { /* 第一次打开 */ }
  // 测试或临时改地址：环境变量优先
  const serverUrl = cleanUrl(process.env.WEIYANG_SERVER_URL) || cleanUrl(saved.serverUrl) || cleanUrl(DEFAULTS.serverUrl);
  return { serverUrl };
}
function saveCfg(cfg) {
  fs.mkdirSync(path.dirname(cfgFile()), { recursive: true });
  fs.writeFileSync(cfgFile(), JSON.stringify(cfg, null, 2));
}

let cfg = { serverUrl: null };
const onServer = (url) => { try { return cfg.serverUrl && new URL(url).origin === cfg.serverUrl; } catch { return false; } };

function showSetup(error = '') {
  win.loadFile(path.join(__dirname, 'setup.html'), { query: { current: cfg.serverUrl || '', error } });
}

function openServer() {
  if (!cfg.serverUrl) return showSetup();
  win.loadURL(cfg.serverUrl).catch(() => showSetup('连不上这个地址，检查一下网络，或者改个地址'));
}

function show() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100, height: 780, minWidth: 360, minHeight: 500, icon: ICON, autoHideMenuBar: true, backgroundColor: '#f6f4ee', title: '未央',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false }
  });
  // 新窗口、外部链接：交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (onServer(url) || url.startsWith('file:')) return;
    e.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } }); // 关窗口只是藏到托盘
  win.on('closed', () => { win = null; });
  openServer();
}

function buildTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setToolTip('未央');
  const menu = () => Menu.buildFromTemplate([
    { label: '打开未央', click: show },
    { label: '更改服务器地址…', click: () => { show(); showSetup(); } },
    { label: '开机自动启动', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: (item) => { app.setLoginItemSettings({ openAtLogin: item.checked }); tray.setContextMenu(menu()); } },
    { label: '检查更新', enabled: app.isPackaged, click: () => checkUpdates(true) },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(menu());
  tray.on('click', show);
}

function checkUpdates(manual = false) {
  if (!app.isPackaged) return;
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.checkForUpdatesAndNotify().catch((e) => { if (manual) notify('检查更新失败', String(e?.message || e).slice(0, 120)); });
  } catch { /* 更新模块坏了不影响使用 */ }
}

function notify(title, body) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: ICON });
  n.on('click', show);
  n.show();
}

// 网页（服务器那个网站）调用：回复做完、窗口不在前面时提醒
ipcMain.on('notify', (e, title, body) => {
  if (!onServer(e.senderFrame?.url || '')) return;
  if (win && win.isVisible() && win.isFocused()) return;
  notify(String(title).slice(0, 80), String(body).slice(0, 200));
  win?.flashFrame(true);
});
// 地址设置页调用
ipcMain.handle('set-server', (e, raw) => {
  if (!String(e.senderFrame?.url || '').startsWith('file:')) return { error: '只能在设置页里改' };
  const url = cleanUrl(raw);
  if (!url) return { error: '地址要以 https:// 开头' };
  cfg = { serverUrl: url };
  saveCfg(cfg);
  openServer();
  return { ok: true };
});
ipcMain.on('change-server', (e) => { if (onServer(e.senderFrame?.url || '')) showSetup(); });

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', show);
  app.whenReady().then(() => {
    cfg = loadCfg();
    // 麦克风（语音输入）、通知、剪贴板写入只给服务器那个网站
    session.defaultSession.setPermissionRequestHandler((wc, permission, done, details) => {
      done(onServer(details.requestingUrl || wc.getURL()) && ['media', 'notifications', 'clipboard-sanitized-write'].includes(permission));
    });
    createWindow();
    buildTray();
    checkUpdates();
  });
  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', () => { /* 留在托盘里 */ });
}
