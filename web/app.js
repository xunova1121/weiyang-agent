/**
 * 网页：登录、对话列表（改名、删除）、发消息边生成边显示、工具步骤、允许/拒绝确认框、停止。
 * 发消息时同一条连接直接收事件；断线或 45 秒没收到任何东西（服务器每 20 秒有心跳）就按最后的序号重连续接，
 * 不重复提交。刷新页面时如果有回复还在进行，会接上继续显示。
 */
const $ = (id) => document.getElementById(id);
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* 存不了就只管这次 */ } }
};
const TOKEN = 'weiyang-agent.token';
const SESSION = 'weiyang-agent.session';
const MODEL = 'weiyang-agent.model';
const IDLE_MS = 45_000;
const RETRY_MS = [1000, 2000, 4000, 8000, 8000];

let current = null; // 正在进行的回复：{ id, last, ctrl, bubble }
let sessionId = store.get(SESSION);

/* ---------- 基础 ---------- */
function show(view) {
  $('login').hidden = view !== 'login';
  $('chat').hidden = view !== 'chat';
}
function status(text) { $('status').textContent = text || ''; }
function setSession(id, title) {
  sessionId = id || null;
  store.set(SESSION, sessionId);
  if (title !== undefined) $('chat-title').textContent = title || '新对话';
  for (const li of $('sessions').children) li.classList.toggle('active', li.dataset.id === sessionId);
}

async function api(path, { method = 'GET', body, rawBody, headers = {}, signal } = {}) {
  const res = await fetch(path, {
    method, signal,
    headers: { ...(body && { 'Content-Type': 'application/json' }), Authorization: 'Bearer ' + (store.get(TOKEN) || ''), ...headers },
    body: rawBody ?? (body && JSON.stringify(body))
  });
  if (res.status === 401) { store.set(TOKEN, null); show('login'); throw new Error('登录已失效'); }
  return res;
}

function add(cls, text = '', before = null) {
  const el = document.createElement('div');
  el.className = cls;
  el.textContent = text;
  $('transcript').insertBefore(el, before);
  el.scrollIntoView({ block: 'end' });
  return el;
}

/* ---------- 工具卡与确认框 ---------- */
/** 自定义工具在模型那边叫 mcp__weiyang__xxx，给人看时去掉前缀 */
const toolLabel = (name) => String(name || '').replace(/^mcp__weiyang__/, '');
function toolCard(t, before = null) {
  const box = document.createElement('details');
  box.className = 'tool' + (t.ok === false ? ' failed' : '');
  box.dataset.id = t.id;
  const s = document.createElement('summary');
  s.textContent = `🔧 ${toolLabel(t.name)}`;
  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(t.input ?? {}, null, 2);
  box.append(s, pre);
  if (t.summary != null) {
    const r = document.createElement('pre');
    r.textContent = (t.ok === false ? '失败：' : '结果：') + t.summary;
    box.append(r);
  }
  $('transcript').insertBefore(box, before);
  return box;
}

function toolResult(ev) {
  const box = $('transcript').querySelector(`.tool[data-id="${CSS.escape(ev.id)}"]`);
  if (!box) return;
  if (!ev.ok) box.classList.add('failed');
  const pre = document.createElement('pre');
  pre.textContent = (ev.ok ? '结果：' : '失败：') + (ev.summary || '');
  box.append(pre);
}

