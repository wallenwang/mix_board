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

/** 节点在屏幕上的真实样式（用 getComputedStyle 读，不靠手抄 CSS） */
export interface NodeStyle {
  bg: string;
  border: string;
  borderW: number;
  radius: number;
  /** 原始 box-shadow 文本，可能有多层 */
  shadow: string;
  color: string;
  font: string;
  fontSize: number;
  lineHeight: number;
  weight: number | string;
  align: "left" | "center";
  padT: number;
  padR: number;
  padB: number;
  padL: number;
}

export interface ExportNode {
  kind: "note" | "text" | "mind" | "file" | "box" | "task" | "doc" | "gantt";
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
  /** 图片裁切（归一化 0~1） */
  crop?: { x: number; y: number; w: number; h: number } | null;
  /** 屏幕上的真实样式 */
  style?: NodeStyle;
  /** 导图节点形状 */
  shape?: "capsule" | "circle";
  /** 任务是否已完成 */
  done?: boolean;
  /** 任务卡第二行：列名 / 优先级 / 截止 / 子节点数（屏幕上 .tn-sub 那行） */
  sub?: string[];
  subColor?: string;
  /** 文档卡片摘要 */
  summary?: string;
  /** 分组框的约束强度（strong/ref/bg）；空 = 没标 */
  cluster?: "strong" | "ref" | "bg" | null;
  /** 任务编号（1、2.1…），画在标题前 */
  seq?: string;
  /** 这个任务用到的资料，画在卡片底部 */
  refs?: { label: string; level: number }[];
}

export interface ExportLine {
  /** 屏幕用的那条 SVG path，canvas 直接 Path2D 复用它 → 曲线/直线零走样 */
  d: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** 箭头方向（弧度），由 wb.ts 的 edgeGeom 给出 */
  angle: number;
  color: string;
  width: number;
  /** 关系类型：决定虚线样式，跟屏幕上的 CSS 一一对应 */
  kind?: "decompose" | "precede" | "evidence" | "produce";
}

export interface ExportScene {
  nodes: ExportNode[];
  lines: ExportLine[];
  title?: string;
  /** 画布底色（默认取 --bg） */
  bg?: string;
}

/** 分组框强度胶囊：跟 Whiteboard.vue 里 CLUSTER_META 的颜色保持一致 */
const CLUSTER_STYLE: Record<string, { label: string; color: string }> = {
  strong: { label: "强依据", color: "#d9822b" },
  ref: { label: "参考", color: "#3b7ddd" },
  bg: { label: "背景", color: "#98a2b6" },
};

const FONT = '"Microsoft YaHei", "PingFang SC", "Segoe UI", system-ui, sans-serif';
const MONO = 'Consolas, "Courier New", monospace';

/** 读一个数字 CSS 值，失败给默认值 */
function num(v: string, dft: number): number {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : dft;
}

/**
 * 把屏幕上的节点样式读下来。
 *
 * 为什么要读 DOM 而不是写常量：白板的便签圆角、导图胶囊/圆形、字色（inkOn）、
 * 阴影、字体全都是 CSS 在管，手抄一份到 canvas 里必然越改越不一致 ——
 * 之前导出"看着不一样"有一半是这么来的。
 *
 * ⚠️ 文字样式在**子元素**上（.note-text / .mind-text / .tn-title ...），
 * 父元素拿到的是继承值（font-weight 400、font-size 16），照父元素画就会丢加粗、
 * 字号也不对。所以传 textSel 优先读子元素，背景/圆角/阴影仍读父元素。
 */
