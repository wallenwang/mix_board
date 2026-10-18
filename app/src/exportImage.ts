/**
 * 白板 / 思维导图 → PNG / PDF。
 *
 * 用 Canvas 2D 自己把节点和连线画一遍，而不是截图 DOM —— 这样：
 *  - 不依赖 html2canvas 之类的东西，也不用担心跨域/字体污染 canvas；
 *  - 导出的是"干净的一版"（没有悬浮按钮、选中框、网格线）；
 *  - 想画多大画多大（scale 参数控制清晰度），缩放到 2 倍也不糊。
 *
 * PDF 是自己拼的最小单页文档，图片用 FlateDecode 无损嵌入。
 */

import { inkOn } from "./wb";

export interface ExportNode {
  kind: "note" | "text" | "mind" | "file" | "box" | "task";
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  body?: string;
  /** 便签底色 / 导图色 / 分组框色 */
  color?: string;
  /** 任务卡左侧竖条颜色 */
  accent?: string;
  /** 图片节点的缩略图（已加载完成的 Image） */
  image?: CanvasImageSource | null;
}

export interface ExportLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface ExportScene {
  nodes: ExportNode[];
  lines: ExportLine[];
  title?: string;
}

const FONT = '"Microsoft YaHei", "PingFang SC", "Segoe UI", system-ui, sans-serif';
const MONO = 'Consolas, "Courier New", monospace';

/** 按可用宽度折行（中文逐字断，英文尽量断在空格） */
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const out: string[] = [];
  const paras = String(text ?? "").split(/\n/);
  for (const para of paras) {
    if (!para) {
      out.push("");
      continue;
    }
    let line = "";
    for (const ch of para) {
      const next = line + ch;
      if (ctx.measureText(next).width <= maxWidth || !line) {
        line = next;
      } else {
        // 英文单词尽量别拆断
        const sp = line.lastIndexOf(" ");
        if (sp > 0 && /[A-Za-z0-9]/.test(ch) && /[A-Za-z0-9]/.test(line[sp - 1] ?? "")) {
          out.push(line.slice(0, sp));
          line = line.slice(sp + 1) + ch;
        } else {
          out.push(line);
          line = ch;
        }
      }
    }
    out.push(line);
  }
  return out;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

