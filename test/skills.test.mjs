/**
 * Anthropic 文档技能（skills/weiyang-office）：开关条件、技能目录只读、真的 SDK 加载技能，
 * 技能脚本真的在沙箱里跑（改 Word、Excel 公式重算）。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFakeModel, startLoggingProxy } from './fakeModel.mjs';
import { createAuth } from '../server/auth.mjs';
import { createTasks } from '../server/tasks.mjs';
import { createHttpServer } from '../server/http.mjs';
import { runAgent, sandboxSettings, sandboxStatus } from '../server/agentRunner.mjs';
import { createSessions, useConfigDir } from '../server/sessions.mjs';
import { checkToolPaths } from '../server/pathGuard.mjs';
import { officeSkillsStatus, SKILLS_DIR, PLUGIN_DIR } from '../server/officeSkills.mjs';
import { generate } from '../server/docs/agent/docs.js';
import { officeAvailable } from '../server/officeRender.mjs';

const PYTHON = officeSkillsStatus();
const CAN_RUN = sandboxStatus() === 'ok' && PYTHON.status === 'ok';
const SKIP_WHY = sandboxStatus() !== 'ok' ? '本机沙箱用不了' : `本机缺 Python 库：${PYTHON.missing.join('、')}`;

/* ---------- 单元 ---------- */

test('要求技能的环境里（GitHub 自动测试跑过 install-office.sh）技能测试必须真的跑，不能悄悄跳过', { skip: process.env.REQUIRE_OFFICE_SKILLS === '1' ? false : '没要求' }, async () => {
  assert.equal(sandboxStatus(), 'ok', '沙箱要能用');
  assert.deepEqual(PYTHON, { status: 'ok', missing: [] }, 'Python 库要齐');
  assert.ok(await officeAvailable(), 'LibreOffice 要装上');
});

test('技能原样带着许可：三个技能都有 Apache 2.0 的 LICENSE.txt 和来源说明', () => {
  for (const s of ['docx', 'pptx', 'xlsx']) {
    assert.match(fs.readFileSync(path.join(SKILLS_DIR, s, 'LICENSE.txt'), 'utf8'), /Apache License\s+Version 2\.0/);
    assert.match(fs.readFileSync(path.join(SKILLS_DIR, s, 'SKILL.md'), 'utf8'), new RegExp(`^---\\nname: ${s}\\n`));
  }
  assert.match(fs.readFileSync(path.join(PLUGIN_DIR, 'NOTICE.md'), 'utf8'), /github\.com\/anthropics\/skills[\s\S]*Apache License 2\.0/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, '.claude-plugin', 'plugin.json'), 'utf8')).name, 'weiyang-office');
});

test('Python 检查：缺哪个库说哪个；没有 python3 也不崩', () => {
  assert.deepEqual(officeSkillsStatus({ spawn: () => ({ status: 0, stdout: 'openpyxl,pptx\n' }) }), { status: 'missing', missing: ['openpyxl', 'pptx'] });
  assert.deepEqual(officeSkillsStatus({ spawn: () => ({ status: 0, stdout: '\n' }) }), { status: 'ok', missing: [] });
  assert.deepEqual(officeSkillsStatus({ spawn: () => ({ error: Object.assign(new Error('x'), { code: 'ENOENT' }) }) }), { status: 'missing', missing: ['python3'] });
});

test('路径守卫：技能目录只许读（绝对路径）；不许写、不许改；没开技能时照旧读不到', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-sk-guard-'));
  const skill = path.join(SKILLS_DIR, 'docx', 'SKILL.md');
  const ro = { readOnly: [SKILLS_DIR] };
  assert.equal(checkToolPaths(ws, 'Read', { file_path: skill }, ro), null);
  assert.equal(checkToolPaths(ws, 'Grep', { path: SKILLS_DIR, pattern: 'x' }, ro), null);
  assert.equal(checkToolPaths(ws, 'Glob', { path: path.join(SKILLS_DIR, 'xlsx'), pattern: '**/*.py' }, ro), null);
  assert.match(checkToolPaths(ws, 'Write', { file_path: skill, content: 'x' }, ro), /只能访问工作文件夹/);
  assert.match(checkToolPaths(ws, 'Edit', { file_path: skill, old_string: 'a', new_string: 'b' }, ro), /只能访问工作文件夹/);
  assert.match(checkToolPaths(ws, 'Read', { file_path: skill }), /只能访问工作文件夹/, '没开技能时读不到');
  assert.match(checkToolPaths(ws, 'Read', { file_path: path.join(SKILLS_DIR, '..', '..', 'server', 'config.mjs') }, ro), /只能访问工作文件夹/, '.. 跳出技能目录不行');
  assert.match(checkToolPaths(ws, 'Read', { file_path: path.join(PLUGIN_DIR, '..', '..', 'package.json') }, ro), /只能访问工作文件夹/);
});