export function readNodeStyle(
  el: Element | null,
  textSel = "",
  fallbackColor = "#1f2328"
): NodeStyle {
  if (!el) {
    return {
      bg: "", border: "", borderW: 0, radius: 8, shadow: "", color: fallbackColor,
      font: FONT, fontSize: 14, lineHeight: 22, weight: 400, align: "left",
      padT: 10, padR: 10, padB: 10, padL: 10,
    };
  }
  const box = el as HTMLElement;
  const cs = getComputedStyle(box);
  const inner = textSel ? (box.querySelector(textSel) as HTMLElement | null) : null;
  const tcs = inner ? getComputedStyle(inner) : cs;
  const fw = tcs.fontWeight;
  const fs = num(tcs.fontSize, 14);
  return {
    bg: cs.backgroundColor === "rgba(0, 0, 0, 0)" ? "" : cs.backgroundColor,
    border: cs.borderTopColor,
    borderW: num(cs.borderTopWidth, 0),
    radius: num(cs.borderTopLeftRadius, 0),
    shadow: cs.boxShadow === "none" ? "" : cs.boxShadow,
    color: tcs.color || fallbackColor,
    font: tcs.fontFamily || FONT,
    fontSize: fs,
    lineHeight:
      tcs.lineHeight === "normal" ? fs * 1.5 : num(tcs.lineHeight, fs * 1.5),
    weight: fw === "normal" ? 400 : fw === "bold" ? 700 : num(fw, 400),
    align: tcs.textAlign === "center" ? "center" : "left",
    padT: num(cs.paddingTop, 0),
    padR: num(cs.paddingRight, 0),
    padB: num(cs.paddingBottom, 0),
    padL: num(cs.paddingLeft, 0),
  };
}

/** box-shadow 文本 → 可用的层（canvas 一次只能一个阴影，多层就分层模拟） */
interface ShadowLayer {
  x: number;
  y: number;
  blur: number;
  spread: number;
  color: string;
}

function parseShadows(css: string): ShadowLayer[] {
  if (!css) return [];
  const out: ShadowLayer[] = [];
  // 按逗号切，但 rgb()/rgba() 里的逗号不能切
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of css) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());

  for (const p of parts) {
    // inset（内阴影）canvas 无法复刻，跳过；硬画会变成外面一圈脏影
    if (/inset/.test(p)) continue;
    const colorM =
      p.match(/rgba?\([^)]*\)/) || p.match(/#[0-9a-fA-F]{3,8}/) || p.match(/\b(?:currentColor|transparent)\b/);
    const nums = (p.replace(colorM ? colorM[0] : "", "").match(/-?\d*\.?\d+px/g) || []).map((s) =>
      parseFloat(s)
    );
    if (nums.length < 2) continue;
    out.push({
      x: nums[0] ?? 0,
      y: nums[1] ?? 0,
      blur: Math.max(0, nums[2] ?? 0),
      spread: nums[3] ?? 0,
      color: colorM ? colorM[0] : "rgba(0,0,0,.12)",
    });
  }
  return out;
}

/**
 * 用 canvas 复刻 box-shadow。
 *
 * canvas 一次只能挂一个阴影，所以取"最主要的一层"（有偏移的柔和阴影）挂到 ctx 上，
 * 由调用方在 fill 时自然生影；0 偏移的细环（--shadow-ring 那种）单独返回，
 * 填充完再描一圈 —— 用 destination-out 去"擦"会把底下已画的内容一起擦掉，绝不能那么干。
 */
function applyShadow(ctx: CanvasRenderingContext2D, layers: ShadowLayer[]): ShadowLayer | null {
  if (!layers.length) return null;
  const ring = layers.find((l) => Math.abs(l.x) < 0.5 && Math.abs(l.y) < 0.5) ?? null;
  const soft =
    layers.find((l) => (Math.abs(l.x) > 0.5 || Math.abs(l.y) > 0.5) && l.blur > 0) ?? null;
  if (soft) {
    ctx.shadowColor = soft.color;
    ctx.shadowBlur = soft.blur;
    ctx.shadowOffsetX = soft.x;
    ctx.shadowOffsetY = soft.y;
  }
  return ring;
}

function clearShadow(ctx: CanvasRenderingContext2D) {
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
}

function paintRing(
  ctx: CanvasRenderingContext2D,
  ring: ShadowLayer | null,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  if (!ring) return;
  ctx.save();
  ctx.strokeStyle = ring.color;
  ctx.lineWidth = Math.max(1, (ring.spread + ring.blur) * 2);
  roundRect(ctx, x, y, w, h, r);
  ctx.stroke();
  ctx.restore();
}

/** 箭头：与屏幕 SVG marker 同尺寸（10×10 的三角） */
function drawArrow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  angle: number,
  color: string,
  size = 11
) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(-size, size * 0.46);
  ctx.lineTo(-size, -size * 0.46);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