function drawNode(ctx: CanvasRenderingContext2D, n: ExportNode) {
  const { x, y, w, h } = n;
  ctx.save();

  if (n.kind === "box") {
    const c = n.color || "#409EFF";
    ctx.globalAlpha = 0.06;
    ctx.fillStyle = c;
    roundRect(ctx, x, y, w, h, 12);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.setLineDash([8, 5]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = c;
    roundRect(ctx, x, y, w, h, 12);
    ctx.stroke();
    ctx.setLineDash([]);
    // 标题画在 6% 淡色底（≈白纸）上，固定用深墨，不用跟着框色走
    ctx.fillStyle = "#1f2328";
    ctx.font = `600 15px ${FONT}`;
    ctx.textBaseline = "top";
    ctx.fillText(n.title || "分组", x + 12, y + 10);
    ctx.restore();
    return;
  }

  if (n.kind === "text") {
    ctx.fillStyle = "#1f2328";
    ctx.font = `15px ${FONT}`;
    ctx.textBaseline = "top";
    const lines = wrapText(ctx, n.title, w);
    lines.forEach((l, i) => ctx.fillText(l, x, y + i * 22));
    ctx.restore();
    return;
  }

  if (n.kind === "mind") {
    const c = n.color || "#409EFF";
    ctx.fillStyle = c;
    roundRect(ctx, x, y, w, h, 9);
    ctx.fill();
    // 浅色节点配深字，深色节点配白字
    ctx.fillStyle = inkOn(c);
    ctx.font = `600 14px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const lines = wrapText(ctx, n.title || "主题", w - 20);
    const lh = 19;
    const top = y + Math.max(6, (h - lines.length * lh) / 2);
    lines.forEach((l, i) => ctx.fillText(l, x + w / 2, top + i * lh));
    ctx.restore();
    return;
  }

  if (n.kind === "file") {
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = "#d0d7de";
    ctx.lineWidth = 1;
    roundRect(ctx, x, y, w, h, 8);
    ctx.fill();
    ctx.stroke();
    let ty = y + 10;
    if (n.image) {
      const th = Math.max(24, h - 40);
      ctx.save();
      roundRect(ctx, x + 1, y + 1, w - 2, th, 7);
      ctx.clip();
      const iw = (n.image as HTMLImageElement).naturalWidth || 1;
      const ih = (n.image as HTMLImageElement).naturalHeight || 1;
      const s = Math.max((w - 2) / iw, th / ih);
      const dw = iw * s;
      const dh = ih * s;
      ctx.drawImage(n.image, x + 1 + (w - 2 - dw) / 2, y + 1 + (th - dh) / 2, dw, dh);
      ctx.restore();
      ty = y + th + 8;
    }
    ctx.fillStyle = "#1f2328";
    ctx.font = `13px ${FONT}`;
    ctx.textBaseline = "top";
    const name = wrapText(ctx, n.title, w - 20).slice(0, n.image ? 1 : 3);
    name.forEach((l, i) => ctx.fillText(l, x + 10, ty + i * 18));
    ctx.fillStyle = "#8b949e";
    ctx.font = `11px ${FONT}`;
    ctx.fillText(n.body || "", x + 10, y + h - 18);
    ctx.restore();
    return;
  }

  if (n.kind === "task") {
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = "#d0d7de";
    ctx.lineWidth = 1;
    roundRect(ctx, x, y, w, h, 8);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = n.accent || "#409EFF";
    ctx.save();
    roundRect(ctx, x, y, w, h, 8);
    ctx.clip();
    ctx.fillRect(x, y, 5, h);
    ctx.restore();
    ctx.fillStyle = "#1f2328";
    ctx.font = `600 14px ${FONT}`;
    ctx.textBaseline = "top";
    const tl = wrapText(ctx, n.title, w - 24).slice(0, 3);
    tl.forEach((l, i) => ctx.fillText(l, x + 13, y + 10 + i * 19));
    if (n.body) {
      ctx.fillStyle = "#6e7781";
      ctx.font = `12px ${FONT}`;
      const bl = wrapText(ctx, n.body, w - 24).slice(0, 2);
      bl.forEach((l, i) => ctx.fillText(l, x + 13, y + 12 + tl.length * 19 + i * 16));
    }
    ctx.restore();
    return;
  }

  // 甘特图节点：画成"白框 + 几条彩色条"的示意（导出场景里没有任务明细）
  if (n.kind === "gantt") {
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = "#d0d7de";
    ctx.lineWidth = 1;
    roundRect(ctx, x, y, w, h, 8);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#1f2328";
    ctx.font = `600 14px ${FONT}`;
    ctx.textBaseline = "top";
    ctx.fillText("甘特图", x + 12, y + 10);
    const colors = ["#f56c6c", "#e6a23c", "#d9c36a", "#909399", "#67c23a"];
    const trackX = x + 70;
    const trackW = Math.max(40, w - 84);
    for (let i = 0; i < 5; i++) {
      const by = y + 36 + i * ((h - 50) / 5);
      const bw = trackW * (0.28 + ((i * 37) % 55) / 100);
      const off = trackW * (((i * 53) % 40) / 100);
      ctx.fillStyle = colors[i % colors.length];
      roundRect(ctx, trackX + off, by, Math.min(bw, trackW - off), 9, 4);
      ctx.fill();
    }
    ctx.restore();
    return;
  }

  // 便签
  ctx.fillStyle = n.color || "#FFF9C4";
  ctx.strokeStyle = "rgba(0,0,0,.10)";
  ctx.lineWidth = 1;
  roundRect(ctx, x, y, w, h, 8);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = inkOn(n.color || "#FFF9C4");
  ctx.font = `14px ${FONT}`;
  ctx.textBaseline = "top";
  const lines = wrapText(ctx, n.title, w - 22);
  lines.forEach((l, i) => ctx.fillText(l, x + 11, y + 11 + i * 20));
  ctx.restore();
}

export function renderScene(scene: ExportScene, scale = 2, pad = 60): HTMLCanvasElement {
  const nodes = scene.nodes;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.w);
    maxY = Math.max(maxY, n.y + n.h);
  }
  for (const l of scene.lines) {
    minX = Math.min(minX, l.x1, l.x2);
    minY = Math.min(minY, l.y1, l.y2);
    maxX = Math.max(maxX, l.x1, l.x2);
    maxY = Math.max(maxY, l.y1, l.y2);
  }
  if (!isFinite(minX)) {
    minX = minY = 0;
    maxX = maxY = 200;
  }

  const w = Math.ceil(maxX - minX + pad * 2);
  const h = Math.ceil(maxY - minY + pad * 2);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;

  ctx.scale(scale, scale);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.translate(-minX + pad, -minY + pad);

  // 连线在最底层
  ctx.strokeStyle = "#a8b3bd";
  ctx.lineWidth = 1.5;
  for (const l of scene.lines) {
    ctx.beginPath();
    ctx.moveTo(l.x1, l.y1);
    ctx.lineTo(l.x2, l.y2);
    ctx.stroke();
  }
  // 分组框画在节点底下
  for (const n of nodes) if (n.kind === "box") drawNode(ctx, n);
  for (const n of nodes) if (n.kind !== "box") drawNode(ctx, n);

  return canvas;
}

// ---------- 输出 ----------

export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("画布导出失败"))), "image/png");
  });
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function safeFileName(s: string, fallback = "导出"): string {
  const t = String(s ?? "")
    .replace(/[\\/:*?"<>|\r\n\t]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return (t || fallback).slice(0, 80);
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate");
  const stream = new Blob([data as unknown as BlobPart]).stream().pipeThrough(cs);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/** canvas → 单页 PDF（图片无损嵌入，长边按 A4 长边排版） */
export async function canvasToPdf(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const cw = canvas.width;
  const ch = canvas.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法读取画布内容");
  const img = ctx.getImageData(0, 0, cw, ch);
  // PDF 的 DeviceRGB 只要 3 通道，去掉 alpha
  const rgb = new Uint8Array(cw * ch * 3);
  for (let i = 0, j = 0; i < img.data.length; i += 4, j += 3) {
    const a = img.data[i + 3] / 255;
    rgb[j] = Math.round(img.data[i] * a + 255 * (1 - a));
    rgb[j + 1] = Math.round(img.data[i + 1] * a + 255 * (1 - a));
    rgb[j + 2] = Math.round(img.data[i + 2] * a + 255 * (1 - a));
  }
  const compressed = await deflate(rgb);

  const LONG = 842; // A4 长边（pt）
  const pageW = cw >= ch ? LONG : Math.round((LONG * cw) / ch);
  const pageH = cw >= ch ? Math.round((LONG * ch) / cw) : LONG;

  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let len = 0;
  const push = (b: Uint8Array | string) => {
    const u = typeof b === "string" ? enc.encode(b) : b;
    chunks.push(u);
    len += u.length;
  };
  const offsets: number[] = [];
  const obj = (n: number, head: string, stream?: Uint8Array, tail = "") => {
    offsets[n] = len;
    push(`${n} 0 obj\n${head}\n`);
    if (stream) {
      push("stream\n");
      push(stream);
      push("\nendstream\n");
    }
    push(`${tail}endobj\n`);
  };

  push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  obj(
    3,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] ` +
      `/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`
  );
  obj(
    4,
    `<< /Type /XObject /Subtype /Image /Width ${cw} /Height ${ch} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${compressed.length} >>`,
    compressed
  );
  const content = enc.encode(`q ${pageW} 0 0 ${pageH} 0 0 cm /Im0 Do Q`);
  obj(5, `<< /Length ${content.length} >>`, content);

  const xrefAt = len;
  let xref = `xref\n0 6\n0000000000 65535 f \n`;
  for (let n = 1; n <= 5; n++) {
    xref += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  }
  push(xref);
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);

  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

export function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    if (!src) return resolve(null);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}
