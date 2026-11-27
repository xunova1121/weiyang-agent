/**
 * 用服务器上的 LibreOffice 把 Word / PPT / Excel 转成 PDF（思路照原未央 server/officeRender.mjs）。
 * 没装 LibreOffice 就不转（create_document 改出可打印的网页并说明）。
 * 每次用一个临时的 LibreOffice 配置目录，宏一律禁用；只接受我们自己生成的这几种文件；一次只转一个，超时就杀掉。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const binary = () => process.env.WEIYANG_SOFFICE || 'soffice';
let available = null; // { bin, ok }：换了 WEIYANG_SOFFICE 就重新检查
let queue = Promise.resolve();

function run(args, { cwd, timeout = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary(), args, {
      cwd, stdio: ['ignore', 'ignore', 'pipe'], detached: process.platform !== 'win32',
      env: { PATH: process.env.PATH, HOME: cwd || os.tmpdir(), LANG: 'C.UTF-8' } // 不带服务器的其他环境变量（含密钥）
    });
    let err = '';
    child.stderr.on('data', (b) => { if (err.length < 4000) err += b; });
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } };
    const timer = setTimeout(() => { kill(); reject(new Error('LibreOffice 转换超时')); }, timeout);
    child.once('error', (e) => { clearTimeout(timer); reject(e); });
    child.once('close', (code) => { clearTimeout(timer); resolve({ code, err }); });
  });
}

export function officeAvailable() {
  if (available?.bin !== binary()) available = { bin: binary(), ok: run(['--version'], { timeout: 15_000 }).then((r) => r.code === 0).catch(() => false) };
  return available.ok;
}

/** @returns {Promise<Buffer|null>} PDF；没装 LibreOffice 时返回 null */
export async function toPdf(buffer, ext) {
  if (!['docx', 'pptx', 'xlsx'].includes(ext)) throw new Error('只转 docx / pptx / xlsx');
  if (!(await officeAvailable())) return null;
  const job = queue.catch(() => {}).then(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'weiyang-office-'));
    try {
      const profile = path.join(dir, 'profile');
      await fs.mkdir(path.join(profile, 'user'), { recursive: true });
      // 宏安全级别“非常高”：不运行任何宏
      await fs.writeFile(path.join(profile, 'user', 'registrymodifications.xcu'), '<?xml version="1.0" encoding="UTF-8"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item></oor:items>');
      const input = path.join(dir, `document.${ext}`);
      await fs.writeFile(input, buffer);
      const r = await run([`-env:UserInstallation=${pathToFileURL(profile).href}`, '--headless', '--nologo', '--nodefault', '--nolockcheck', '--norestore', '--convert-to', 'pdf', '--outdir', dir, input], { cwd: dir });
      if (r.code !== 0) throw new Error('LibreOffice 转换失败');
      const pdf = await fs.readFile(path.join(dir, 'document.pdf'));
      if (pdf.subarray(0, 5).toString() !== '%PDF-') throw new Error('LibreOffice 没生成有效的 PDF');
      return pdf;
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
  queue = job;
  return job;
}
