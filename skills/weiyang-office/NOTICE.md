# 来源和许可

`skills/docx`、`skills/pptx`、`skills/xlsx` 原样复制自 Anthropic 的公开仓库
https://github.com/anthropics/skills （提交 e4bb5d960d87126ff3b3a8af1a104b7db67560ba，2026-11-16 09:22:47 -0500）。
每个技能目录里的 `LICENSE.txt` 是它的许可：Apache License 2.0。没有改动原文件。

在未央 Agent 版里的用法：作为本地插件加载（`server/agentRunner.mjs` 的 `plugins` / `skills` 选项），
只在服务器开放了“运行命令”（沙箱）并装好 Python 库时才启用（见 `deploy/install-office.sh`）。
技能里的脚本在沙箱里跑：只能写工作文件夹，不能联网。