/** 把工具调用说成人话：要做什么、对什么做 */
function describe(name, input = {}) {
  if (name === 'Write') return { what: '新建或覆盖文件', detail: `${input.file_path}\n\n${String(input.content ?? '').slice(0, 1500)}` };
  if (name === 'Edit') return { what: '修改文件', detail: `${input.file_path}\n\n把：${String(input.old_string ?? '').slice(0, 600)}\n改成：${String(input.new_string ?? '').slice(0, 600)}` };
  if (name === 'Bash') return { what: '运行命令（隔离环境，不能联网）', detail: `${input.description ? input.description + '\n' : ''}$ ${input.command}` };
  if (name === 'mcp__weiyang__create_document') return { what: `生成 ${String(input.format || '').toUpperCase()} 文件`, detail: `${input.path ? '保存到（已有同名文件会被覆盖）：' + input.path : '保存到“文档”文件夹（重名不覆盖）'}\n标题：${input.title || '（按内容）'}\n\n${String(input.content ?? '').slice(0, 1500)}` };
  if (name === 'mcp__weiyang__recalc_excel') return { what: '重算 Excel 公式并检查错误', detail: String(input.path) };
  if (name === 'mcp__weiyang__convert_to_pdf') return { what: '把文件转成 PDF', detail: `${input.path}\n（存在原文件旁边，不覆盖）` };
  if (name === 'mcp__weiyang__remember') return { what: '记住这件事（以后每次对话都能看到）', detail: String(input.text ?? '') };
  if (name === 'mcp__weiyang__forget') return { what: '忘掉一条记忆', detail: `编号 ${input.id}` };
  return { what: `使用“${toolLabel(name)}”`, detail: JSON.stringify(input, null, 2) };
}
const DECISION_TEXT = { allow: '已允许', always: '已允许（本次对话都允许）', deny: '已拒绝', timeout: '太久没回答，已按拒绝处理' };

function askCard(ev) {
  const { what, detail } = describe(ev.name, ev.input);
  const box = document.createElement('div');
  box.className = 'ask';
  box.dataset.request = ev.requestId;
  const head = document.createElement('div');
  head.className = 'what';
  head.textContent = `未央想${what}，可以吗？`;
  const pre = document.createElement('pre');
  pre.textContent = detail;
  const actions = document.createElement('div');
  actions.className = 'actions';
  for (const [decision, label, cls] of [['allow', '允许', ''], ['always', '本次对话都允许', 'ghost'], ['deny', '拒绝', 'danger']]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    if (cls) b.className = cls;
    b.addEventListener('click', async () => {
      for (const x of actions.querySelectorAll('button')) x.disabled = true;
      const res = await api(`/api/tasks/${current?.id}/permission`, { method: 'POST', body: { requestId: ev.requestId, decision } }).catch(() => null);
      if (!res?.ok) { for (const x of actions.querySelectorAll('button')) x.disabled = false; status('没有提交成功，再点一次'); }
    });
    actions.append(b);
  }
  box.append(head, pre, actions);
  $('transcript').insertBefore(box, current?.bubble ?? null);
  box.scrollIntoView({ block: 'end' });
}

function answered(ev) {
  const box = $('transcript').querySelector(`.ask[data-request="${CSS.escape(ev.requestId)}"]`);
  if (!box) return;
  const done = document.createElement('div');
  done.className = 'answered';
  done.textContent = DECISION_TEXT[ev.decision] || ev.decision;
  box.querySelector('.actions')?.replaceWith(done);
}

/* ---------- 事件流 ---------- */
function handle(ev) {
  if (Number.isFinite(ev.seq)) {
    if (ev.seq <= current.last) return null; // 续接时服务器会补发，已经收过的跳过
    current.last = ev.seq;
  }
  switch (ev.type) {
    case 'task_created': current.id = ev.id; break;
    case 'session': if (ev.sessionId !== sessionId) { setSession(ev.sessionId); refreshList(); } break;
    case 'text': current.bubble.textContent += ev.delta; current.bubble.scrollIntoView({ block: 'end' }); break;
    case 'tool': toolCard(ev, current.bubble); break;
    case 'tool_result': toolResult(ev); break;
    case 'permission': askCard(ev); break;
    case 'permission_answered': answered(ev); break;
    case 'notice': status(ev.text); break;
    case 'done': if (!current.bubble.textContent) current.bubble.textContent = ev.text || '（没有文字回复）'; speakButton(current.bubble); return 'end';
    case 'stopped': current.bubble.textContent += (current.bubble.textContent ? '\n' : '') + '（已停止）'; return 'end';
    case 'error': add('msg agent error', ev.error); return 'end';
  }
  return null;
}

