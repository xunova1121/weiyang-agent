/**
 * Word / PPT / Excel / PDF：原未央引擎在服务器上真的生成，再读回核对；路径只许在工作文件夹里；
 * 真的 SDK 调用时生成文件要先确认，读文件直接放行。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { startFakeModel } from './fakeModel.mjs';
import { createAuth } from '../server/auth.mjs';
import { createTasks } from '../server/tasks.mjs';
import { createHttpServer } from '../server/http.mjs';
import { runAgent } from '../server/agentRunner.mjs';
import { createSessions, useConfigDir } from '../server/sessions.mjs';
import { workspaceResolver } from '../server/tools/registry.mjs';
import { tools } from '../server/tools/documents.mjs';
import { officeAvailable } from '../server/officeRender.mjs';

const REPORT = `# 2026年工作总结

## 一、主要成绩

- 完成项目 12 个
- 营收增长 18%

## 二、数据

| 月份 | 收入 | 支出 |
|---|--:|--:|
| 1月 | 100 | 80 |
| 2月 | 120 | 90 |

![现场照片](图片/现场.png)

## 三、下一步

继续推进。`;

// 1×1 的 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function toolsIn(ws) {
  const list = tools({ cfg: {}, workspace: ws, resolve: workspaceResolver(ws) });
  return Object.fromEntries(list.map((t) => [t.name, (args) => t.run(args)]));
}
function freshWorkspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-docs-'));
  fs.mkdirSync(path.join(ws, '图片'));
  fs.writeFileSync(path.join(ws, '图片', '现场.png'), PNG);
  return ws;
}

test('Word：默认存到“文档/标题.docx”，重名加序号；有目录、图片嵌进去，读回内容对', async () => {
  const ws = freshWorkspace();
  const t = toolsIn(ws);
  const r = await t.create_document({ format: 'docx', content: REPORT });
  assert.match(r, /已生成：文档\/2026年工作总结\.docx/);
  assert.match(r, /3 个标题，带目录/);
  assert.doesNotMatch(r, /没找到/, '工作文件夹里的图片找到了');
  const zip = await JSZip.loadAsync(fs.readFileSync(path.join(ws, '文档', '2026年工作总结.docx')));
  assert.ok(Object.keys(zip.files).some((f) => f.startsWith('word/media/')), '图片真的嵌进了 Word');
  assert.match(await zip.file('word/document.xml').async('string'), /主要成绩/);
  const again = await t.create_document({ format: 'docx', content: REPORT });
  assert.match(again, /已生成：文档\/2026年工作总结\(2\)\.docx/, '重名不覆盖');
  const read = await t.read_document({ path: '文档/2026年工作总结.docx' });
  assert.match(read, /一、主要成绩[\s\S]*完成项目 12 个/);
});

test('改已有文件：path 填原路径就覆盖；回执说“已覆盖”', async () => {
  const ws = freshWorkspace();
  const t = toolsIn(ws);
  await t.create_document({ format: 'docx', content: '# 通知\n\n第一版', path: '通知.docx' });
  const r = await t.create_document({ format: 'docx', content: '# 通知\n\n第二版', path: '通知.docx' });
  assert.match(r, /已覆盖：通知\.docx/);
  assert.match(await t.read_document({ path: '通知.docx' }), /第二版/);
  assert.equal(fs.readdirSync(ws).filter((f) => f.startsWith('通知')).length, 1);
});

test('PPT：按内容自动选版式，回执里有页数；读回每页文字', async () => {
  const ws = freshWorkspace();
  const t = toolsIn(ws);
  const r = await t.create_document({ format: 'pptx', title: '项目汇报', content: '## 建设必要性：补齐告警到处置的人工断点\n\n- 预警研判：多源证据汇聚\n- 处置闭环：自动派单\n- 复盘改进：指标量化\n\n## 关键数字\n\n- 67 万元：总投资\n- 12 个：监测点\n\n## 谢谢' });
  assert.match(r, /4 页幻灯片（版式：cover、cards、stats、end）/);
  const read = await t.read_document({ path: '文档/项目汇报.pptx' });
  assert.match(read, /第 2 页幻灯片[\s\S]*预警研判/);
});

test('Excel：“合计”行写成公式；读回能看到公式清单', async () => {
  const ws = freshWorkspace();
  const t = toolsIn(ws);
  const r = await t.create_document({ format: 'xlsx', title: '收支', content: '## 收支\n| 月份 | 收入 | 支出 |\n|---|--:|--:|\n| 1月 | 100 | 80 |\n| 2月 | 120 | 90 |\n| 合计 | | |' });
  assert.match(r, /1 个工作表、2 个公式/);
  const read = await t.read_document({ path: '文档/收支.xlsx' });
  assert.match(read, /B4 =SUM\(B2:B3\)/);
});

test('PDF：装了 LibreOffice 就是真 PDF；没装（或转换失败）做成可打印网页并说明', async (t) => {
  const ws = freshWorkspace();
  const tool = toolsIn(ws);
  const saved = process.env.WEIYANG_SOFFICE;
  try {
    process.env.WEIYANG_SOFFICE = '/nonexistent/soffice';
    const r = await tool.create_document({ format: 'pdf', content: REPORT });
    assert.match(r, /已生成：文档\/2026年工作总结\.html/);
    assert.match(r, /没装 LibreOffice/);
    assert.match(fs.readFileSync(path.join(ws, '文档', '2026年工作总结.html'), 'utf8'), /data:image\/png;base64/, '网页里图片已内嵌');
  } finally {
    if (saved === undefined) delete process.env.WEIYANG_SOFFICE; else process.env.WEIYANG_SOFFICE = saved;
  }
  if (!(await officeAvailable())) return t.skip('这台机器没装 LibreOffice，真 PDF 那半没测');
  const r = await tool.create_document({ format: 'pdf', content: REPORT, path: '报告.pdf' });
  assert.match(r, /已生成：报告\.pdf/);
  assert.equal(fs.readFileSync(path.join(ws, '报告.pdf')).subarray(0, 5).toString(), '%PDF-');
  assert.match(r, /读回的开头：[\s\S]*主要成绩/, 'PDF 读回有文字（中文字体正常）');
});

test('路径只许在工作文件夹里；网上的图片不下载；读不支持的格式说人话', async () => {
  const ws = freshWorkspace();
  const t = toolsIn(ws);
  await assert.rejects(t.create_document({ format: 'docx', content: '# x\n\n内容', path: '../外面.docx' }), /只能访问工作文件夹里的文件/);
  assert.ok(!fs.existsSync(path.join(path.dirname(ws), '外面.docx')));
  await assert.rejects(t.read_document({ path: '../../etc/passwd' }), /只能访问工作文件夹里的文件/);
  const r = await t.create_document({ format: 'docx', content: '# 图\n\n![网图](https://example.com/a.png)' });
  assert.match(r, /这些图片没找到，留了占位：https:\/\/example\.com\/a\.png/);
  fs.writeFileSync(path.join(ws, 'a.exe'), 'x');
  await assert.rejects(t.read_document({ path: 'a.exe' }), /这种文件读不了/);
  await assert.rejects(t.create_document({ format: 'docx', content: '  ' }), /content 是空的/);
});

/* ---------- 真的 SDK ---------- */