/** 等字体就绪：不等的话中文回退字体，换行位置和屏幕对不上 */
export async function ensureFontsReady(): Promise<void> {
  try {
    await (document as Document & { fonts?: FontFaceSet }).fonts?.ready;
  } catch {
    /* 忽略：老环境没有 FontFaceSet */
  }
}

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
  const st = n.style;
  ctx.save();

  /* ---------- 分组框：虚线 + 淡色填充 + 标题底色条 ---------- */
  if (n.kind === "box") {
    const c = n.color || "#409EFF";
    const r = st?.radius ?? 16;
    // 屏幕上是 .box-node：background: color-mix(text 3%)、border: 1px dashed、radius-lg
    ctx.fillStyle = st?.bg || "rgba(31,35,40,0.03)";
    roundRect(ctx, x, y, w, h, r);
    ctx.fill();
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = st?.borderW || 1;
    ctx.strokeStyle = c;
    roundRect(ctx, x, y, w, h, r);
    ctx.stroke();
    ctx.setLineDash([]);

    // .box-title：top:-12px、left:12px，底色跟框色，字色由 inkOn 决定
    const fs = st?.fontSize || 14;
    const font = st?.font || FONT;
    ctx.font = `600 ${fs}px ${font}`;
    const label = n.title || "分组";
    const tw = Math.min(Math.max(60, w - 24), ctx.measureText(label).width + 24);
    const barH = fs + 12;
    ctx.fillStyle = c;
    roundRect(ctx, x + 12, y - 12, tw, barH, 8);
    ctx.fill();
    ctx.fillStyle = inkOn(c);
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillText(label, x + 24, y - 12 + barH / 2);

    // 强度胶囊：屏幕上是 .box-cluster，贴右端；导出图里也得有，不然两张对不上
    if (n.cluster) {
      const ci = CLUSTER_STYLE[n.cluster];
      const pfs = Math.max(10, fs - 2);
      ctx.font = `600 ${pfs}px ${font}`;
      const pw = ctx.measureText(ci.label).width + 16;
      const ph = pfs + 8;
      const px = x + w - 12 - pw;
      const py = y - 12 + (barH - ph) / 2;
      // 白底 + 彩边 + 彩字，跟屏幕上的 .box-cluster 一致
      ctx.fillStyle = "#ffffff";
      roundRect(ctx, px, py, pw, ph, ph / 2);
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = ci.color;
      roundRect(ctx, px, py, pw, ph, ph / 2);
      ctx.stroke();
      ctx.fillStyle = ci.color;
      ctx.textAlign = "center";
      ctx.fillText(ci.label, px + pw / 2, y - 12 + barH / 2);
    }
    ctx.restore();
    return;
  }

  /* ---------- 其余节点：先按屏幕真实样式铺底 ---------- */
  const isCircle = n.kind === "mind" && n.shape === "circle";
  const radius = isCircle ? Math.min(w, h) / 2 : st?.radius ?? 8;
  // 没底色的节点（列头文字、纯文本）不要硬刷白：那会在画布上多出一块白板
  const bg = st?.bg || n.color || "";

  const layers = parseShadows(st?.shadow || "");
  const ring = applyShadow(ctx, layers);
  if (bg) {
    ctx.fillStyle = bg;
    roundRect(ctx, x, y, w, h, radius);
    ctx.fill();
  }
  clearShadow(ctx);
  paintRing(ctx, ring, x, y, w, h, radius);

  if (st && st.borderW > 0 && st.border) {
    ctx.strokeStyle = st.border;
    ctx.lineWidth = st.borderW;
    roundRect(ctx, x, y, w, h, radius);
    ctx.stroke();
  }

  const padL = st?.padL ?? 12;
  const padR = st?.padR ?? 12;
  const padT = st?.padT ?? 11;
  const innerW = Math.max(8, w - padL - padR);
  const font = st?.font || FONT;
  const fs = st?.fontSize || 14;
  const lh = st?.lineHeight || fs * 1.6;
  const color = st?.color || "#1f2328";
  // CSS 的行框比字形高，多出来的半行距要把文字整体往下推，否则比屏幕高 1~2px
  const halfLead = Math.max(0, (lh - fs) / 2);

  /* ---------- 资料卡：缩略图（cover + crop）+ 文件名 + 大小 ---------- */
  if (n.kind === "file") {
    let ty = y + 8;
    const thumbH = Math.max(24, h - 44);
    if (n.image) {
      ctx.save();
      roundRect(ctx, x + 1, y + 1, w - 2, thumbH, Math.max(0, radius - 1));
      ctx.clip();
      const iw = (n.image as HTMLImageElement).naturalWidth || 1;
      const ih = (n.image as HTMLImageElement).naturalHeight || 1;
      const c = n.crop;
      const sx = c ? c.x * iw : 0;
      const sy = c ? c.y * ih : 0;
      const sw = c ? c.w * iw : iw;
      const sh = c ? c.h * ih : ih;
      const s = Math.max((w - 2) / sw, thumbH / sh);
      const dw = sw * s;
      const dh = sh * s;
      ctx.drawImage(
        n.image, sx, sy, sw, sh,
        x + 1 + (w - 2 - dw) / 2, y + 1 + (thumbH - dh) / 2, dw, dh
      );
      ctx.restore();
      ty = y + thumbH + 8;
    }
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    ctx.fillStyle = color;
    ctx.font = `600 ${Math.max(11, fs - 1)}px ${font}`;
    const nl = wrapText(ctx, n.title, w - 20).slice(0, n.image ? 1 : 3);
    nl.forEach((l, i) => ctx.fillText(l, x + 10, ty + i * (fs + 4)));
    ctx.save();
    ctx.globalAlpha = 0.62;
    ctx.font = `11px ${font}`;
    ctx.fillText(n.body || "", x + 10, y + h - 18);
    ctx.restore();
    ctx.restore();
    return;
  }

  /* ---------- 文档卡：标题 + 摘要 ---------- */
  if (n.kind === "doc") {
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    ctx.fillStyle = color;
    ctx.font = `600 ${Math.max(12, fs)}px ${font}`;
    const tl = wrapText(ctx, n.title, innerW).slice(0, 2);
    tl.forEach((l, i) => ctx.fillText(l, x + padL, y + padT + halfLead + i * lh));
    if (n.summary) {
      ctx.save();
      ctx.globalAlpha = 0.66;
      ctx.font = `${Math.max(11, fs - 2)}px ${font}`;
      const sl = wrapText(ctx, n.summary, innerW).slice(0, 3);
      const sy = y + padT + tl.length * lh + 6 + halfLead;
      sl.forEach((l, i) => ctx.fillText(l, x + padL, sy + i * (fs + 5)));
      ctx.restore();
    }
    ctx.restore();
    return;
  }

  /* ---------- 甘特卡：示意彩条（屏幕上那是真甘特组件，canvas 只画轮廓） ---------- */
  if (n.kind === "gantt") {
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    ctx.fillStyle = color;
    ctx.font = `600 ${Math.max(12, fs)}px ${font}`;
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

  /* ---------- 任务卡：优先级竖条 + 标题 + 第二行 + 备注 + 完成态 ---------- */
  if (n.kind === "task") {
    // 屏幕上 task-node 是 border-left: 3px，不是自己画的色块，宽度要对上
    ctx.save();
    roundRect(ctx, x, y, w, h, radius);
    ctx.clip();
    ctx.fillStyle = n.accent || "#409EFF";
    ctx.fillRect(x, y, 3, h);
    ctx.restore();

    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    ctx.save();
    if (n.done) ctx.globalAlpha = 0.55;
    // 首行先画编号徽标（屏幕上 .tn-seq），标题从它右边开始，
    // 不画的话导出图里就没有 T1/T2，跟屏幕对不上。
    let titleX = x + 13;
    let titleW = innerW;
    if (n.seq) {
      const bFont = `700 ${Math.max(9, Math.round(fs * 0.77))}px ${font}`;
      const label = `T${n.seq}`;
      ctx.font = bFont;
      const bw = ctx.measureText(label).width + 8;
      const bh = Math.round(fs * 1.15);
      const by = y + padT + halfLead + Math.max(0, (lh - bh) / 2);
      ctx.save();
      if (n.done) ctx.globalAlpha = 0.55;
      ctx.fillStyle = "rgb(0 0 0 / 6%)";
      roundRect(ctx, titleX, by, bw, bh, 4);
      ctx.fill();
      ctx.fillStyle = n.subColor || color;
      ctx.globalAlpha *= 0.78;
      ctx.textBaseline = "middle";
      ctx.fillText(label, titleX + 4, by + bh / 2 + 0.5);
      ctx.restore();
      ctx.textBaseline = "top";
      titleX += bw + 5;
      titleW = Math.max(20, innerW - (bw + 5));
    }

    ctx.fillStyle = color;
    ctx.font = `600 ${Math.max(12, fs)}px ${font}`;
    const tl = wrapText(ctx, n.title, titleW).slice(0, 3);
    tl.forEach((l, i) =>
      ctx.fillText(l, i === 0 ? titleX : x + 13, y + padT + halfLead + i * lh)
    );

    let cursorY = y + padT + tl.length * lh + 3 + halfLead;
    const sub = (n.sub || []).filter(Boolean);
    if (sub.length) {
      ctx.font = `${Math.max(10, fs - 2.5)}px ${font}`;
      ctx.fillStyle = n.subColor || color;
      ctx.globalAlpha = n.done ? 0.4 : 0.85;
      ctx.fillText(sub.join("   "), x + 13, cursorY);
      ctx.globalAlpha = n.done ? 0.4 : 1;
      cursorY += Math.max(11, fs);
    }
    if (n.body) {
      ctx.globalAlpha = n.done ? 0.4 : 0.7;
      ctx.font = `${Math.max(11, fs - 2)}px ${font}`;
      const bl = wrapText(ctx, n.body, innerW).slice(0, 2);
      bl.forEach((l, i) => ctx.fillText(l, x + 13, cursorY + 3 + i * (fs + 4)));
      cursorY += 3 + bl.length * (fs + 4);
    }

    // 依据 chip：三档用明暗区分（实心 / 描边 / 虚线灰字），与卡片上的样式一致
    if (n.refs && n.refs.length) {
      const cFont = `${Math.max(9, Math.round(fs * 0.77))}px ${font}`;
      const chH = Math.round(fs * 1.3);
      const cy = cursorY + 4;
      let cx = x + 13;
      ctx.font = cFont;
      ctx.textBaseline = "middle";
      for (const r of n.refs) {
        const label = r.label || "资料";
        const tw = ctx.measureText(label).width + 10;
        if (cx + tw > x + w - 10) break;
        ctx.save();
        if (n.done) ctx.globalAlpha = 0.5;
        if (r.level === 0) {
          ctx.fillStyle = "#6f7680";
          roundRect(ctx, cx, cy, tw, chH, 4);
          ctx.fill();
          ctx.fillStyle = "#ffffff";
        } else {
          ctx.fillStyle = "#ffffff";
          roundRect(ctx, cx, cy, tw, chH, 4);
          ctx.fill();
          if (r.level === 2) ctx.setLineDash([3, 3]);
          ctx.lineWidth = 1;
          ctx.strokeStyle = "#d5d8dc";
          roundRect(ctx, cx, cy, tw, chH, 4);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = r.level === 2 ? "#9aa0a6" : color;
        }
        ctx.fillText(label, cx + 5, cy + chH / 2 + 0.5);
        ctx.restore();
        cx += tw + 4;
      }
      ctx.textBaseline = "top";
    }
    ctx.restore();
    ctx.restore();
    return;
  }

  /* ---------- 便签 / 文本 / 导图：纯文字 ---------- */
  ctx.fillStyle = color;
  ctx.font = `${st?.weight || 400} ${fs}px ${font}`;
  ctx.textBaseline = "top";
  const centered = n.kind === "mind" || st?.align === "center";
  ctx.textAlign = centered ? "center" : "left";
  const lines = wrapText(ctx, n.title, innerW);
  const totalH = lines.length * lh;
  const top = n.kind === "mind" ? y + Math.max(padT, (h - totalH) / 2) : y + padT;
  lines.forEach((l, i) => ctx.fillText(l, centered ? x + w / 2 : x + padL, top + halfLead + i * lh));
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
  ctx.fillStyle = scene.bg || "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.translate(-minX + pad, -minY + pad);

  // 连线在最底层：直接复用屏幕那条 SVG path（曲线/直线都在里面了）
  ctx.lineCap = "round";
  for (const l of scene.lines) {
    ctx.strokeStyle = l.color;
    ctx.lineWidth = l.width;
    // 依据用点线，其余实线 —— 屏幕上的 .edge-line.k-* 是同一条规则
    ctx.setLineDash(l.kind === "evidence" ? [1, 5] : []);
    ctx.stroke(new Path2D(l.d));
  }
  ctx.setLineDash([]);
  // 箭头单独一轮画，避免被后画的连线盖住
  for (const l of scene.lines) drawArrow(ctx, l.x2, l.y2, l.angle, l.color);

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