test('沙箱可写范围：没开技能只有工作文件夹；开了技能多一处 /var/tmp（LibreOffice 的管道要用），配置目录照旧不许读', () => {
  const base = { dataDir: '/srv/data' };
  assert.deepEqual(sandboxSettings(base).filesystem.allowWrite, ['/srv/data/workspace']);
  assert.deepEqual(sandboxSettings({ ...base, officeSkills: true }).filesystem.allowWrite, ['/srv/data/workspace', '/var/tmp']);
  assert.deepEqual(sandboxSettings({ ...base, officeSkills: true }).filesystem.denyRead, ['/srv/data']);
  assert.deepEqual(sandboxSettings({ ...base, officeSkills: true }).network.allowedDomains, []);
});

/* ---------- 真的 SDK + 沙箱 ---------- */

let model, proxy, server, base, token, cfg, ws;
before(async () => {
  model = await startFakeModel();
  proxy = await startLoggingProxy();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-skills-'));
  ws = path.join(dataDir, 'workspace');
  fs.mkdirSync(ws, { recursive: true });
  cfg = { dataDir, password: 'skills-password', apiKey: 'fake', baseUrl: model.url, model: 'deepseek-flash', commands: CAN_RUN, officeSkills: CAN_RUN };
  useConfigDir(cfg);
  const extraEnv = { HTTPS_PROXY: proxy.url, HTTP_PROXY: proxy.url, https_proxy: proxy.url, http_proxy: proxy.url, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
  server = createHttpServer({ auth: createAuth({ password: cfg.password, dataDir }), tasks: createTasks({ run: (o) => runAgent(cfg, { ...o, extraEnv }) }), cfg, sessions: createSessions(cfg) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  token = (await (await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: cfg.password }) })).json()).token;
});
after(() => { server?.close(); model?.server.close(); proxy?.server.close(); });

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
const lastRequest = () => model.requests.filter((r) => r.url.startsWith('/v1/messages')).at(-1).body;

test('开了技能：模型看得到 Skill 工具和三个技能，系统提示里写了分工', { skip: CAN_RUN ? false : SKIP_WHY }, async () => {
  await ask('你好');
  const req = lastRequest();
  assert.ok(req.tools.some((t) => t.name === 'Skill'), '有 Skill 工具');
  const all = JSON.stringify(req);
  for (const s of ['docx', 'pptx', 'xlsx']) assert.ok(all.includes(`weiyang-office:${s}`), `技能清单里有 ${s}`);
  assert.match(JSON.stringify(req.system), /文档分工：新建 Word/);
  assert.equal(proxy.attempts.length, 0, '没有往外连');
});

test('调用技能直接放行，技能说明真的读进来；技能目录可以读、不能写', { skip: CAN_RUN ? false : SKIP_WHY }, async () => {
  const r = await ask('调用工具 Skill {"skill":"weiyang-office:docx"}');
  assert.ok(!r.evs.some((e) => e.type === 'permission'), '读技能说明不弹确认');
  assert.match(r.text, /工具成功/);
  const sent = JSON.stringify(model.requests.at(-1).body.messages);
  assert.match(sent, /DOCX creation, editing, and analysis/, '技能内容进了对话');
  const read = await ask(`读文件 ${path.join(SKILLS_DIR, 'xlsx', 'SKILL.md')}`);
  assert.match(read.text, /工具成功/);
  const write = await ask(`写文件 ${path.join(SKILLS_DIR, 'docx', 'evil.md')} 坏东西`, () => 'allow');
  assert.match(write.text, /工具失败/);
  assert.ok(!fs.existsSync(path.join(SKILLS_DIR, 'docx', 'evil.md')));
});