/** 读一条事件流，返回 'end'（任务结束）或 'drop'（连接断了/半死，需要续接） */
async function readStream(res, ctrl) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let touched = Date.now();
  const watch = setInterval(() => { if (Date.now() - touched > IDLE_MS) reader.cancel().catch(() => {}); }, 5000);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done || ctrl.signal.aborted) return 'drop';
      touched = Date.now();
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
        if (!data) continue; // 心跳
        if (handle(JSON.parse(data)) === 'end') return 'end';
      }
    }
  } catch {
    return 'drop';
  } finally {
    clearInterval(watch);
  }
}

/** 断了就按最后序号续接，直到任务结束或连续失败 */
async function follow(outcome) {
  let failures = 0;
  while (outcome === 'drop' && current.id && failures < RETRY_MS.length) {
    status('连接断了，正在接着收…');
    await new Promise((r) => setTimeout(r, RETRY_MS[failures]));
    try {
      const again = await api(`/api/tasks/${current.id}/events?after=${current.last}`, { headers: { Accept: 'text/event-stream' } });
      if (again.status === 404) { add('msg agent error', '服务器上找不到这个任务了（可能重启过）'); return; }
      failures = again.ok ? 0 : failures + 1;
      if (again.ok) { status(''); outcome = await readStream(again, current.ctrl); }
    } catch { failures++; }
  }
  if (outcome === 'drop') add('msg agent error', '一直连不上服务器。服务器可能还在做，稍后刷新再看，不要重复发送。');
}

async function run(start) {
  const bubble = add('msg agent streaming');
  const ctrl = new AbortController();
  current = { id: null, last: 0, ctrl, bubble };
  busy(true);
  try {
    await start();
  } catch (e) {
    if (!ctrl.signal.aborted) add('msg agent error', '发送失败：' + (e.message || e));
  } finally {
    bubble.classList.remove('streaming');
    if (!bubble.textContent) bubble.remove();
    for (const b of $('transcript').querySelectorAll('.ask .actions button')) b.disabled = true;
    status('');
    busy(false);
    current = null;
    refreshList();
    if (!$('files').hidden) loadFiles();
  }
}

function send(text) {
  add('msg user', text);
  return run(async () => {
    const res = await api('/api/tasks', { method: 'POST', body: { text, sessionId, model: $('model').value || null }, headers: { Accept: 'text/event-stream' }, signal: current.ctrl.signal });
    if (!res.ok) { add('msg agent error', (await res.json().catch(() => ({}))).error || `服务器返回 ${res.status}`); return; }
    await follow(await readStream(res, current.ctrl));
  });
}

/** 刷新页面时有回复还在进行：从头重放这一轮并接着收 */
function reattach(task) {
  add('msg user', task.text);
  return run(async () => {
    current.id = task.id;
    await follow('drop');
  });
}

function busy(on) {
  $('send').hidden = on;
  $('stop').hidden = !on;
  $('prompt').disabled = on;
}

/* ---------- 对话列表 ---------- */
const when = (ms) => new Date(ms).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

async function refreshList() {
  let rows = [];
  try { const res = await api('/api/sessions'); if (res.ok) rows = await res.json(); } catch { return; }
  const ul = $('sessions');
  ul.replaceChildren(...rows.map(row));
  $('sessions-empty').hidden = rows.length > 0;
  const mine = rows.find((r) => r.id === sessionId);
  if (mine) $('chat-title').textContent = mine.title;
}

function row(s) {
  const li = document.createElement('li');
  li.dataset.id = s.id;
  li.classList.toggle('active', s.id === sessionId);
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'open';
  const t = document.createElement('span'); t.className = 'title'; t.textContent = s.title;
  const w = document.createElement('span'); w.className = 'when'; w.textContent = when(s.updatedAt);
  open.append(t, w);
  open.addEventListener('click', () => { if (!current) openSession(s.id, s.title); closeSide(); });
  const ren = document.createElement('button');
  ren.type = 'button'; ren.className = 'mini'; ren.textContent = '✎'; ren.title = '改名'; ren.setAttribute('aria-label', '改名');
  ren.addEventListener('click', () => renameInline(li, s));
  const del = document.createElement('button');
  del.type = 'button'; del.className = 'mini'; del.textContent = '🗑'; del.title = '删除'; del.setAttribute('aria-label', '删除');
  del.addEventListener('click', async () => {
    if (del.dataset.armed !== '1') { del.dataset.armed = '1'; del.textContent = '确认删除？'; setTimeout(() => { del.dataset.armed = ''; del.textContent = '🗑'; }, 3000); return; }
    const res = await api(`/api/sessions/${s.id}`, { method: 'DELETE' }).catch(() => null);
    if (!res?.ok) { status((await res?.json().catch(() => ({})))?.error || '删除失败'); return; }
    if (s.id === sessionId) newChat();
    refreshList();
  });
  li.append(open, ren, del);
  return li;
}

