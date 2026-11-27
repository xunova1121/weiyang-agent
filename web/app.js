/**
 * 最简网页：登录、发消息、边生成边显示、工具步骤、停止。
 * 发消息时同一条连接直接收事件；断线或 45 秒没收到任何东西（服务器每 20 秒有心跳）就按最后的序号重连续接，
 * 不重复提交（未央 1.0.500 里修过的“连接半死一直转圈”在这里一开始就按对的做）。
 */
const $ = (id) => document.getElementById(id);
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* 存不了就只管这次 */ } }
};
const TOKEN = 'weiyang-agent.token';
const SESSION = 'weiyang-agent.session';
const IDLE_MS = 45_000;
const RETRY_MS = [1000, 2000, 4000, 8000, 8000];

let current = null; // { id, last, ctrl, bubble }

function show(view) {
  $('login').hidden = view !== 'login';
  $('chat').hidden = view !== 'chat';
}
function status(text) { $('status').textContent = text || ''; }

async function api(path, { method = 'GET', body, headers = {}, signal } = {}) {
  const res = await fetch(path, {
    method, signal,
    headers: { ...(body && { 'Content-Type': 'application/json' }), Authorization: 'Bearer ' + (store.get(TOKEN) || ''), ...headers },
    body: body && JSON.stringify(body)
  });
  if (res.status === 401 && path !== '/api/login') { store.set(TOKEN, null); show('login'); throw new Error('登录已失效'); }
  return res;
}

function add(cls, text = '') {
  const el = document.createElement('div');
  el.className = cls;
  el.textContent = text;
  $('transcript').append(el);
  el.scrollIntoView({ block: 'end' });
  return el;
}

function addTool(ev) {
  const box = document.createElement('details');
  box.className = 'tool';
  box.dataset.id = ev.id;
  const s = document.createElement('summary');
  s.textContent = `🔧 ${ev.name}`;
  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(ev.input ?? {}, null, 2);
  box.append(s, pre);
  // 工具卡放在当前回复气泡前面，回复文字继续在后面长
  $('transcript').insertBefore(box, current?.bubble ?? null);
}

function toolResult(ev) {
  const box = $('transcript').querySelector(`.tool[data-id="${CSS.escape(ev.id)}"]`);
  if (!box) return;
  if (!ev.ok) box.classList.add('failed');
  const pre = document.createElement('pre');
  pre.textContent = (ev.ok ? '结果：' : '失败：') + (ev.summary || '');
  box.append(pre);
}

function handle(ev) {
  if (Number.isFinite(ev.seq)) {
    if (ev.seq <= current.last) return; // 续接时服务器会补发，已经收过的跳过
    current.last = ev.seq;
  }
  switch (ev.type) {
    case 'task_created': current.id = ev.id; break;
    case 'session': store.set(SESSION, ev.sessionId); break;
    case 'text': current.bubble.textContent += ev.delta; current.bubble.scrollIntoView({ block: 'end' }); break;
    case 'tool': addTool(ev); break;
    case 'tool_result': toolResult(ev); break;
    case 'notice': status(ev.text); break;
    case 'done': if (!current.bubble.textContent) current.bubble.textContent = ev.text || '（没有文字回复）'; return 'end';
    case 'stopped': current.bubble.textContent += '\n（已停止）'; return 'end';
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

async function send(text) {
  add('msg user', text);
  const bubble = add('msg agent streaming');
  const ctrl = new AbortController();
  current = { id: null, last: 0, ctrl, bubble };
  busy(true);
  try {
    const res = await api('/api/tasks', { method: 'POST', body: { text, sessionId: store.get(SESSION) }, headers: { Accept: 'text/event-stream' }, signal: ctrl.signal });
    if (!res.ok) { add('msg agent error', (await res.json().catch(() => ({}))).error || `服务器返回 ${res.status}`); return; }
    let outcome = await readStream(res, ctrl);
    let failures = 0;
    while (outcome === 'drop' && current.id && failures < RETRY_MS.length) {
      status('连接断了，正在接着收…');
      await new Promise((r) => setTimeout(r, RETRY_MS[failures]));
      try {
        const again = await api(`/api/tasks/${current.id}/events?after=${current.last}`, { headers: { Accept: 'text/event-stream' } });
        if (again.status === 404) { add('msg agent error', '服务器上找不到这个任务了（可能重启过）'); return; }
        failures = again.ok ? 0 : failures + 1;
        if (again.ok) { status(''); outcome = await readStream(again, ctrl); }
      } catch { failures++; }
    }
    if (outcome === 'drop') add('msg agent error', '一直连不上服务器。服务器可能还在做，稍后刷新再看，不要重复发送。');
  } catch (e) {
    if (!ctrl.signal.aborted) add('msg agent error', '发送失败：' + (e.message || e));
  } finally {
    bubble.classList.remove('streaming');
    if (!bubble.textContent) bubble.remove();
    status('');
    busy(false);
    current = null;
  }
}

function busy(on) {
  $('send').hidden = on;
  $('stop').hidden = !on;
  $('prompt').disabled = on;
}

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
  send(text);
});
$('prompt').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('composer').requestSubmit(); }
});
$('stop').addEventListener('click', () => { if (current?.id) api(`/api/tasks/${current.id}/stop`, { method: 'POST' }).catch(() => {}); });
$('new-chat').addEventListener('click', () => { if (current) return; store.set(SESSION, null); $('transcript').replaceChildren(); status('已开始新对话'); });
$('logout').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }).catch(() => {}); store.set(TOKEN, null); show('login'); });

async function enter() {
  show('chat');
  try {
    const res = await api('/api/status');
    if (res.ok) status('模型：' + (await res.json()).model);
  } catch { /* 401 已切回登录 */ }
}

if (store.get(TOKEN)) enter(); else show('login');
