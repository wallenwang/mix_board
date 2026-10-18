/**
 * 把「缩进式文本 / Markdown 大纲」解析成树，用来一键生成白板思维导图。
 *
 * 认定的层级规则（两种都支持，也能混着写）：
 *  1. 缩进：父节点不缩进，子节点比上一级多缩进一点（空格或 Tab 都行，
 *     不要求固定几个空格 —— 只要"比上一级多"就能识别成下一级）。
 *  2. Markdown 标题：`#` / `##` / `###` …，个数越多层级越深。
 *
 * 例：
 *   山茶间品牌                        → 根
 *     ├ 品牌定位                      → 子（缩进 2）
 *     │   └ 客群画像                  → 孙（缩进 4）
 *     └ 视觉规范
 *   # 另一个根
 */

export interface OutlineNode {
  text: string;
  children: OutlineNode[];
}

export interface OutlineParseResult {
  /** 顶层节点（可能多个） */
  roots: OutlineNode[];
  /** 节点总数 */
  count: number;
  /** 最大层级深度（根 = 1） */
  maxDepth: number;
  /** 被忽略的行数（空行、代码块、分隔线、表格） */
  skipped: number;
}

export interface OutlineOptions {
  /** 去掉行内 Markdown 标记（**粗体**、`代码`、[文字](链接) 等）。默认 true */
  stripMarks?: boolean;
  /** Tab 折算成几个空格。默认 4 */
  tabSize?: number;
}

// ---------- 单行解析 ----------

