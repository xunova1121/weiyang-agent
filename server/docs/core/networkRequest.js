// 原未央 src/core/networkRequest.js 的替身：文档引擎只用到 throwControl（原文件连着模型调用和重试）
export function throwControl(error, signal) {
  if (signal?.aborted) throw signal.reason ?? Object.assign(new Error('已停止'), { name: 'AbortError' });
  if (error?.name === 'AbortError' || ['RETRIEVAL_BUDGET', 'EVAL_QUOTA', 'EVAL_EXPIRED'].includes(error?.code)) throw error;
}
