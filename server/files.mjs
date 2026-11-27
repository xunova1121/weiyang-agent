/**
 * 工作文件夹的文件：列目录、下载、上传、删除（用户自己在网页上操作，不经过模型）。
 * 所有路径都先过 insideWorkspace（和工具用的是同一套判断：../、绝对路径、符号链接指向外面都拒绝），
 * 所以网页上也碰不到配置（含密钥）、登录令牌和对话记录。
 */
import fs from 'node:fs';
import path from 'node:path';
import { insideWorkspace } from './pathGuard.mjs';

export const MAX_UPLOAD = 20 * 1024 * 1024; // 单个文件 20MB
const MAX_LIST = 500;
const BAD_NAME = /[\\/:*?"<>|\u0000-\u001f]/;

export function createFiles(workspace) {
  fs.mkdirSync(workspace, { recursive: true });
  /** 把网页给的相对路径换成真实路径；不在工作文件夹里返回 null */
  const resolve = (rel = '') => {
    const s = String(rel ?? '').replace(/^\/+/, '');
    if (!insideWorkspace(workspace, s || '.')) return null;
    return path.resolve(workspace, s || '.');
  };
  const relOf = (abs) => path.relative(workspace, abs).split(path.sep).join('/');

  return {
    resolve,
    list(rel = '') {
      const dir = resolve(rel);
      if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return null;
      const items = [];
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        if (items.length >= MAX_LIST) break;
        const abs = path.join(dir, d.name);
        // 符号链接只列指向工作文件夹里面的
        if (!insideWorkspace(workspace, relOf(abs))) continue;
        let st;
        try { st = fs.statSync(abs); } catch { continue; }
        items.push({ name: d.name, path: relOf(abs), dir: st.isDirectory(), size: st.isDirectory() ? null : st.size, modified: st.mtimeMs });
      }
      items.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, 'zh-CN') : a.dir ? -1 : 1));
      return { path: relOf(dir) === '' ? '' : relOf(dir), items, truncated: items.length >= MAX_LIST };
    },
    /** 下载：返回 { abs, size, name } 或 null */
    file(rel) {
      const abs = resolve(rel);
      if (!abs || abs === path.resolve(workspace)) return null;
      try {
        const st = fs.statSync(abs);
        return st.isFile() ? { abs, size: st.size, name: path.basename(abs) } : null;
      } catch { return null; }
    },
    /** 上传到 dir/name：重名自动加序号，不覆盖已有文件 */
    async save(relDir, name, stream) {
      const dir = resolve(relDir);
      const clean = String(name ?? '').trim();
      if (!dir || !clean || clean === '.' || clean === '..' || BAD_NAME.test(clean) || clean.length > 200) return { error: '文件名不对', status: 400 };
      fs.mkdirSync(dir, { recursive: true });
      const ext = path.extname(clean);
      const stem = clean.slice(0, clean.length - ext.length);
      let target = path.join(dir, clean);
      for (let i = 2; fs.existsSync(target); i++) target = path.join(dir, `${stem}(${i})${ext}`);
      if (!insideWorkspace(workspace, relOf(target))) return { error: '只能传到工作文件夹里', status: 400 };
      const tmp = target + '.uploading';
      let size = 0;
      try {
        const out = fs.createWriteStream(tmp, { flags: 'wx' });
        for await (const chunk of stream) {
          size += chunk.length;
          if (size > MAX_UPLOAD) { out.destroy(); throw Object.assign(new Error(`文件太大（最多 ${MAX_UPLOAD / 1024 / 1024}MB）`), { status: 413 }); }
          if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        }
        await new Promise((resolveDone, reject) => out.end((e) => (e ? reject(e) : resolveDone())));
        fs.renameSync(tmp, target);
        return { path: relOf(target), size };
      } catch (e) {
        fs.rmSync(tmp, { force: true });
        return { error: e.status ? e.message : '保存失败', status: e.status || 500 };
      }
    },
    remove(rel) {
      const abs = resolve(rel);
      if (!abs || abs === path.resolve(workspace) || !fs.existsSync(abs)) return false;
      // 只删这一项本身：是符号链接就删链接，不跟到外面
      const st = fs.lstatSync(abs);
      if (st.isDirectory()) fs.rmSync(abs, { recursive: true, force: true });
      else fs.unlinkSync(abs);
      return true;
    }
  };
}
