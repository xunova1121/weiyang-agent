/**
 * “忙”标记：有回复正在进行时，在数据目录里放一个 .busy 文件（内容是开始时间），做完就删。
 * 服务器上的自动更新（deploy/update.sh）看到它就先不重启，等下一轮，免得打断正在做的事。
 * 只是一个本地文件，不经过网络，外面看不到。
 */
import fs from 'node:fs';
import path from 'node:path';

export const BUSY_FILE = '.busy';

export function busyMarker(dataDir) {
  const file = path.join(dataDir, BUSY_FILE);
  // 启动时清掉上次异常退出留下的标记
  try { fs.rmSync(file, { force: true }); } catch { /* 删不了就算了 */ }
  return (busy) => {
    if (busy) fs.writeFileSync(file, String(Date.now()));
    else fs.rmSync(file, { force: true });
  };
}
