# 文档引擎（来自原未央）

`agent/` 下的文件原样复制自原未央仓库 `xunova1121/-` 的 `jarvis/src/agent/`（提交 477ce979，2026-11-26），同一作者的代码。
只换了两个替身：`agent/workspace.js`、`core/networkRequest.js`（原文件连着浏览器存储和模型调用，引擎只用到其中两三个小函数）。

- 入口：`agent/docs.js` 的 `generate(format, options)`（写 Word / PPT / Excel / PDF / HTML / CSV）和 `parseFile(blob, name)`（读）。
- 智能体用的工具在 `../tools/documents.mjs`，测试在 `test/documents.test.mjs`。
- 原未央这边修了引擎的 bug，按同样的方式重新复制过来，不要在这里单独改（两边会分叉）；确实要改时写在这份说明里。
