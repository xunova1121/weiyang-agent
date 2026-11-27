/**
 * 把各功能模块的工具汇总成一个工具服务器。新功能在这里加一行即可。
 * 每次对话（每轮）都新建一份：工具上下文里有当轮的工作文件夹、配置。
 */
import path from 'node:path';
import { buildToolServer, workspaceResolver } from './registry.mjs';
import * as basic from './basic.mjs';
import * as search from './search.mjs';
import * as memory from './memory.mjs';
import * as vision from './vision.mjs';
import * as documents from './documents.mjs';
import * as history from './history.mjs';

export const MODULES = [basic, search, memory, vision, documents, history];

export function createToolBox(cfg, { modules = MODULES, settings = null, sessionId = null } = {}) {
  const workspace = path.join(cfg.dataDir, 'workspace');
  // settings：取其他服务（千帆等）的密钥，见 settings.mjs
  // sessionId：当前这段对话（翻旧对话时跳过它）
  const ctx = { cfg, workspace, settings, sessionId, resolve: workspaceResolver(workspace) };
  const defs = modules.flatMap((m) => m.tools(ctx) ?? []);
  return buildToolServer(defs, ctx);
}
