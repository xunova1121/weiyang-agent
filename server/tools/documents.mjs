/**
 * Word / PPT / Excel / PDF：用原未央的文档引擎（server/docs/，原样复制）生成和读取，存进工作文件夹。
 * 写文件（create_document）先问用户；读文件（read_document）直接放行。都只碰工作文件夹。
 * PDF：服务器装了 LibreOffice 时先做成 Word 再转 PDF；没装时做成 A4 可打印网页，并说清楚。
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { generate, parseFile } from '../docs/agent/docs.js';
import { THEME_IDS, REPORT_THEME_IDS, TEMPLATE_THEME_IDS, themeList } from '../docs/agent/themes.js';
import { ALL_STYLE_IDS } from '../docs/agent/pptStyles.js';
import { SHEET_STYLE_IDS } from '../docs/agent/spreadsheetDesign.js';
import { officeTypography } from '../docs/agent/officeTypography.js';
import { toPdf } from '../officeRender.mjs';
import { userError } from './registry.mjs';

export const FORMATS = ['docx', 'pptx', 'xlsx', 'pdf', 'html', 'md', 'txt', 'csv'];
const READABLE = /\.(docx?|wps|pptx|xlsx?|ods|pdf|html?|md|txt|csv|json)$/i;
const MAX_READ = 32 * 1024 * 1024;
const BAD_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;

const DESCRIPTION = `生成 Word / PPT / Excel / PDF 等文件，保存到工作文件夹（默认放在“文档”里，重名自动加序号；改已有文件时 path 填原路径直接覆盖，不要另起“_v2”这类新名字）。排版自动完成（A4、标题样式、编号列表、带表头底色的表格、页码；Word / PDF 二级标题 3 个以上自动加目录）。
content 用 Markdown：
- docx / pdf / html：开头一个“# 文档标题”，正文用 ## 一级标题、### 二级标题、#### 三级标题；支持多级列表（缩进两个空格）、| 表格 |（:--: 居中、--: 右对齐）、**粗体**、*斜体*、[链接](https://…)、> 引用、代码块、--- 分隔线、单独一行 [分页]、![图注](工作文件夹里的图片路径)。
  招租、招聘、启事、海报这类贴出去的一页告示：kind 填 poster，字号自动取最大、铺满一页。公文（通知、请示、报告、函）theme 用 gongwen，可填 issuer（发文单位，加红头）和 docNo（文号）。
- pptx：每页用“## 页标题”。汇报、方案类的页标题写成一句观点（如“建设必要性：补齐告警到处置的人工断点”）。版式按内容自动选：
  · 3–8 条“标签：说明”→ 卡片；页标题含流程 / 步骤 / 闭环 → 步骤箭头
  · 2–6 条以数字开头（“67 万元：总投资”）→ 大数字卡片；3–7 条以日期开头 → 时间线；“名称：百分比”→ 进度条
  · 一句“A→B→C→D”→ 流程图；带数字列的表格 → 柱状图；其他表格 → 表格；两个 ### 小标题 → 左右对比
  · 一两句话 → 大字重点页；“第一部分……”→ 章节页；“谢谢”→ 结尾页
  · 页内单独一行“版式：卡片”（大数字 / 卡片 / 步骤 / 时间线 / 流程 / 对比 / 图表 / 柱状图 / 饼图 / 折线图 / 关系图 / 进度 / 表格 / 重点句 / 章节 / 要点）可指定版式，前后各空一行
  每条一句完整的话，不要整页长段落；同一种版式不要连续超过 2 页；封面信息（单位、日期）用 author 和 subtitle。
- xlsx：Markdown 表格，“## 名称”分出多个工作表；“合计”行和“增长率 / 同比 / 完成率 / 占比”列自动写成 Excel 公式，也可以直接写“=SUM(B2:B5)”；1,200、18%、¥300、2026-10-14 自动设成对应格式；kind 填 settlement（结算对账）/ ledger（台账清单）/ budget（预算测算）/ analysis（分析报表）。
- csv：单个表格，自动加 BOM（Excel 打开中文不乱码）。
theme 可选：${themeList()}。不填按内容自动选。
生成后回执里有读回的内容和检查结果，按回执如实告诉用户（含文件路径），不要说没做到的事。`;

/** 工作文件夹里的保存路径：没给就放“文档/标题.格式”，重名加序号 */
export function outputPath(ctx, { path: rel, title, ext }) {
  if (rel) {
    const clean = String(rel).trim();
    const want = clean.toLowerCase().endsWith(`.${ext}`) ? clean : `${clean.replace(/\.[a-z0-9]{1,5}$/i, '')}.${ext}`;
    ctx.resolve(want); // 不在工作文件夹里就抛错
    return want;
  }
  const stem = (String(title || '未命名').replace(BAD_CHARS, ' ').replace(/\s+/g, ' ').trim() || '未命名').slice(0, 60);
  for (let i = 1; ; i++) {
    const cand = `文档/${stem}${i > 1 ? `(${i})` : ''}.${ext}`;
    if (!fs.existsSync(ctx.resolve(cand))) return cand;
  }
}

