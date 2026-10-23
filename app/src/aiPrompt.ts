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
/** 当前打开的是哪个任务（弹窗里改交付格式要写回它） */
export const aiPromptTaskId = ref<number | null>(null);

/** 交付格式选项：弹窗里的那排按钮和指令里的输出要求都读这一份 */
export const DELIVER_OPTIONS = [
  { key: "word", label: "Word", desc: "文档，带标题层级" },
  { key: "pdf", label: "PDF", desc: "可打印的文档版式" },
  { key: "ppt", label: "PPT", desc: "一页一个标题加要点" },
  { key: "md", label: "Markdown", desc: "结构化纯文本" },
  { key: "html", label: "HTML", desc: "自包含网页" },
  { key: "sheet", label: "表格", desc: "一行一条记录" },
] as const;

export function openPrompt(store: PromptStore, taskId: number) {
  const t = store.allTasks.find((x) => x.id === taskId);
  if (!t) return;
  aiPromptTaskId.value = taskId;
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
  if (r.cluster) bits.push(`分区「${r.cluster.name}」· ${CLUSTER_LABEL[r.cluster.key]}`);
  const head = bits.length ? `${r.label}（${bits.join("；")}）` : r.label;
  // 关注重点另起一行：混在文件名后面会被当装饰忽略
  return r.point ? `${head}\n   关注重点：${r.point}` : head;
}

/* ---------------- 关系 ---------------- */

interface Neighbor {
  seq: string;
  title: string;
  done: boolean;
  /** 子任务的说明，让它在指令里不只是一个名字 */
  desc: string;
  /** 子任务已标注的关注重点数量 */
  points: number;
}

/** 连到本任务的白板节点（思维导图、便签、文字），它们也是参数 */
interface BoardLink {
  kind: string;
  label: string;
  text: string;
}

const BOARD_KIND_NAME: Record<string, string> = {
  mind: "思维导图",
  note: "便签",
  text: "文字",
  doc: "文档",
  file: "资料",
};

function collectLinks(store: PromptStore, taskId: number) {
  /** 连线两端各自指向哪个任务：from 是上级/前置/产出方，to 是下级/后续 */
  const atFrom = (e: BoardEdge) => store.allTasks.find((t) => t.id === e.from_id);
  const atTo = (e: BoardEdge) => store.allTasks.find((t) => t.id === e.to_id);
  let parentRow: Neighbor | null = null;
  const children: Neighbor[] = [];
  const prev: Neighbor[] = [];
  const next: Neighbor[] = [];
  const outputs: string[] = [];
  const boardLinks: BoardLink[] = [];

  const asNeighbor = (t: Task): Neighbor => {
    const refs = store.refsOfTask(t.id);
    return {
      seq: store.numberOf(t.id),
      title: t.title,
      done: !!t.completed_at,
      desc: (t.description || "").trim(),
      points: refs.filter((r) => (r.point || "").trim()).length,
    };
  };

  for (const e of store.edges) {
    const kind = e.kind || "decompose";
    // 所属任务：别人 → 我（父子，本任务是它的一部分）
    if (kind === "decompose" && e.to_kind === "task" && e.to_id === taskId && e.from_kind === "task") {
      const t = atFrom(e);
      if (t) parentRow = asNeighbor(t);
    }
    // 下级任务：我 → 别人（父子，本任务拆出的子项）
    if (kind === "decompose" && e.from_kind === "task" && e.from_id === taskId && e.to_kind === "task") {
      const t = atTo(e);
      if (t) children.push(asNeighbor(t));
    }
    // 前置任务：前置 → 我（必须等它完成）
    if (kind === "precede" && e.to_kind === "task" && e.to_id === taskId && e.from_kind === "task") {
      const t = atFrom(e);
      if (t) prev.push(asNeighbor(t));
    }
    // 后续任务：我 → 后续（它在等本任务）
    if (kind === "precede" && e.from_kind === "task" && e.from_id === taskId && e.to_kind === "task") {
      const t = atTo(e);
      if (t) next.push(asNeighbor(t));
    }
    // 产出：我 → 文档 / 资料节点
    if (kind === "produce" && e.from_kind === "task" && e.from_id === taskId && e.to_kind === "note") {
      const n = store.notes.find((x) => x.id === e.to_id);
      if (n) {
        const f = n.file_id ? store.assets.find((a) => a.id === n.file_id) : null;
        outputs.push((n.text || f?.name || "产出").trim());
      }
    }
    // 白板节点 → 我：思维导图、便签、文字等，都是本任务要用到的参数。
    // file 节点跳过 —— 那些是资料，已经在「参考材料」里，不重复列。
    if (e.to_kind === "task" && e.to_id === taskId && e.from_kind === "note") {
      const n = store.notes.find((x) => x.id === e.from_id);
      if (n && n.kind !== "box" && n.kind !== "gantt" && n.kind !== "file") {
        const f = n.file_id ? store.assets.find((a) => a.id === n.file_id) : null;
        boardLinks.push({
          kind: n.kind,
          label: (n.text || f?.name || "").trim().slice(0, 40),
          text: (n.text || "").trim(),
        });
      }
    }
    // 我 → 白板节点（除产出外的连线，例如连到一张便签上补充说明）
    if (
      e.from_kind === "task" &&
      e.from_id === taskId &&
      e.to_kind === "note" &&
      kind !== "produce"
    ) {
      const n = store.notes.find((x) => x.id === e.to_id);
      if (n && n.kind !== "box" && n.kind !== "gantt" && n.kind !== "file") {
        boardLinks.push({
          kind: n.kind,
          label: (n.text || "").trim().slice(0, 40),
          text: (n.text || "").trim(),
        });
      }
    }
  }
  return { parent: parentRow, children, prev, next, outputs, boardLinks };
}

