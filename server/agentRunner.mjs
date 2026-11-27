/**
 * 用 Claude Agent SDK 跑一轮对话，把 SDK 的消息翻译成网页好用的简单事件：
 *   { type: 'session', sessionId }      本轮所属对话（第一次发消息时由 SDK 新建）
 *   { type: 'text', delta }              回复文字（边生成边推）
 *   { type: 'tool', id, name, input }    调用了哪个工具
 *   { type: 'tool_result', id, ok, summary }
 *   { type: 'done', text, sessionId, ms } / { type: 'error', error }
 *
 * 模型走 DeepSeek 的 Anthropic 兼容接口（ANTHROPIC_BASE_URL）。传给 SDK 的环境变量只给必需的几项，
 * 不把服务器自身的环境（含登录密码）带进去；并关掉非必要外连——实测关掉后不再连 Anthropic 的服务器。
 */
import fs from 'node:fs';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { pathGuardHooks } from './pathGuard.mjs';

/** 关掉统计、错误上报、自动更新等非必要外连（spike 实测：不关会连 api.anthropic.com，关了一次都不连） */
export const QUIET_ENV = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  DISABLE_AUTOUPDATER: '1'
};

/**
 * 第一版只放开只读工具：看文件、找文件、搜内容。改文件、跑命令要等第二批的“允许/拒绝”弹框做好才开。
 * WebSearch 是 Anthropic 服务器端的搜索，接 DeepSeek 用不了，不放。
 */
export const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep'];

export const SYSTEM_APPEND = [
  '你是“未央”，用户的个人助手。用中文回答，说人话，少用术语。',
  '用户在中国大陆，时间按北京时间。',
  '没做过、没核实过的事不要说成已完成；工具失败要如实说明。',
  '你只能在当前工作文件夹里读文件；改文件、运行命令目前还没开放，需要时请告诉用户。'
].join('\n');

/** SDK 进程的环境变量：只放必需项，不继承服务器的 process.env */
export function agentEnv(cfg, { home, extra = {} } = {}) {
  return {
    PATH: process.env.PATH,
    LANG: 'C.UTF-8',
    HOME: home,
    ANTHROPIC_BASE_URL: cfg.baseUrl,
    ANTHROPIC_AUTH_TOKEN: cfg.apiKey,
    ANTHROPIC_MODEL: cfg.model,
    ...QUIET_ENV,
    ...extra
  };
}

const short = (v, n = 300) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? '');
  return s.length > n ? s.slice(0, n) + '…' : s;
};

function resultSummary(content) {
  if (typeof content === 'string') return short(content);
  if (Array.isArray(content)) return short(content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n'));
  return short(content);
}

/**
 * @param {object} cfg  loadConfig() 的结果
 * @param {{ text: string, sessionId?: string, emit: (ev: object) => void, signal?: AbortSignal, extraEnv?: object, queryImpl?: Function }} o
 */
export async function runAgent(cfg, { text, sessionId = null, emit, signal, extraEnv, queryImpl = query }) {
  const workspace = path.join(cfg.dataDir, 'workspace');
  const home = path.join(cfg.dataDir, 'home'); // SDK 的对话记录存在这里（.claude/projects）
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const abortController = new AbortController();
  const onAbort = () => abortController.abort();
  if (signal?.aborted) onAbort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const t0 = Date.now();
  let full = '';
  let current = sessionId;
  let announced = false;
  let streamedThisMessage = false; // 有逐字推送时，整条 assistant 消息里的文字就不再重复推
  try {
    const q = queryImpl({
      prompt: text,
      options: {
        cwd: workspace,
        env: agentEnv(cfg, { home, extra: extraEnv }),
        model: cfg.model,
        settingSources: [], // 不读服务器上任何 ~/.claude 或项目里的设置、规则
        systemPrompt: { type: 'preset', preset: 'claude_code', append: SYSTEM_APPEND },
        tools: READ_ONLY_TOOLS,
        // 不用 allowedTools 免确认：每次调用都先过路径守卫钩子，再由下面的 canUseTool 决定
        permissionMode: 'default',
        // 兜底：列表外的工具一律拒绝（第二批改成问用户）
        canUseTool: async (name) => (READ_ONLY_TOOLS.includes(name)
          ? { behavior: 'allow' }
          : { behavior: 'deny', message: `第一版还没开放“${name}”这个工具` }),
        hooks: pathGuardHooks(workspace), // 路径只许在工作文件夹里（见 pathGuard.mjs）
        includePartialMessages: true,
        maxTurns: 30,
        abortController,
        ...(sessionId && { resume: sessionId })
      }
    });
    for await (const m of q) {
      // 每轮都告诉网页一次所属对话（续接时编号不变也报一次；万一 SDK 换了新编号也会再报）
      if (m.session_id && (m.session_id !== current || !announced)) {
        current = m.session_id;
        announced = true;
        emit({ type: 'session', sessionId: current });
      }
      if (m.type === 'stream_event') {
        const ev = m.event;
        if (ev?.type === 'message_start') streamedThisMessage = false;
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && !m.parent_tool_use_id) {
          streamedThisMessage = true;
          full += ev.delta.text;
          emit({ type: 'text', delta: ev.delta.text });
        }
      } else if (m.type === 'assistant') {
        for (const block of m.message?.content ?? []) {
          if (block.type === 'text' && !streamedThisMessage && !m.parent_tool_use_id) {
            full += block.text;
            emit({ type: 'text', delta: block.text });
          } else if (block.type === 'tool_use') {
            emit({ type: 'tool', id: block.id, name: block.name, input: block.input });
          }
        }
        if (m.error) emit({ type: 'notice', text: `模型返回错误：${m.error}` });
      } else if (m.type === 'user') {
        const content = m.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_result') emit({ type: 'tool_result', id: block.tool_use_id, ok: !block.is_error, summary: resultSummary(block.content) });
          }
        }
      } else if (m.type === 'result') {
        if (m.subtype !== 'success' || m.is_error) {
          const why = m.subtype === 'error_max_turns' ? '步骤太多，先停下了' : m.result || m.subtype;
          emit({ type: 'error', error: `没有顺利完成：${why}`, sessionId: current });
          return;
        }
        emit({ type: 'done', text: full || m.result || '', sessionId: current, ms: Date.now() - t0 });
        return;
      }
    }
    if (abortController.signal.aborted) emit({ type: 'stopped', sessionId: current });
    else emit({ type: 'error', error: '智能体没有给出结果就结束了', sessionId: current });
  } catch (error) {
    if (abortController.signal.aborted) emit({ type: 'stopped', sessionId: current });
    else emit({ type: 'error', error: String(error?.message || error).slice(0, 500), sessionId: current });
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}
