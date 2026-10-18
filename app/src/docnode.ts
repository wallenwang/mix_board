/**
 * 「Markdown 文档 ↔ 白板节点」的关联工具。
 *
 * 关联信息存在 board_notes.meta 里（JSON），**不改数据库表结构**：
 *   meta = {"doc":{"doc_id":7,"title":"品牌手册"}}
 *
 * 为什么不用新建一张关联表：文档节点本身已经是 board_notes 的一行，
 * meta 是它本来就有的字段，且 parseSource / 引用溯源也在用同一套 JSON。
 *
 * 三种方向都能走通：
 *   1. 写作栏文档列表 → 拖到白板（HTML5 drag，mime = DOC_MIME）
 *   2. 白板文档节点 → 点「编辑」在白板里直接改这篇文档（落 docs 表）
 *   3. 白板任意节点 → 「写入文档」把内容追加进某篇 Markdown（反方向）
 */
import type { BoardNote, Doc } from "./types";
import { parseDocRef, withDocRef, type DocRef } from "./types";

/** 写作栏拖到白板时用的自定义 MIME（白板的 onDrop 只认 Files，这个要单独判） */
export const DOC_MIME = "application/x-kanban-doc";

export { parseDocRef, withDocRef };
export type { DocRef };

/** 取节点关联的文档 id（没关联就是 null） */
export function docIdOf(n: Pick<BoardNote, "meta">): number | null {
  return parseDocRef(n.meta)?.doc_id ?? null;
}

/**
 * 文档卡片的摘要：把 Markdown 压成两三行纯文字。
 * 去掉标题井号、列表符号、强调标记，代码块和表格行直接跳过。
 */
export function docSummary(body: string, maxLen = 110): string {
  const lines = String(body ?? "").split(/\r\n|\r|\n/);
  const out: string[] = [];
  let inFence = false;
  for (const raw of lines) {
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    let t = raw.trim();
    if (!t) continue;
    if (/^(?:-{3,}|\*{3,}|_{3,}|={3,})$/.test(t)) continue;
    if (/^\|.*\|$/.test(t)) continue;
    t = t
      .replace(/^#{1,6}\s+/, "")
      .replace(/^[-*+]\s+\[[ xX]\]\s*/, "")
      .replace(/^[-*+]\s+/, "")
      .replace(/^\d{1,3}[.)]\s+/, "")
      .replace(/^>\s?/, "")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/`{1,3}([^`]*)`{1,3}/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/\s+$/, "");
    if (!t) continue;
    out.push(t);
    if (out.join(" ").length >= maxLen) break;
  }
  let s = out.join(" ");
  return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
}

/**
 * 正文字数：不算空白符，也**不算图片**。
 * 插进文档的图片是 data URL（几十万字符起），算进字数毫无意义，
 * 还会让白板卡片上出现"18 万字"这种吓人的数字。
 */
export function charCount(body: string): number {
  return String(body ?? "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\s/g, "").length;
}

/** 文档里有多少字 / 多少个标题（卡片角标用） */
export function docStats(body: string) {
  const text = String(body ?? "");
  return {
    chars: charCount(text),
    headings: (text.match(/^#{1,6}\s/gm) ?? []).length,
  };
}

/** 建一张「文档卡片」节点时用的字段（配合 api.createNote） */
export function docNoteFields(
  projectId: number,
  doc: Pick<Doc, "id" | "title">,
  x: number,
  y: number,
  size: { w: number; h: number }
) {
  return {
    project_id: projectId,
    x: Math.round(x),
    y: Math.round(y),
    // text 存标题的快照：导出 PNG/PDF、大纲时不至于空着
    text: doc.title || "未命名文档",
    // 卡片背景交给 CSS（要跟着明暗主题走），不给死白色
    color: "transparent",
    kind: "doc" as const,
    w: size.w,
    h: size.h,
    file_id: null as number | null,
    meta: withDocRef("", { doc_id: doc.id, title: doc.title }),
  };
}

/** 把某段内容追加进一篇文档的正文（末尾，空两行分隔） */
export function appendToBody(body: string, chunk: string): string {
  const c = String(chunk ?? "").trim();
  if (!c) return body;
  const base = String(body ?? "").replace(/\s+$/, "");
  return base ? `${base}\n\n${c}\n` : `${c}\n`;
}
