#!/usr/bin/env bash
# 自动更新未央 Agent 版：系统定时器每 30 分钟用 root 跑一次（deploy/install.sh 会装好），也可以手动跑：
#   bash /opt/weiyang-agent/deploy/update.sh
# 规则：
#   - 只拉 stable 分支：GitHub 上自动测试全过的版本才会进 stable，没测过的代码不会装到服务器上
#   - 先直连 GitHub，不通再走加速镜像；经镜像拿到的要和 GitHub 接口给的版本编号核对一致才装
#   - 都连不上就这次不更新，下次再试（国内常见的 Empty reply 换用 HTTP/1.1）
#   - 有回复正在进行（数据目录里有 .busy）就先不重启，下次再试
#   - 依赖有变化时先在旁边装好，装不上就这次不更新，正在用的版本一点不动
#   - 更新后服务起不来，自动退回上一个版本
# 不碰密码、密钥（/etc/weiyang-agent.env）和数据（/var/lib/weiyang-agent）。
set -uo pipefail

# 更新会改到本脚本自己：先复制一份到临时文件再从那里跑，免得边跑边被改
if [ -z "${WEIYANG_UPDATE_COPY:-}" ]; then
  COPY="$(mktemp /tmp/weiyang-update.XXXXXX.sh)"
  cp "${BASH_SOURCE[0]}" "$COPY"
  APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}" WEIYANG_UPDATE_COPY="$COPY" exec bash "$COPY" "$@"
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

# 先直连 GitHub，不通再依次走加速镜像（国内服务器常常直连不通）。“-”表示直连
REPO_URL="${UPDATE_REPO_URL:-$(git remote get-url origin)}"
read -ra MIRRORS <<< "${UPDATE_MIRRORS:-- https://ghfast.top/ https://gh-proxy.com/ https://ghproxy.net/}"
VIA=""
for m in "${MIRRORS[@]}"; do
  [ "$m" = - ] && m=""
  if timeout 120 git -c http.version=HTTP/1.1 -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=30 fetch -q "${m}${REPO_URL}" "$BRANCH" 2>/dev/null; then VIA="${m:-直连}"; break; fi
done
[ -n "$VIA" ] || { say "这次直连和镜像都连不上 GitHub，下次再试"; exit 0; }

OLD="$(git rev-parse HEAD)"
NEW="$(git rev-parse FETCH_HEAD)"
[ "$OLD" = "$NEW" ] && { say "已是最新（${OLD:0:7}，经$VIA）"; exit 0; }

# 经镜像拿到的：镜像是别人的服务器，可能被篡改。向 GitHub 接口直接要 stable 的版本编号核对，
# 编号一致就说明内容和 GitHub 上的一字不差（git 按内容算编号）；对不上就不装。
# 接口也连不上时默认这次不装；在 /etc/weiyang-agent.env 里写 UPDATE_TRUST_MIRROR=1 才直接信任镜像（和原未央的做法一样）
if [ "$VIA" != 直连 ]; then
  OWNER_REPO="$(printf '%s' "$REPO_URL" | sed -E 's#^https://github.com/##; s#\.git$##')"
  SHA_URL="${UPDATE_SHA_URL:-https://api.github.com/repos/$OWNER_REPO/commits/$BRANCH}"
  EXPECTED=""
  for _ in 1 2 3; do
    EXPECTED="$(curl -fsS -m 15 -H 'Accept: application/vnd.github.sha' "$SHA_URL" 2>/dev/null | tr -d '[:space:]')"
    [[ "$EXPECTED" =~ ^[0-9a-f]{40}$ ]] && break
    EXPECTED=""; sleep 5
  done
  TRUST="$(sed -n 's/^UPDATE_TRUST_MIRROR=//p' /etc/weiyang-agent.env 2>/dev/null | tail -1)"
  if [ -n "$EXPECTED" ] && [ "$EXPECTED" != "$NEW" ]; then
    say "经 $VIA 拿到的 ${NEW:0:7} 和 GitHub 上的 ${EXPECTED:0:7} 对不上，可能被篡改，不装"; exit 0
  elif [ -z "$EXPECTED" ] && [ "$TRUST" != 1 ]; then
    say "经 $VIA 拿到 ${NEW:0:7}，但连不上 GitHub 接口核对编号，这次不装（要信任镜像就在 /etc/weiyang-agent.env 加 UPDATE_TRUST_MIRROR=1）"; exit 0
  elif [ -z "$EXPECTED" ]; then
    say "经 $VIA 拿到 ${NEW:0:7}，连不上 GitHub 接口核对，按设置信任镜像"
  else
    say "经 $VIA 拿到 ${NEW:0:7}，已和 GitHub 上的编号核对一致"
  fi
fi
# 上次装了起不来、已经退回的版本：不再反复试（否则每 30 分钟重启一次），等出了更新的版本再装
FAILED_MARK="$DATA/.update-failed"
if [ "$(cat "$FAILED_MARK" 2>/dev/null)" = "$NEW" ]; then say "${NEW:0:7} 上次装了起不来，已跳过，等下一个版本"; exit 0; fi

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

# 跑安装脚本（重新生成服务并重启、做健康检查）；输出写进更新记录（journalctl -u weiyang-agent-update），出错能查
run_install() {
  SKIP_PACKAGES=1 SKIP_NPM=1 bash "$APP/deploy/install.sh" 2>&1 | sed 's/^/[未央更新]   /'
  return "${PIPESTATUS[0]}"
}

rollback() {
  say "新版本起不来，退回 ${OLD:0:7}"
  echo "$NEW" > "$FAILED_MARK"
  git reset -q --hard "$OLD"
  if [ -n "$STAGED" ] && [ -d "$APP/node_modules.prev" ]; then rm -rf "$APP/node_modules" && mv "$APP/node_modules.prev" "$APP/node_modules"; fi
  if run_install; then say "已退回，服务正常"; else say "退回后也没起来，请看 journalctl -u weiyang-agent"; fi
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
if run_install; then
  rm -rf "$APP/node_modules.prev"
  rm -f "$FAILED_MARK"
  say "已更新到 ${NEW:0:7}"
  exit 0
fi
rollback
