# 未央 Agent 版（weiyang-agent）

和原来的未央完全独立的新版本：服务器上用 [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) 驱动智能体，模型接 DeepSeek 的 Anthropic 兼容接口；手机和电脑都用浏览器连服务器使用。

> **第一版三批都已完成**：登录、发消息实时出字、断线按序号续接；对话列表（打开旧对话、改名、删除），刷新页面能接上正在进行的回复；
> 看/找/搜文件直接做，**新建/修改文件和运行命令每次都先弹确认框**，运行命令只在沙箱里；工作文件夹可以在网页上浏览、下载、上传、删除；Docker 部署。
> 还没验收：接真实 DeepSeek 的效果、在你自己的服务器上安装。

## 部署方式零：宝塔面板 / 一条命令安装

用宝塔面板的服务器（OpenCloudOS、CentOS、Ubuntu）看 [deploy/宝塔安装说明.md](deploy/宝塔安装说明.md)。核心就两条：

```bash
cd /opt && git clone https://github.com/xunova1121/weiyang-agent.git
bash /opt/weiyang-agent/deploy/install.sh     # 会问登录密码和 DeepSeek 密钥（不显示），装成系统服务，只开在本机 8797
```

装好后自动更新：每 30 分钟检查一次 `stable` 分支（GitHub 上测试全过的版本才会进去），忙时不重启，起不来自动退回（`deploy/update.sh`）。

## 部署方式一：Docker

```bash
git clone https://github.com/xunova1121/weiyang-agent.git && cd weiyang-agent
cp .env.example .env      # 填好 WEIYANG_PASSWORD 和 DEEPSEEK_API_KEY
docker compose up -d --build
docker compose logs -f    # 看到“未央 Agent 版已启动”就好了
```

- 数据在 `./data`（配置、对话记录、工作文件夹），升级镜像不会丢。
- 默认只开在本机 8797 端口，前面加 HTTPS 再对外（见下面“加 HTTPS”）。
- **运行命令**在 Docker 里默认不开放（Docker 自己的安全设置会挡住沙箱，启动日志会说明）。要开放，在 `docker-compose.yml` 里去掉 `security_opt` 那三行的注释：`seccomp=unconfined`、`systempaths=unconfined`。这会放宽 Docker 自己的两项限制，命令仍在沙箱里：只能写工作文件夹、看不到配置和密钥、不能联网（实测过）。
- **国内构建**：Docker Hub、Ubuntu 和 npm 官方源可能很慢或连不上，按 `Dockerfile` 开头的说明换镜像源（`NODE_IMAGE`、`BASE_IMAGE`、`APT_MIRROR`、`NPM_REGISTRY`）。

## 部署方式二：直接装在服务器上（Ubuntu / Debian）

需要 Node.js 20 以上。想开放运行命令还要 `apt install bubblewrap socat`；没装就不开放，其他功能照常。
**Ubuntu 23.10 起（含 24.04）** 系统默认拦着沙箱，还要装一条只放行 bubblewrap 的 AppArmor 规则（见下面的步骤；GitHub 上的自动测试就是在 Ubuntu 24.04 上装了这条规则跑的）。

```bash
sudo apt install -y bubblewrap socat
sudo useradd --system --home /var/lib/weiyang-agent --create-home weiyang
sudo git clone https://github.com/xunova1121/weiyang-agent.git /opt/weiyang-agent
# 只在 Ubuntu 23.10+（含 24.04）需要：放行沙箱
sudo cp /opt/weiyang-agent/deploy/apparmor-bwrap /etc/apparmor.d/weiyang-bwrap && sudo apparmor_parser -r /etc/apparmor.d/weiyang-bwrap
cd /opt/weiyang-agent && sudo npm ci --omit=dev      # 国内加 --registry=https://registry.npmmirror.com
printf 'WEIYANG_PASSWORD=改成你的密码\nDEEPSEEK_API_KEY=你的密钥\n' | sudo tee /etc/weiyang-agent.env >/dev/null
sudo chmod 600 /etc/weiyang-agent.env
sudo cp deploy/weiyang-agent.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now weiyang-agent
journalctl -u weiyang-agent -f
```

这种方式只开在本机 127.0.0.1:8797，同样要在前面加 HTTPS。**和原来的未央装在同一台服务器上时**：端口、目录、用户都不一样（原未央 8787、`/opt/jarvis`、`jarvis`；这里 8797、`/opt/weiyang-agent`、`weiyang`），互不影响。

## 加 HTTPS

