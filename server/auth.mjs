/**
 * 登录：一个服务器密码换一个随机令牌（第一版只给主人一人用）。
 * 令牌存在数据目录里，服务器重启不用重新登录；密码比较用定长哈希防计时猜测；
 * 同一来源连续输错 5 次锁 10 分钟。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const LOCK_AFTER = 5;
const LOCK_MS = 10 * 60_000;
const TOKEN_DAYS = 30;

const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();

export function createAuth({ password, dataDir, now = Date.now }) {
  const file = path.join(dataDir, 'tokens.json');
  let tokens = {};
  try { tokens = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 第一次启动没有文件 */ }
  const save = () => {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(tokens), { mode: 0o600 });
  };
  const failures = new Map(); // 来源 → { count, until }
  // 令牌只存哈希：数据目录被人看到也拿不到能用的令牌
  const key = (token) => digest(token).toString('hex');

  return {
    login(source, given) {
      const f = failures.get(source);
      if (f && f.until > now()) return { ok: false, status: 429, error: '密码错误次数太多，请 10 分钟后再试' };
      if (!crypto.timingSafeEqual(digest(given ?? ''), digest(password))) {
        // 锁定期已过就重新计数
        const count = (f && !(f.until && f.until <= now()) ? f.count : 0) + 1;
        failures.set(source, { count, until: count >= LOCK_AFTER ? now() + LOCK_MS : 0 });
        return { ok: false, status: 401, error: '密码不对' };
      }
      failures.delete(source);
      const token = crypto.randomBytes(32).toString('base64url');
      tokens[key(token)] = now() + TOKEN_DAYS * 86_400_000;
      for (const [k, exp] of Object.entries(tokens)) if (exp < now()) delete tokens[k];
      save();
      return { ok: true, token };
    },
    check(token) {
      if (!token) return false;
      const exp = tokens[key(token)];
      return Boolean(exp && exp > now());
    },
    logout(token) {
      delete tokens[key(token)];
      save();
    }
  };
}