function renameInline(li, s) {
  const input = document.createElement('input');
  input.value = s.title;
  input.setAttribute('aria-label', '新名字');
  input.style.cssText = 'flex:1;min-width:0;font:inherit;padding:6px 8px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--fg)';
  li.replaceChildren(input);
  input.focus();
  input.select();
  let done = false;
  const save = async (ok) => {
    if (done) return;
    done = true;
    if (ok && input.value.trim() && input.value.trim() !== s.title) await api(`/api/sessions/${s.id}/rename`, { method: 'POST', body: { title: input.value.trim() } }).catch(() => {});
    refreshList();
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) save(true); if (e.key === 'Escape') save(false); });
  input.addEventListener('blur', () => save(true));
}

async function openSession(id, title) {
  const res = await api(`/api/sessions/${id}`).catch(() => null);
  if (!res?.ok) { status('打不开这段对话'); return false; }
  const s = await res.json();
  renderHistory(s.items);
  setSession(id, title ?? s.title);
  return s;
}

function renderHistory(items) {
  $('transcript').replaceChildren();
  for (const it of items) {
    if (it.role === 'user') add('msg user', it.text);
    else if (it.role === 'agent') speakButton(add('msg agent', it.text));
    else if (it.role === 'tool') toolCard(it);
  }
}

function newChat() {
  if (current) return;
  setSession(null, '新对话');
  $('transcript').replaceChildren();
}

/* ---------- 工作文件夹 ---------- */
let filesPath = '';
const size = (n) => (n == null ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

async function loadFiles(p = filesPath) {
  const res = await api('/api/files?path=' + encodeURIComponent(p)).catch(() => null);
  if (!res?.ok) { $('files-note').textContent = '读不到这个文件夹'; return; }
  const data = await res.json();
  filesPath = data.path;
  // 面包屑：工作文件夹 / a / b
  const crumbs = $('crumbs');
  crumbs.replaceChildren();
  const parts = filesPath ? filesPath.split('/') : [];
  const go = (label, target) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.addEventListener('click', () => loadFiles(target)); crumbs.append(b); };
  go('工作文件夹', '');
  parts.forEach((name, i) => { crumbs.append('/'); go(name, parts.slice(0, i + 1).join('/')); });
  const ul = $('file-list');
  ul.replaceChildren(...data.items.map(fileRow));
  $('files-note').textContent = data.items.length ? (data.truncated ? '文件太多，只列出前 500 个' : '') : '这里还没有文件。未央写的文件、你上传的文件都会在这里。';
}

function fileRow(f) {
  const li = document.createElement('li');
  li.dataset.path = f.path;
  const name = document.createElement('button');
  name.type = 'button';
  name.className = 'name';
  name.textContent = (f.dir ? '📁 ' : '📄 ') + f.name;
  name.title = f.dir ? '打开文件夹' : '下载';
  name.addEventListener('click', () => (f.dir ? loadFiles(f.path) : download(f)));
  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent = [size(f.size), when(f.modified)].filter(Boolean).join(' · ');
  const del = document.createElement('button');
  del.type = 'button'; del.className = 'mini'; del.textContent = '🗑'; del.title = '删除'; del.setAttribute('aria-label', '删除');
  del.addEventListener('click', async () => {
    if (del.dataset.armed !== '1') { del.dataset.armed = '1'; del.textContent = '确认删除？'; setTimeout(() => { del.dataset.armed = ''; del.textContent = '🗑'; }, 3000); return; }
    await api('/api/files?path=' + encodeURIComponent(f.path), { method: 'DELETE' }).catch(() => null);
    loadFiles();
  });
  li.append(name, meta, del);
  return li;
}