const RE_FENCE = /^\s*(```|~~~)/;
const RE_HEADING = /^(#{1,6})\s+(.*)$/;
const RE_BULLET = /^([-*+]|\d{1,3}[.)])\s+(.*)$/;
const RE_HR = /^\s*(?:-{3,}|\*{3,}|_{3,}|={3,})\s*$/;
const RE_TABLE = /^\s*\|.*\|\s*$/;
const RE_QUOTE = /^(?:>\s*)+/;
const RE_CHECKBOX = /^\[([ xX])\]\s*(.*)$/;

/** 抹掉行内 Markdown 标记，只留下能看的文字 */
export function stripInlineMarks(s: string): string {
  let t = s;
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1"); // ![alt](url) → alt
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"); // [文字](链接) → 文字
  t = t.replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1"); // 引用式链接
  t = t.replace(/`{1,3}([^`]*)`{1,3}/g, "$1"); // 行内代码
  t = t.replace(/\*\*\*([^*]+)\*\*\*/g, "$1");
  t = t.replace(/\*\*([^*]+)\*\*/g, "$1");
  t = t.replace(/___([^_]+)___/g, "$1");
  t = t.replace(/__([^_]+)__/g, "$1");
  t = t.replace(/~~([^~]+)~~/g, "$1");
  t = t.replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1$2"); // 斜体 *文字*
  t = t.replace(/(^|[\s(])_([^_\s][^_]*)_/g, "$1$2");
  t = t.replace(/\s+#+\s*$/, ""); // 行尾的多余 #
  return t.replace(/\s+$/, "").trim();
}

interface RawLine {
  /** 比较用的层级键：标题 = 0..5，普通行 = 100 + 缩进宽度 */
  rank: number;
  text: string;
}

function parseLine(trimmedRaw: string, tabSize: number, stripMarks: boolean): RawLine | null {
  // Tab 先折算成空格，统一按"空格数"量缩进
  const line = trimmedRaw.replace(/\t/g, " ".repeat(tabSize));
  const m = /^(\s*)(.*)$/.exec(line);
  if (!m) return null;
  const indent = m[1].length;
  let body = m[2].replace(/\s+$/, "");
  if (!body) return null;
  if (RE_HR.test(body)) return null;
  if (RE_TABLE.test(body)) return null;

  // 引用块 `> ` 不参与层级，只把标记摘掉
  body = body.replace(RE_QUOTE, "").replace(/\s+$/, "");
  if (!body) return null;

  // 标题：层级直接来自 # 的个数
  const h = RE_HEADING.exec(body);
  if (h) {
    const text = cleanText(h[2], stripMarks);
    return text ? { rank: h[1].length - 1, text } : null;
  }

  // 列表符号：摘掉，但保留缩进（缩进才是层级）
  let rest = body;
  const b = RE_BULLET.exec(rest);
  if (b) rest = b[2];
  // 任务清单 [ ] / [x]
  const c = RE_CHECKBOX.exec(rest);
  if (c) rest = `${c[1].trim() ? "☑" : "☐"} ${c[2]}`;

  const text = cleanText(rest, stripMarks);
  if (!text) return null;
  // +100 是为了让"缩进行"永远排在标题行之后（标题 rank 只有 0..5）
  return { rank: 100 + indent, text };
}

function cleanText(s: string, stripMarks: boolean): string {
  return (stripMarks ? stripInlineMarks(s) : s.trim()).trim();
}

// ---------- 主解析 ----------

export function parseOutline(src: string, opts: OutlineOptions = {}): OutlineParseResult {
  const { stripMarks = true, tabSize = 4 } = opts;
  const lines = String(src ?? "").split(/\r\n|\r|\n/);
  const roots: OutlineNode[] = [];
  // 栈里放"当前路径"，栈底是虚拟根（rank = -Infinity，谁的父都能当）
  const stack: { node: OutlineNode | null; rank: number }[] = [{ node: null, rank: -Infinity }];
  let count = 0;
  let skipped = 0;
  let inFence = false;

  for (const raw of lines) {
    if (RE_FENCE.test(raw)) {
      inFence = !inFence;
      skipped++;
      continue;
    }
    if (inFence) {
      skipped++;
      continue;
    }
    if (!raw.trim()) {
      skipped++;
      continue;
    }
    const parsed = parseLine(raw, tabSize, stripMarks);
    if (!parsed) {
      skipped++;
      continue;
    }
    // 往回找到第一个"层级比我浅"的祖先
    while (stack.length > 1 && stack[stack.length - 1].rank >= parsed.rank) stack.pop();
    const node: OutlineNode = { text: parsed.text, children: [] };
    const parent = stack[stack.length - 1].node;
    if (parent) parent.children.push(node);
    else roots.push(node);
    stack.push({ node, rank: parsed.rank });
    count++;
  }

  let maxDepth = 0;
  const walk = (n: OutlineNode, d: number) => {
    if (d > maxDepth) maxDepth = d;
    for (const k of n.children) walk(k, d + 1);
  };
  roots.forEach((r) => walk(r, 1));

  return { roots, count, maxDepth, skipped };
}

/** 树 → 扁平序列（父一定排在子前面），方便按顺序建节点、算坐标 */
export interface FlatOutlineItem {
  /** 临时 key（建节点前用） */
  key: string;
  text: string;
  /** 父节点的临时 key，根为 null */
  parentKey: string | null;
  depth: number;
}

export function flattenOutline(roots: OutlineNode[]): FlatOutlineItem[] {
  const out: FlatOutlineItem[] = [];
  let seq = 0;
  const walk = (n: OutlineNode, parentKey: string | null, depth: number) => {
    const key = `o${seq++}`;
    out.push({ key, text: n.text, parentKey, depth });
    for (const k of n.children) walk(k, key, depth + 1);
  };
  for (const r of roots) walk(r, null, 0);
  return out;
}

/** 把树再写回缩进文本（在对话框里给个"生成前预览"用） */
export function outlineToText(roots: OutlineNode[], indentSize = 2): string {
  const buf: string[] = [];
  const walk = (n: OutlineNode, d: number) => {
    buf.push(`${" ".repeat(d * indentSize)}${n.text}`);
    for (const k of n.children) walk(k, d + 1);
  };
  roots.forEach((r) => walk(r, 0));
  return buf.join("\n");
}
