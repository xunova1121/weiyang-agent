/**
 * 把各功能模块的工具汇总成一个工具服务器。新功能在这里加一行即可。
 * 每次对话（每轮）都新建一份：工具上下文里有当轮的工作文件夹、配置。
 */
import path from 'node:path';
import { buildToolServer, workspaceResolver } from './registry.mjs';
import * as basic from './basic.mjs';

export const MODULES = [basic];

export function createToolBox(cfg, { modules = MODULES } = {}) {
  const workspace = path.join(cfg.dataDir, 'workspace');
  const ctx = { cfg, workspace, resolve: workspaceResolver(workspace) };
  const defs = modules.flatMap((m) => m.tools(ctx) ?? []);
  return buildToolServer(defs, ctx);
}
