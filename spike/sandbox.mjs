// 实验：SDK 自带沙箱能挡住什么（读外面的配置、写外面、联网、看环境变量里的密钥）
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { startFakeModel } from '../test/fakeModel.mjs';
const model = await startFakeModel();
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-sb-')); const ws = path.join(data, 'workspace'); fs.mkdirSync(ws);
fs.writeFileSync(path.join(data, 'config.json'), 'SECRET-CONFIG');
const home = path.join(data, 'home'); fs.mkdirSync(home);
const cmds = ['env | grep -c THE-DEEPSEEK-KEY; env | cut -d= -f1 | tr "\\n" " "'];
for (const c of cmds) {
  let out = '';
  for await (const m of query({ prompt: '跑命令 ' + c, options: { cwd: ws, settingSources: [], tools: ['Bash'], model: 'deepseek-flash',
    env: { PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), ANTHROPIC_BASE_URL: model.url, ANTHROPIC_AUTH_TOKEN: 'THE-DEEPSEEK-KEY', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1' },
    canUseTool: async () => ({ behavior: 'allow' }),
    sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, network: { allowedDomains: [], strictAllowlist: true }, filesystem: { allowWrite: [ws], denyRead: [data], allowRead: [ws] }, credentials: { envVars: [{ name: 'ANTHROPIC_AUTH_TOKEN', mode: 'deny' }] } },
    stderr: (d) => { if (/sandbox|error/i.test(d)) out += '[stderr]' + d.slice(0, 200); } } })) {
    if (m.type === 'result') out += ' RESULT:' + String(m.result).slice(0, 1500).replace(/\n/g, ' | ');
  }
  console.log('$', c, '\n   ', out);
}
console.log('escaped exists:', fs.existsSync(path.join(data, 'escaped.txt')));
model.server.close();
