/**
 * 工具只许碰工作文件夹：读文件、找文件、搜内容的路径一律先换成真实路径再核对，
 * 不在工作文件夹里（含 ../ 跳出、绝对路径、符号链接指向外面）就拒绝。
 * 数据目录里的配置（含模型密钥）、登录令牌、对话记录都在工作文件夹外面，模型读不到。
 *
 * 用 SDK 的 PreToolUse 钩子实现：钩子在权限判断之前、每次调用工具都会跑，
 * 即使工具在 allowedTools 里被设为免确认也绕不过去。钩子自身出错按“拒绝”处理（onFailure: 'block'）。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 各工具里表示路径的参数 */
const PATH_FIELDS = { Read: ['file_path'], Glob: ['path', 'pattern'], Grep: ['path', 'glob'] };

function realOrResolved(p) {
  // 文件还不存在时 realpath 会失败：退回到最近一层存在的父目录的真实路径
  let cur = p;
  const tail = [];
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...tail.reverse()); } catch { /* 往上一层 */ }
    const parent = path.dirname(cur);
    if (parent === cur) return p;
    tail.push(path.basename(cur));
    cur = parent;
  }
}

export function insideWorkspace(workspace, value) {
  if (value == null || value === '') return true;
  const s = String(value);
  if (s.startsWith('~')) return false;
  // 通配符里出现 .. 一律不许（展开后可能跳出去）
  if (/(^|[\\/])\.\.([\\/]|$)/.test(s)) return false;
  const root = realOrResolved(path.resolve(workspace));
  const target = realOrResolved(path.resolve(root, s.replace(/[*?[{].*$/, '') || '.'));
  return target === root || target.startsWith(root + path.sep);
}

/** 检查一次工具调用，返回 null 表示放行，否则返回拒绝原因 */
export function checkToolPaths(workspace, toolName, input) {
  const fields = PATH_FIELDS[toolName];
  if (!fields) return null; // 别的工具由工具白名单管
  for (const f of fields) {
    if (!insideWorkspace(workspace, input?.[f])) return `只能访问工作文件夹里的文件（${f}: ${String(input[f]).slice(0, 120)}）`;
  }
  return null;
}

export function pathGuardHooks(workspace) {
  const deny = (reason) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
  return {
    PreToolUse: [{
      onFailure: 'block',
      hooks: [async (input) => {
        try {
          const why = checkToolPaths(workspace, input.tool_name, input.tool_input);
          return why ? deny(why) : {};
        } catch {
          return deny('路径检查出错，已拒绝');
        }
      }]
    }]
  };
}
