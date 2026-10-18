/**
 * 极简 Markdown 内核（零依赖）。
 *
 * 只做一件事：把 Markdown 文本解析成**块列表**，再分别渲染成 HTML 或喂给 docx 导出。
 * 解析一次、多处复用，避免"预览和导出的排版不一样"。
 *
 * 支持：标题、段落、粗体/斜体/删除线、行内代码、围栏代码块、有序/无序列表（可嵌套）、
 * 任务清单、引用、表格、分隔线、链接、图片。
 */

export type MdBlock =
  | { type: "heading"; level: number; text: string }
  | { type: "para"; text: string }
  | {
      type: "list";
      ordered: boolean;
      depth: number;
      text: string;
      task: boolean;
      checked: boolean;
    }
  | { type: "quote"; text: string }
  | { type: "code"; lang: string; text: string }
  | { type: "hr" }
  | { type: "table"; head: string[]; rows: string[][] };

const RE_FENCE = /^\s*(```|~~~)\s*([\w+#.-]*)\s*$/;
const RE_HEADING = /^(#{1,6})\s+(.*)$/;
const RE_HR = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const RE_QUOTE = /^\s*>\s?/;
const RE_ITEM = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
const RE_TABLE_ROW = /^\s*\|.*\|\s*$/;

const splitCells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

const isTableSep = (line: string) => /^\s*\|[\s:|-]+\|\s*$/.test(line ?? "");

function blockStarts(line: string): boolean {
  return (
    RE_HEADING.test(line) ||
    RE_FENCE.test(line) ||
    RE_HR.test(line) ||
    RE_QUOTE.test(line) ||
    RE_ITEM.test(line)
  );
}

/** Markdown 文本 → 块列表 */
export function parseBlocks(src: string): MdBlock[] {
  const lines = String(src ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out: MdBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].replace(/\s+$/, "");

    // 围栏代码块
    const fence = RE_FENCE.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*(```|~~~)\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++;
      out.push({ type: "code", lang: fence[2] || "", text: body.join("\n") });
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    if (RE_HR.test(line)) {
      out.push({ type: "hr" });
      i++;
      continue;
    }

    const h = RE_HEADING.exec(line);
    if (h) {
      out.push({ type: "heading", level: h[1].length, text: h[2].trim() });
      i++;
      continue;
    }

    if (RE_TABLE_ROW.test(line) && isTableSep(lines[i + 1])) {
      const head = splitCells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && RE_TABLE_ROW.test(lines[i])) {
        rows.push(splitCells(lines[i]));
        i++;
      }
      out.push({ type: "table", head, rows });
      continue;
    }

    if (RE_QUOTE.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && RE_QUOTE.test(lines[i])) {
        buf.push(lines[i].replace(RE_QUOTE, ""));
        i++;
      }
      out.push({ type: "quote", text: buf.join("\n") });
      continue;
    }

    const item = RE_ITEM.exec(line);
    if (item) {
      // 缩进按"每 2 空格一层"折算，Tab 当 4 空格
      const indent = item[1].replace(/\t/g, "    ").length;
      const depth = Math.min(5, Math.floor(indent / 2));
      let text = item[3];
      let task = false;
      let checked = false;
      const cb = /^\[([ xX])\]\s*(.*)$/.exec(text);
      if (cb) {
        task = true;
        checked = cb[1].trim().length > 0;
        text = cb[2];
      }
      out.push({
        type: "list",
        ordered: /\d/.test(item[2]),
        depth,
        text,
        task,
        checked,
      });
      i++;
      continue;
    }

    // 段落：一直吃到下一个块级元素
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !blockStarts(lines[i]) && !RE_TABLE_ROW.test(lines[i])) {
      para.push(lines[i].trim());
      i++;
    }
    out.push({ type: "para", text: para.join("\n") });
  }

  return out;
}

// ---------- 行内元素 ----------

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 行内 Markdown → HTML 片段 */
export function inlineHtml(s: string): string {
  let t = escapeHtml(s);
  const codes: string[] = [];
  // 行内代码先抽出来，免得里面的符号被后面的规则吃掉
  t = t.replace(/`([^`]+)`/g, (_m, c: string) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, '<img src="$2" alt="$1">');
  t = t.replace(
    /\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g,
    '<a href="$2" target="_blank" rel="noreferrer">$1</a>'
  );
  t = t.replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>");
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  t = t.replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  t = t.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  t = t.replace(/\u0000(\d+)\u0000/g, (_m, n: string) => `<code>${codes[Number(n)]}</code>`);
  return t;
}

/** 块列表 → HTML（写作视图的实时预览用） */
export function blocksToHtml(blocks: MdBlock[]): string {
  const out: string[] = [];
  let listOpen: { ordered: boolean } | null = null;
  const closeList = () => {
    if (listOpen) {
      out.push(listOpen.ordered ? "</ol>" : "</ul>");
      listOpen = null;
    }
  };

  for (const b of blocks) {
    if (b.type !== "list") closeList();
    switch (b.type) {
      case "heading": {
        const lv = Math.min(6, Math.max(1, b.level));
        out.push(`<h${lv}>${inlineHtml(b.text)}</h${lv}>`);
        break;
      }
      case "para":
        out.push(`<p>${inlineHtml(b.text).replace(/\n/g, "<br>")}</p>`);
        break;
      case "list": {
        const want = b.ordered;
        if (!listOpen || listOpen.ordered !== want) {
          closeList();
          listOpen = { ordered: want };
          out.push(want ? "<ol>" : "<ul>");
        }
        const prefix = b.task
          ? `<input type="checkbox" disabled${b.checked ? " checked" : ""}> `
          : "";
        const pad = b.depth > 0 ? ` style="margin-left:${b.depth * 18}px"` : "";
        out.push(`<li${pad}>${prefix}${inlineHtml(b.text)}</li>`);
        break;
      }
      case "quote":
        out.push(`<blockquote>${inlineHtml(b.text).replace(/\n/g, "<br>")}</blockquote>`);
        break;
      case "code":
        out.push(
          `<pre><code${b.lang ? ` class="lang-${escapeHtml(b.lang)}"` : ""}>${escapeHtml(
            b.text
          )}</code></pre>`
        );
        break;
      case "hr":
        out.push("<hr>");
        break;
      case "table":
        out.push("<table><thead><tr>");
        for (const c of b.head) out.push(`<th>${inlineHtml(c)}</th>`);
        out.push("</tr></thead><tbody>");
        for (const r of b.rows) {
          out.push("<tr>");
          for (let k = 0; k < b.head.length; k++) out.push(`<td>${inlineHtml(r[k] ?? "")}</td>`);
          out.push("</tr>");
        }
        out.push("</tbody></table>");
        break;
    }
  }
  closeList();
  return out.join("\n");
}

export function renderMarkdown(src: string): string {
  return blocksToHtml(parseBlocks(src));
}

/** 行内 Markdown → 纯文本（导出 Word 时用，Word 里我们再单独处理粗斜体） */
export function stripInline(s: string): string {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1（$2）")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*\*([^*]+)\*\*\*/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1$2");
}
