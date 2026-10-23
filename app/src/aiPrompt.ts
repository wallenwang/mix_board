/**
 * 把一个任务连同它的上下文，拼成一段可以直接粘给 AI 的话。
 *
 * 为什么要在软件里生成，而不是让用户自己写：
 * AI 答得泛，多数时候是它不知道这个任务的约束、依赖和素材。
 * 这些信息本来就存在白板和库里，只是没被翻译成 AI 能读的形式。
 *
 * 内容全部来自数据库，没有一句是写死的示例：
 *   - 任务标题/说明/阶段/截止   → tasks
 *   - 资料与它的三档等级        → task_refs(level)
 *   - 资料所在分区、分区强度    → board_notes(type=box) + meta.cluster
 *   - 上一环节 / 下一环节 / 父子 → board_edges(kind)
 *   - 要交什么                  → produce 边指向的文档或资料节点
 *
 * ⚠️ 这段话不搬运材料内容。多模态模型能直接读 PDF / 图片，把文件一并拖过去就行；
 * 这段话要做的是「移交材料清单」——哪几个文件、各自多硬、重点在哪儿、冲突时听谁的。
 * 所以要点（point）的定位是导航和约束，不是内容替身：
 *   200 页的规范书，让 AI 知道只看第 12 页，比把第 12 页抄一遍更稳。
 *
 * 三档等级不写数值权重：AI 拿到 0.7 不知道该干什么，拿到「冲突时以它为准」
 * 才知道怎么做。这也是为什么等级挂在关系上（同一份资料对不同任务可以不同档）。
 */

import { ref } from "vue";
import type { BoardEdge, BoardNote, Task, TaskRef, WbFile } from "./types";

/* ------------------------------------------------------------------
 * 只依赖用得到的这几个字段，方便白板、看板卡片都能直接传 store 进来
 * ------------------------------------------------------------------ */
export interface PromptStore {
  currentProject: { name: string } | null;
  columns: { id: number; name: string }[];
  allTasks: Task[];
  notes: BoardNote[];
  assets: WbFile[];
  edges: BoardEdge[];
  refsOfTask(taskId: number): TaskRef[];
  numberOf(taskId: number): string;
}

/* ---------------- 弹窗状态：任何地方调 openPrompt 都能打开 ---------------- */

export const aiPromptOpen = ref(false);
export const aiPromptText = ref("");
export const aiPromptTitle = ref("");

export function openPrompt(store: PromptStore, taskId: number) {
  const t = store.allTasks.find((x) => x.id === taskId);
  if (!t) return;
  aiPromptText.value = buildTaskPrompt(store, taskId);
  aiPromptTitle.value = `给 AI 的指令 · T${store.numberOf(taskId)} ${t.title}`;
  aiPromptOpen.value = true;
}

/* ---------------- 材料 ---------------- */

type ClusterKey = "strong" | "ref" | "weak";

const CLUSTER_LABEL: Record<ClusterKey, string> = {
  strong: "强依据",
  ref: "参考",
  weak: "弱参考",
};

/** 三档标题按用户的说法写，同时保留"必须/可以/不要引用"这层执行含义 */
const LEVEL_TITLE: Record<number, string> = {
  0: "重要依据（必须遵守，违反即作废）",
  1: "参考（不强制，没有冲突时补充）",
  2: "弱参考（只用来理解语境，不要当依据引用）",
};

const EXT_LABEL: Record<string, string> = {
  pdf: "PDF",
  doc: "Word",
  docx: "Word",
  xls: "Excel",
  xlsx: "Excel",
  csv: "表格",
  ppt: "PPT",
  pptx: "PPT",
  png: "图片",
  jpg: "图片",
  jpeg: "图片",
  gif: "图片",
  webp: "图片",
  svg: "矢量图",
  mp4: "视频",
  mov: "视频",
  md: "Markdown",
  txt: "文本",
};

