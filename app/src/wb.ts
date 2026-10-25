import type { NodeKind } from "./types";

// ---------- 文件读取 ----------

export function readAsDataURL(file: File | Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ""));
    fr.onerror = () => reject(fr.error ?? new Error("读取文件失败"));
    fr.readAsDataURL(file);
  });
}

/** 量出图片原始尺寸，用来按比例摆放缩略图 */
export function imageSize(dataUrl: string): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

// ---------- 节点尺寸 ----------

export const NODE_SIZE: Record<NodeKind, { w: number; h: number }> = {
  note: { w: 176, h: 132 },
  text: { w: 200, h: 44 },
  mind: { w: 190, h: 46 },
  box: { w: 340, h: 240 },
  file: { w: 240, h: 96 },
  /** 甘特图：横向时间轴，默认给个能放下 10 来天的大格子 */
  gantt: { w: 620, h: 300 },
  /** 文档卡片：显示 Markdown 文档的标题 + 摘要，点一下直接在这里编辑 */
  doc: { w: 260, h: 150 },
};

export function sizeOfNode(kind: NodeKind, w?: number | null, h?: number | null) {
  const def = NODE_SIZE[kind] ?? NODE_SIZE.note;
  return { w: w && w > 40 ? w : def.w, h: h && h > 24 ? h : def.h };
}

export const NOTE_COLORS = [
  "#FFF9C4",
  "#FFE0B2",
  "#F8BBD0",
  "#C8E6C9",
  "#B3E5FC",
  "#E1BEE7",
  "#FFFFFF",
];

/* ------------------------------------------------------------------
 * 节点文字颜色：按背景亮度自动在「深墨 / 白」之间二选一
 * 用户给便签、导图节点、分组框自选颜色，可能是很浅的米黄，也可能是深蓝；
 * 字色写死就会出现「浅底浅字」看不清。黑/白二选一的对比度必然 ≥ 4.5:1，
 * 所以只按 WCAG 相对亮度挑对比度更大的那个，不用再做兜底。
 * ------------------------------------------------------------------ */
const INK_DARK = "#1b2130";
const INK_LIGHT = "#ffffff";

/** #rgb / #rrggbb / #rrggbbaa / rgb() / rgba() → [r,g,b,a]；认不出就返回 null */
function parseColor(s: string): [number, number, number, number] | null {
  const v = String(s ?? "").trim().toLowerCase();
  if (!v || v === "transparent" || v === "none") return null;
  if (v[0] === "#") {
    const h = v.slice(1);
    const ex = (i: number, len: number) => {
      const seg = h.slice(i, i + len);
      return len === 1 ? parseInt(seg + seg, 16) : parseInt(seg, 16);
    };
    if (h.length === 3 || h.length === 4) {
      return [ex(0, 1), ex(1, 1), ex(2, 1), h.length === 4 ? ex(3, 1) / 255 : 1];
    }
    if (h.length === 6 || h.length === 8) {
      return [ex(0, 2), ex(2, 2), ex(4, 2), h.length === 8 ? ex(6, 2) / 255 : 1];
    }
    return null;
  }
  const m = v.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const p = m[1].split(/[,/\s]+/).filter(Boolean).map(Number);
    if (p.length >= 3 && p.slice(0, 3).every((n) => !Number.isNaN(n))) {
      return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
    }
  }
  return null;
}

