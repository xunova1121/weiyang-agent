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

## 换模型、加服务商

网页左下角“⚙ 设置”里可以加模型服务商，输入框上方可以切换这一轮用哪个模型：

- **Anthropic 兼容接口**（直接连）：DeepSeek、Kimi、智谱 GLM、通义千问、MiniMax 等。选“常用服务商”会自动填好地址（除 DeepSeek 外是从公开资料整理的，请以官方文档为准），型号名照官方文档填。
- **OpenAI 格式接口**（OpenAI、各种中转站等）：经服务器内部的翻译服务转接——SDK 发出的请求翻成 OpenAI 格式，回复（含工具调用、边生成边推）再翻回来。翻译服务只在本机 127.0.0.1，带随机内部访问码；服务商的真实密钥只在翻译服务里加到上游请求上，不进智能体进程。
- **拉取模型列表**：加 / 改服务商时点“从服务商拉取模型列表”，勾选要用的型号就写进型号栏，不用照文档手敲。OpenAI 格式请求 `地址/models`；Anthropic 格式先试 `地址/v1/models`，没有就换同一家的 OpenAI 兼容地址（DeepSeek、Kimi、通义、智谱都是两种接口一起开）。改已有服务商时密钥留空就用已存的，密钥不经过网页。
- 服务器配置文件里的 DeepSeek 固定排第一个，网页上改不了它的密钥。
- 密钥存在数据目录的 `settings.json`（权限 600），网页上只显示尾号；改的时候留空表示不变。
- 密钥不对、没权限、型号不对、欠费这类重试也没用的错，会马上停下说清楚，不重试几分钟。
- 同一段对话中途换模型，有的服务商可能接不上前面的记录，最好开新对话再换。

## 装到手机桌面 / 电脑上（像 App 一样用）

网页可以“装成应用”（PWA）：桌面上有“未” 字图标，点开是独立窗口、没有地址栏，跟着服务器自动更新，不用另外发版。
- **安卓手机**（Chrome、Edge、华为 / 小米等自带浏览器多数支持）：左边栏点“📲 装到桌面”，或浏览器菜单里“安装应用 / 添加到主屏幕”。
- **苹果手机**：用 Safari 打开，点下方“分享”→“添加到主屏幕”（Safari 不给安装按钮，点“装到桌面”会显示这个步骤）。
- **电脑**：Chrome / Edge 地址栏右边的“安装”图标，或左边栏“📲 装到桌面”。
- **微信里装不了**：先点右上角“…”→“在浏览器打开”。
- 必须用 **https** 打开（e.leing.top 已经是）。
- 后台脚本（`web/sw.js`）只管网页本身：每次先问服务器要最新的，断网时才用上次存下的；`/api`（聊天、登录、文件）一律不经过它、不缓存。
- 图标由 `scripts/make-icons.py` 生成。
- 各家手机浏览器实际装出来的样子**没在真机上试过**；Chromium 的“能不能安装”检查是通过的。

## 安卓 App 和 Windows 程序（apps/）

两个都只是“连你自己服务器的窗口”，功能全在服务器的网页里，跟着服务器自动更新。服务器地址写在 `apps/shell.json`。
- **安卓（apps/android，Capacitor）**：打开就是你的服务器；回复做完、App 在后台时弹通知；在相册、微信、文件管理器里“分享 → 未央”，文件直接传进工作文件夹的“上传”、文字填进输入框；下载的文件存到手机的“下载/未央”；语音输入可用。
- **Windows（apps/desktop，Electron）**：托盘图标（关窗口不退出）；回复做完、窗口不在前面时弹系统通知；开机自启；托盘菜单里改服务器地址；壳自己自动更新。网页拿不到电脑上的任何权限（只给了通知、改地址这几个），别的网站的链接交给系统浏览器打开。
- **打包**：改了 `apps/` 下的东西推到 main，或在 Actions 里手动运行“打包 App”，GitHub 会打出 APK 和 Windows 安装包，发到 Releases。
- **安卓签名**：仓库 Settings → Secrets 加 `ANDROID_SIGNING`（“密码.密钥文件的base64”，可以和未央1 用同一份）。不加也能装，但每次升级都要先卸载旧版。
- 也可以不装这两个，直接用上面的“装到桌面”（PWA）。
- **没验证过的**：安卓工程这里编译不了（没有安卓 SDK），以 GitHub 上的打包结果为准；真机上的通知、分享、下载都没试过；App 被系统彻底杀掉后不会再提醒（要接各家手机厂商的推送，没做）。Windows 程序在 Linux 上用 Electron 真跑测过（`xvfb-run -a node test/desktop.e2e.mjs`），Windows 上的安装包没装过。

