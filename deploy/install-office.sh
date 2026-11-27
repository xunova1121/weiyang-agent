#!/usr/bin/env bash
# 可选：装“文档技能”（改已有 Word / PPT / Excel）和真 PDF 要用的东西。用 root 运行一次：
#   bash /opt/weiyang-agent/deploy/install-office.sh
# 装这些：
#   1. Python 3 和技能脚本要的库（lxml、defusedxml、openpyxl、python-pptx、Pillow、pandas、markitdown），用清华镜像
#   2. LibreOffice（转 PDF、Excel 公式重算）、中文字体、poppler（PDF 转图片）、zip、gcc（技能在沙箱里启动 LibreOffice 要现编一个小垫片）
#   3. 用 weiyang 账号检查一遍库能不能导入，然后重启服务
# 自动更新不会跑这个脚本；只在你手动运行时装。装不上的软件会说明，不影响其他功能。
# 可选环境变量：PIP_INDEX（默认清华镜像）、PYTHON（指定 python3 的路径，默认用服务的 PATH 里那个）、SKIP_RESTART=1（装完不重启服务）、DRY_RUN=1（只打印要做的事）
set -euo pipefail

APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIP_INDEX="${PIP_INDEX:-https://pypi.tuna.tsinghua.edu.cn/simple}"
PY_LIBS=(lxml defusedxml openpyxl python-pptx pillow pandas markitdown)
SYSTEMD_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin

say() { printf '== %s\n' "$*"; }
warn() { printf '!! %s\n' "$*" >&2; }
die() { printf '!! %s\n' "$*" >&2; exit 1; }
run() { if [ "${DRY_RUN:-}" = 1 ]; then printf '   (演练) %s\n' "$*"; else "$@"; fi; }

[ "$(id -u)" = 0 ] || die "请用 root 运行（宝塔终端默认就是 root）"
[ -f "$APP/server/officeSkills.mjs" ] || die "没找到程序文件：$APP/server/officeSkills.mjs（先更新到最新版）"

# 1. 系统软件：一个一个装，某个包名在这个系统上不存在就跳过，不影响其他
if command -v dnf >/dev/null || command -v yum >/dev/null; then
  PM="$(command -v dnf || command -v yum)"
  pkg() { for p in "$@"; do run "$PM" install -y "$p" >/dev/null 2>&1 && say "已装 $p" && return 0; done; warn "没装上：$*（这个系统可能叫别的名字）"; return 0; }
  pkg python3
  pkg python3-pip
  pkg gcc
  pkg zip
  pkg poppler-utils
  pkg libreoffice-calc
  pkg libreoffice-writer
  pkg libreoffice-impress
  pkg google-noto-sans-cjk-ttc-fonts google-noto-sans-cjk-fonts google-noto-sans-sc-fonts wqy-microhei-fonts
elif command -v apt-get >/dev/null; then
  run apt-get update -qq || warn "apt-get update 失败，接着用现有的软件源"
  pkg() { for p in "$@"; do run env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$p" >/dev/null 2>&1 && say "已装 $p" && return 0; done; warn "没装上：$*"; return 0; }
  pkg python3
  pkg python3-pip
  pkg gcc
  pkg zip
  pkg poppler-utils
  pkg libreoffice-calc
  pkg libreoffice-writer
  pkg libreoffice-impress
  pkg fonts-noto-cjk
else
  warn "不认识这个系统的软件管理器（不是 dnf / yum / apt），系统软件请自己装；接着装 Python 库"
fi

# 2. Python 库：装给服务实际用的那个 python3（systemd 里的 PATH）
PY="${PYTHON:-$(PATH=$SYSTEMD_PATH command -v python3 || true)}"
[ -n "$PY" ] || die "没找到 python3，装不了技能要的库"
say "Python：$PY（$("$PY" --version 2>&1)）"
"$PY" -m pip --version >/dev/null 2>&1 || die "$PY 没有 pip：装上 python3-pip 后再运行"
pip_install() { run "$PY" -m pip install -q -i "$PIP_INDEX" "$@"; }
if ! pip_install "${PY_LIBS[@]}" 2>/tmp/weiyang-pip.err; then
  # Ubuntu 23.04 起系统 Python 默认不让 pip 装（PEP 668）：这台服务器专门跑未央，按系统级安装
  if grep -q externally-managed /tmp/weiyang-pip.err; then
    say "系统 Python 默认不让 pip 装，改用 --break-system-packages"
    pip_install --break-system-packages "${PY_LIBS[@]}" || die "Python 库没装上，看上面的报错"
  else
    cat /tmp/weiyang-pip.err >&2
    die "Python 库没装上（看上面的报错；国内网络可以换 PIP_INDEX）"
  fi
fi
rm -f /tmp/weiyang-pip.err

# 3. 用服务账号检查（服务启动时也是这样检查的，见 server/officeSkills.mjs）
CHECK='import importlib.util,sys
m=[x for x in ["lxml","defusedxml","openpyxl","pptx","PIL","pandas"] if importlib.util.find_spec(x) is None]
print(",".join(m)); sys.exit(1 if m else 0)'
AS=()
id weiyang >/dev/null 2>&1 && AS=(runuser -u weiyang --)
if [ "${DRY_RUN:-}" = 1 ]; then
  say "（演练）跳过检查和重启"
  exit 0
fi
if MISSING="$(env PATH=$SYSTEMD_PATH "${AS[@]}" "$PY" -c "$CHECK")"; then
  say "Python 库齐了"
else
  [ -n "$MISSING" ] || die "服务账号（weiyang）运行不了 $PY（权限不够？）"
  die "服务账号导入不了这些库：$MISSING（可能装到了别的 Python 里）"
fi
if PATH=$SYSTEMD_PATH command -v soffice >/dev/null; then say "LibreOffice：有（真 PDF、Excel 重算可用）"; else warn "没有 LibreOffice：文档技能照样能改文件，但 PDF 只能出可打印网页、Excel 公式不能重算"; fi
command -v gcc >/dev/null || warn "没有 gcc：技能在沙箱里启动 LibreOffice 会失败（转 PDF、重算公式用不了）"

if [ "${SKIP_RESTART:-}" != 1 ] && systemctl list-unit-files weiyang-agent.service >/dev/null 2>&1; then
  systemctl restart weiyang-agent && sleep 3
  journalctl -u weiyang-agent -n 20 --no-pager | grep -E "已启动|文档技能" | tail -2 || true
fi
say "好了。启动日志里写“文档技能已启用”就是开了（还要“运行命令”已开放）"