/* ---------------- 组装 ---------------- */

function dueLine(t: Task): string {
  if (!t.due_date) return "";
  const d = new Date(t.due_date + "T23:59:59");
  const days = Math.ceil((d.getTime() - Date.now()) / 86400000);
  if (Number.isNaN(days)) return `交付截止 ${t.due_date.slice(0, 10)}`;
  if (days < 0) return `交付截止 ${t.due_date.slice(0, 10)}（已逾期 ${-days} 天）`;
  if (days === 0) return `交付截止 ${t.due_date.slice(0, 10)}（今日）`;
  return `交付截止 ${t.due_date.slice(0, 10)}（剩余 ${days} 天）`;
}

/** 各交付格式对应的输出要求，写的是「产出物长什么样」，不是工具操作说明 */
const DELIVER_RULES: Record<string, string[]> = {
  word: [
    "输出完整可用的 Word 文档正文，不要输出提纲、占位符或待补充标记",
    "使用规范的标题层级（一级标题、二级标题），不要用 Markdown 井号",
  ],
  pdf: [
    "输出可直接打印成 PDF 的完整正文，不要输出提纲或占位符",
    "版面按 A4 纵向考虑，标题层级清晰，段落长度适中",
  ],
  ppt: [
    "按演示文稿的组织方式输出：每页一个明确的标题，配 3 至 5 条要点",
    "每页要点要能独立成句，不要出现「详见上文」这类指代",
  ],
  md: [
    "输出结构化的 Markdown 文本，使用标题层级组织内容",
    "不要输出 HTML 标签",
  ],
  html: [
    "输出单个自包含的 HTML 文件，样式内嵌，不依赖外部资源",
    "正文语义化排版（标题、列表、表格各归其位），不要用空白字符对齐",
  ],
  sheet: [
    "输出表格：列名明确、一行一条记录，不要合并单元格",
    "用 Markdown 表格给出，若列数超过 6 列则拆成多张表",
  ],
};

const DELIVER_NAME: Record<string, string> = {
  word: "Word 文档",
  pdf: "PDF 文档",
  ppt: "PPT 演示文稿",
  md: "Markdown 文本",
  html: "HTML 网页",
  sheet: "表格",
};