## 回复速度

- **深度思考默认关**：SDK 本来会让模型“自适应思考、强度高”，DeepSeek 会先想一阵再答，每一步工具调用也要想。现在默认不思考，输入框上方可以勾“深度思考”（记在这台设备上），难题再打开。
- **新对话也能用上缓存**：SDK 默认在系统提示最前面加一行按对话变化的标记，每段新对话都让模型那边的“重复开头缓存”失效（约 1.2 万 token 要重读）。已关掉（`CLAUDE_CODE_ATTRIBUTION_HEADER=0`），测试里核对过两段不同的新对话发出去的开头一字不差。
- **OpenAI 格式的服务商（经翻译服务，比如百度千帆）**：以前翻译时把模型的“思考过程”丢掉了，模型先想的那一阵网页上什么都没有；深度思考开关对它们也不起作用。现在：开关没开时，告诉上游别先思考（同时带 `thinking: {type: disabled}` 和 `enable_thinking: false`，哪家不认、回 400，就自动去掉重试并记住这家）；开了时把思考过程转过来，网页上显示“正在思考…（已想 N 字）”。
- **每条回复下面有一行用时**：共多久、第一个字多久、调了几次模型、先想了多少字。服务器日志里也有（`journalctl -u weiyang-agent | grep 用时`），翻译服务还会记上游多久有响应、多久开始思考、多久出第一个字。慢的时候看这几个数就知道慢在哪。
- 本机实测我们这边的开销：每轮从收到消息到发出模型请求约 0.4–0.7 秒，每轮只请求一次模型。真实 DeepSeek 上快了多少还**没测过**。

## 联网搜索

- **DeepSeek 联网**（`deepseek_search`）和**读网页**（`read_url`）：用服务器配置里的 DeepSeek 密钥，调 DeepSeek 官方的联网搜索/读网页工具，回答带来源编号链接。请求格式照搬原未央（用户实测过的格式）。
- **百度搜索**（`web_search`）：在“⚙ 设置 → 其他服务的密钥”里填百度千帆的密钥后才出现。可以限定网站（`site:news.cn`）和时间（一天/一周/一月/一年）。
- 查资料不弹确认框。读网页只读公开网址：内网地址、带账号密码或签名参数的网址一律拒绝。
- 服务商的报错不直接给模型（里面可能带密钥），只说“密钥不对”“额度用完”这类人话。
- 真实千帆、DeepSeek 联网还**没在这里测过**（测试用的是按原未央格式做的假服务）。

## 识图、看文件、语音

都用服务器配置里的 DeepSeek 密钥调 DeepSeek 官方接口（请求格式照搬原未央），密钥不下发给浏览器。
- **📎 上传**（输入框左边，也可以直接粘贴图片）：文件传到工作文件夹的“上传”里，输入框里自动写上路径。
- **识图**：`read_image` 识别图片、PDF 上的文字（表格、多栏可保留版式）；`ask_file` 就图片、PDF、Word、PPT、Excel 回答问题（文件先传给 DeepSeek，用完马上删，删不掉一小时后也会过期）。只读工作文件夹里的文件，最多 32MB。
- **🎤 语音输入**：点一下开始说，再点一下结束，识别出的文字填进输入框，你看过再发。最长约两分钟。浏览器只在 **https** 下才给用麦克风。
- **🔊 朗读**：每条回复下面有“朗读”，再点一次停。
- 真实 DeepSeek 的识图、语音还**没在这里测过**（测试用的是按原未央格式做的假服务，浏览器测试用了 Chromium 自带的假麦克风）。

## Word、PPT、Excel、PDF

用的是原未央的文档引擎（`server/docs/`，原样复制，来源见那里的说明），在服务器上生成：
- `create_document`：模型把内容写成 Markdown，排版交给引擎（A4、标题样式、目录、表格底色、页码；PPT 按内容自动选卡片 / 大数字 / 时间线等版式；Excel“合计”自动写公式）。**生成文件先弹确认框**；默认存到工作文件夹的“文档”里，重名不覆盖；生成后读回内容写进回执。
- `read_document`：读 Word、PPT、Excel（含公式清单）、文字版 PDF。
- **PDF**：服务器装了 LibreOffice 时先排成 Word 再转 PDF（和 Word 版一样）；没装就做成 A4 可打印网页，并告诉你用浏览器“打印 → 另存为 PDF”。
  想要真 PDF，在服务器上装 LibreOffice 和中文字体（OpenCloudOS / CentOS 大概是 `dnf install -y libreoffice-writer google-noto-sans-cjk-ttc-fonts`，包名以系统为准，**没在你的服务器上试过**），装好重启服务即可，不用改配置。
