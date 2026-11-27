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
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { pathGuardHooks } from './pathGuard.mjs';
import { configDir } from './sessions.mjs';
import { createToolBox } from './tools/index.mjs';

/** 关掉统计、错误上报、自动更新等非必要外连（spike 实测：不关会连 api.anthropic.com，关了一次都不连） */
export const QUIET_ENV = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  DISABLE_AUTOUPDATER: '1'
};

/**
 * 工具分三档：
 *   只读（看、找、搜文件）：直接放行；
 *   改文件（新建、修改）：每次先问用户；
 *   跑命令：每次先问用户，而且只在 SDK 自带沙箱里跑（服务器装了 bubblewrap 和 socat 才开放）。
 * 三档都先过路径守卫，只许在工作文件夹里。WebSearch 是 Anthropic 服务器端的搜索，接 DeepSeek 用不了，不放。
 */
export const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep'];
export const WRITE_TOOLS = ['Write', 'Edit'];
export const COMMAND_TOOLS = ['Bash'];

/** 服务器能不能用沙箱（bubblewrap + socat）：能才开放跑命令 */
export function sandboxAvailable() {
  return sandboxStatus() === 'ok';
}

/**
 * 'ok' 能用；'missing' 没装齐；'blocked' 装了但起不来（多半是在 Docker 默认安全设置里）。
 * SDK 的沙箱要 bubblewrap 和 socat 两样（实测：缺 socat 时每次对话都会报错，连不跑命令的聊天也做不了），
 * 所以两样都在、bubblewrap 真能起来，才开放运行命令。
 */
export function sandboxStatus({ spawn = spawnSync } = {}) {
  try {
    const socat = spawn('socat', ['-V'], { timeout: 5000, stdio: 'ignore' });
    if (socat.error?.code === 'ENOENT') return 'missing';
    // 和 SDK 真正用的一样要挂 /proc、隔离进程和网络：只试一半会误判（Docker 里 /proc 挂不上，命令全失败）
    const r = spawn('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--unshare-pid', '--unshare-net', 'true'], { timeout: 5000, stdio: 'ignore' });
    if (r.error?.code === 'ENOENT') return 'missing';
    return r.status === 0 ? 'ok' : 'blocked';
  } catch { return 'missing'; }
}

/** 沙箱装了却起不来时，按环境告诉用户怎么办 */
export function blockedHint({ readFile = fs.readFileSync, exists = fs.existsSync } = {}) {
  const head = '沙箱（bubblewrap）装了但起不来，不开放“跑命令”（其他功能照常）。';
  let restricted = false;
  try { restricted = String(readFile('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8')).trim() === '1'; } catch { /* 没有这项就不是 Ubuntu 的限制 */ }
  if (restricted) return head + 'Ubuntu 23.10 起默认拦着它，装上仓库里的规则后重启：sudo cp deploy/apparmor-bwrap /etc/apparmor.d/weiyang-bwrap && sudo apparmor_parser -r /etc/apparmor.d/weiyang-bwrap';
  if (exists('/.dockerenv')) return head + '在 Docker 里要加 --security-opt seccomp=unconfined --security-opt systempaths=unconfined（见 README）。';
  return head + '请看 README 的“运行命令”说明。';
}

/**
 * 跑命令的沙箱：只能写工作文件夹；数据目录里除工作文件夹外（配置、令牌、对话记录）都看不到；不能联网；
 * 模型密钥不进命令的环境变量。spike/sandbox.mjs 实测过这几条。沙箱起不来就报错，不退回到沙箱外面跑。
 */
export function sandboxSettings(cfg) {
  const workspace = path.join(cfg.dataDir, 'workspace');
  return {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    autoAllowBashIfSandboxed: false,
    network: { allowedDomains: [], strictAllowlist: true },
    filesystem: { allowWrite: [workspace], denyRead: [cfg.dataDir], allowRead: [workspace] },
    credentials: { envVars: [{ name: 'ANTHROPIC_AUTH_TOKEN', mode: 'deny' }, { name: 'ANTHROPIC_API_KEY', mode: 'deny' }] }
  };
}

export function systemAppend({ commands }) {
  return [
    '你是“未央”，用户的个人助手。用中文回答，说人话，少用术语。',
    '用户在中国大陆，时间按北京时间。',
    '没做过、没核实过的事不要说成已完成；工具失败或被用户拒绝要如实说明。',
    '你只能在当前工作文件夹里读写文件。新建或修改文件前，用户会看到确认框，拒绝了就不要换个办法硬做。',
    commands
      ? '可以运行命令，但每次都要用户同意；命令在隔离环境里跑，不能联网，只能改工作文件夹。'
      : '这台服务器没有开放运行命令，需要时请告诉用户。'
  ].join('\n');
}

