#!/usr/bin/env bash
# 自动更新未央 Agent 版：系统定时器每 30 分钟用 root 跑一次（deploy/install.sh 会装好），也可以手动跑：
#   bash /opt/weiyang-agent/deploy/update.sh
# 规则：
#   - 只拉 stable 分支：GitHub 上自动测试全过的版本才会进 stable，没测过的代码不会装到服务器上
#   - 连不上 GitHub 就这次不更新，下次再试（国内常见的 Empty reply 换用 HTTP/1.1）
#   - 有回复正在进行（数据目录里有 .busy）就先不重启，下次再试
#   - 依赖有变化时先在旁边装好，装不上就这次不更新，正在用的版本一点不动
#   - 更新后服务起不来，自动退回上一个版本
# 不碰密码、密钥（/etc/weiyang-agent.env）和数据（/var/lib/weiyang-agent）。
set -uo pipefail

# 更新会改到本脚本自己：先复制一份到临时文件再从那里跑，免得边跑边被改
if [ -z "${WEIYANG_UPDATE_COPY:-}" ]; then
  COPY="$(mktemp /tmp/weiyang-update.XXXXXX.sh)"
  cp "${BASH_SOURCE[0]}" "$COPY"
  APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" WEIYANG_UPDATE_COPY="$COPY" exec bash "$COPY" "$@"
fi
trap 'rm -f "$WEIYANG_UPDATE_COPY"' EXIT

APP="${APP_DIR:?}"
DATA="${WEIYANG_DATA:-/var/lib/weiyang-agent}"
BRANCH="${UPDATE_BRANCH:-stable}"
REG="${NPM_REGISTRY:-https://registry.npmmirror.com}"
BUSY_MAX_S=7200 # .busy 超过 2 小时算是异常残留，不再等它

say() { printf '[未央更新] %s\n' "$*"; }

# 定时器里 PATH 很短，找不到 nvm 装的 node：用安装时记下的目录
[ -f /etc/weiyang-agent.node-dir ] && PATH="$(cat /etc/weiyang-agent.node-dir):$PATH"
export PATH

cd "$APP" || { say "没有 $APP"; exit 1; }
[ -d .git ] || { say "$APP 不是用 git 装的（可能是上传的压缩包），不能自动更新"; exit 0; }

fetched=0
for i in 1 2 3; do
  if git -c http.version=HTTP/1.1 -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=60 fetch -q origin "$BRANCH" 2>/dev/null; then fetched=1; break; fi
  [ "$i" -lt 3 ] && sleep 20
done
[ "$fetched" = 1 ] || { say "这次连不上 GitHub，下次再试"; exit 0; }

OLD="$(git rev-parse HEAD)"
NEW="$(git rev-parse FETCH_HEAD)"
[ "$OLD" = "$NEW" ] && { say "已是最新（${OLD:0:7}）"; exit 0; }

if [ -f "$DATA/.busy" ]; then
  started="$(cat "$DATA/.busy" 2>/dev/null || echo 0)"
  [[ "$started" =~ ^[0-9]+$ ]] || started=0
  age=$(( $(date +%s) - ${started:0:10} ))
  if [ "$age" -lt "$BUSY_MAX_S" ]; then say "有回复正在进行，等它做完，下次再更新"; exit 0; fi
  say "忙标记已经 $((age / 60)) 分钟，当作残留，照常更新"
fi

say "发现新版本 ${NEW:0:7}（当前 ${OLD:0:7}）：$(git log -1 --format=%s "$NEW")"

# 依赖有变化：先在旁边装好
STAGED=""
if ! git diff --quiet "$OLD" "$NEW" -- package.json package-lock.json; then
  STAGED="$APP/.update-modules"
  rm -rf "$STAGED" && mkdir -p "$STAGED"
  git show "$NEW:package.json" > "$STAGED/package.json"
  git show "$NEW:package-lock.json" > "$STAGED/package-lock.json"
  say "依赖有变化，先在旁边安装"
  if ! (cd "$STAGED" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --registry="$REG" >/dev/null 2>&1); then
    rm -rf "$STAGED"
    say "依赖没装上（网络问题？），这次不更新，正在用的版本没动"
    exit 0
  fi
  if ldd --version 2>&1 | grep -qi 'glibc\|gnu libc'; then rm -rf "$STAGED"/node_modules/@anthropic-ai/claude-agent-sdk-*-musl; fi
fi

rollback() {
  say "新版本起不来，退回 ${OLD:0:7}"
  git reset -q --hard "$OLD"
  if [ -n "$STAGED" ] && [ -d "$APP/node_modules.prev" ]; then rm -rf "$APP/node_modules" && mv "$APP/node_modules.prev" "$APP/node_modules"; fi
  SKIP_PACKAGES=1 SKIP_NPM=1 bash "$APP/deploy/install.sh" >/dev/null 2>&1 && say "已退回，服务正常" || say "退回后也没起来，请看 journalctl -u weiyang-agent"
  exit 1
}

git reset -q --hard "$NEW"
if [ -n "$STAGED" ]; then
  rm -rf "$APP/node_modules.prev"
  [ -d "$APP/node_modules" ] && mv "$APP/node_modules" "$APP/node_modules.prev"
  mv "$STAGED/node_modules" "$APP/node_modules"
  rm -rf "$STAGED"
fi

# 用新版本的安装脚本重新生成服务并重启（不装系统软件、不重装依赖、不改配置），它会做健康检查
if SKIP_PACKAGES=1 SKIP_NPM=1 bash "$APP/deploy/install.sh" >/dev/null 2>&1; then
  rm -rf "$APP/node_modules.prev"
  say "已更新到 ${NEW:0:7}"
  exit 0
fi
rollback