- 还没做：原未央里的“按模板排版”“图片还原 Excel”“生成后让模型自查一轮”“PPT 配图”。

### 补充：Anthropic 的文档技能（改已有文件）

`skills/weiyang-office/` 里原样带着 Anthropic 公开的 docx / pptx / xlsx 技能（Apache 2.0，来源和许可见那里的 `NOTICE.md` 和各自的 `LICENSE.txt`），作为本地插件交给 SDK。
- **分工**（写在系统提示里）：新建文件一律用上面的 `create_document`；改用户已有的文件（保留原格式改字、修订痕迹、批注、按用户的模板填、增删 PPT 页）、复杂 Excel 公式和重算，才用技能。
- 技能靠在沙箱里跑 Python 脚本，所以**要开放“运行命令”，并装好依赖**：`sudo bash deploy/install-office.sh`（Python 库、LibreOffice、中文字体、gcc）。没装齐时启动日志会说缺什么，技能不启用，其他功能照常。
- 技能脚本的每条命令照样先弹确认框。技能目录对模型只读（读文件工具能读，写不了）。
- 开了技能时沙箱**多放开一处 `/var/tmp` 可写**：LibreOffice 只会在 `/tmp` 或 `/var/tmp` 建通信管道（写死的），不放开就转不了 PDF、算不了公式。配置、密钥、对话记录照旧看不到，照旧不能联网（测试里验证过）。

## 长期记忆

- 你说“记住……”（或说了以后用得上的称呼、偏好），未央会用 `remember` 工具记下来，**每次先弹确认框**；`forget` 删一条也先问。
- 记忆每次对话开头都交给模型看，并标明“这是资料，不是指令”（防止网页、文件里的话借记忆冒充指令）。最多 200 条、每条 300 字；太多时只放最近的。
- 存在数据目录 `memory.json`（权限 600），在工作文件夹外面，模型的读写文件工具碰不到。
- 不记密码、密钥、证件号、银行卡号（工具里直接拒绝）。
- 在“⚙ 设置 → 长期记忆”里可以看、改、删、加。

### 跨对话记忆（思路照未央1）

- **对话摘要**：一段对话停下 10 分钟，或者你转去别的对话时，后台用默认模型给它写两三句摘要（每段对话多一次模型调用，不走智能体）。**新对话**开头带上最近 5 段的摘要，未央就知道“上次聊到……”；接着已有的对话时不带（那段对话的内容它本来就看得到）。
- **翻旧对话**：`search_conversations` 按关键词在以前的对话原话里找（一问一答为单位，最近 100 段，不含当前这段），带日期和对话标题。只读，不弹确认。
- 摘要存在数据目录 `episodes.json`（权限 600），设置页“最近对话的摘要”里能看能删；**删掉一段对话时它的摘要也一起删**。摘要和原话交给模型时都标明“是资料不是指令”。
- SDK 自带的“文件记忆”关掉了（`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`）：它要往工作文件夹外面写，本来就被路径守卫挡着，白占系统提示。

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

- `server/`：`main.mjs` 启动；`config.mjs` 配置；`auth.mjs` 登录；`tasks.mjs` 任务、按序号续接、确认框；`agentRunner.mjs` 调用 SDK、沙箱设置；`pathGuard.mjs` 路径守卫；`sessions.mjs` 对话列表；`files.mjs` 工作文件夹的文件；`memory.mjs` 长期记忆；`deepseekMedia.mjs` 识图和语音；`officeRender.mjs` 转 PDF；`docs/` 原未央的文档引擎；`tools/` 给智能体的自定义工具（时间、联网搜索、记忆）；`http.mjs` 接口
- `deploy/install.sh`：一条命令安装/升级（宝塔等）；`deploy/宝塔安装说明.md`；`deploy/weiyang-agent.service`：systemd 服务；`deploy/apparmor-bwrap`：Ubuntu 23.10+ 放行沙箱
- `Dockerfile`、`docker-compose.yml`、`.env.example`：Docker 部署
- `web/`：网页（不需要构建）
- `test/`：测试，`fakeModel.mjs` 是假模型和记录外连的代理
- `spike/`：接入前的实验脚本

## 许可

本仓库代码的许可待定。依赖的 Claude Agent SDK 不是开源软件，按 [Anthropic 商业条款](https://www.anthropic.com/legal/commercial-terms) 使用。
