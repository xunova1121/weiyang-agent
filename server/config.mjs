/**
 * 服务器配置：只从环境变量或数据目录里的 config.json 读，不写进仓库（仓库是公开的）。
 *
 * 必填：WEIYANG_PASSWORD（至少 8 位）、DEEPSEEK_API_KEY（或 MODEL_API_KEY）。
 * 选填：MODEL_BASE_URL（默认 DeepSeek 的 Anthropic 兼容接口）、MODEL（默认 deepseek-flash）、
 *       PORT（默认 8787）、HOST（默认 0.0.0.0）、DATA_DIR（默认 ./data）、ALLOW_COMMANDS（auto / off）。
 */
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULTS = {
  baseUrl: 'https://api.deepseek.com/anthropic',
  model: 'deepseek-flash',
  port: 8787,
  host: '0.0.0.0'
};

export function loadConfig(env = process.env) {
  const dataDir = path.resolve(env.DATA_DIR || 'data');
  let file = {};
  const filePath = path.join(dataDir, 'config.json');
  if (fs.existsSync(filePath)) file = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const cfg = {
    dataDir,
    password: env.WEIYANG_PASSWORD ?? file.password ?? '',
    apiKey: env.DEEPSEEK_API_KEY ?? env.MODEL_API_KEY ?? file.apiKey ?? '',
    baseUrl: (env.MODEL_BASE_URL ?? file.baseUrl ?? DEFAULTS.baseUrl).replace(/\/+$/, ''),
    model: env.MODEL ?? file.model ?? DEFAULTS.model,
    port: Number(env.PORT ?? file.port ?? DEFAULTS.port),
    host: env.HOST ?? file.host ?? DEFAULTS.host,
    // 跑命令：auto = 服务器有沙箱（bubblewrap）就开放；off = 不开放。没有沙箱时一律不开放，不退回到沙箱外面跑
    commandsSetting: String(env.ALLOW_COMMANDS ?? file.allowCommands ?? 'auto')
  };
  const problems = checkConfig(cfg);
  if (problems.length) throw Object.assign(new Error('配置不完整：' + problems.join('；')), { problems });
  return cfg;
}

export function checkConfig(cfg) {
  const out = [];
  if (String(cfg.password).length < 8) out.push('WEIYANG_PASSWORD 至少 8 位');
  if (!cfg.apiKey) out.push('缺少模型密钥 DEEPSEEK_API_KEY');
  // SDK 会自己在地址后面拼 /v1/messages，地址已经以 /v1 结尾会拼成 /v1/v1/messages
  if (/\/v1$/.test(cfg.baseUrl)) out.push('MODEL_BASE_URL 不要以 /v1 结尾');
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) out.push('PORT 不是有效端口');
  return out;
}