export function buildTaskPrompt(store: PromptStore, taskId: number): string {
  const t = store.allTasks.find((x) => x.id === taskId);
  if (!t) return "";

  const seq = store.numberOf(taskId);
  const out: string[] = [];
  const gaps: string[] = [];

  /* 标题与任务标识 */
  out.push(`【任务 T${seq} · ${t.title}】`);
  out.push(`项目：${store.currentProject?.name ?? "未命名项目"}`);
  const metaBits: string[] = [];
  const col = store.columns.find((c) => c.id === t.column_id);
  if (col) metaBits.push(`所属阶段 ${col.name}`);
  const due = dueLine(t);
  if (due) metaBits.push(due);
  if (t.completed_at) metaBits.push("状态 已完成");
  if (metaBits.length) out.push(metaBits.join("　｜　"));
  out.push("");

  /* 一、任务要求 */
  out.push("一、任务要求");
  const desc = (t.description || "").trim();
  if (desc) out.push(desc);
  else {
    out.push("（本任务尚未填写任务说明。）");
    gaps.push("任务说明为空，只能依据标题推断工作内容");
  }
  out.push("");

  /* 二、参考材料 */
  const refs = collectRefs(store, taskId);
  out.push("二、参考材料");
  if (!refs.length) {
    out.push("（本任务尚未关联任何资料。）");
    gaps.push("未关联任何资料，缺少工作依据");
  } else {
    out.push(
      `下列 ${refs.length} 份资料随本指令一并提供，请直接查阅原文件。` +
        `以下条目说明各份资料的约束层级与关注重点，不替代文件内容。`
    );
    out.push("当资料之间、或资料与本指令发生冲突时，按约束层级高者执行。");
    const TITLES = [
      "【强制约束】不得违反；与本指令冲突时以资料为准",
      "【参考依据】可用于补充完善，不构成强制要求",
      "【背景资料】仅供理解语境，不得作为论据引用",
    ];
    for (const lv of [0, 1, 2]) {
      const list = refs.filter((r) => r.level === lv);
      if (!list.length) continue;
      out.push("");
      out.push(`${TITLES[lv]}　${list.length} 份`);
      list.forEach((r, i) => out.push(`${i + 1}. ${refLine(r)}`));
    }
    // 分区标注与任务定级不一致时点明，避免 AI 面对两个来源无所适从
    const mismatch = refs.find(
      (r) =>
        r.cluster &&
        ((r.cluster.key === "strong" && r.level !== 0) ||
          (r.cluster.key === "weak" && r.level !== 2))
    );
    if (mismatch && mismatch.cluster) {
      out.push("");
      out.push(
        `说明：上述某份资料在白板分区中标为「${CLUSTER_LABEL[mismatch.cluster.key]}」，` +
          `而在本任务中定级为「${LEVEL_TITLE[mismatch.level]?.split("（")[0]}」。以本任务的定级为准。`
      );
    }
    // 未标注关注重点 = AI 拿到文件却不知道往哪儿看
    const noPoint = refs.filter((r) => !r.point);
    if (noPoint.length) {
      gaps.push(
        `${noPoint.length} 份资料未标注关注重点（${noPoint.map((r) => r.label).join("、")}）；` +
          `文件虽可查阅，但篇幅较长，未标注易导致抓取错位`
      );
    }
  }
  out.push("");

  /* 三、任务关系 */
  const links = collectLinks(store, taskId);
  const posLines: string[] = [];
  if (links.parent) {
    posLines.push(`- 所属任务：T${links.parent.seq} ${links.parent.title}`);
    posLines.push("  （本任务是它的一部分，完成后作为它的组成部分交付）");
  }
  for (const p of links.prev) {
    posLines.push(
      `- 前置任务：T${p.seq} ${p.title}` +
        (p.done ? "（已完成，其结论可直接采用）" : "（进行中，其结论可能变动）")
    );
  }
  for (const p of links.next) {
    posLines.push(`- 后续任务：T${p.seq} ${p.title}（待本任务完成后启动）`);
  }
  for (const c of links.children) {
    const extra = c.desc ? `：${c.desc.split("\n")[0].slice(0, 60)}` : "";
    const pts = c.points ? `（已标注 ${c.points} 项关注重点）` : "";
    posLines.push(`- 下级任务：T${c.seq} ${c.title}${extra}${pts}`);
  }
  if (posLines.length) {
    out.push("三、任务关系");
    out.push(...posLines);
    out.push("");
  }

  /* 四、白板关联内容：思维导图、便签、文字节点，都是本任务要用到的参数 */
  const boards = links.boardLinks.filter((b) => b.text);
  if (boards.length) {
    out.push("四、白板关联内容");
    out.push("本任务在白板上关联的节点如下，均为工作输入的一部分：");
    for (const b of boards) {
      const name = BOARD_KIND_NAME[b.kind] || "节点";
      const title = b.label && b.label !== b.text ? `${name}「${b.label}」` : name;
      const oneLine = b.text.replace(/\s*\n\s*/g, " / ").slice(0, 400);
      out.push(`- ${title}：${oneLine}`);
    }
    out.push("");
  }

  /* 五、交付物 */
  const fmt = (t.deliver_fmt || "").trim().toLowerCase();
  const fmtName = DELIVER_NAME[fmt] || "";
  out.push("五、交付物");
  if (links.outputs.length) {
    for (const o of links.outputs) out.push(`- ${o}`);
  } else {
    out.push("- 按「一、任务要求」所述内容交付，并在开头说明本次交付的具体成果");
  }
  if (fmtName) out.push(`- 交付格式：${fmtName}`);
  out.push("");

  /* 六、输出要求 */
  out.push("六、输出要求");
  let n = 1;
  out.push(`${n++}. 结论先行：直接给出交付内容，不复述任务背景，结尾不询问是否继续`);
  if (refs.some((r) => r.level === 0)) {
    out.push(`${n++}. 「强制约束」不得违反；与本指令存在冲突时，以资料为准并明确指出`);
  }
  if (refs.some((r) => r.level === 2)) {
    out.push(`${n++}. 「背景资料」仅供理解语境，不得作为论据引用`);
  }
  if (refs.length >= 2) {
    out.push(`${n++}. 资料之间表述不一致时，先说明冲突所在，不得自行取舍`);
  }
  out.push(`${n++}. 引用资料内容时注明出处`);
  if (refs.some((r) => r.point)) {
    out.push(`${n++}. 「关注重点」仅用于定位，以原文为准；标注与原文不符时请指出`);
  }
  for (const r of DELIVER_RULES[fmt] || []) out.push(`${n++}. ${r}`);
  out.push("");

  /* 六、信息缺口 */
  if (!fmtName) gaps.push("未指定交付格式");
  if (gaps.length) {
    out.push("七、信息缺口");
    out.push("以下内容尚未确定，可能影响交付质量：");
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
