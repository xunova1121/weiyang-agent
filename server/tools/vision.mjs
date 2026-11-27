/**
 * 识图、看文件：用户把图片、PDF、表格上传到工作文件夹（网页上 📎 或“文件”面板），
 * 智能体用这两个工具交给 DeepSeek 官方识别。只读工作文件夹里的文件，只读不改，直接放行。
 * 服务器没配 DeepSeek 密钥时不提供。
 */
import fs from 'node:fs';
import { z } from 'zod';
import { askFile, IMAGE_OR_DOC, MAX_FILE, ocr } from '../deepseekMedia.mjs';
import { userError } from './registry.mjs';

function readWorkspaceFile(ctx, rel) {
  const abs = ctx.resolve(rel);
  let st;
  try { st = fs.statSync(abs); } catch { throw userError(`工作文件夹里没有“${rel}”`); }
  if (!st.isFile()) throw userError(`“${rel}”不是文件`);
  if (!IMAGE_OR_DOC.test(rel)) throw userError('这种文件不支持（支持图片、PDF、Word、PPT、Excel、文本）');
  if (st.size > MAX_FILE) throw userError('文件太大（最多 32MB）');
  return fs.readFileSync(abs);
}

export function tools(ctx) {
  if (!ctx.cfg.apiKey) return [];
  const opts = { ...(ctx.fetch && { fetchImpl: ctx.fetch }) };
  return [
    {
      name: 'read_image',
      description: '识别工作文件夹里图片或 PDF 上的文字（截图、照片、扫描件、发票）。表格、多栏排版设 layout=true。只要文字时用它；要理解图里画了什么、回答关于图的问题，用 ask_file。',
      schema: {
        path: z.string().describe('工作文件夹里的相对路径，例如 照片/发票.jpg'),
        layout: z.boolean().optional().describe('保留表格、多栏等版式')
      },
      risk: 'read',
      run: async ({ path: rel, layout }) => {
        const r = await ocr(ctx.cfg, { name: rel, buffer: readWorkspaceFile(ctx, rel), layout: Boolean(layout) }, opts);
        return `“${rel}”识别出的文字（共 ${r.pages} 页）：\n\n${r.text}`;
      }
    },
    {
      name: 'ask_file',
      description: '就工作文件夹里的一个图片、PDF、Word、PPT、Excel 或文本文件提问，由 DeepSeek 看完文件回答（看图说话、读表格、总结 PDF）。一次问清楚要什么。',
      schema: {
        path: z.string().describe('工作文件夹里的相对路径'),
        question: z.string().describe('要问这个文件的问题'),
        layout: z.boolean().optional().describe('文件里有表格、多栏时设为 true')
      },
      risk: 'read',
      run: async ({ path: rel, question, layout }) => {
        const answer = await askFile(ctx.cfg, { name: rel, buffer: readWorkspaceFile(ctx, rel), question, layout: Boolean(layout) }, opts);
        return `关于“${rel}”：\n\n${answer}`;
      }
    }
  ];
}
