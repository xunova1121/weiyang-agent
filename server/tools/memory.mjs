/**
 * 长期记忆工具：记住、忘掉。改记忆算“写”，每次先弹确认框（防止网页、文件里的内容偷偷往记忆里塞东西）。
 * 记忆本身每轮开头已放进系统提示（见 agentRunner.systemAppend），不需要“查记忆”工具。
 */
import { z } from 'zod';
import { createMemory, MAX_TEXT } from '../memory.mjs';
import { userError } from './registry.mjs';

export function tools(ctx) {
  const memory = createMemory(ctx.cfg.dataDir);
  return [
    {
      name: 'remember',
      description: `把一件关于用户的事记进长期记忆（以后每次对话都能看到）。用户明确说“记住……”，或说了以后显然用得上的称呼、偏好、常用信息时用。一条写一件事，${MAX_TEXT} 字以内，用第三人称写清楚，例如“用户叫小徐，在杭州工作”。不要记密码、密钥、身份证号、银行卡号。`,
      schema: { text: z.string().describe('要记住的内容') },
      risk: 'write',
      run: async ({ text }) => {
        if (/(密码|password|密钥|api[_ -]?key|token|sk-[\w-]{8,}|\b\d{17}[\dXx]\b|\b\d{16,19}\b)/i.test(text)) throw userError('这条像是密码、密钥或证件/银行卡号，不记。');
        const r = memory.add(text, { by: 'agent' });
        if (r.error) throw userError(r.error);
        return r.duplicate ? `已经记过了（编号 ${r.item.id}）` : `记住了（编号 ${r.item.id}）：${r.item.text}`;
      }
    },
    {
      name: 'forget',
      description: '从长期记忆里删掉一条（用户说“忘掉……”“这条不对”时）。编号见系统提示里的长期记忆。',
      schema: { id: z.string().describe('记忆编号，方括号里那串') },
      risk: 'write',
      run: async ({ id }) => {
        if (!memory.remove(String(id).replace(/[[\]\s]/g, ''))) throw userError('没有这个编号的记忆');
        return '已忘掉这条';
      }
    }
  ];
}