/** 下载要带登录令牌，所以先取回来再交给浏览器保存 */
async function download(f) {
  const res = await api('/api/files/download?path=' + encodeURIComponent(f.path)).catch(() => null);
  if (!res?.ok) { $('files-note').textContent = '下载失败'; return; }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = f.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function upload(list) {
  for (const file of list) {
    $('files-note').textContent = `正在上传 ${file.name}…`;
    const res = await api(`/api/files/upload?dir=${encodeURIComponent(filesPath)}&name=${encodeURIComponent(file.name)}`, { method: 'POST', rawBody: file }).catch(() => null);
    if (!res?.ok) { $('files-note').textContent = `${file.name} 上传失败：${(await res?.json().catch(() => ({})))?.error || '连不上服务器'}`; return; }
  }
  $('files-note').textContent = '';
  loadFiles();
}

function openFiles() { $('files').hidden = false; loadFiles(); }
function closeFiles() { $('files').hidden = true; }

/* ---------- 模型与设置 ---------- */
async function loadModels() {
  const res = await api('/api/models').catch(() => null);
  if (!res?.ok) return;
  const { models, default: def } = await res.json();
  const opts = (sel, chosen) => {
    sel.replaceChildren(...models.map((m) => { const o = document.createElement('option'); o.value = m.ref; o.textContent = `${m.model}（${m.provider}）`; return o; }));
    sel.value = models.some((m) => m.ref === chosen) ? chosen : def;
  };
  opts($('model'), store.get(MODEL));
  opts($('default-model'), def);
}

let presets = [];
async function loadMemory() {
  const res = await api('/api/memory').catch(() => null);
  if (!res?.ok) return;
  const { items } = await res.json();
  $('memories').replaceChildren(...(items.length ? items : [null]).map((it) => {
    const li = document.createElement('li');
    if (!it) { li.className = 'muted'; li.textContent = '还没有记忆'; return li; }
    const box = document.createElement('div');
    box.className = 'svc';
    const row = document.createElement('div');
    row.className = 'row';
    const input = document.createElement('input');
    input.value = it.text; input.maxLength = 300; input.setAttribute('aria-label', '记忆内容');
    const save = document.createElement('button');
    save.type = 'button'; save.textContent = '改'; save.className = 'ghost';
    save.addEventListener('click', async () => {
      const r = await api(`/api/memory/${it.id}`, { method: 'PUT', body: { text: input.value } }).catch(() => null);
      $('memory-error').textContent = r?.ok ? '' : ((await r?.json().catch(() => null))?.error || '没改成功');
      loadMemory();
    });
    const del = document.createElement('button');
    del.type = 'button'; del.className = 'mini'; del.textContent = '🗑'; del.title = '删除'; del.setAttribute('aria-label', '删除这条记忆');
    del.addEventListener('click', async () => { await api(`/api/memory/${it.id}`, { method: 'DELETE' }).catch(() => null); loadMemory(); });
    row.append(input, save, del);
    box.append(row);
    li.append(box);
    return li;
  }));
}

$('memory-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('memory-new').value.trim();
  if (!text) return;
  const r = await api('/api/memory', { method: 'POST', body: { text } }).catch(() => null);
  if (r?.ok) { $('memory-new').value = ''; $('memory-error').textContent = ''; } else $('memory-error').textContent = (await r?.json().catch(() => null))?.error || '没加上';
  loadMemory();
});

