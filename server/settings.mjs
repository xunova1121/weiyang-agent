/**
 * 网页上的“设置”：模型服务商、默认模型、其他服务（百度千帆等）的密钥。
 * 存在数据目录 settings.json（权限 600，只有运行服务的账号能读），不进仓库。
 * 密钥只进不出：网页上只看得到“已填（尾号 xxxx）”，改的时候留空表示不变。
 *
 * 服务器配置文件里的 DeepSeek（/etc/weiyang-agent.env）作为固定的第一个服务商“env”，网页上不能改它的密钥。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** 预设的接口地址（国内站）。除 DeepSeek 外都是从公开资料整理的，页面上提示“以官方文档为准” */
export const PRESETS = [
  { id: 'deepseek', name: 'DeepSeek', format: 'anthropic', baseUrl: 'https://api.deepseek.com/anthropic', verified: true },
  { id: 'kimi', name: 'Kimi（月之暗面）', format: 'anthropic', baseUrl: 'https://api.moonshot.cn/anthropic' },
  { id: 'glm', name: '智谱 GLM', format: 'anthropic', baseUrl: 'https://open.bigmodel.cn/api/anthropic' },
  { id: 'qwen', name: '通义千问', format: 'anthropic', baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic' },
  { id: 'minimax', name: 'MiniMax', format: 'anthropic', baseUrl: 'https://api.minimaxi.com/anthropic' },
  { id: 'openai', name: 'OpenAI 格式（OpenAI、中转站等）', format: 'openai', baseUrl: 'https://api.openai.com/v1' }
];

/** 其他服务的密钥：功能模块用到时在这里登记 */
export const SERVICES = [
  { id: 'qianfan', name: '百度千帆（联网搜索）', hint: '千帆控制台的 API Key（bce-v3/... 开头）' }
];

const FORMATS = ['anthropic', 'openai'];
const mask = (k) => (k ? `已填（尾号 ${String(k).slice(-4)}）` : '');

export function validBaseUrl(raw) {
  try {
    const u = new URL(String(raw).trim());
    if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.search || u.hash) return null;
    return u.href.replace(/\/+$/, '');
  } catch { return null; }
}

function cleanModels(list) {
  const arr = Array.isArray(list) ? list : String(list ?? '').split(/[,，\s]+/);
  return [...new Set(arr.map((s) => String(s).trim()).filter((s) => /^[\w.:/\[\]@-]{1,100}$/.test(s)))].slice(0, 30);
}

export function createSettings(cfg) {
  const file = path.join(cfg.dataDir, 'settings.json');
  let data = { providers: [], defaultModel: null, services: {} };
  try { data = { ...data, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* 第一次用 */ }
  const save = () => {
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
  };
  /** 服务器配置里的 DeepSeek，固定为第一个 */
  const envProvider = () => ({ id: 'env', name: 'DeepSeek（服务器配置）', format: 'anthropic', baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, models: [cfg.model], fixed: true });
  const all = () => [envProvider(), ...data.providers];

  const api = {
    /** 给网页看的：不含密钥原文 */
    publicView() {
      return {
        presets: PRESETS,
        providers: all().map((p) => ({ id: p.id, name: p.name, format: p.format, baseUrl: p.baseUrl, models: p.models, key: mask(p.apiKey), fixed: Boolean(p.fixed) })),
        defaultModel: api.defaultModel(),
        services: SERVICES.map((s) => ({ ...s, key: mask(data.services[s.id]) }))
      };
    },
    /** 所有能选的模型：provider/model */
    models() {
      return all().flatMap((p) => p.models.map((m) => ({ ref: `${p.id}/${m}`, provider: p.name, model: m, format: p.format })));
    },
    defaultModel() {
      const refs = api.models().map((m) => m.ref);
      return refs.includes(data.defaultModel) ? data.defaultModel : refs[0];
    },
    /** provider/model → 实际连接信息（含密钥，只在服务器里用） */
    resolve(ref) {
      const r = ref && api.models().some((m) => m.ref === ref) ? ref : api.defaultModel();
      const i = r.indexOf('/');
      const p = all().find((x) => x.id === r.slice(0, i));
      return { ref: r, providerId: p.id, format: p.format, baseUrl: p.baseUrl, apiKey: p.apiKey, model: r.slice(i + 1) };
    },
    provider(id) { return all().find((p) => p.id === id) || null; },
    saveProvider(input) {
      const name = String(input.name ?? '').trim().slice(0, 40);
      const format = FORMATS.includes(input.format) ? input.format : null;
      const baseUrl = validBaseUrl(input.baseUrl);
      const models = cleanModels(input.models);
      if (!name || !format) return { error: '名字和接口格式要填' };
      if (!baseUrl) return { error: '接口地址不对：要 http:// 或 https:// 开头，不能带用户名密码或问号参数' };
      if (format === 'anthropic' && /\/v1$/.test(baseUrl)) return { error: 'Anthropic 格式的地址不要以 /v1 结尾（程序会自己加 /v1/messages）' };
      if (!models.length) return { error: '至少填一个模型名（多个用逗号隔开）' };
      const old = input.id ? data.providers.find((p) => p.id === input.id) : null;
      if (input.id && !old) return { error: input.id === 'env' ? '服务器配置的 DeepSeek 不能在网页上改' : '没有这个服务商' };
      const apiKey = String(input.apiKey ?? '').trim() || old?.apiKey || '';
      if (!apiKey) return { error: '要填密钥' };
      if (/\s/.test(apiKey) || apiKey.length > 500) return { error: '密钥格式不对' };
      const p = { id: old?.id || crypto.randomBytes(6).toString('hex'), name, format, baseUrl, apiKey, models };
      data.providers = old ? data.providers.map((x) => (x.id === old.id ? p : x)) : [...data.providers, p];
      save();
      return { id: p.id };
    },
    removeProvider(id) {
      if (!data.providers.some((p) => p.id === id)) return false;
      data.providers = data.providers.filter((p) => p.id !== id);
      save();
      return true;
    },
    setDefault(ref) {
      if (!api.models().some((m) => m.ref === ref)) return false;
      data.defaultModel = ref;
      save();
      return true;
    },
    /** 其他服务密钥：空字符串 = 不变；null = 清除 */
    setService(id, key) {
      if (!SERVICES.some((s) => s.id === id)) return { error: '没有这个服务' };
      if (key === null) delete data.services[id];
      else {
        const k = String(key ?? '').trim();
        if (!k) return { ok: true };
        if (/\s/.test(k) || k.length > 500) return { error: '密钥格式不对' };
        data.services[id] = k;
      }
      save();
      return { ok: true };
    },
    service(id) { return data.services[id] || ''; }
  };
  return api;
}
