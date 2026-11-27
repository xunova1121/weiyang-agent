/**
 * 自定义工具底座：联网搜索、记忆、识图、文档这些能力都以“工具”的形式交给智能体，代码在服务器进程里跑。
 *
 * 每个功能模块导出 `tools(ctx)`，返回这样的定义：
 *   { name, description, schema（zod 字段）, risk: 'read' | 'write', run: async (args, ctx) => 文本或 { text, isError } }
 * 这里统一：
 *   - 注册成 SDK 的进程内 MCP 服务器（名字 weiyang，模型看到的工具名是 mcp__weiyang__<name>），一律常驻、不藏在“工具搜索”后面
 *     （DeepSeek 等模型不一定会先搜工具）；
 *   - 出错只把一句人话交给模型，详细错误记服务器日志，不把密钥、内部路径带出去；想让模型看到具体原因，
 *     就抛 userError('……')（见下），这样的话才原样转给模型；
 *   - 权限：risk=read（查资料、看时间）直接放行；risk=write（改文件、改记忆）和内置的改文件一样先问用户。
 * 工具自己碰文件时必须用 ctx.resolve() 换算路径，只许在工作文件夹里（和 pathGuard 同一套判断）。
 */
import path from 'node:path';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { insideWorkspace } from '../pathGuard.mjs';

export const SERVER_NAME = 'weiyang';
export const TOOL_PREFIX = `mcp__${SERVER_NAME}__`;
const TOOL_TIMEOUT_MS = 120_000;

/** 工具里换算工作文件夹路径：不在里面就抛错 */
export function workspaceResolver(workspace) {
  return (rel) => {
    const s = String(rel ?? '');
    if (!insideWorkspace(workspace, s)) throw userError('只能访问工作文件夹里的文件');
    return path.resolve(workspace, s);
  };
}

/** 工具里抛给模型看的错误（会原样转给模型，别带密钥和内部路径） */
export const userError = (message) => Object.assign(new Error(message), { userFacing: true });

const short = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);

/**
 * @param {Array<object>} defs 工具定义（见文件开头）
 * @param {object} ctx 传给每个工具的上下文（cfg、workspace、resolve、log 等）
 */
export function buildToolServer(defs, ctx) {
  const names = new Set();
  const risk = new Map();
  const sdkTools = defs.map((d) => {
    if (!/^[a-z][a-z0-9_]{1,40}$/.test(d.name) || names.has(d.name)) throw new Error(`工具名不对或重复：${d.name}`);
    if (!['read', 'write'].includes(d.risk)) throw new Error(`工具 ${d.name} 没写清 risk`);
    names.add(d.name);
    risk.set(TOOL_PREFIX + d.name, d.risk);
    return tool(d.name, d.description, d.schema, async (args) => {
      try {
        const out = await d.run(args, ctx);
        const text = typeof out === 'string' ? out : String(out?.text ?? '');
        return { content: [{ type: 'text', text: short(text, 60_000) }], ...(out?.isError && { isError: true }) };
      } catch (e) {
        // 给模型的只是一句人话；细节只进服务器日志
        if (!e?.userFacing) console.warn(`[工具出错] ${d.name}:`, String(e?.stack || e).slice(0, 800));
        // 没标 userFacing 的原始报错可能带内部路径、地址甚至密钥：一律不给模型
        const msg = e?.userFacing ? e.message : `工具“${d.name}”出错了，这一步没做成。可以换个办法，或如实告诉用户。`;
        return { content: [{ type: 'text', text: msg }], isError: true };
      }
    }, { alwaysLoad: true });
  });
  return {
    server: createSdkMcpServer({ name: SERVER_NAME, version: '1.0.0', tools: sdkTools, alwaysLoad: true, timeout: TOOL_TIMEOUT_MS }),
    /** 这个工具要不要先问用户：null 表示不是我们的工具 */
    riskOf: (fullName) => risk.get(fullName) ?? null,
    names: [...names]
  };
}
