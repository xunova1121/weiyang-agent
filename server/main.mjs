/** 启动：node server/main.mjs（配置见 server/config.mjs） */
import { loadConfig } from './config.mjs';
import { createAuth } from './auth.mjs';
import { createTasks } from './tasks.mjs';
import { createHttpServer } from './http.mjs';
import { runAgent, sandboxStatus } from './agentRunner.mjs';
import { createSessions, useConfigDir, workspaceDir } from './sessions.mjs';
import { createFiles } from './files.mjs';

let cfg;
try { cfg = loadConfig(); }
catch (e) { console.error(e.message); process.exit(1); }

const sandbox = cfg.commandsSetting === 'off' ? 'off' : sandboxStatus();
cfg.commands = sandbox === 'ok';
if (sandbox === 'missing') console.warn('沙箱没装齐（要 bubblewrap 和 socat），不开放“跑命令”。装上后重启即可：apt install bubblewrap socat');
if (sandbox === 'blocked') console.warn('沙箱（bubblewrap）装了但起不来，不开放“跑命令”。在 Docker 里要加 --security-opt seccomp=unconfined --security-opt systempaths=unconfined 才能用（见 README）。');
useConfigDir(cfg);

const auth = createAuth({ password: cfg.password, dataDir: cfg.dataDir });
const tasks = createTasks({ run: (o) => runAgent(cfg, o) });
const server = createHttpServer({ auth, tasks, cfg, sessions: createSessions(cfg), files: createFiles(workspaceDir(cfg)) });
server.listen(cfg.port, cfg.host, () => console.log(`未央 Agent 版已启动：http://${cfg.host}:${cfg.port}（模型 ${cfg.model}，接口 ${cfg.baseUrl}，跑命令${cfg.commands ? '已开放（沙箱内，每次需确认）' : '未开放'}）`));
