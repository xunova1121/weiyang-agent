/**
 * Anthropic 的 docx / pptx / xlsx 技能（skills/weiyang-office，Apache 2.0）：给原未央文档引擎做补充，
 * 管引擎不擅长的——改已有文件、修订和批注、复杂公式和重算、按别人的模板改。
 *
 * 技能靠在沙箱里跑 Python 脚本干活，所以只在“运行命令”开放、并且服务器装了要用的 Python 库时才启用
 * （装法见 deploy/install-office.sh）。技能目录对模型只读：读文件工具可以读它，写文件仍只许在工作文件夹。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../skills/weiyang-office');
export const PLUGIN_NAME = 'weiyang-office';
export const SKILL_NAMES = ['docx', 'pptx', 'xlsx'].map((s) => `${PLUGIN_NAME}:${s}`);
export const SKILLS_DIR = path.join(PLUGIN_DIR, 'skills');
/** 技能脚本要的 Python 库（缺一个技能就会半路出错，所以都要在） */
export const PY_MODULES = ['lxml', 'defusedxml', 'openpyxl', 'pptx', 'PIL', 'pandas'];

/** 'ok' 能用；'missing' 缺 python3 或库（返回缺哪些） */
export function officeSkillsStatus({ spawn = spawnSync } = {}) {
  const probe = `import importlib.util,sys\nmissing=[m for m in ${JSON.stringify(PY_MODULES)} if importlib.util.find_spec(m) is None]\nprint(','.join(missing))`;
  try {
    const r = spawn('python3', ['-c', probe], { timeout: 15_000, encoding: 'utf8' });
    if (r.error || r.status !== 0) return { status: 'missing', missing: ['python3'] };
    const missing = String(r.stdout || '').trim().split(',').filter(Boolean);
    return missing.length ? { status: 'missing', missing } : { status: 'ok', missing: [] };
  } catch { return { status: 'missing', missing: ['python3'] }; }
}
