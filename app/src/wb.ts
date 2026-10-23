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

/**
 * 连线路径 + 末端切线角。
 *
 * 直线：两个边界点直接连。
 *
 * 弧线：用**固定水平控制臂**的三次贝塞尔 —— 也就是思维导图那种 S 形：
 * 线先从卡片边缘水平走出去，中途拐弯，再水平进入目标卡片。
 * ⚠️ 不要用"沿出边法线外推"的写法：当两个卡片垂直堆叠时，法线方向和连线方向
 * 几乎重合，控制点共线，曲线就退化成直线了（手绘感全没了）。
 * 只有近乎垂直对齐（|dx| < 24）时才改用垂直臂，否则会绕出一个很怪的圈。
 *
 * 返回的 angle 是箭头方向（弧度）：直线取 p1→p2，曲线取终点控制点→终点
 * （即贝塞尔在 t=1 处的切线），所以箭头会顺着弧线"进"卡片，不会歪。
 */
export function edgeGeom(
  a: Pt,
  b: Pt,
  p1: Pt,
  p2: Pt,
  style: EdgeStyle = "curve"
): { d: string; angle: number } {
  if (style === "line") {
    return {
      d: `M${p1.x},${p1.y} L${p2.x},${p2.y}`,
      angle: Math.atan2(p2.y - p1.y, p2.x - p1.x),
    };
  }
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  let c1x: number, c1y: number, c2x: number, c2y: number;
  if (Math.abs(dx) < 24 && Math.abs(dy) > 24) {
    // 几乎垂直：竖向 S
    const k = Math.max(34, Math.min(130, Math.abs(dy) * 0.5));
    const s = dy >= 0 ? 1 : -1;
    c1x = p1.x;
    c1y = p1.y + s * k;
    c2x = p2.x;
    c2y = p2.y - s * k;
  } else {
    // 常规：横向 S（臂长跟水平距离走，避免短连线绕成圈）
    const k = Math.max(36, Math.min(140, Math.abs(dx) * 0.6));
    const s = dx >= 0 ? 1 : -1;
    c1x = p1.x + s * k;
    c1y = p1.y;
    c2x = p2.x - s * k;
    c2y = p2.y;
  }
  return {
    d: `M${p1.x},${p1.y} C${c1x},${c1y} ${c2x},${c2y} ${p2.x},${p2.y}`,
    angle: Math.atan2(p2.y - c2y, p2.x - c2x),
  };
}

/** 只要 path 字符串时用这个（屏幕侧 linkingPathD 之类） */
export function edgePath(a: Pt, b: Pt, p1: Pt, p2: Pt, style: EdgeStyle = "curve"): string {
  return edgeGeom(a, b, p1, p2, style).d;
}