不要用明文 HTTP 从外网登录（密码会被看到）。最省事的是 [Caddy](https://caddyserver.com/)，有域名就自动申请证书：

```
your.domain.com {
    reverse_proxy 127.0.0.1:8797 {
        flush_interval -1    # 回复要边生成边推，不能攒着
    }
}
```

用 Nginx 的话，`location /` 里要加 `proxy_buffering off;` 和 `proxy_read_timeout 1h;`，否则回复会一下子才出来或中途断开。

## 本机试跑

```bash
npm ci
export WEIYANG_PASSWORD='至少8位的登录密码'
export DEEPSEEK_API_KEY='你的 DeepSeek 密钥'
npm start            # 默认 http://0.0.0.0:8797
```

也可以把配置写进 `data/config.json`（`data/` 不进仓库）：

```json
{ "password": "至少8位", "apiKey": "DeepSeek 密钥", "model": "deepseek-flash", "port": 8797 }
```

| 变量 | 默认 | 说明 |
|---|---|---|
| `WEIYANG_PASSWORD` | 无（必填） | 网页登录密码，至少 8 位 |
| `DEEPSEEK_API_KEY` | 无（必填） | 也可用 `MODEL_API_KEY` |
| `MODEL_BASE_URL` | `https://api.deepseek.com/anthropic` | Anthropic 格式的接口地址，不要以 `/v1` 结尾 |
| `MODEL` | `deepseek-flash` | 型号名以 DeepSeek 文档为准 |
| `PORT` / `HOST` | `8797` / `0.0.0.0` | 原未央用 8787，这里默认 8797，两个可以装在同一台服务器上 |
| `DATA_DIR` | `./data` | 登录令牌、对话记录、工作文件夹都在这里 |
| `ALLOW_COMMANDS` | `auto` | `auto`：沙箱能用就开放运行命令；`off`：不开放 |

## 安全设计

- **不连 Anthropic**：传给 SDK 的环境里关掉了统计、错误上报、自动更新（`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` 等）。测试里所有外连都经一个“只记录、一律拒绝”的代理，断言一次都没有。
- **不泄露服务器环境**：SDK 进程只拿到 PATH、HOME 和模型地址/密钥，拿不到登录密码等其他环境变量。
- **只能碰工作文件夹**：读、找、搜、写、改文件的路径先换成真实路径再核对（含 `../`、绝对路径、符号链接），在 `data/workspace` 外面就拒绝。配置文件（含密钥）、登录令牌、对话记录都在外面。用 SDK 的 PreToolUse 钩子实现，每次调用都会过，钩子出错按拒绝处理。
- **改文件、运行命令先问你**：每次弹确认框（允许 / 本次对话都允许 / 拒绝）；点停止或 15 分钟没回答都按拒绝。
- **运行命令只在沙箱里**（Agent SDK 自带，要 bubblewrap 和 socat）：只能写工作文件夹；配置、令牌、对话记录都看不到；不能联网；模型密钥不在命令的环境变量里。启动时按 SDK 真正的用法试一次沙箱，起不来就不开放运行命令，不会退回到沙箱外面跑。测试里逐条验证过，Docker 里也验证过。
- **网页上的文件操作**（浏览、下载、上传、删除）用同一套路径判断，也碰不到工作文件夹外面；上传单个文件最多 20MB，重名自动加序号不覆盖；下载一律当附件，不在浏览器里直接打开。
- **登录**：令牌只存哈希；同一来源连错 5 次锁 10 分钟。
- 密钥和密码只放服务器上，不进仓库（仓库是公开的）。

## 测试

```bash
npm test     # 单元 + 端到端（真的 SDK + 假模型 + 真的 HTTP 服务），不需要真实密钥
npm run e2e  # 真浏览器（需要本机有 Playwright 和 Chromium），电脑和手机两种宽度
node test/server.smoke.mjs https://your.domain.com 你的密码   # 装好以后对真服务器做一遍冒烟检查
```

接真实 DeepSeek 的效果还**没测过**（这里没有密钥，也不该有）：装好后跑一遍上面的冒烟检查（不加 `--fake`），再在网页上实际问几句。

## 目录

- `server/`：`main.mjs` 启动；`config.mjs` 配置；`auth.mjs` 登录；`tasks.mjs` 任务、按序号续接、确认框；`agentRunner.mjs` 调用 SDK、沙箱设置；`pathGuard.mjs` 路径守卫；`sessions.mjs` 对话列表；`files.mjs` 工作文件夹的文件；`http.mjs` 接口
- `deploy/install.sh`：一条命令安装/升级（宝塔等）；`deploy/宝塔安装说明.md`；`deploy/weiyang-agent.service`：systemd 服务；`deploy/apparmor-bwrap`：Ubuntu 23.10+ 放行沙箱
- `Dockerfile`、`docker-compose.yml`、`.env.example`：Docker 部署
- `web/`：网页（不需要构建）
- `test/`：测试，`fakeModel.mjs` 是假模型和记录外连的代理
- `spike/`：接入前的实验脚本

## 许可

本仓库代码的许可待定。依赖的 Claude Agent SDK 不是开源软件，按 [Anthropic 商业条款](https://www.anthropic.com/legal/commercial-terms) 使用。