async function loadSettings() {
  loadMemory();
  const res = await api('/api/settings').catch(() => null);
  if (!res?.ok) return;
  const st = await res.json();
  presets = st.presets;
  $('pf-preset').replaceChildren(new Option('（自己填）', ''), ...presets.map((p) => new Option(p.name, p.id)));
  $('providers').replaceChildren(...st.providers.map((p) => {
    const li = document.createElement('li');
    li.className = 'prov';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = `${p.name}：${p.models.join('、')}`;
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `${p.format === 'openai' ? 'OpenAI 格式' : 'Anthropic 兼容'} · ${p.key || '没填密钥'}`;
    li.append(name, meta);
    if (!p.fixed) {
      const edit = document.createElement('button');
      edit.type = 'button'; edit.className = 'mini'; edit.textContent = '✎'; edit.title = '修改'; edit.setAttribute('aria-label', '修改');
      edit.addEventListener('click', () => fillProvider(p));
      const del = document.createElement('button');
      del.type = 'button'; del.className = 'mini'; del.textContent = '🗑'; del.title = '删除'; del.setAttribute('aria-label', '删除');
      del.addEventListener('click', async () => {
        if (del.dataset.armed !== '1') { del.dataset.armed = '1'; del.textContent = '确认删除？'; setTimeout(() => { del.dataset.armed = ''; del.textContent = '🗑'; }, 3000); return; }
        await api(`/api/settings/providers/${p.id}`, { method: 'DELETE' }).catch(() => null);
        loadSettings(); loadModels();
      });
      li.append(edit, del);
    } else {
      const tag = document.createElement('span');
      tag.className = 'meta';
      tag.textContent = '服务器配置';
      li.append(tag);
    }
    return li;
  }));
  $('services').replaceChildren(...st.services.map((sv) => {
    const li = document.createElement('li');
    const box = document.createElement('div');
    box.className = 'svc';
    const title = document.createElement('span');
    title.textContent = `${sv.name}${sv.key ? '：' + sv.key : '：没填'}`;
    const row = document.createElement('div');
    row.className = 'row';
    const input = document.createElement('input');
    input.type = 'password'; input.autocomplete = 'off'; input.placeholder = sv.hint || '密钥'; input.setAttribute('aria-label', sv.name + ' 密钥');
    const save = document.createElement('button');
    save.type = 'button'; save.textContent = '保存';
    save.addEventListener('click', async () => { if (!input.value.trim()) return; await api(`/api/settings/services/${sv.id}`, { method: 'POST', body: { key: input.value.trim() } }).catch(() => null); loadSettings(); });
    row.append(input, save);
    if (sv.key) {
      const clear = document.createElement('button');
      clear.type = 'button'; clear.className = 'ghost'; clear.textContent = '清除';
      clear.addEventListener('click', async () => { await api(`/api/settings/services/${sv.id}`, { method: 'POST', body: { key: null } }).catch(() => null); loadSettings(); });
      row.append(clear);
    }
    box.append(title, row);
    li.append(box);
    return li;
  }));
}

function fillProvider(p) {
  $('provider-form-box').open = true;
  $('pf-id').value = p?.id || '';
  $('pf-preset').value = '';
  $('pf-name').value = p?.name || '';
  $('pf-format').value = p?.format || 'anthropic';
  $('pf-url').value = p?.baseUrl || '';
  $('pf-key').value = '';
  $('pf-key').placeholder = p ? `${p.key}；留空表示不变` : '填密钥';
  $('pf-models').value = p?.models?.join(', ') || '';
  $('pf-error').textContent = '';
  $('pf-hint').textContent = '';
}

$('pf-preset').addEventListener('change', () => {
  const p = presets.find((x) => x.id === $('pf-preset').value);
  if (!p) return;
  $('pf-name').value = p.name;
  $('pf-format').value = p.format;
  $('pf-url').value = p.baseUrl;
  $('pf-hint').textContent = p.verified ? '' : '这个地址是从公开资料整理的，请以服务商官方文档为准；型号名也请照官方文档填。';
});
$('pf-cancel').addEventListener('click', () => { fillProvider(null); $('provider-form-box').open = false; });
$('provider-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = { id: $('pf-id').value || undefined, name: $('pf-name').value, format: $('pf-format').value, baseUrl: $('pf-url').value, apiKey: $('pf-key').value, models: $('pf-models').value };
  const res = await api('/api/settings/providers', { method: 'POST', body }).catch(() => null);
  if (!res?.ok) { $('pf-error').textContent = (await res?.json().catch(() => ({})))?.error || '保存失败'; return; }
  fillProvider(null);
  $('provider-form-box').open = false;
  await loadSettings();
  await loadModels();
});
$('default-model').addEventListener('change', async () => {
  await api('/api/settings/default', { method: 'POST', body: { model: $('default-model').value } }).catch(() => null);
});
$('model').addEventListener('change', () => store.set(MODEL, $('model').value));
$('open-settings').addEventListener('click', () => { closeSide(); $('settings').hidden = false; loadSettings(); loadModels(); });
$('close-settings').addEventListener('click', () => { $('settings').hidden = true; });
$('settings').addEventListener('click', (e) => { if (e.target === $('settings')) $('settings').hidden = true; });

