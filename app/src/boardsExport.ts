/**
 * 看板导出多格式：PNG 长图 / 打印成 PDF / 单文件 HTML。
 *
 * PNG 走和白板同一套 canvas 渲染器（boardScene → renderScene），
 * PDF 不画位图 —— 生成 A4 版式的 HTML 交给系统打印，文字是矢量的、能选中。
 */

import {
  renderScene,
  canvasToBlob,
  downloadBlob,
  safeFileName,
  ensureFontsReady,
} from "./exportImage";
import { buildBoardScene, boardBg, type BoardSceneInput } from "./boardScene";
import { priorityOf } from "./types";

function esc(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const md = (d?: string | null) => (d ? String(d).slice(5) : "");

/** 导出整块看板为一张长图 */
export async function exportBoardPng(input: BoardSceneInput): Promise<{ w: number; h: number }> {
  await ensureFontsReady();
  const scene = buildBoardScene(input);
  const canvas = renderScene(scene, 2, 40);
  const blob = await canvasToBlob(canvas);
  downloadBlob(blob, `${safeFileName(input.projectName || "看板", "看板")}-看板.png`);
  return { w: canvas.width, h: canvas.height };
}

/** A4 打印版 HTML（一列一页，含项目名与页码感的分节） */
export function boardPrintHtml(input: BoardSceneInput): string {
  const cols = input.columns.filter((c) => !c.collapsed);
  const total = cols.reduce((n, c) => n + (input.tasksByCol[c.id]?.length ?? 0), 0);
  const done = cols.reduce(
    (n, c) => n + (input.tasksByCol[c.id] ?? []).filter((t) => t.completed_at).length,
    0
  );
  const body = cols
    .map((c, i) => {
      const list = input.tasksByCol[c.id] ?? [];
      const cards = list
        .map((t) => {
          const pr = priorityOf(t.priority);
          const tags = input.tagNames ? input.tagNames(t) : [];
          const bits: string[] = [pr.label];
          if (t.start_date || t.due_date) bits.push(`${md(t.start_date) || "?"} → ${md(t.due_date) || "?"}`);
          if (tags.length) bits.push(tags.slice(0, 3).join(" · "));
          if (t.progress != null) bits.push(`${t.progress}%`);
          return `<div class="card${t.completed_at ? " done" : ""}" style="border-left-color:${pr.color}">
  <div class="t">${esc(t.title)}</div>
  <div class="s">${esc(bits.join("　"))}</div>
  ${t.description ? `<div class="d">${esc(t.description)}</div>` : ""}
</div>`;
        })
        .join("\n");
      return `<section class="col"${i ? ' style="break-before:page"' : ""}>
  <h2><span class="dot" style="background:${c.color}"></span>${esc(c.name)}<em>${list.length}</em></h2>
  ${cards || '<p class="empty">暂无任务</p>'}
</section>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>${esc(input.projectName)} · 看板</title>
<style>
  @page { size: A4; margin: 16mm 14mm; }
  * { box-sizing: border-box; }
  body { margin: 0; color: #1f2328; background: #fff;
         font-family: "Microsoft YaHei", "PingFang SC", "Segoe UI", system-ui, sans-serif; }
  header { padding-bottom: 8mm; border-bottom: 2px solid #111; margin-bottom: 6mm; }
  h1 { margin: 0 0 3mm; font-size: 20px; letter-spacing: .02em; }
  .meta { color: #666; font-size: 12px; }
  .col { margin: 0 0 6mm; break-inside: auto; }
  .col h2 { display: flex; align-items: center; gap: 6px; font-size: 15px;
            margin: 0 0 3mm; padding-bottom: 2mm; border-bottom: 1px solid #e5e7eb; }
  .col h2 em { margin-left: auto; font-style: normal; color: #999; font-size: 12px; font-weight: 400; }
  .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  .card { border: 1px solid #e5e7eb; border-left: 3px solid #409EFF; border-radius: 6px;
          padding: 3mm 3.5mm; margin: 0 0 2.5mm; break-inside: avoid; }
  .card .t { font-size: 12.5px; font-weight: 600; line-height: 1.45; }
  .card .s { font-size: 10.5px; color: #888; margin-top: 1mm; }
  .card .d { font-size: 10.5px; color: #666; margin-top: 1mm; line-height: 1.5; }
  .card.done .t { color: #999; text-decoration: line-through; }
  .empty { color: #999; font-size: 11px; margin: 2mm 0; }
</style></head>
<body>
<header>
  <h1>${esc(input.projectName)}</h1>
  <div class="meta">${cols.length} 列 · ${total} 个任务 · 已完成 ${done} 个 · 导出于 ${new Date().toLocaleString("zh-CN")}</div>
</header>
${body}
</body></html>`;
}

/** 用隐藏 iframe 打印：Tauri webview 里开新窗口会被拦，iframe 两边都能用 */
function printHtml(html: string) {
  const iframe = document.createElement("iframe");
  iframe.setAttribute(
    "style",
    "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden"
  );
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument;
  if (!doc) {
    iframe.remove();
    return;
  }
  doc.open();
  doc.write(html);
  doc.close();
  const cleanup = () => setTimeout(() => iframe.remove(), 800);
  try {
    iframe.contentWindow?.addEventListener("afterprint", cleanup);
  } catch {
    /* 忽略 */
  }
  setTimeout(() => {
    iframe.contentWindow?.focus();
    iframe.contentWindow?.print();
    // 用户可能直接关掉打印框、不触发 afterprint
    setTimeout(cleanup, 120000);
  }, 350);
}

/** 打印 / 存 PDF */
export function exportBoardPdf(input: BoardSceneInput) {
  printHtml(boardPrintHtml(input));
}

/** 下载单文件 HTML（双击即看，不需要装任何东西） */
export function exportBoardHtml(input: BoardSceneInput) {
  const html = boardPrintHtml(input);
  downloadBlob(
    new Blob([html], { type: "text/html;charset=utf-8" }),
    `${safeFileName(input.projectName || "看板", "看板")}-看板.html`
  );
}

export { boardBg };