function metaOf(n: BoardNote): Record<string, unknown> {
  try {
    return JSON.parse(n.meta || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

function sizeText(bytes: number): string {
  if (!bytes || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 资料被哪个分组框收着：取能完整包住它的最小的那个（跟白板上的判定一致） */
function clusterOf(store: PromptStore, n: BoardNote): { key: ClusterKey; name: string } | null {
  const nw = n.w ?? 0;
  const nh = n.h ?? 0;
  let best: BoardNote | null = null;
  let bestArea = Infinity;
  for (const b of store.notes) {
    if (b.kind !== "box") continue;
    const bw = b.w ?? 0;
    const bh = b.h ?? 0;
    if (bw <= 0 || bh <= 0) continue;
    const hit =
      n.x >= b.x - 0.5 &&
      n.y >= b.y - 0.5 &&
      n.x + nw <= b.x + bw + 0.5 &&
      n.y + nh <= b.y + bh + 0.5;
    if (!hit) continue;
    if (bw * bh < bestArea) {
      bestArea = bw * bh;
      best = b;
    }
  }
  if (!best) return null;
  const raw = metaOf(best).cluster;
  const key: ClusterKey = raw === "strong" ? "strong" : raw === "weak" || raw === "bg" ? "weak" : "ref";
  return { key, name: (best.text || "未命名分区").trim() };
}

interface RefRow {
  label: string;
  level: number;
  file: { name: string; ext: string; size: number } | null;
  cluster: { key: ClusterKey; name: string } | null;
  isDoc: boolean;
  /** 这条依据对这个任务的要点（用户写的一句话） */
  point: string;
}

function collectRefs(store: PromptStore, taskId: number): RefRow[] {
  const rows: RefRow[] = [];
  for (const r of store.refsOfTask(taskId)) {
    const n = store.notes.find((x) => x.id === r.note_id);
    if (!n) continue;
    const f = n.file_id ? store.assets.find((a) => a.id === n.file_id) : null;
    rows.push({
      label: (n.text || f?.name || "未命名资料").trim(),
      level: r.level,
      file: f ? { name: f.name, ext: (f.ext || "").toLowerCase(), size: f.size } : null,
      cluster: clusterOf(store, n),
      isDoc: n.kind === "doc",
      point: (r.point || "").trim(),
    });
  }
  // 同一个任务里按等级排好，同级保持原有顺序
  return rows.sort((a, b) => a.level - b.level);
}

function refLine(r: RefRow): string {
  const bits: string[] = [];
  if (r.file) {
    const kind = EXT_LABEL[r.file.ext] || r.file.ext.toUpperCase() || "文件";
    const size = sizeText(r.file.size);
    bits.push(size ? `${kind}，${size}` : kind);
  } else if (r.isDoc) {
    bits.push("站内文档");
  }
  if (r.cluster) {
    bits.push(`来自分区「${r.cluster.name}」，标为${CLUSTER_LABEL[r.cluster.key]}`);
  }
  const tail = bits.length ? ` ｜ ${bits.join(" · ")}` : "";
  // 要点另起一行：这是材料里真正的内容，混在文件名后面会被 AI 当装饰忽略
  const pointLine = r.point ? `\n  要点：${r.point}` : "";
  return `- ${r.label}${tail}${pointLine}`;
}

/* ---------------- 关系 ---------------- */

interface Neighbor {
  seq: string;
  title: string;
  done: boolean;
}

function collectLinks(store: PromptStore, taskId: number) {
  /** 连线两端各自指向哪个任务：from 是上级/前置/产出方，to 是下级/后续 */
  const atFrom = (e: BoardEdge) => store.allTasks.find((t) => t.id === e.from_id);
  const atTo = (e: BoardEdge) => store.allTasks.find((t) => t.id === e.to_id);
  let parentRow: Neighbor | null = null;
  const children: Neighbor[] = [];
  const prev: Neighbor[] = [];
  const next: Neighbor[] = [];
  const outputs: string[] = [];

  const asNeighbor = (t: Task): Neighbor => ({
    seq: store.numberOf(t.id),
    title: t.title,
    done: !!t.completed_at,
  });

  for (const e of store.edges) {
    const kind = e.kind || "decompose";
    // 上级：别人 → 我（父子）
    if (kind === "decompose" && e.to_kind === "task" && e.to_id === taskId && e.from_kind === "task") {
      const t = atFrom(e);
      if (t) parentRow = asNeighbor(t);
    }
    // 下级：我 → 别人（父子）
    if (kind === "decompose" && e.from_kind === "task" && e.from_id === taskId && e.to_kind === "task") {
      const t = atTo(e);
      if (t) children.push(asNeighbor(t));
    }
    // 上一个环节：前置 → 我
    if (kind === "precede" && e.to_kind === "task" && e.to_id === taskId && e.from_kind === "task") {
      const t = atFrom(e);
      if (t) prev.push(asNeighbor(t));
    }
    // 下一个环节：我 → 后续
    if (kind === "precede" && e.from_kind === "task" && e.from_id === taskId && e.to_kind === "task") {
      const t = atTo(e);
      if (t) next.push(asNeighbor(t));
    }
    // 产出：我 → 文档 / 资料
    if (kind === "produce" && e.from_kind === "task" && e.from_id === taskId && e.to_kind === "note") {
      const n = store.notes.find((x) => x.id === e.to_id);
      if (n) {
        const f = n.file_id ? store.assets.find((a) => a.id === n.file_id) : null;
        outputs.push((n.text || f?.name || "产出").trim());
      }
    }
  }
  return { parent: parentRow as Neighbor | null, children, prev, next, outputs };
}

/* ---------------- 组装 ---------------- */

function dueLine(t: Task): string {
  if (!t.due_date) return "";
  const d = new Date(t.due_date + "T23:59:59");
  const days = Math.ceil((d.getTime() - Date.now()) / 86400000);
  if (Number.isNaN(days)) return `截止 ${t.due_date.slice(0, 10)}`;
  if (days < 0) return `截止 ${t.due_date.slice(0, 10)}（已过 ${-days} 天）`;
  if (days === 0) return `截止 ${t.due_date.slice(0, 10)}（今天）`;
  return `截止 ${t.due_date.slice(0, 10)}（还剩 ${days} 天）`;
}

export function buildTaskPrompt(store: PromptStore, taskId: number): string {
  const t = store.allTasks.find((x) => x.id === taskId);
  if (!t) return "";

  const seq = store.numberOf(taskId);
  const out: string[] = [];
  const gaps: string[] = [];

  out.push(`【T${seq} ${t.title}】${store.currentProject?.name ?? "未命名项目"}`);
  out.push("");

  /* 一、要做什么 */
  out.push("一、这次要你做什么");
  const desc = (t.description || "").trim();
  if (desc) out.push(desc);
  else {
    out.push("（这个任务还没写说明。）");
    gaps.push("任务说明是空的，AI 只能靠标题猜");
  }
  const metaBits: string[] = [];
  const col = store.columns.find((c) => c.id === t.column_id);
  if (col) metaBits.push(`阶段：${col.name}`);
  const due = dueLine(t);
  if (due) metaBits.push(due);
  if (t.completed_at) metaBits.push("状态：已完成");
  if (metaBits.length) {
    out.push("");
    out.push(metaBits.join(" ｜ "));
  }
  out.push("");

  /* 二、材料 */
  const refs = collectRefs(store, taskId);
  out.push("二、手上的材料（按能不能违背分类）");
  if (!refs.length) {
    out.push("（这个任务还没有挂任何资料。）");
    gaps.push("任务上没有挂资料，AI 没有任何依据");
  } else {
    // 这句是整段话里最要紧的一句：不写它，使用者会以为光靠下面这些条目就够了，
    // 而 AI 其实一个文件也没看到。
    out.push(
      `（下面 ${refs.length} 个文件要一并传给我，直接看原文件就行。` +
        `这几句说的是「它们各自多硬、该重点看哪儿」，不是文件内容本身。）`
    );
    for (const lv of [0, 1, 2]) {
      const list = refs.filter((r) => r.level === lv);
      if (!list.length) continue;
      out.push("");
      out.push(`【${LEVEL_TITLE[lv]}】${list.length} 份`);
      for (const r of list) out.push(refLine(r));
    }
    // 框上的强度跟任务里定的不一样时点一句，避免 AI 看到两边冲突
    const mismatch = refs.find(
      (r) =>
        r.cluster &&
        ((r.cluster.key === "strong" && r.level !== 0) ||
          (r.cluster.key === "weak" && r.level !== 2))
    );
    if (mismatch && mismatch.cluster) {
      out.push("");
      out.push(
        `（注：资料所在分区标的是「${CLUSTER_LABEL[mismatch.cluster.key]}」，而这个任务里定的是「${
          LEVEL_TITLE[mismatch.level]?.split("（")[0]
        }」。以任务里的定级为准。）`
      );
    }
    // 没写要点 = AI 拿到文件却不知道看哪儿。文件能让它读，但重点得人点。
    const noPoint = refs.filter((r) => !r.point);
    if (noPoint.length) {
      gaps.push(
        `${noPoint.length} 份材料还没说重点（${noPoint
          .map((r) => r.label)
          .join("、")}）。文件传过去它会读，但不点出重点，它容易抓错地方`
      );
    }
  }
  out.push("");

  /* 三、位置 */
  const links = collectLinks(store, taskId);
  const posLines: string[] = [];
  if (links.parent) {
    posLines.push(`- 所属上级：T${links.parent.seq} ${links.parent.title}`);
  }
  if (links.prev.length) {
    for (const p of links.prev) {
      posLines.push(
        `- 上一个环节：T${p.seq} ${p.title}${p.done ? "（已完成）" : "（还没做完，它的结论之后可能变）"}`
      );
    }
  }
  if (links.next.length) {
    for (const p of links.next) {
      posLines.push(`- 下一个环节：T${p.seq} ${p.title}（要等我这边做完）`);
    }
  }
  if (links.children.length) {
    const names = links.children.map((c) => `T${c.seq} ${c.title}`).join("、");
    posLines.push(`- 这件事拆成了：${names}`);
  }
  if (posLines.length) {
    out.push("三、这件事在项目里的位置");
    out.push(...posLines);
    out.push("");
  }

  /* 四、产出 */
  out.push("四、要交出来的东西");
  if (links.outputs.length) {
    for (const o of links.outputs) out.push(`- ${o}`);
    out.push("（直接给能用的内容，不要给提纲。）");
  } else {
    out.push("（这个任务还没挂产出物。请按「一、这次要你做什么」里的要求产出，");
    out.push("  并在第一句话说明你交了什么。）");
    gaps.push("任务上没挂产出物，AI 只能自己判断该交什么");
  }
  out.push("");

  /* 五、交付要求 */
  out.push("五、交付要求");
  out.push("- 直接给结论，不要复述这个任务，也不要在结尾问我要不要继续");
  if (refs.some((r) => r.level === 0)) {
    out.push("- 「重要依据」里写的内容不得违背；与我说的有冲突时，以材料为准并指出来");
  }
  if (refs.some((r) => r.level === 2)) {
    out.push("- 「弱参考」只用来理解语境，不要引用其中的说法");
  }
  if (refs.length >= 2) {
    out.push("- 两份材料说法不一致时，先把冲突说清楚，不要自己挑一个圆过去");
  }
  out.push("- 用到哪份材料，就在那句后面注明它的名字");
  if (refs.some((r) => r.point)) {
    out.push("- 我写的「要点」只是帮你定位重点，不是文件内容的替代；具体以文件为准");
    out.push("- 要点和文件对不上时，以文件为准，并告诉我哪里对不上");
  }
  out.push("");

  if (gaps.length) {
    out.push("六、这份任务还缺");
    for (const g of gaps) out.push(`- ${g}`);
    out.push("");
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/* ---------------- 复制 ---------------- */

/** 复制到剪贴板。非安全上下文（file:// 之类）下 clipboard 不可用，退回老办法。 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 继续走备用方案 */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
