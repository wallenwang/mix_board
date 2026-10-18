/**
 * 导出管线自检：Markdown 解析 → 块列表 → .docx 字节流。
 * 用 esbuild 打包后跑（源码里是免扩展名的相对导入，Node 直接跑不了）。
 *   node node_modules/.bin/esbuild --bundle --platform=node --format=esm \
 *        --outfile=<tmp>/test-export.mjs scripts/test-export.ts && node <tmp>/test-export.mjs
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { parseBlocks, blocksToHtml, renderMarkdown } from "../src/markdown";
import { markdownToDocx } from "../src/docx";
import { boardToMarkdown, outlineToMarkdown } from "../src/exportMd";

const SAMPLE = `# 山茶间品牌手册

这是**第一段**，带 *斜体*、\`行内代码\`、~~删除线~~ 和一个[链接](https://a.b/c)。

## 品牌定位

- 目标客群：25-35 岁都市女性
  - 一二线城市为主
  - 月收入 1.5w+
- 价格带：中高端
  1. 主力 399-899
  2. 形象款 1200+

### 待办清单

- [x] 完成 logo 设计
- [ ] 交付 VI 手册

> 一句话定位：**东方茶感的轻奢生活品牌**。

\`\`\`js
const brand = "山茶间";
console.log(brand);
\`\`\`

| 项目 | 负责人 | 状态 |
| --- | --- | --- |
| 标志 | 王老师 | 已完成 |
| 色彩 | 李老师 | 进行中 |

---

### 渠道规划

1. 线上旗舰店
2. 线下体验店
`;

const outDir = process.argv[2] || ".";
mkdirSync(outDir, { recursive: true });

const blocks = parseBlocks(SAMPLE);
console.log("[blocks]", blocks.length);
const kinds: Record<string, number> = {};
for (const b of blocks) kinds[b.type] = (kinds[b.type] ?? 0) + 1;
console.log("[kinds]", JSON.stringify(kinds));

const html = blocksToHtml(blocks);
console.log("[html bytes]", html.length);
if (!html.includes("<table>")) throw new Error("表格没渲染出来");
if (!html.includes("checkbox")) throw new Error("任务清单没渲染出来");
if (!html.includes("<pre><code")) throw new Error("代码块没渲染出来");
if (!html.includes("<blockquote>")) throw new Error("引用没渲染出来");
if (!html.includes("<hr>")) throw new Error("分隔线没渲染出来");
if (!html.includes("<h3>")) throw new Error("三级标题没渲染出来");

const docx = markdownToDocx(SAMPLE, "山茶间品牌手册");
console.log("[docx bytes]", docx.length);
writeFileSync(`${outDir}/sample.docx`, docx);

const boardMd = boardToMarkdown({
  project: "适老化改造",
  date: "2026-10-14 14:30",
  columns: [
    {
      name: "待办",
      tasks: [
        {
          title: "现场量房",
          priority: "紧急",
          due: "2026-10-20",
          tags: ["教材", "外勤"],
          description: "带激光测距仪\n记得拍水电位置",
          children: [
            { title: "联系业主确认时间", priority: "高" },
            { title: "准备图纸", done: true },
          ],
        },
        { title: "确定平面方案" },
      ],
    },
    { name: "已完成", tasks: [{ title: "收集参考图", done: true }] },
  ],
});
console.log("[board md]\n" + boardMd);
writeFileSync(`${outDir}/board.md`, boardMd);

const outlineMd = outlineToMarkdown(
  "山茶间思维导图",
  "品牌定位\n  目标客群\n  价格带\n视觉规范\n  主色",
  "共 5 个节点"
);
writeFileSync(`${outDir}/outline.md`, outlineMd);

console.log("[renderMarkdown snippet]", renderMarkdown(SAMPLE).slice(0, 120).replace(/\n/g, " "));
console.log("OK");