/** WCAG 相对亮度（0 = 纯黑，1 = 纯白） */
function relLuminance(r: number, g: number, b: number) {
  const lin = (c: number) => {
    const x = Math.min(255, Math.max(0, c)) / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** 这个背景上最清楚的字色（深墨或白） */
export function inkOn(bg: string): string {
  const c = parseColor(bg);
  if (!c) return INK_DARK;
  const [r, g, b, a] = c;
  // 半透明的颜色按"叠在白纸上"估算，避免大面积透明被当成深色
  const mix = (v: number) => v * a + 255 * (1 - a);
  const L = relLuminance(mix(r), mix(g), mix(b));
  const onWhite = 1.05 / (L + 0.05); // 白字的对比度
  const onDark = (L + 0.05) / 0.05; // 深字的对比度
  return onDark >= onWhite ? INK_DARK : INK_LIGHT;
}

/** 字色偏浅时补一层很淡的暗影，压在照片/渐变上也不糊 */
export function inkShadowOn(bg: string): string {
  return inkOn(bg) === INK_LIGHT ? "0 1px 2px rgb(0 0 0 / 22%)" : "none";
}

/** 分组框（分区）用的颜色：够区分，又不至于像便签那么跳 */
export const BOX_COLORS = [
  "#409EFF",
  "#67C23A",
  "#E6A23C",
  "#9254de",
  "#13c2c2",
  "#eb2f96",
  "#fa8c16",
  "#909399",
];

// ---------- 树形自动布局 ----------

export interface TreePos {
  x: number;
  y: number;
}

export interface TreeEdge {
  from: string;
  to: string;
}

/**
 * 把一串节点按「父子连线」排成从左到右的树。
 *
 * ⚠️ 边的方向是**子 → 父**（from 是子、to 是父），所以找子级要
 * 「顺着 to 找 from」。父在左、子在右，跟白板上的收敛图一致。
 * 节点用字符串 key 标识（`task:3` / `note:5`），因为任务和便签的自增 id 会撞车。
 */
export function layoutTree(
  keys: string[],
  edges: TreeEdge[],
  gapX = 250,
  gapY = 28,
  nodeH = 72,
  heightOf?: (key: string) => number
): Map<string, TreePos> {
  // 每个节点按自己的实际高度排：任务卡比便签高，写死一个高度必然交叠
  const hOf = (k: string) => {
    const h = heightOf ? heightOf(k) : nodeH;
    return h > 16 ? h : nodeH;
  };
  const set = new Set(keys);
  const kids = new Map<string, string[]>();
  const hasParent = new Set<string>();

  for (const e of edges) {
    if (!set.has(e.from) || !set.has(e.to)) continue;
    // from 是子、to 是父：父的子级列表里放 from
    const list = kids.get(e.to);
    if (list) list.push(e.from);
    else kids.set(e.to, [e.from]);
    hasParent.add(e.from);
  }

  const roots = keys.filter((k) => !hasParent.has(k));
  const pos = new Map<string, TreePos>();
  const seen = new Set<string>();
  let cursor = 0;

  const walk = (key: string, depth: number): number => {
    if (seen.has(key)) return 0;
    seen.add(key);
    const cs = (kids.get(key) ?? []).filter((k) => !seen.has(k));
    const h = hOf(key);
    let cy: number;
    if (cs.length === 0) {
      cy = cursor + h / 2;
      cursor += h + gapY;
    } else {
      const ys = cs.map((k) => walk(k, depth + 1));
      cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    }
    pos.set(key, { x: depth * gapX, y: cy - h / 2 });
    return cy;
  };

  roots.forEach((r) => walk(r, 0));

  // 环或孤儿节点（有父但没被游走到）垫在最下面，避免重叠
  for (const k of keys) {
    if (!pos.has(k)) {
      pos.set(k, { x: 0, y: cursor });
      cursor += hOf(k) + gapY;
    }
  }
  return pos;
}

/* ------------------------------------------------------------------
 * 连线几何：屏幕（SVG）和导出（Canvas）共用这一份，别再各画各的。
 *
 * 之前导出把连线写成 moveTo/lineTo 直线，屏幕上却是贝塞尔弧线 ——
 * 于是"白板设的是曲线、导出来变直线"。几何只能有一处真源。
 * ------------------------------------------------------------------ */

export type EdgeStyle = "curve" | "line";

export interface Pt {
  x: number;
  y: number;
}

/** 从矩形中心朝目标方向，把点推到矩形边框上 —— 连线贴边走，不会画进卡片里面 */
export function clipToRect(c: Pt, toward: Pt, s: { w: number; h: number }): Pt {
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (!dx && !dy) return { x: c.x, y: c.y };
  const hw = Math.max(1, s.w / 2);
  const hh = Math.max(1, s.h / 2);
  const k = Math.min(hw / (Math.abs(dx) || 1e-6), hh / (Math.abs(dy) || 1e-6));
  return { x: c.x + dx * k, y: c.y + dy * k };
}

export interface Size {
  w: number;
  h: number;
}

export interface EdgeCtx {
  /** 横向错开量：同一个列间隙里常常并排好几条线，不错开会叠成一条粗线 */
  bias?: number;
  /** 指定的竖走线位置（一般不用，留给特殊场景） */
  mx?: number;
  /** 起点所在卡片的尺寸：反向绕行时用它判断"绕到卡片外面"要多远 */
  s1?: Size;
  /** 终点所在卡片的尺寸 */
  s2?: Size;
}

/**
 * 连线路径 + 末端切线角。
 *
 * 端口语义是固定的（全板统一）：**起点从左端口出、终点从右端口进**。
 * 于是几何只有两种情形：
 *
 * 1. **顺向**（终点落在起点左边，父子左右排开）—— 思维导图那种 S 形：
 *    用两个钉在同一条竖线上的控制点，线「水平出去 → 空隙里竖着走 → 水平进去」。
 *    ⚠️ 别用"沿出边法线外推"：两卡垂直堆叠时法线与连线几乎重合，控制点共线，
 *    曲线会退化成直线。
 *
 * 2. **反向**（终点落在起点右边，典型就是父子上下堆叠）—— 一条贝塞尔绕不出来，
 *    必须绕到卡片外侧再折回来（见 loopGeom）。这不是"画得难看"，是端口语义的
 *    必然结果：父的右端口本来就在子的左端口右边，线只能绕过子卡。
 *
 * 返回的 angle 是箭头方向（弧度），取终点控制点 → 终点（即 t=1 处的切线），
 * 所以箭头会顺着弧线"进"卡片，不会歪。
 */
export function edgeGeom(
  a: Pt,
  b: Pt,
  p1: Pt,
  p2: Pt,
  style: EdgeStyle = "curve",
  ctx: EdgeCtx = {}
): { d: string; angle: number } {
  if (style === "line") {
    return {
      d: `M${p1.x},${p1.y} L${p2.x},${p2.y}`,
      angle: Math.atan2(p2.y - p1.y, p2.x - p1.x),
    };
  }
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  // 落差可以忽略、方向也对：一条水平直线最清楚，箭头也最明确
  if (Math.abs(dy) < 3 && dx <= 8) {
    return { d: `M${p1.x},${p1.y} L${p2.x},${p2.y}`, angle: Math.atan2(0, dx) };
  }
  if (dx > 8) return loopGeom(p1, p2, ctx);
  const mx = ctx.mx ?? edgeMx(p1, p2, ctx.bias ?? 0);
  return {
    d: `M${p1.x},${p1.y} C${mx},${p1.y} ${mx},${p2.y} ${p2.x},${p2.y}`,
    angle: Math.atan2(0, p2.x - mx),
  };
}

/**
 * 反向绕行：起点朝左出、终点要从右边进，但终点在起点右边。
 *
 * 走法（全程落在卡片外面，最后一段一定水平向左，箭头明确指向终点卡）：
 *
 *   左出去 → 竖向走到两卡之间的空档（没有空档就绕到父卡的反面）
 *   → 横向穿到另一侧 → 竖向回到终点高度 → 水平向左插进终点卡
 *
 * 拐角用半径 34 的圆弧磨过，是一整条连续的曲线，不是方框。
 * 横向只比卡片边缘多出 34px，尽量少占地方。
 */
function loopGeom(p1: Pt, p2: Pt, ctx: EdgeCtx) {
  const h1 = ctx.s1?.h ?? 80;
  const h2 = ctx.s2?.h ?? 80;
  const arm = 34;
  const r = 34;
  let yc: number;
  if (p2.y <= p1.y) {
    // 父在上：两卡之间有空档就横穿空档，否则绕到子卡下方
    const gap = p1.y - h1 / 2 - (p2.y + h2 / 2);
    yc = gap >= 30 ? (p1.y - h1 / 2 + p2.y + h2 / 2) / 2 : p1.y + h1 / 2 + arm;
  } else {
    const gap = p2.y - h2 / 2 - (p1.y + h1 / 2);
    yc = gap >= 30 ? (p2.y - h2 / 2 + p1.y + h1 / 2) / 2 : p1.y - h1 / 2 - arm;
  }
  const xL = Math.min(p1.x, p2.x) - arm;
  const xR = Math.max(p1.x, p2.x) + arm;
  const pts: Pt[] = [
    p1,
    { x: xL, y: p1.y },
    { x: xL, y: yc },
    { x: xR, y: yc },
    { x: xR, y: p2.y },
    p2,
  ];
  return { d: roundedPath(pts, r), angle: Math.atan2(0, -1) };
}

/**
 * 圆角折线：把一串点连成一条路径，每个拐点切一段圆弧。
 *
 * 只在 loopGeom 里用（反向绕行）。半径会自动收缩到相邻两段较短那段的 1/2，
 * 短段不会被切出反向的小钩；半径给得够大时看起来就是一整条连续的曲线。
 */
function roundedPath(pts: Pt[], r: number): string {
  if (pts.length < 2) return "";
  let d = `M${pts[0].x},${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i];
    const prev = pts[i - 1];
    const next = pts[i + 1];
    const v1 = { x: p.x - prev.x, y: p.y - prev.y };
    const v2 = { x: next.x - p.x, y: next.y - p.y };
    const l1 = Math.hypot(v1.x, v1.y) || 1;
    const l2 = Math.hypot(v2.x, v2.y) || 1;
    const rr = Math.min(r, l1 / 2, l2 / 2);
    const pa = { x: p.x - (v1.x / l1) * rr, y: p.y - (v1.y / l1) * rr };
    const pb = { x: p.x + (v2.x / l2) * rr, y: p.y + (v2.y / l2) * rr };
    d += ` L${pa.x},${pa.y} Q${p.x},${p.y} ${pb.x},${pb.y}`;
  }
  const last = pts[pts.length - 1];
  return `${d} L${last.x},${last.y}`;
}

/**
 * 曲线的竖走线位置（两个控制点都在这条竖线上）。
 *
 * 两卡左右分得开（|dx| ≥ 64）→ 取中间那条列间隙的中线；
 * 两卡几乎离得很近 → 没有间隙可用，从卡片外侧绕。
 */
export function edgeMx(p1: Pt, p2: Pt, bias = 0): number {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  let mx: number;
  if (Math.abs(dx) >= 64) {
    mx = p1.x + dx * 0.5;
  } else {
    const bulge = Math.max(70, Math.min(140, 170 - Math.abs(dy) * 0.3));
    mx = dx >= 0 ? Math.max(p1.x, p2.x) + bulge : Math.min(p1.x, p2.x) - bulge;
  }
  return mx + bias;
}

/** 只要 path 字符串时用这个（屏幕侧 linkingPathD 之类） */
export function edgePath(a: Pt, b: Pt, p1: Pt, p2: Pt, style: EdgeStyle = "curve"): string {
  return edgeGeom(a, b, p1, p2, style).d;
}

/**
 * 圆角折线：一串点连成路径，每个拐点切一个小圆角。
 *
 * 远距离的连线（资料卡在最右、任务卡在最左，中间横着一整列卡片）用一条大 S
 * 是绕不开的 —— 无论竖走线放在哪一列，1000px 高的竖段都会从卡片身上压过去，
 * 于是线被卡片"切断"成两截。这种线改走正交通道：沿列间隙竖走、沿行间隙横走，
 * 每段都在空白里，拐点用圆角磨软，看起来仍然是流畅的线，不是方框。
 *
 * 半径自动收缩到相邻两段较短那段的 1/2，短段不会被切出反向的小钩。
 */
export function roundedPolyline(pts: Pt[], r = 14): string {
  if (pts.length < 2) return "";
  let d = `M${pts[0].x},${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i];
    const prev = pts[i - 1];
    const next = pts[i + 1];
    const v1 = { x: p.x - prev.x, y: p.y - prev.y };
    const v2 = { x: next.x - p.x, y: next.y - p.y };
    const l1 = Math.hypot(v1.x, v1.y) || 1;
    const l2 = Math.hypot(v2.x, v2.y) || 1;
    const rr = Math.min(r, l1 / 2, l2 / 2);
    const a = { x: p.x - (v1.x / l1) * rr, y: p.y - (v1.y / l1) * rr };
    const b = { x: p.x + (v2.x / l2) * rr, y: p.y + (v2.y / l2) * rr };
    d += ` L${a.x.toFixed(1)},${a.y.toFixed(1)} Q${p.x},${p.y} ${b.x.toFixed(1)},${b.y.toFixed(1)}`;
  }
  const last = pts[pts.length - 1];
  return `${d} L${last.x},${last.y}`;
}
