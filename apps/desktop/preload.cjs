/**
 * 网页能用的壳功能（只有这几个，网页拿不到 Node）。网页里用 window.weiyangShell 判断是不是在 Windows 程序里。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('weiyangShell', {
  platform: 'windows',
  /** 回复做完时提醒（窗口在前面时不弹） */
  notify: (title, body) => ipcRenderer.send('notify', String(title ?? ''), String(body ?? '')),
  /** 打开“更改服务器地址”页 */
  changeServer: () => ipcRenderer.send('change-server'),
  /** 设置页用：保存服务器地址并打开 */
  setServer: (url) => ipcRenderer.invoke('set-server', String(url ?? ''))
});