/**
 * 这一轮连哪里：Anthropic 格式的直接连服务商；OpenAI 格式的连本机翻译服务（openaiBridge），
 * 那时 SDK 拿到的只是内部访问码，服务商的真实密钥留在翻译服务里。
 */
export function connectionFor(cfg, { settings, bridge, model }) {
  if (!settings) return { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model, ref: null };
  const r = settings.resolve(model);
  if (r.format === 'openai') {
    if (!bridge) throw new Error('OpenAI 格式的翻译服务没启动');
    return { baseUrl: `${bridge.url}/p/${r.providerId}`, apiKey: bridge.token, model: r.model, ref: r.ref };
  }
  return { baseUrl: r.baseUrl, apiKey: r.apiKey, model: r.model, ref: r.ref };
}

/** 模型接口的错误里，重试也不会好的那些：返回给用户看的说明；可以重试的返回 null */
export function fatalModelError(m) {
  const status = m.error_status;
  if (status === 401 || m.error === 'authentication_failed') return '模型服务商说密钥不对（401）。请到“设置”里检查这个模型的密钥，服务器配置的 DeepSeek 则检查 /etc/weiyang-agent.env。';
  if (status === 403 || m.error === 'oauth_org_not_allowed') return '模型服务商拒绝访问（403）：这个密钥没有用这个模型的权限。';
  if (status === 402 || m.error === 'billing_error') return '模型服务商说额度不够或欠费（402），请到服务商后台看看余额。';
  if (status === 404 || m.error === 'model_not_found') return '模型服务商说没有这个型号（404）。请到“设置”里检查型号名和接口地址。';
  return null;
}

/** SDK 进程的环境变量：只放必需项，不继承服务器的 process.env */
export function agentEnv(cfg, { home, extra = {} } = {}) {
  return {
    PATH: process.env.PATH,
    LANG: 'C.UTF-8',
    HOME: home,
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'), // 和本进程读对话列表用同一个目录（见 sessions.mjs）
    ANTHROPIC_BASE_URL: cfg.baseUrl,
    ANTHROPIC_AUTH_TOKEN: cfg.apiKey,
    ANTHROPIC_MODEL: cfg.model,
    // SDK 做起标题、子任务这些后台活时会按“小模型/大模型”另选型号；全部指到同一个 DeepSeek 型号，免得发去它不认识的 Claude 型号名
    ANTHROPIC_DEFAULT_HAIKU_MODEL: cfg.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: cfg.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: cfg.model,
    ANTHROPIC_SMALL_FAST_MODEL: cfg.model,
    CLAUDE_CODE_SUBAGENT_MODEL: cfg.model,
    ...QUIET_ENV,
    ...extra
  };
}

const short = (v, n = 300) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? '');
  return s.length > n ? s.slice(0, n) + '…' : s;
};

/** 确认框里显示的参数：文件路径换成工作文件夹里的相对路径（好读，也不暴露服务器目录） */
export function forDisplay(input, workspace) {
  if (!input || typeof input.file_path !== 'string') return input;
  const rel = path.relative(workspace, input.file_path);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? { ...input, file_path: rel } : input;
}

