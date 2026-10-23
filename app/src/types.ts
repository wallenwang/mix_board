export interface Project {
  id: number;
  name: string;
  color: string;
  icon: string;
  sort_order: number;
}

export interface Column {
  id: number;
  project_id: number;
  name: string;
  color: string;
  wip_limit: number | null;
  sort_order: number;
  collapsed: boolean;
}

export interface Tag {
  id: number;
  project_id: number;
  name: string;
  color: string;
}

export interface Task {
  id: number;
  project_id: number;
  column_id: number;
  title: string;
  description: string;
  priority: number;
  due_date: string | null;
  /** 计划开始日期（甘特图左端），可空 = 从今天算起 */
  start_date: string | null;
  /** 手动进度 0~100；为空时按「开始→截止」的时间流逝推算 */
  progress: number | null;
  /** 甘特条手动配色（null = 按截止日期紧迫度自动配色） */
  bar_color: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  tags: number[];
  /** whiteboard position (null = not placed yet, auto-layout is used) */
  wx: number | null;
  wy: number | null;
  /** 项目内编号（T1、T2…）。删除后不回收，0 表示尚未编号 */
  seq: number;
  /** 交付格式（word/pdf/ppt/md/html），空 = 未指定。只影响给 AI 的指令怎么写输出要求 */
  deliver_fmt: string;
}

/** 白板节点类型：便签 / 文本 / 思维导图 / 上传资料 / 分组框 / 甘特图 / 文档 */
export type NodeKind = "note" | "text" | "mind" | "file" | "box" | "gantt" | "doc";

export interface BoardNote {
  id: number;
  project_id: number;
  x: number;
  y: number;
  text: string;
  color: string;
  kind: NodeKind;
  w: number | null;
  h: number | null;
  file_id: number | null;
  /** JSON 字符串：字号 / 对齐 / 形状等细粒度样式 */
  meta: string;
  /** 分区的用途：goal/input/constraint/work/output/defer，空 = 未标注 */
  role: string;
  /** 特殊分组：candidates 候选组 / versions 版本组，空 = 普通分组 */
  group_kind: string;
}

/** 连线的关系类型。默认分解，老数据全是这个，升级后观感不变 */
export type EdgeKind = "decompose" | "precede" | "evidence" | "produce";

/** 依据的三档。等级挂在关系上，同一份资料对不同任务可以不同档 */
export type RefLevel = 0 | 1 | 2;

export interface BoardEdge {
  id: number;
  project_id: number;
  from_kind: "task" | "note";
  from_id: number;
  to_kind: "task" | "note";
  to_id: number;
  kind: EdgeKind;
  /** 只对依据类有意义：0 必须遵守 / 1 可以参考 / 2 仅作背景 */
  strength: number;
}

/** 任务用到的一份资料，以及它对这个任务的等级 */
export interface TaskRef {
  id: number;
  task_id: number;
  note_id: number;
  level: RefLevel;
  ord: number;
  /**
   * 这条依据对「这个任务」的重点，一句话：哪几页关键、什么不能违背、
   * 冲突时听谁的。
   *
   * 文件本身是随指令一并传给 AI 的（多模态模型能直接读 PDF / 图片），
   * 这句是导航和约束，不是内容替身。同一份资料对不同任务可以摘不同的话。
   */
  point: string;
}

/** 白板上传的资料（文件实体在应用数据目录 assets/ 下） */
export interface WbFile {
  id: number;
  project_id: number;
  name: string;
  ext: string;
  mime: string;
  size: number;
  path: string;
  created_at: string;
}

/** 写作模块的文档：body 直接就是 Markdown 源文 */
export interface Doc {
  id: number;
  project_id: number;
  title: string;
  body: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

/** 便签 / 节点的来源标记（从哪份资料引出的一句话） */
export interface NodeSource {
  file_id: number;
  name: string;
  /** 可选的页码 / 位置说明 */
  loc?: string;
  /** 引用的原文片段 */
  quote?: string;
}

export function parseSource(meta: string): NodeSource | null {
  if (!meta) return null;
  try {
    const o = JSON.parse(meta);
    const s = o?.src;
    if (s && typeof s.file_id === "number") return s as NodeSource;
  } catch {
    /* meta 不是 JSON 就当没有来源 */
  }
  return null;
}

/**
 * 文档节点（kind = "doc"）指向写作模块里的哪一份 Markdown。
 * 存在 meta 里（和 src 同一个 JSON 对象），所以不用改数据库表结构。
 *   meta = {"doc":{"doc_id":7,"title":"品牌手册"}}
 */
export interface DocRef {
  doc_id: number;
  title: string;
}

export function parseDocRef(meta: string): DocRef | null {
  if (!meta) return null;
  try {
    const o = JSON.parse(meta);
    const d = o?.doc;
    if (d && typeof d.doc_id === "number") {
      return { doc_id: d.doc_id, title: String(d.title ?? "") };
    }
  } catch {
    /* 不是 JSON 就当没关联 */
  }
  return null;
}

/** 往 meta 里塞 doc 关联（保留已有的 src 等字段） */
export function withDocRef(meta: string, ref: DocRef | null): string {
  let o: Record<string, unknown> = {};
  if (meta) {
    try {
      const parsed = JSON.parse(meta);
      if (parsed && typeof parsed === "object") o = parsed as Record<string, unknown>;
    } catch {
      o = {};
    }
  }
  if (ref) o.doc = { doc_id: ref.doc_id, title: ref.title };
  else delete o.doc;
  return JSON.stringify(o);
}

export interface TrashItem {
  id: number;
  title: string;
  column_name: string | null;
  project_name: string | null;
  deleted_at: string | null;
}

export const PRIORITIES = [
  { value: 0, label: "紧急", color: "#F56C6C" },
  { value: 1, label: "高", color: "#E6A23C" },
  { value: 2, label: "中", color: "#409EFF" },
  { value: 3, label: "低", color: "#909399" },
] as const;

export function priorityOf(v: number) {
  return PRIORITIES.find((p) => p.value === v) ?? PRIORITIES[2];
}

export const TAG_COLORS = [
  "#409EFF", "#67C23A", "#E6A23C", "#F56C6C", "#909399",
  "#9254de", "#13c2c2", "#eb2f96", "#7cb305", "#fa8c16",
];

// ---------- 白板辅助 ----------

export const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico"];
export const PDF_EXTS = ["pdf"];

export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

export function isImageFile(f: Pick<WbFile, "ext" | "mime"> | null | undefined): boolean {
  if (!f) return false;
  if (IMAGE_EXTS.includes((f.ext || "").toLowerCase())) return true;
  return (f.mime || "").startsWith("image/");
}

export function formatBytes(n: number): string {
  if (!n || n < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function fileIcon(ext: string): string {
  const e = (ext || "").toLowerCase();
  if (IMAGE_EXTS.includes(e)) return "🖼️";
  if (["pdf"].includes(e)) return "📕";
  if (["doc", "docx"].includes(e)) return "📄";
  if (["xls", "xlsx", "csv"].includes(e)) return "📊";
  if (["ppt", "pptx"].includes(e)) return "📽️";
  if (["zip", "rar", "7z"].includes(e)) return "🗜️";
  if (["mp4", "mov", "avi", "mkv"].includes(e)) return "🎬";
  if (["mp3", "wav", "m4a"].includes(e)) return "🎵";
  if (["txt", "md", "log"].includes(e)) return "📝";
  return "📎";
}
