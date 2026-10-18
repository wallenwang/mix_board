/**
 * 看板数据 → Markdown 文本。
 *
 * 输出刻意做成**标准 Markdown**（任务用 `- [ ]`、层级用缩进、备注用引用），
 * 这样它既能直接粘进 Word / 邮件 / 微信，也能再喂回「文本转导图」变成思维导图 ——
 * 一次导出，两条路都能走。
 */

export interface ExportTask {
  title: string;
  description?: string;
  /** 优先级标签文字，如 "紧急" */
  priority?: string;
  due?: string | null;
  tags?: string[];
  done?: boolean;
  children?: ExportTask[];
}

export interface ExportColumn {
  name: string;
  tasks: ExportTask[];
}

export interface BoardExportOptions {
  project: string;
  columns: ExportColumn[];
  /** 导出时间文字，不传就用当前时间 */
  date?: string;
}

function nowText(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes()
  )}`;
}

function countTasks(list: ExportTask[]): number {
  let n = 0;
  for (const t of list) {
    n += 1 + countTasks(t.children ?? []);
  }
  return n;
}

/** 任务标题后面跟的元信息：`紧急` `标签` 📅 日期 */
function metaOf(t: ExportTask): string {
  const bits: string[] = [];
  if (t.priority) bits.push(`\`${t.priority}\``);
  for (const tag of t.tags ?? []) bits.push(`\`${tag}\``);
  if (t.due) bits.push(`📅 ${t.due}`);
  return bits.length ? "  " + bits.join(" ") : "";
}

function taskLines(t: ExportTask, indent: number): string[] {
  const pad = " ".repeat(indent);
  const box = t.done ? "[x]" : "[ ]";
  const safeTitle = String(t.title ?? "").replace(/\n/g, " ").trim() || "（无标题）";
  const lines = [`${pad}- ${box} **${safeTitle}**${metaOf(t)}`];
  const desc = (t.description ?? "").trim();
  if (desc) {
    for (const dl of desc.split(/\r?\n/)) {
      lines.push(`${pad}  > ${dl.trim()}`);
    }
  }
  for (const c of t.children ?? []) lines.push(...taskLines(c, indent + 2));
  return lines;
}

export function boardToMarkdown(opts: BoardExportOptions): string {
  const total = opts.columns.reduce((n, c) => n + countTasks(c.tasks), 0);
  const out: string[] = [];
  out.push(`# ${opts.project}`);
  out.push("");
  out.push(`> 由「工作看板」导出 · ${opts.date ?? nowText()} · 共 ${total} 个任务`);
  out.push("");
  for (const col of opts.columns) {
    const n = countTasks(col.tasks);
    out.push(`## ${col.name}（${n}）`);
    out.push("");
    if (!col.tasks.length) {
      out.push("_（空）_");
      out.push("");
      continue;
    }
    for (const t of col.tasks) {
      out.push(...taskLines(t, 0));
    }
    out.push("");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/** 白板导图 / 大纲 → Markdown（带一级标题的文档形态） */
export function outlineToMarkdown(title: string, outlineText: string, note?: string): string {
  const out: string[] = [`# ${title}`, ""];
  out.push(`> 由「工作看板」导出 · ${nowText()}${note ? ` · ${note}` : ""}`);
  out.push("");
  out.push(outlineText.trimEnd());
  out.push("");
  return out.join("\n");
}