function resultSummary(content) {
  if (typeof content === 'string') return short(content);
  if (Array.isArray(content)) return short(content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n'));
  return short(content);
}

/**
 * @param {object} cfg  loadConfig() 的结果（commands：是否开放跑命令）
 * @param {{ text: string, sessionId?: string, emit: (ev: object) => void, ask: (req: object) => Promise<'allow'|'always'|'deny'>,
 *           signal?: AbortSignal, extraEnv?: object, queryImpl?: Function, toolModules?: Array }} o
 */
export async function runAgent(cfg, { text, sessionId = null, model = null, emit, ask, signal, extraEnv, queryImpl = query, toolModules, settings = null, bridge = null }) {
  // 这一轮用哪个模型：网页上选的（provider/model），没选或不认识就用默认的；没有设置（测试里）就用服务器配置
  const conn = connectionFor(cfg, { settings, bridge, model });
  const workspace = path.join(cfg.dataDir, 'workspace');
  const home = path.dirname(configDir(cfg)); // SDK 的对话记录存在这里（.claude/projects）
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const abortController = new AbortController();
  const onAbort = () => abortController.abort();
  if (signal?.aborted) onAbort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const t0 = Date.now();
  const stoppedOrFatal = () => (fatalReason ? { type: 'error', error: fatalReason, sessionId: current } : { type: 'stopped', sessionId: current });
  let full = '';
  let current = sessionId;
  let announced = false;
  let fatalReason = null; // 不可重试的模型错误，停下时报这个而不是“已停止”
  const tools = [...READ_ONLY_TOOLS, ...WRITE_TOOLS, ...(cfg.commands ? COMMAND_TOOLS : [])];
  // 自定义工具（联网搜索、记忆、文档……）：每轮新建一份，见 tools/
  const toolBox = createToolBox(cfg, { ...(toolModules && { modules: toolModules }), settings });
  let streamedThisMessage = false; // 有逐字推送时，整条 assistant 消息里的文字就不再重复推
  try {
    const q = queryImpl({
      prompt: text,
      options: {
        cwd: workspace,
        env: agentEnv({ ...cfg, ...conn }, { home, extra: extraEnv }),
        model: conn.model,
        settingSources: [], // 不读服务器上任何 ~/.claude 或项目里的设置、规则
        systemPrompt: { type: 'preset', preset: 'claude_code', append: systemAppend({ commands: Boolean(cfg.commands) }) },
        tools,
        // 不用 allowedTools 免确认：每次调用都先过路径守卫钩子，再由下面的 canUseTool 决定
        permissionMode: 'default',
        mcpServers: { weiyang: toolBox.server },
        canUseTool: async (name, input, { signal: toolSignal, suggestions }) => {
          const custom = toolBox.riskOf(name);
          if (READ_ONLY_TOOLS.includes(name) || custom === 'read') return { behavior: 'allow' };
          if ((!tools.includes(name) && custom !== 'write') || !ask) return { behavior: 'deny', message: `没有开放“${name}”这个工具` };
          const decision = await ask({ name, input: forDisplay(input, workspace), signal: toolSignal });
          if (decision === 'always') return { behavior: 'allow', updatedPermissions: suggestions ?? [] };
          if (decision === 'allow') return { behavior: 'allow' };
          return { behavior: 'deny', message: decision === 'timeout' ? '用户太久没回应，这一步没做' : '用户拒绝了这一步' };
        },
        ...(cfg.commands && { sandbox: sandboxSettings(cfg) }),
        hooks: pathGuardHooks(workspace), // 路径只许在工作文件夹里（见 pathGuard.mjs）
        includePartialMessages: true,
        // SDK 子进程的报错只记在服务器日志里（排查用），不发给网页
        stderr: (d) => { const line = String(d).trim(); if (line && !/CLAUDE_SDK_CAN_USE_TOOL_SHADOWED|unrecognized_model/.test(line)) console.warn('[SDK]', line.slice(0, 500)); },
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
      if (m.type === 'system' && m.subtype === 'api_retry') {
        // 模型接口出错时 SDK 会悄悄退避重试，不说出来就像卡死了：写进日志，也告诉网页
        const why = m.error_status ? `状态码 ${m.error_status}` : m.no_response ? `${Math.round(m.no_response.waited_ms / 1000)} 秒没回应` : String(m.error || '连不上');
        console.warn(`[模型重试] 第 ${m.attempt}/${m.max_retries} 次，${why}（${m.error || ''}），${Math.round((m.retry_delay_ms || 0) / 1000)} 秒后再试`);
        // 重试也没用的错（密钥不对、没权限、型号不对、欠费）：马上停下并说清楚，不让人干等几分钟
        const fatal = fatalModelError(m);
        if (fatal) { fatalReason = fatal; abortController.abort(); continue; }
        emit({ type: 'notice', text: `模型那边出错（${why}），正在第 ${m.attempt} 次重试…` });
        continue;
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
        // 用户点了停止：不管 SDK 最后报的是什么，都算“已停止”
        if (abortController.signal.aborted) { emit(stoppedOrFatal()); return; }
        if (m.subtype !== 'success' || m.is_error) {
          const detail = Array.isArray(m.errors) && m.errors.length ? m.errors.join('；').slice(0, 300) : '';
          if (detail) console.warn('[智能体出错]', detail);
          const why = m.subtype === 'error_max_turns' ? '步骤太多，先停下了' : m.result || detail || m.subtype;
          emit({ type: 'error', error: `没有顺利完成：${why}`, sessionId: current });
          return;
        }
        emit({ type: 'done', text: full || m.result || '', sessionId: current, ms: Date.now() - t0 });
        return;
      }
    }
    if (abortController.signal.aborted) emit(stoppedOrFatal());
    else emit({ type: 'error', error: '智能体没有给出结果就结束了', sessionId: current });
  } catch (error) {
    if (abortController.signal.aborted) emit(stoppedOrFatal());
    else emit({ type: 'error', error: String(error?.message || error).slice(0, 500), sessionId: current });
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}
