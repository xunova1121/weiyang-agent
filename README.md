# 未央 Agent 版（weiyang-agent）

和原来的未央完全独立的新版本：服务器上用 [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) 驱动智能体，模型接 DeepSeek 的 Anthropic 兼容接口；手机和电脑都用浏览器连服务器使用。

> 开发中。**第一、二批已完成**：登录、发消息实时出字、断线按序号续接；对话列表（打开旧对话、改名、删除），刷新页面能接上正在进行的回复；
> 看/找/搜文件直接做，**新建/修改文件和运行命令每次都先弹确认框**，运行命令只在沙箱里。第三批：文件下载、Docker 部署。

## 运行

需要 Node.js 20 以上。想开放“运行命令”，服务器还要装 bubblewrap（`apt install bubblewrap`）；没装就不开放，其他功能照常。

```bash
npm ci
export WEIYANG_PASSWORD='至少8位的登录密码'
export DEEPSEEK_API_KEY='你的 DeepSeek 密钥'
npm start            # 默认 http://0.0.0.0:8787
```

也可以把配置写进 `data/config.json`（`data/` 不进仓库）：

```json
{ "password": "至少8位", "apiKey": "DeepSeek 密钥", "model": "deepseek-flash", "port": 8787 }
```

| 变量 | 默认 | 说明 |
|---|---|---|
| `WEIYANG_PASSWORD` | 无（必填） | 网页登录密码，至少 8 位 |
| `DEEPSEEK_API_KEY` | 无（必填） | 也可用 `MODEL_API_KEY` |
| `MODEL_BASE_URL` | `https://api.deepseek.com/anthropic` | Anthropic 格式的接口地址，不要以 `/v1` 结尾 |
| `MODEL` | `deepseek-flash` | 型号名以 DeepSeek 文档为准 |
| `PORT` / `HOST` | `8787` / `0.0.0.0` | |
| `DATA_DIR` | `./data` | 登录令牌、对话记录、工作文件夹都在这里 |
| `ALLOW_COMMANDS` | `auto` | `auto`：有沙箱就开放运行命令；`off`：不开放 |

公网使用请在前面加 HTTPS（Nginx / Caddy 反向代理），不要用明文 HTTP 传密码。

## 安全设计

- **不连 Anthropic**：传给 SDK 的环境里关掉了统计、错误上报、自动更新（`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` 等）。测试里所有外连都经一个“只记录、一律拒绝”的代理，断言一次都没有。
- **不泄露服务器环境**：SDK 进程只拿到 PATH、HOME 和模型地址/密钥，拿不到登录密码等其他环境变量。
- **只能碰工作文件夹**：读、找、搜、写、改文件的路径先换成真实路径再核对（含 `../`、绝对路径、符号链接），在 `data/workspace` 外面就拒绝。配置文件（含密钥）、登录令牌、对话记录都在外面。用 SDK 的 PreToolUse 钩子实现，每次调用都会过，钩子出错按拒绝处理。
- **改文件、运行命令先问你**：每次弹确认框（允许 / 本次对话都允许 / 拒绝）；点停止或 15 分钟没回答都按拒绝。
- **运行命令只在沙箱里**（Agent SDK 自带，靠 bubblewrap）：只能写工作文件夹；配置、令牌、对话记录都看不到；不能联网；模型密钥不在命令的环境变量里。沙箱起不来就不跑，不会退回到沙箱外面。测试里逐条验证过。
- **登录**：令牌只存哈希；同一来源连错 5 次锁 10 分钟。
- 密钥和密码只放服务器上，不进仓库（仓库是公开的）。

## 测试

```bash
npm test     # 单元 + 端到端（真的 SDK + 假模型 + 真的 HTTP 服务），不需要真实密钥
npm run e2e  # 真浏览器（需要本机有 Playwright 和 Chromium），电脑和手机两种宽度
```

接真实 DeepSeek 的效果还**没测过**（这里没有密钥，也不该有）：配好密钥后在网页上实际问几句即可。

## 目录

- `server/`：`main.mjs` 启动；`config.mjs` 配置；`auth.mjs` 登录；`tasks.mjs` 任务、按序号续接、确认框；`agentRunner.mjs` 调用 SDK、沙箱设置；`pathGuard.mjs` 路径守卫；`sessions.mjs` 对话列表；`http.mjs` 接口
- `web/`：网页（不需要构建）
- `test/`：测试，`fakeModel.mjs` 是假模型和记录外连的代理
- `spike/`：接入前的实验脚本

## 许可

本仓库代码的许可待定。依赖的 Claude Agent SDK 不是开源软件，按 [Anthropic 商业条款](https://www.anthropic.com/legal/commercial-terms) 使用。
