/**
 * 任务登记：每发一条消息就是一个任务，事件按序号存在内存里。
 * 网页断线后带上“最后收到的序号”重连，就能从断开的地方接着收，不丢字、不重复（未央 1.0.500 的经验）。
 * 第一版只有主人一个人用，同一时间只跑一个任务，免得两个任务同时改同一个工作文件夹。
 */
import crypto from 'node:crypto';

const KEEP_FINISHED = 20; // 做完的任务只留最近 20 个的事件

export function createTasks({ run }) {
  const tasks = new Map();
  let running = null;

  function publish(task, ev) {
    const row = { seq: task.events.length + 1, at: Date.now(), ...ev };
    task.events.push(row);
    if (ev.type === 'session') task.sessionId = ev.sessionId;
    if (['done', 'error', 'stopped'].includes(ev.type)) task.status = ev.type;
    for (const fn of task.listeners) fn(row);
  }

  function prune() {
    const finished = [...tasks.values()].filter((t) => t.status !== 'running');
    for (const t of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) tasks.delete(t.id);
  }

  return {
    get running() { return running; },
    start({ text, sessionId = null }) {
      if (running) return { error: '上一条还在做，等它做完或先点停止', status: 409 };
      const task = { id: crypto.randomUUID(), status: 'running', sessionId, events: [], listeners: new Set(), ctrl: new AbortController(), startedAt: Date.now() };
      tasks.set(task.id, task);
      running = task.id;
      publish(task, { type: 'started' });
      Promise.resolve()
        .then(() => run({ text, sessionId, signal: task.ctrl.signal, emit: (ev) => publish(task, ev) }))
        .catch((e) => publish(task, { type: 'error', error: String(e?.message || e) }))
        .finally(() => {
          if (task.status === 'running') publish(task, { type: 'error', error: '任务意外结束' });
          if (running === task.id) running = null;
          for (const fn of task.listeners) fn(null); // 通知订阅者：结束了
          task.listeners.clear();
          prune();
        });
      return { task: { id: task.id } };
    },
    get(id) { return tasks.get(id) || null; },
    /** 订阅：先补发 after 之后的旧事件，再推新事件；任务结束时回调 null */
    subscribe(id, after, fn) {
      const task = tasks.get(id);
      if (!task) return null;
      for (const ev of task.events) if (ev.seq > after) fn(ev);
      if (task.status !== 'running') { fn(null); return () => {}; }
      task.listeners.add(fn);
      return () => task.listeners.delete(fn);
    },
    stop(id) {
      const task = tasks.get(id);
      if (!task) return false;
      task.ctrl.abort();
      return true;
    }
  };
}
