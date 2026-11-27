import { query } from '@anthropic-ai/claude-agent-sdk';
const quiet = process.argv[2] === 'quiet';
const env = { PATH: process.env.PATH, HOME: process.env.TMPHOME, ANTHROPIC_BASE_URL: 'http://127.0.0.1:18080', ANTHROPIC_AUTH_TOKEN: 'dummy-not-a-real-key', ANTHROPIC_MODEL: 'deepseek-flash',
  HTTPS_PROXY: 'http://127.0.0.1:18081', HTTP_PROXY: 'http://127.0.0.1:18081', https_proxy: 'http://127.0.0.1:18081', http_proxy: 'http://127.0.0.1:18081', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
  ...(quiet && { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1' }) };
const t0 = Date.now();
for await (const m of query({ prompt: '你好', options: { cwd: process.env.WORKDIR, env, settingSources: [], model: 'deepseek-flash', permissionMode: 'default', maxTurns: 2, stderr: d => process.stderr.write('[stderr] ' + d) } })) {
  const brief = m.type === 'assistant' ? JSON.stringify(m.message.content).slice(0, 120) : m.type === 'result' ? `${m.subtype} ${m.is_error ? 'ERR' : ''} ${String(m.result ?? '').slice(0, 80)}` : m.subtype || '';
  console.log('MSG', m.type, brief);
}
console.log('done ms', Date.now() - t0);
