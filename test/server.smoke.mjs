/**
 * 对一台已经在跑的服务器做冒烟检查（比如刚用 Docker 起来的）：
 *   node test/server.smoke.mjs <地址> <登录密码> [--fake]
 * 登录 → 聊一句 → 新建文件（自动点允许）→ 文件列表和下载 → 对话列表；
 * 服务器开放了运行命令时，再跑一条命令，核对它看不到模型密钥、不能联网。
 * 加 --fake 表示后面接的是测试用的假模型（会按固定格式回话），接真实 DeepSeek 时不要加，只看能不能正常回复。
 */
import assert from 'node:assert/strict';

const [base, password] = process.argv.slice(2);
const fake = process.argv.includes('--fake');
if (!base || !password) { console.error('用法：node test/server.smoke.mjs <地址> <登录密码> [--fake]'); process.exit(2); }
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`); if (!ok) throw new Error(name); };

const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
check('登录', login.ok);
const { token } = await login.json();
const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
const status = await (await fetch(base + '/api/status', { headers: H })).json();
console.log(`  模型 ${status.model}，运行命令${status.commands ? '已开放' : '未开放'}`);

async function ask(text, sessionId) {
  const res = await fetch(base + '/api/tasks', { method: 'POST', headers: { ...H, Accept: 'text/event-stream' }, body: JSON.stringify({ text, sessionId }) });
  assert.equal(res.status, 200, `发消息失败 ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const evs = [];
  let buf = '', taskId = null;
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
      if (ev.type === 'task_created') taskId = ev.id;
      if (ev.type === 'permission') await fetch(`${base}/api/tasks/${taskId}/permission`, { method: 'POST', headers: H, body: JSON.stringify({ requestId: ev.requestId, decision: 'allow' }) });
    }
  }
  return { evs, end: evs.at(-1), text: evs.filter((e) => e.type === 'text').map((e) => e.delta).join(''), sessionId: evs.find((e) => e.type === 'session')?.sessionId };
}

const t0 = Date.now();
const hi = await ask(fake ? '你好' : '你好，用一句话介绍你自己');
check('聊一句', hi.end.type === 'done' && hi.text.length > 0, `${((Date.now() - t0) / 1000).toFixed(1)} 秒：${hi.text.slice(0, 60)}`);
const name = `smoke-${Date.now()}.txt`;
const w = await ask(fake ? `写文件 ${name} 冒烟测试` : `在工作文件夹里新建文件 ${name}，内容只写“冒烟测试”四个字`, hi.sessionId);
check('新建文件时弹了确认框', w.evs.some((e) => e.type === 'permission' && ['Write', 'Edit', 'Bash'].includes(e.name)));
const files = await (await fetch(base + '/api/files', { headers: H })).json();
check('文件列表里有刚写的文件', files.items.some((f) => f.name === name));
const dl = await fetch(`${base}/api/files/download?path=${encodeURIComponent(name)}`, { headers: H });
check('下载内容对', dl.ok && (await dl.text()).includes('冒烟测试'));
const sessions = await (await fetch(base + '/api/sessions', { headers: H })).json();
check('对话列表里有这段对话', sessions.some((s) => s.id === hi.sessionId));
if (status.commands && fake) {
  // 联网试两个地方：外网，和服务器自己的本机端口（沙箱外一定连得上，所以连不上只能是沙箱挡的）
  const localUrl = `http://127.0.0.1:${new URL(base).port || 8787}/`;
  // 先确认命令真的跑起来了，否则“看不到密钥”是因为根本没跑（Docker 里沙箱起不来时就会这样）
  // 输出要短（结果摘要只保留开头几百字）；联网用 node 试（镜像里没有 curl）
  const env = await ask(`跑命令 echo RAN_OK; env | grep -c -E 'ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY|DEEPSEEK_API_KEY' ; node -e "Promise.any(['https://example.com','${localUrl}'].map(u=>fetch(u,{signal:AbortSignal.timeout(4000)}))).then(()=>console.log('NET_OK'),()=>console.log('NET_BLOCKED'))"`);
  check('命令真的在沙箱里跑起来了', /工具成功/.test(env.text) && /RAN_OK/.test(env.text), env.text.slice(0, 120));
  check('命令看不到模型密钥', /RAN_OK\s+0\b/.test(env.text), '环境变量里含密钥名的行数应为 0');
  check('命令不能联网', /NET_BLOCKED/.test(env.text));
}
console.log(`冒烟检查 ${results.length}/${results.length} 通过`);