/* ---------- 侧栏（手机上是抽屉） ---------- */
function openSide() { $('side').classList.add('open'); $('scrim').hidden = false; $('toggle-side').setAttribute('aria-expanded', 'true'); }
function closeSide() { $('side').classList.remove('open'); $('scrim').hidden = true; $('toggle-side').setAttribute('aria-expanded', 'false'); }

/* ---------- 绑定 ---------- */
$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').textContent = '';
  const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('password').value }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { $('login-error').textContent = data.error || '登录失败'; return; }
  store.set(TOKEN, data.token);
  $('password').value = '';
  enter();
});
$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('prompt').value.trim();
  if (!text || current) return;
  $('prompt').value = '';
  fitPrompt();
  send(text);
});
/** 输入框跟着内容长高（最多屏幕 40%，见 style.css 的 max-height） */
function fitPrompt() {
  const p = $('prompt');
  p.style.height = 'auto';
  p.style.height = `${p.scrollHeight + 2}px`;
}
$('prompt').addEventListener('input', fitPrompt);
$('prompt').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('composer').requestSubmit(); }
});
$('stop').addEventListener('click', () => { if (current?.id) api(`/api/tasks/${current.id}/stop`, { method: 'POST' }).catch(() => {}); });
$('new-chat').addEventListener('click', () => { newChat(); closeSide(); });
$('toggle-side').addEventListener('click', () => ($('side').classList.contains('open') ? closeSide() : openSide()));
$('scrim').addEventListener('click', closeSide);
$('open-files').addEventListener('click', openFiles);
$('close-files').addEventListener('click', closeFiles);
$('files').addEventListener('click', (e) => { if (e.target === $('files')) closeFiles(); });
$('upload').addEventListener('change', (e) => { upload([...e.target.files]); e.target.value = ''; });
$('logout').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }).catch(() => {}); store.set(TOKEN, null); show('login'); });

/* ---------- 上传附件、语音 ---------- */
let voiceOn = false;

/** 📎 或粘贴：传到工作文件夹的“上传”里，并在输入框里写上路径，让未央知道是哪个文件 */
async function attach(list) {
  for (const file of list) {
    const name = file.name && file.name !== 'image.png' ? file.name : `粘贴的图片-${Date.now()}.${(file.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`;
    status(`正在上传 ${name}…`);
    const res = await api(`/api/files/upload?dir=${encodeURIComponent('上传')}&name=${encodeURIComponent(name)}`, { method: 'POST', rawBody: file }).catch(() => null);
    if (!res?.ok) { status(`${name} 上传失败：${(await res?.json().catch(() => ({})))?.error || '连不上服务器'}`); return; }
    const { path: saved } = await res.json();
    const p = $('prompt');
    p.value = `${p.value}${p.value && !p.value.endsWith('\n') ? '\n' : ''}（我上传了：${saved}）\n`;
    p.dispatchEvent(new Event('input'));
  }
  status('');
  $('prompt').focus();
}
$('attach').addEventListener('change', (e) => { attach([...e.target.files]); e.target.value = ''; });
$('prompt').addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); attach(files); }
});

/** 16kHz 单声道 WAV（DeepSeek 语音识别收 wav/ogg；浏览器录出来多是 webm，先转一下） */
function encodeWav(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) { const s = Math.max(-1, Math.min(1, samples[i])); v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
  return new Blob([buf], { type: 'audio/wav' });
}
async function toWav16k(blob) {
  const ctx = new AudioContext();
  let audio;
  try { audio = await ctx.decodeAudioData(await blob.arrayBuffer()); } finally { ctx.close().catch(() => {}); }
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(audio.duration * 16000)), 16000);
  const src = off.createBufferSource();
  src.buffer = audio; src.connect(off.destination); src.start();
  return encodeWav((await off.startRendering()).getChannelData(0), 16000);
}

