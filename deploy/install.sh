#!/usr/bin/env bash
# 一条命令装好（或升级）未央 Agent 版。用 root 运行：
#   bash /opt/weiyang-agent/deploy/install.sh
# 做这些事：
#   1. 检查 Node.js 20 以上（宝塔：软件商店 → Node.js 版本管理器，装 22 并设为命令行版本）
#   2. 装沙箱工具 bubblewrap、socat（开放“运行命令”要用；装不上也能正常聊天、读写文件）
#   3. 建专门的系统账号 weiyang，数据放 /var/lib/weiyang-agent
#   4. 用国内镜像装依赖（不运行任何安装脚本）
#   5. 第一次装时问登录密码和 DeepSeek 密钥（输入时不显示），写进 /etc/weiyang-agent.env（只有 root 能读）
#   6. 注册成系统服务 weiyang-agent，只在本机 127.0.0.1:8797 监听，开机自启、崩了自动重启
# 和原来的未央（/opt/jarvis、端口 8787、账号 jarvis）互不影响，这个脚本一样也不碰。
# 可选环境变量：PORT（默认 8797）、NPM_REGISTRY（默认 npmmirror）、SKIP_PACKAGES=1（不装系统软件）
set -euo pipefail

APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA=/var/lib/weiyang-agent
ENVF=/etc/weiyang-agent.env
UNIT=/etc/systemd/system/weiyang-agent.service
PORT="${PORT:-8797}"
REG="${NPM_REGISTRY:-https://registry.npmmirror.com}"

say() { printf '== %s\n' "$*"; }
die() { printf '!! %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "请用 root 运行（宝塔终端默认就是 root）"
[ -f "$APP/server/main.mjs" ] || die "没找到程序文件：$APP/server/main.mjs"

# 1. Node.js
NODE="$(command -v node || true)"
[ -n "$NODE" ] || die "没找到 node。宝塔：软件商店 → Node.js 版本管理器，装 v22，并点“设为命令行版本”"
NODE="$(readlink -f "$NODE")"
MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[ "$MAJOR" -ge 20 ] || die "Node.js 版本太低（$("$NODE" -v)），要 20 以上"
NPM="$(dirname "$NODE")/npm"
[ -x "$NPM" ] || NPM="$(command -v npm || true)"
[ -n "$NPM" ] || die "没找到 npm"
say "Node.js $("$NODE" -v)：$NODE"

# 2. 沙箱工具
if [ "${SKIP_PACKAGES:-}" != 1 ]; then
  if ! command -v bwrap >/dev/null || ! command -v socat >/dev/null; then
    say "安装沙箱工具 bubblewrap、socat"
    if command -v dnf >/dev/null; then dnf install -y bubblewrap socat || say "沙箱工具没装上：运行命令不开放，其他功能照常"
    elif command -v yum >/dev/null; then yum install -y bubblewrap socat || say "沙箱工具没装上：运行命令不开放，其他功能照常"
    elif command -v apt-get >/dev/null; then apt-get install -y bubblewrap socat || say "沙箱工具没装上：运行命令不开放，其他功能照常"
    else say "不认识这个系统的软件包管理器，跳过沙箱工具（运行命令不开放）"; fi
  fi
  # Ubuntu 23.10+ 默认拦着沙箱：装只放行 bwrap 的 AppArmor 规则
  if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = 1 ] && command -v apparmor_parser >/dev/null; then
    say "放行沙箱（AppArmor 规则）"
    cp "$APP/deploy/apparmor-bwrap" /etc/apparmor.d/weiyang-bwrap && apparmor_parser -r /etc/apparmor.d/weiyang-bwrap
  fi
fi

# 端口不能和别的程序（比如原未央的 8787）撞
if command -v ss >/dev/null && ss -ltnH "sport = :$PORT" 2>/dev/null | grep -q . && ! systemctl is-active --quiet weiyang-agent 2>/dev/null; then
  die "端口 $PORT 已经被别的程序占用。换一个再装：PORT=8798 bash $APP/deploy/install.sh"
fi

# 3. 账号和数据目录
if ! id weiyang >/dev/null 2>&1; then
  say "建系统账号 weiyang"
  useradd --system --home-dir "$DATA" --create-home --shell /sbin/nologin weiyang 2>/dev/null \
    || useradd --system --home-dir "$DATA" --create-home --shell /usr/sbin/nologin weiyang
fi
mkdir -p "$DATA"
chown weiyang:weiyang "$DATA"
chmod 700 "$DATA"

# 4. 依赖
say "安装依赖（$REG，一般 1～3 分钟）"
cd "$APP"
"$NPM" ci --omit=dev --ignore-scripts --no-audit --no-fund --registry="$REG"
# glibc 系统用不到 musl 版程序，删掉省 300 多 MB
if ldd --version 2>&1 | grep -qi 'glibc\|gnu libc'; then rm -rf node_modules/@anthropic-ai/claude-agent-sdk-*-musl; fi

# 5. 配置（已有就不动，升级时不会改你的密码和密钥）
if [ ! -f "$ENVF" ]; then
  say "第一次安装：设登录密码和 DeepSeek 密钥（输入时屏幕上不显示）"
  while :; do
    read -rsp "登录密码（至少 8 位，不要有空格、引号、反斜杠）：" P1 </dev/tty; echo
    read -rsp "再输一次：" P2 </dev/tty; echo
    [ "$P1" = "$P2" ] || { echo "两次不一样，重来"; continue; }
    [ "${#P1}" -ge 8 ] || { echo "太短，至少 8 位"; continue; }
    case "$P1" in *[[:space:]\"\'\\]*) echo "不要有空格、引号、反斜杠"; continue;; esac
    break
  done
  while :; do
    read -rsp "DeepSeek 密钥（以 sk- 开头）：" KEY </dev/tty; echo
    [ -n "$KEY" ] && case "$KEY" in *[[:space:]\"\'\\]*) false;; *) true;; esac && break
    echo "密钥不能为空，也不能有空格或引号"
  done
  umask 077
  printf 'WEIYANG_PASSWORD=%s\nDEEPSEEK_API_KEY=%s\nPORT=%s\n' "$P1" "$KEY" "$PORT" > "$ENVF"
  unset P1 P2 KEY
  chown root:root "$ENVF"
  chmod 600 "$ENVF"
else
  say "已有配置 $ENVF，不改动（要改密码或密钥就编辑它，再 systemctl restart weiyang-agent）"
fi

# 6. 系统服务（用本机实际的 node 路径和端口）
sed -e "s|^ExecStart=.*|ExecStart=$NODE server/main.mjs|" \
    -e "s|^WorkingDirectory=.*|WorkingDirectory=$APP|" \
    -e "s|PORT=8797|PORT=$PORT|" \
    "$APP/deploy/weiyang-agent.service" > "$UNIT"
systemctl daemon-reload
systemctl enable weiyang-agent >/dev/null 2>&1
systemctl restart weiyang-agent

say "等服务起来"
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" 2>/dev/null | grep -q '"ok":true'; then
    say "好了：未央 Agent 版已在运行（本机 127.0.0.1:$PORT）"
    journalctl -u weiyang-agent -n 5 --no-pager 2>/dev/null | grep -E '已启动|沙箱|跑命令' || true
    echo "下一步：在宝塔里给你的域名加反向代理，目标 http://127.0.0.1:$PORT（见 deploy/宝塔安装说明.md）"
    exit 0
  fi
  sleep 1
done
journalctl -u weiyang-agent -n 30 --no-pager 2>/dev/null || true
die "服务没起来，看上面的日志"
