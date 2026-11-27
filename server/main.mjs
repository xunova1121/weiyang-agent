/** 启动：node server/main.mjs（配置见 server/config.mjs） */
import { loadConfig } from './config.mjs';
import { createAuth } from './auth.mjs';
import { createTasks } from './tasks.mjs';
import { createHttpServer } from './http.mjs';
import { runAgent, sandboxAvailable } from './agentRunner.mjs';
import { createSessions, useConfigDir } from './sessions.mjs';

let cfg;
try { cfg = loadConfig(); }
catch (e) { console.error(e.message); process.exit(1); }

cfg.commands = cfg.commandsSetting !== 'off' && sandboxAvailable();
if (cfg.commandsSetting !== 'off' && !cfg.commands) console.warn('没有找到可用的沙箱（bubblewrap），不开放“跑命令”。装上后重启即可：apt install bubblewrap');
useConfigDir(cfg);

const auth = createAuth({ password: cfg.password, dataDir: cfg.dataDir });
const tasks = createTasks({ run: (o) => runAgent(cfg, o) });
const server = createHttpServer({ auth, tasks, cfg, sessions: createSessions(cfg) });
server.listen(cfg.port, cfg.host, () => console.log(`未央 Agent 版已启动：http://${cfg.host}:${cfg.port}（模型 ${cfg.model}，接口 ${cfg.baseUrl}，跑命令${cfg.commands ? '已开放（沙箱内，每次需确认）' : '未开放'}）`));