let recorder = null;
async function toggleMic() {
  if (recorder) { recorder.stop(); return; }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { status('没拿到麦克风（要用 https 打开网页，并允许使用麦克风）'); return; }
  const chunks = [];
  const rec = new MediaRecorder(stream);
  recorder = rec;
  const limit = setTimeout(() => rec.state === 'recording' && rec.stop(), 110_000); // 接口最多约两分钟
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  rec.onstop = async () => {
    clearTimeout(limit);
    for (const t of stream.getTracks()) t.stop();
    recorder = null;
    $('mic').classList.remove('recording'); $('mic').textContent = '🎤';
    status('正在识别…');
    try {
      const wav = await toWav16k(new Blob(chunks, { type: rec.mimeType }));
      const res = await api('/api/voice/asr', { method: 'POST', rawBody: wav, headers: { 'Content-Type': 'audio/wav' } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { status(data.error || '识别失败'); return; }
      if (!data.text) { status('没听清，再说一次'); return; }
      const p = $('prompt');
      p.value = p.value ? `${p.value} ${data.text}` : data.text;
      p.dispatchEvent(new Event('input'));
      p.focus();
      status('');
    } catch { status('识别失败（录音格式转换或网络出错）'); }
  };
  rec.start();
  $('mic').classList.add('recording'); $('mic').textContent = '⏹';
  status('正在听…再点一次结束');
}
$('mic').addEventListener('click', toggleMic);

/** 回复下面的 🔊：服务器用 DeepSeek 朗读，再点一次停 */
let playing = null;
function speakButton(bubble) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'speak'; b.textContent = '🔊 朗读'; b.hidden = !voiceOn;
  b.addEventListener('click', async () => {
    if (playing?.button === b) { playing.audio.pause(); playing = null; b.textContent = '🔊 朗读'; return; }
    if (playing) { playing.audio.pause(); playing.button.textContent = '🔊 朗读'; playing = null; }
    const text = bubble.textContent.trim();
    if (!text) return;
    b.textContent = '…'; b.disabled = true;
    try {
      const res = await api('/api/voice/tts', { method: 'POST', body: { text: text.slice(0, 4000) } });
      if (!res.ok) { status((await res.json().catch(() => ({}))).error || '朗读失败'); b.textContent = '🔊 朗读'; return; }
      const url = URL.createObjectURL(await res.blob());
      const audio = new Audio(url);
      playing = { audio, button: b };
      audio.addEventListener('ended', () => { URL.revokeObjectURL(url); if (playing?.audio === audio) playing = null; b.textContent = '🔊 朗读'; });
      b.textContent = '⏹ 停止';
      await audio.play();
    } catch { status('朗读失败'); b.textContent = '🔊 朗读'; } finally { b.disabled = false; }
  });
  bubble.after(b);
  return b;
}

async function enter() {
  show('chat');
  loadModels();
  let st = null;
  try { const res = await api('/api/status'); if (res.ok) st = await res.json(); } catch { return; }
  voiceOn = Boolean(st?.voice);
  $('mic').hidden = !voiceOn || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined';
  for (const b of document.querySelectorAll('.speak')) b.hidden = !voiceOn;
  await refreshList();
  const running = st?.running;
  const target = running?.sessionId || sessionId;
  if (target) {
    const s = await openSession(target);
    if (!s) setSession(null, '新对话');
    // 正在进行的这一轮可能已经部分写进记录：从最后一条相同的提问处截掉，交给重放来显示
    if (s && running) {
      const nodes = [...$('transcript').children];
      const idx = nodes.findLastIndex((n) => n.classList.contains('user') && n.textContent === running.text);
      if (idx >= 0) for (const n of nodes.slice(idx)) n.remove();
    }
  }
  if (running) reattach(running);
}

if (store.get(TOKEN)) enter(); else show('login');