test('技能脚本在沙箱里真的跑：合并 Word 文字片段，输出到工作文件夹（跑命令要确认）', { skip: CAN_RUN ? false : SKIP_WHY }, async () => {
  const docx = await generate('docx', { title: '合同', content: '# 合同\n\n## 第一条\n\n甲方应于十日内付款。' });
  fs.writeFileSync(path.join(ws, '合同.docx'), Buffer.from(await docx.blob.arrayBuffer()));
  const command = `python3 ${path.join(SKILLS_DIR, 'docx', 'scripts', 'merge_runs.py')} 合同.docx -o 合同-合并.docx`;
  const no = await ask('跑命令 ' + command, () => 'deny');
  assert.ok(no.evs.some((e) => e.type === 'permission' && e.name === 'Bash'), '跑脚本前弹了确认框');
  assert.ok(!fs.existsSync(path.join(ws, '合同-合并.docx')));
  const yes = await ask('跑命令 ' + command, () => 'allow');
  assert.match(yes.text, /工具成功/, yes.text);
  assert.ok(fs.existsSync(path.join(ws, '合同-合并.docx')), '脚本在沙箱里跑完，结果写进了工作文件夹');
  const bad = await ask(`跑命令 python3 -c "open('${path.join(SKILLS_DIR, 'x.txt')}','w').write('x')"`, () => 'allow');
  assert.match(bad.text, /工具失败|Read-only|Permission denied|只读/i, '沙箱里也写不进技能目录');
  assert.ok(!fs.existsSync(path.join(SKILLS_DIR, 'x.txt')));
  fs.writeFileSync(path.join(cfg.dataDir, 'config.json'), '{"apiKey":"SECRET-IN-CONFIG"}');
  assert.doesNotMatch((await ask('跑命令 cat ../config.json; cat ' + path.join(cfg.dataDir, 'config.json'), () => 'allow')).text, /SECRET-IN-CONFIG/, '开了技能，配置照样读不到');
  const marker = `wa-escape-${Date.now()}`;
  await ask(`跑命令 touch /tmp/${marker}`, () => 'allow');
  assert.ok(!fs.existsSync(`/tmp/${marker}`), '/tmp 本身照样写不进');
});

test('Excel 技能：在沙箱里用 LibreOffice 重算公式', { skip: !CAN_RUN ? SKIP_WHY : false }, async (t) => {
  if (!(await officeAvailable())) return t.skip('本机没装 LibreOffice');
  fs.writeFileSync(path.join(ws, 'mk.py'), "import openpyxl\nwb=openpyxl.Workbook();ws=wb.active\nws['A1']=2;ws['A2']=3;ws['A3']='=SUM(A1:A2)'\nwb.save('表.xlsx')\n");
  assert.match((await ask('跑命令 python3 mk.py', () => 'allow')).text, /工具成功/);
  const recalc = await ask(`跑命令 python3 ${path.join(SKILLS_DIR, 'xlsx', 'scripts', 'recalc.py')} 表.xlsx 60 > recalc.json`, () => 'allow');
  assert.match(recalc.text, /工具成功/, recalc.text);
  const out = JSON.parse(fs.readFileSync(path.join(ws, 'recalc.json'), 'utf8'));
  assert.equal(out.status, 'success', JSON.stringify(out));
  fs.writeFileSync(path.join(ws, 'rd.py'), "import openpyxl\nprint(openpyxl.load_workbook('表.xlsx',data_only=True).active['A3'].value)\n");
  await ask('跑命令 python3 rd.py > a3.txt', () => 'allow');
  assert.equal(fs.readFileSync(path.join(ws, 'a3.txt'), 'utf8').trim(), '5', '公式真的算出了结果');
});

test('没开技能（没开放跑命令时）：没有 Skill 工具，调用也被拒', async () => {
  const off = { ...cfg, commands: false, officeSkills: true };
  const tasks = createTasks({ run: (o) => runAgent(off, o) });
  const s2 = createHttpServer({ auth: createAuth({ password: cfg.password, dataDir: cfg.dataDir }), tasks, cfg: off, sessions: createSessions(off) });
  await new Promise((r) => s2.listen(0, '127.0.0.1', r));
  try {
    const b2 = `http://127.0.0.1:${s2.address().port}`;
    const tk = (await (await fetch(b2 + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: cfg.password }) })).json()).token;
    const res = await fetch(b2 + '/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tk, Accept: 'text/event-stream' }, body: JSON.stringify({ text: '调用工具 Skill {"skill":"weiyang-office:docx"}' }) });
    const raw = await res.text();
    assert.ok(!lastRequest().tools.some((t) => t.name === 'Skill'), '没有 Skill 工具');
    assert.doesNotMatch(JSON.stringify(lastRequest()), /weiyang-office:docx.*DOCX creation/s);
    assert.doesNotMatch(raw, /DOCX creation, editing/, '技能内容没被读进来');
  } finally { s2.close(); }
});
