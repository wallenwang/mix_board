import { parseOutline, flattenOutline, outlineToText } from "../src/outline.ts";

const cases: [string, string][] = [
  [
    "纯缩进（用户描述的写法）",
    `山茶间品牌
  品牌定位
    目标客群
    价格带
  视觉规范
    主色
    字体
门店体验
  动线
  陈列`,
  ],
  [
    "Markdown 无序列表",
    `- 品牌策略
  - 市场调研
    - 竞品分析
  - 定位
- 视觉系统
  - 标志
  - 色彩`,
  ],
  [
    "Markdown 标题",
    `# 第一章 品牌认知
## 1.1 什么是品牌
### 1.1.1 定义
### 1.1.2 作用
## 1.2 品牌资产
# 第二章 品牌定位`,
  ],
  [
    "标题 + 缩进混用",
    `## 品牌定位
- 目标市场
  - 一二线城市
  - 25-35 岁女性
- 差异化
### 小结
- 一句话定位`,
  ],
  [
    "带行内标记 / 待办 / 表格 / 代码块",
    `# **山茶间** 品牌手册
- [x] 完成 \`logo\` 设计
- [ ] 交接待办 [查看文档](https://a.b/c)
  - 备注：~~旧版~~ 已废弃
| 项目 | 值 |
| --- | --- |
\`\`\`js
const a = 1;
\`\`\`
## 渠道规划
1. 线上
2. 线下`,
  ],
  [
    "空行与 Tab",
    `一级

\t二级
\t\t三级
\t二级B
一级B`,
  ],
];

for (const [name, src] of cases) {
  const r = parseOutline(src);
  console.log("=".repeat(60));
  console.log(`【${name}】 roots=${r.roots.length} count=${r.count} depth=${r.maxDepth} skipped=${r.skipped}`);
  console.log(outlineToText(r.roots));
  const flat = flattenOutline(r.roots);
  console.log("flat:", flat.map((f) => `${f.key}${"  ".repeat(f.depth)}${f.text}(p=${f.parentKey})`).join(" | "));
}