const PASSWORD = 'docs-password';
let model, server, base, token, ws;
before(async () => {
  model = await startFakeModel();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-docs-e2e-'));
  ws = path.join(dataDir, 'workspace');
  fs.mkdirSync(ws, { recursive: true });
  const cfg = { dataDir, password: PASSWORD, apiKey: 'fake', baseUrl: model.url, model: 'deepseek-flash', commands: false };
  useConfigDir(cfg);
  server = createHttpServer({ auth: createAuth({ password: PASSWORD, dataDir }), tasks: createTasks({ run: (o) => runAgent(cfg, o) }), cfg, sessions: createSessions(cfg) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  token = (await (await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) })).json()).token;
});
after(() => { server?.close(); model?.server.close(); });

const H = () => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + token });
async function ask(text, decide) {
  const res = await fetch(base + '/api/tasks', { method: 'POST', headers: { ...H(), Accept: 'text/event-stream' }, body: JSON.stringify({ text }) });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const evs = [];
  let buf = '', id = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const data = buf.slice(0, i).split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
      buf = buf.slice(i + 2);
      if (!data) continue;
      const ev = JSON.parse(data);
      evs.push(ev);
      if (ev.type === 'task_created') id = ev.id;
      if (ev.type === 'permission') await fetch(`${base}/api/tasks/${id}/permission`, { method: 'POST', headers: H(), body: JSON.stringify({ requestId: ev.requestId, decision: decide?.(ev) ?? 'deny' }) });
    }
  }
  return { evs, text: evs.filter((e) => e.type === 'text').map((e) => e.delta).join('') };
}

test('真的 SDK：生成文件先弹确认框，拒绝就不生成；允许才生成；读文件直接放行', async () => {
  const call = '调用工具 mcp__weiyang__create_document {"format":"docx","title":"会议纪要","content":"# 会议纪要\\n\\n## 议题\\n\\n- 讨论预算"}';
  const no = await ask(call, () => 'deny');
  const p = no.evs.find((e) => e.type === 'permission');
  assert.equal(p?.name, 'mcp__weiyang__create_document');
  assert.ok(!fs.existsSync(path.join(ws, '文档')), '拒绝了就没生成');
  const yes = await ask(call, () => 'allow');
  assert.match(yes.text, /工具成功：已生成：文档\/会议纪要\.docx/);
  assert.ok(fs.existsSync(path.join(ws, '文档', '会议纪要.docx')));
  const read = await ask('调用工具 mcp__weiyang__read_document {"path":"文档/会议纪要.docx"}');
  assert.ok(!read.evs.some((e) => e.type === 'permission'), '读不弹确认');
  assert.match(read.text, /工具成功：“文档\/会议纪要.docx”的内容[\s\S]*讨论预算/);
});
