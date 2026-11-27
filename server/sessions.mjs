/**
 * 对话管理：列表、读出历史、改名、删除。对话记录由 Agent SDK 自己存（数据目录 home/.claude/projects 下的 jsonl），
 * 这里只调用 SDK 提供的读写函数，并把记录换成网页好显示的样子。
 *
 * SDK 的这些函数在本进程里按 CLAUDE_CONFIG_DIR 找记录，跑对话的子进程也用同一个目录（见 agentRunner.mjs），
 * 两边必须一致，否则列表里看不到刚聊的对话。
 */
import path from 'node:path';
import { deleteSession, getSessionInfo, getSessionMessages, listSessions, renameSession } from '@anthropic-ai/claude-agent-sdk';

export const configDir = (cfg) => path.join(cfg.dataDir, 'home', '.claude');
export const workspaceDir = (cfg) => path.join(cfg.dataDir, 'workspace');

/** 本进程里的 SDK 函数读哪个目录：启动时设一次（服务器进程只跑未央这一件事） */
export function useConfigDir(cfg) {
  process.env.CLAUDE_CONFIG_DIR = configDir(cfg);
}

const ID = /^[0-9a-f-]{36}$/i;
export const validSessionId = (id) => typeof id === 'string' && ID.test(id);

const stripReminders = (s) => String(s || '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
const short = (v, n = 300) => {
  const s = typeof v === 'string' ? v : Array.isArray(v) ? v.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n') : JSON.stringify(v ?? '');
  return s.length > n ? s.slice(0, n) + '…' : s;
};

/** SDK 记录 → 网页条目：{ role:'user'|'agent', text } 和 { role:'tool', id, name, input, ok?, summary? } */
export function toDisplay(messages) {
  const items = [];
  const tools = new Map();
  for (const m of messages) {
    if (m.parent_tool_use_id) continue; // 子任务内部的过程不展开
    const content = m.message?.content;
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
    for (const b of blocks) {
      if (m.type === 'user' && b.type === 'text') {
        const text = stripReminders(b.text);
        if (text) items.push({ role: 'user', text });
      } else if (m.type === 'user' && b.type === 'tool_result') {
        const t = tools.get(b.tool_use_id);
        if (t) Object.assign(t, { ok: !b.is_error, summary: short(b.content) });
      } else if (m.type === 'assistant' && b.type === 'text' && b.text.trim()) {
        const last = items.at(-1);
        if (last?.role === 'agent') last.text += b.text; else items.push({ role: 'agent', text: b.text });
      } else if (m.type === 'assistant' && b.type === 'tool_use') {
        const t = { role: 'tool', id: b.id, name: b.name, input: b.input };
        tools.set(b.id, t);
        items.push(t);
      }
    }
  }
  return items;
}

export function createSessions(cfg) {
  const dir = workspaceDir(cfg);
  return {
    async list() {
      const rows = await listSessions({ dir, includeWorktrees: false });
      return rows
        .map((s) => ({ id: s.sessionId, title: s.customTitle || s.summary || s.firstPrompt || '（无标题）', updatedAt: s.lastModified, createdAt: s.createdAt }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
    },
    async get(id) {
      if (!validSessionId(id)) return null;
      const info = await getSessionInfo(id, { dir });
      if (!info) return null;
      const messages = await getSessionMessages(id, { dir });
      return { id, title: info.customTitle || info.summary || '', items: toDisplay(messages) };
    },
    async rename(id, title) {
      if (!validSessionId(id) || !(await getSessionInfo(id, { dir }))) return false;
      await renameSession(id, String(title).trim().slice(0, 80) || '未命名对话', { dir });
      return true;
    },
    async remove(id) {
      if (!validSessionId(id) || !(await getSessionInfo(id, { dir }))) return false;
      await deleteSession(id, { dir });
      return true;
    }
  };
}
