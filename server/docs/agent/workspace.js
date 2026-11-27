// 原未央 src/agent/workspace.js 的替身：文档引擎只用到这两个（原文件连着浏览器里的工作区存储，这里用不上）
export const ext = (p) => (String(p).match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
export const isText = (p) => /^(html?|css|m?js|json|md|txt|csv|py|svg|xml|ts|tsx|jsx|yml|yaml|ini|log|sh|bat)$/.test(ext(p));