const sizeText = (n) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);

export function tools(ctx) {
  // ![图注](路径)：只读工作文件夹里的图片，读不到就留占位
  const loadImage = async (src) => {
    if (/^[a-z]+:/i.test(src)) return null; // 不下载网上的图
    try { return new Uint8Array(fs.readFileSync(ctx.resolve(decodeURI(src)))); } catch { return null; }
  };
  return [
    {
      name: 'create_document',
      description: DESCRIPTION,
      schema: {
        format: z.enum(FORMATS),
        content: z.string().describe('Markdown 内容'),
        title: z.string().optional().describe('文档标题'),
        path: z.string().optional().describe('保存路径（工作文件夹里）；新建可省略。改已有文件时填原路径'),
        theme: z.enum([...THEME_IDS, ...REPORT_THEME_IDS, ...TEMPLATE_THEME_IDS]).optional().describe('配色主题，不填自动选'),
        style: z.enum(ALL_STYLE_IDS).optional().describe('PPT 设计风格：business 稳重商务 / minimal 简洁留白 / story 叙事氛围 / data 数据报告 / report 政企汇报。不填自动选'),
        sheet_style: z.enum(SHEET_STYLE_IDS).optional().describe('Excel 风格：business / minimal / ledger / analysis'),
        kind: z.string().optional().describe('文种：Word 用 notice 通知函 / minutes 会议纪要 / policy 制度办法 / proposal 方案 / report 报告总结 / poster 单页告示 / general；Excel 用 settlement / ledger / budget / analysis / general。不填自动判断'),
        cover: z.boolean().optional().describe('Word / PDF 加封面（正式报告、方案、标书建议加）'),
        subtitle: z.string().optional(),
        author: z.string().optional().describe('署名，如单位或部门（用在封面）'),
        issuer: z.string().optional().describe('公文发文单位（加红头）'),
        doc_no: z.string().optional().describe('公文文号，如“×政办发〔2026〕12号”'),
        toc: z.enum(['auto', 'yes', 'no']).optional().describe('目录，默认 auto'),
        font_size: z.number().min(8).max(72).optional().describe('正文字号（磅），用户明确说了才填'),
        title_font_size: z.number().min(8).max(72).optional().describe('标题字号（磅）'),
        print_friendly: z.boolean().optional().describe('PPT 打印友好：不用深色背景')
      },
      risk: 'write',
      run: async (a) => {
        if (!String(a.content ?? '').trim() && a.format !== 'csv') throw userError('content 是空的：先把要写的内容用 Markdown 写好再生成');
        const title = a.title || String(a.content).match(/^#\s+(.+)$/m)?.[1]?.trim() || '未命名';
        const typography = a.font_size || a.title_font_size ? officeTypography('', { body: a.font_size, title: a.title_font_size }) : {};
        const opts = { title, content: a.content, theme: a.theme, style: a.style || 'business', sheetStyle: a.sheet_style, kind: a.kind, cover: a.cover, subtitle: a.subtitle, author: a.author, issuer: a.issuer, docNo: a.doc_no, toc: a.toc || 'auto', typography, printFriendly: a.print_friendly, loadImage };
        const notes = [];
        let out;
        if (a.format === 'pdf') {
          // 先排成 Word，再用 LibreOffice 转：和 Word 版排版一致
          const docx = await generate('docx', opts);
          const pdf = await toPdf(Buffer.from(await docx.blob.arrayBuffer()), 'docx').catch((e) => { console.warn('[PDF 转换]', e.message); return null; });
          if (pdf) out = { bytes: pdf, ext: 'pdf', info: docx.info };
          else {
            const html = await generate('pdf', opts);
            out = { bytes: Buffer.from(await html.blob.arrayBuffer()), ext: 'html', info: html.info };
            notes.push('服务器没装 LibreOffice（或转换失败），做成了 A4 排版的网页：下载后用浏览器打开，按“打印 → 另存为 PDF”就是 PDF。请把这一点告诉用户。');
          }
        } else {
          const r = await generate(a.format, opts);
          out = { bytes: Buffer.from(await r.blob.arrayBuffer()), ext: r.ext, info: r.info };
          if (r.note) notes.push(r.note);
        }
        const rel = outputPath(ctx, { path: a.path, title, ext: out.ext });
        const abs = ctx.resolve(rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        const existed = fs.existsSync(abs);
        fs.writeFileSync(abs, out.bytes);
        // 读回实际内容：让模型按真实结果回答
        let back = '';
        if (['docx', 'pptx', 'xlsx', 'pdf'].includes(out.ext)) {
          try { back = (await parseFile(new Blob([out.bytes]), rel, { limit: 1500 })).text; } catch (e) { notes.push(`读回检查没成功（${String(e.message).slice(0, 80)}），文件可能有问题，请如实告诉用户`); }
        }
        const info = out.info || {};
        const facts = [
          info.slides && `${info.slides} 页幻灯片${info.layouts ? `（版式：${info.layouts.join('、')}）` : ''}`,
          info.sheets && `${info.sheets} 个工作表、${info.formulas ?? 0} 个公式${info.formulaIssues?.length ? `；公式问题：${info.formulaIssues.slice(0, 5).map((x) => x.text || x).join('；')}` : ''}`,
          info.headings && `${info.headings} 个标题${info.toc ? '，带目录' : ''}`,
          info.missingImages?.length && `这些图片没找到，留了占位：${info.missingImages.join('、')}`
        ].filter(Boolean);
        return [
          `已${existed ? '覆盖' : '生成'}：${rel}（${sizeText(out.bytes.length)}）${facts.length ? '\n' + facts.join('\n') : ''}`,
          ...notes,
          back && `读回的开头：\n${back}`,
          '用户可以在网页右上角“文件”里下载。'
        ].filter(Boolean).join('\n\n');
      }
    },
    {
      name: 'read_document',
      description: '读取工作文件夹里 Word（docx，含被改成 .doc 后缀的）、PPT（pptx）、Excel（xlsx / xls，含公式清单）、PDF（文字版）、网页、文本文件的文字内容。扫描版 PDF、图片用 read_image。',
      schema: {
        path: z.string().describe('工作文件夹里的相对路径'),
        max_chars: z.number().int().min(1000).max(200_000).optional().describe('最多读多少字，默认 30000')
      },
      risk: 'read',
      run: async ({ path: rel, max_chars: limit = 30_000 }) => {
        const abs = ctx.resolve(rel);
        let st;
        try { st = fs.statSync(abs); } catch { throw userError(`工作文件夹里没有“${rel}”`); }
        if (!st.isFile()) throw userError(`“${rel}”不是文件`);
        if (!READABLE.test(rel)) throw userError('这种文件读不了（支持 Word、PPT、Excel、PDF、网页、文本）；图片用 read_image');
        if (st.size > MAX_READ) throw userError('文件太大（最多 32MB）');
        let r;
        try { r = await parseFile(new Blob([fs.readFileSync(abs)]), rel, { limit }); }
        catch (e) { throw userError(`读不了“${rel}”：${String(e.message).slice(0, 120)}`); }
        if (!r.text.trim()) throw userError(`“${rel}”里没读到文字（扫描件或图片可以用 read_image）`);
        return `“${rel}”的内容（共 ${r.chars} 字）：\n\n${r.text}`;
      }
    }
  ];
}
