/**
 * 基础工具：现在几点（北京时间）。模型自己不知道今天几号，问“今天星期几”“距离春节还有几天”时要用。
 */
import { z } from 'zod';

export function beijingNow(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: false });
  return fmt.format(now);
}

export function tools() {
  return [{
    name: 'current_time',
    description: '查现在的北京时间（年月日、星期、几点几分）。回答和今天、日期、星期、倒计时有关的问题前先调用。',
    schema: {},
    risk: 'read',
    run: async () => `现在是北京时间 ${beijingNow()}`
  }];
}
