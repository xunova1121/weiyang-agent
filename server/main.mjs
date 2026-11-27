/** 启动：node server/main.mjs（配置见 server/config.mjs） */
import { loadConfig } from './config.mjs';
import { createAuth } from './auth.mjs';
import { createTasks } from './tasks.mjs';
import { createHttpServer } from './http.mjs';
import { runAgent } from './agentRunner.mjs';

let cfg;
try { cfg = loadConfig(); }
catch (e) { console.error(e.message); process.exit(1); }

const auth = createAuth({ password: cfg.password, dataDir: cfg.dataDir });
const tasks = createTasks({ run: (o) => runAgent(cfg, o) });
const server = createHttpServer({ auth, tasks, cfg });
server.listen(cfg.port, cfg.host, () => console.log(`未央 Agent 版已启动：http://${cfg.host}:${cfg.port}（模型 ${cfg.model}，接口 ${cfg.baseUrl}）`));
