/**
 * 预置项目：山茶间 · 品牌视觉体系
 *
 * 为什么预置一个完整项目：一个空的看板说明不了任何问题。
 * 这个项目把「策略 → 设计 → 延展 → 交付」四段拆开，资料按三档分组，
 * 同一份资料被多个任务引用、关注重点各不相同，正好用来检验
 * 「给 AI 的指令」能不能把关系说清楚。
 *
 * 数据只在浏览器预览模式（mock）下注入；桌面版走真实数据库。
 */
import type { BoardEdge, BoardNote, Column, Doc, Project, Task, TaskRef, WbFile } from "./types";

export const DEMO_PROJECT_NAME = "山茶间 · 品牌视觉体系";

const P = 2; // 项目 id
const T = (n: number) => 1000 + n; // 任务 id
const N = (n: number) => 2000 + n; // 节点 id
const E = (n: number) => 3000 + n; // 连线 id
const R = (n: number) => 4000 + n; // 依据 id
const F = (n: number) => 5000 + n; // 资料 id
const D = (n: number) => 6000 + n; // 文档 id

/** 计数器要大于上面所有 id，否则新建的东西会覆盖预置数据 */
export const SEED_COUNTERS = {
  pid: 100,
  cid: 100,
  tid: 1200,
  gid: 1000,
  nid: 2200,
  eid: 3200,
  did: 6100,
  rid: 4100,
};

export const seedProject: Project = {
  id: P,
  name: DEMO_PROJECT_NAME,
  color: "#2F4F3A",
  icon: "山",
  sort_order: 2000,
};

export const seedColumns: Column[] = [
  { id: 101, project_id: P, name: "策略调研", color: "#8A9BA8", wip_limit: null, sort_order: 1000, collapsed: false },
  { id: 102, project_id: P, name: "视觉设计", color: "#3B7DDD", wip_limit: null, sort_order: 2000, collapsed: false },
  { id: 103, project_id: P, name: "应用延展", color: "#D9822B", wip_limit: null, sort_order: 3000, collapsed: false },
  { id: 104, project_id: P, name: "交付提案", color: "#2F9E6B", wip_limit: null, sort_order: 4000, collapsed: false },
  { id: 105, project_id: P, name: "已完成", color: "#98A2B6", wip_limit: null, sort_order: 5000, collapsed: false },
];

/**
 * 任务树：四段式，垂直最多四层（阶段 → 任务 → 子项）。
 * 每个任务都写说明 —— 空说明的任务交给 AI 只能靠标题猜。
 */
function t(
  id: number,
  column_id: number,
  title: string,
  description: string,
  seq: number,
  opt: Partial<Task> = {}
): Task {
  return {
    id: T(id),
    project_id: P,
    column_id,
    title,
    description,
    priority: 2,
    due_date: null,
    start_date: null,
    progress: null,
    bar_color: null,
    sort_order: id * 10,
    created_at: "2026-10-20 09:00",
    updated_at: "2026-10-23 09:00",
    completed_at: null,
    tags: [],
    wx: 520 + Math.floor(id / 10) * 260,
    wy: 90 + (id % 10) * 130,
    seq,
    deliver_fmt: "",
    ...opt,
  };
}

export const seedTasks: Task[] = [
  // ---------- T1 策略调研 ----------
  t(1, 101, "品牌调研", "摸清市场格局与目标客群，为视觉决策提供依据。\n本阶段产出一份调性说明，是后续所有设计工作的前提。", 1, {
    start_date: "2026-10-23", due_date: "2026-10-30", progress: 55,
    wx: 520, wy: 90,
  }),
  t(11, 101, "竞品分析", "拆解三家头部茶饮品牌的视觉体系：标志构造、色彩体系、包装版式。\n输出对照表，标出可差异化的机会点。", 0, {
    start_date: "2026-10-23", due_date: "2026-10-26", progress: 100,
    completed_at: "2026-10-26 17:30", wx: 800, wy: 60,
  }),
  t(12, 101, "用户访谈", "访谈 8 位目标客群（25-40 岁、注重生活品质），记录审美偏好与饮茶场景。\n重点问「视觉上什么让你觉得廉价」。", 0, {
    start_date: "2026-10-24", due_date: "2026-10-28", progress: 60,
    wx: 800, wy: 195,
  }),
  t(13, 101, "调性提炼", "从调研结论中提炼 5 个品牌关键词，每个词配一句解释和一条设计约束。\n产出物是后面所有设计判断的准绳。", 0, {
    start_date: "2026-10-28", due_date: "2026-10-30",
    wx: 800, wy: 330,
  }),

  // ---------- T2 视觉设计 ----------
  t(2, 102, "视觉设计", "建立品牌的核心视觉元素：标志、色彩、字体、版式。\n四者相互制约，顺序不能打乱。", 2, {
    start_date: "2026-10-30", due_date: "2026-11-13",
    wx: 520, wy: 470,
  }),
  t(21, 102, "标志设计", "从草图到标准化制图，最终交付可用于印刷的矢量标志。", 0, {
    start_date: "2026-10-30", due_date: "2026-11-04",
    wx: 800, wy: 440,
  }),
  t(211, 102, "草图方案", "手绘 20 个方向，收敛到 3 个可深化的方案。\n评图标准：辨识度、可缩放性、与调性的一致性。", 0, {
    start_date: "2026-10-30", due_date: "2026-11-01",
    wx: 1080, wy: 415,
  }),
  t(212, 102, "方案细化", "选定方向后做标准化制图：网格、安全空间、最小尺寸、单色反白版本。", 0, {
    start_date: "2026-11-01", due_date: "2026-11-04",
    wx: 1080, wy: 545,
  }),
  t(22, 102, "色彩体系", "确定主色、辅助色及其使用比例，输出色卡表。\n色彩是这套体系里最硬的约束，定错了下游全错。", 0, {
    start_date: "2026-11-04", due_date: "2026-11-08", deliver_fmt: "sheet",
    wx: 800, wy: 645,
  }),
  t(221, 102, "主色确定", "确定品牌主色及其 5 级明度阶梯，标注各场景用途。\n必须与调性说明一致。", 0, {
    start_date: "2026-11-04", due_date: "2026-11-06",
    wx: 1080, wy: 630,
  }),
  t(222, 102, "辅助色板", "确定 12 色辅助色板及使用面积比例（主色 60% / 辅色 30% / 点缀 10%）。", 0, {
    start_date: "2026-11-06", due_date: "2026-11-08",
    wx: 1080, wy: 760,
  }),
  t(23, 102, "字体规范", "确定中英文字体、字重与字号层级（标题 / 正文 / 注释三档）。\n必须含商用授权说明，否则后面不敢用。", 0, {
    start_date: "2026-11-04", due_date: "2026-11-07",
    wx: 800, wy: 880,
  }),
  t(24, 102, "版式网格", "建立 12 栏网格系统与图文排版规则，含页边距、栏宽、行距。\n这是手册和包装共同的骨架。", 0, {
    start_date: "2026-11-08", due_date: "2026-11-13",
    wx: 800, wy: 1015,
  }),

  // ---------- T3 应用延展 ----------
  t(3, 103, "应用延展", "把视觉体系落到具体物料上，验证它的可扩展性。", 3, {
    start_date: "2026-11-13", due_date: "2026-11-24",
    wx: 520, wy: 1160,
  }),
  t(31, 103, "名片信封", "办公事务用品：名片（双面）、信封、信纸。\n尺寸按国标，出血 3mm。", 0, {
    start_date: "2026-11-13", due_date: "2026-11-17",
    wx: 800, wy: 1135,
  }),
  t(32, 103, "包装设计", "三款主打产品的包装结构与图形。\n结构上要能单手开合（用户访谈里的明确诉求）。", 0, {
    start_date: "2026-11-15", due_date: "2026-11-21",
    wx: 800, wy: 1265,
  }),
  t(33, 103, "展厅导视", "展厅的标识系统：入口形象墙、区域指示、产品标签。", 0, {
    start_date: "2026-11-19", due_date: "2026-11-24",
    wx: 800, wy: 1395,
  }),

  // ---------- T4 交付提案 ----------
  t(4, 104, "交付提案", "整理成果，向客户交付并提案。", 4, {
    start_date: "2026-11-24", due_date: "2026-11-28",
    wx: 520, wy: 1530,
  }),
  t(41, 104, "品牌手册", "编制完整品牌手册：标志规范、色彩体系、字体规范、版式规则、应用范例。\n交付 Word 文档，便于客户后续编辑。", 0, {
    start_date: "2026-11-24", due_date: "2026-11-27", deliver_fmt: "word",
    wx: 800, wy: 1505,
  }),
  t(42, 104, "提案汇报", "制作提案演示文稿：设计逻辑、方案展示、落地建议。\n交付 PPT，现场汇报 20 分钟。", 0, {
    start_date: "2026-11-26", due_date: "2026-11-28", deliver_fmt: "ppt",
    wx: 800, wy: 1635,
  }),
];

/* ------------------------------------------------------------------
 * 资料：三档分组，同一份资料被多个任务引用时关注重点各不相同
 * ------------------------------------------------------------------ */

function box(id: number, text: string, color: string, cluster: string, x: number, y: number, h: number): BoardNote {
  return {
    id: N(id), project_id: P, x, y, text, color, kind: "box",
    w: 360, h, file_id: null,
    meta: JSON.stringify({ cluster }), role: "", group_kind: "",
  };
}
function fileNode(id: number, text: string, file_id: number, x: number, y: number): BoardNote {
  return {
    id: N(id), project_id: P, x, y, text, color: "#FFFFFF", kind: "file",
    w: 300, h: 78, file_id,
    meta: "", role: "", group_kind: "",
  };
}
function noteNode(id: number, text: string, color: string, kind: string, x: number, y: number, w = 260, h = 88): BoardNote {
  return {
    id: N(id), project_id: P, x, y, text, color, kind: kind as BoardNote["kind"],
    w, h, file_id: null,
    meta: "", role: "", group_kind: "",
  };
}

export const seedNotes: BoardNote[] = [
  // 三个分组框：强依据 / 参考 / 弱参考
  box(11, "硬性依据", "#D9822B", "strong", 60, 90, 250),
  box(12, "可参考的", "#3B7DDD", "ref", 60, 380, 250),
  box(13, "看看就好", "#98A2B6", "weak", 60, 670, 170),

  // 资料节点（挂在框内）
  fileNode(1, "品牌手册 v3", F(1), 90, 145),
  fileNode(2, "竞品调研", F(2), 90, 240),
  fileNode(3, "釉色参考", F(3), 90, 435),
  fileNode(4, "日式杂志版式", F(5), 90, 530),
  fileNode(5, "茶室摄影集", F(4), 90, 725),

  // 白板上的思路节点。⚠️ 分清「谁的产出」和「谁的依据」——
  // 同一个便签可以既是谁的产出、又是谁的依据，方向不能连反。
  // 品牌关键词 = 调性提炼的产出，不是它的输入
  noteNode(21, "东方克制 / 留白 / 釉色 / 低饱和 / 人文", "#E7E2F3", "mind", 60, 900, 300, 96),
  // 两张便签是用户访谈的结论（产出），同时约束后面的设计（依据）
  noteNode(22, "不要用金色，太俗", "#F4E3C3", "note", 60, 1030, 240, 80),
  noteNode(23, "包装要能单手开合", "#F4E3C3", "note", 60, 1145, 240, 80),
  // 这条是外部约束（客户要求），不是谁的产出
  noteNode(24, "版式参考日式杂志，12 栏网格", "#E7E2F3", "text", 60, 1260, 300, 72),

  // 产出节点
  noteNode(31, "调性说明", "#DCEFE4", "doc", 1340, 330, 220, 78),
  noteNode(32, "版式规范", "#DCEFE4", "doc", 1340, 1015, 220, 78),
  noteNode(33, "品牌手册（成稿）", "#DCEFE4", "doc", 1340, 1505, 220, 78),
];

export const seedAssets: WbFile[] = [
  { id: F(1), project_id: P, name: "品牌手册 v3.pdf", ext: "pdf", mime: "application/pdf", size: 8650752, path: "附件/品牌手册-v3.pdf", created_at: "2026-10-20" },
  { id: F(2), project_id: P, name: "竞品调研.xlsx", ext: "xlsx", mime: "application/vnd.ms-excel", size: 246784, path: "附件/竞品调研.xlsx", created_at: "2026-10-21" },
  { id: F(3), project_id: P, name: "釉色参考.png", ext: "png", mime: "image/png", size: 1258291, path: "附件/釉色参考.png", created_at: "2026-10-21" },
  { id: F(4), project_id: P, name: "茶室摄影集.pdf", ext: "pdf", mime: "application/pdf", size: 12582912, path: "附件/茶室摄影集.pdf", created_at: "2026-10-21" },
  { id: F(5), project_id: P, name: "日式杂志版式.pdf", ext: "pdf", mime: "application/pdf", size: 4718592, path: "附件/日式杂志版式.pdf", created_at: "2026-10-22" },
];

/* ------------------------------------------------------------------
 * 连线：父子 / 先后 / 依据 / 产出，四类各司其职
 * ------------------------------------------------------------------ */

function edge(id: number, from: [string, number], to: [string, number], kind: BoardEdge["kind"]): BoardEdge {
  return {
    id: E(id), project_id: P,
    from_kind: from[0] as BoardEdge["from_kind"], from_id: from[1],
    to_kind: to[0] as BoardEdge["to_kind"], to_id: to[1],
    kind, strength: 0,
  };
}

export const seedEdges: BoardEdge[] = [
  // 父子：阶段拆任务、任务拆子项
  edge(1, ["task", T(1)], ["task", T(11)], "decompose"),
  edge(2, ["task", T(1)], ["task", T(12)], "decompose"),
  edge(3, ["task", T(1)], ["task", T(13)], "decompose"),
  edge(4, ["task", T(2)], ["task", T(21)], "decompose"),
  edge(5, ["task", T(2)], ["task", T(22)], "decompose"),
  edge(6, ["task", T(2)], ["task", T(23)], "decompose"),
  edge(7, ["task", T(2)], ["task", T(24)], "decompose"),
  edge(8, ["task", T(21)], ["task", T(211)], "decompose"),
  edge(9, ["task", T(21)], ["task", T(212)], "decompose"),
  edge(10, ["task", T(22)], ["task", T(221)], "decompose"),
  edge(11, ["task", T(22)], ["task", T(222)], "decompose"),
  edge(12, ["task", T(3)], ["task", T(31)], "decompose"),
  edge(13, ["task", T(3)], ["task", T(32)], "decompose"),
  edge(14, ["task", T(3)], ["task", T(33)], "decompose"),
  edge(15, ["task", T(4)], ["task", T(41)], "decompose"),
  edge(16, ["task", T(4)], ["task", T(42)], "decompose"),

  // 先后：阶段间 + 关键依赖
  edge(17, ["task", T(1)], ["task", T(2)], "precede"),
  edge(18, ["task", T(2)], ["task", T(3)], "precede"),
  edge(19, ["task", T(3)], ["task", T(4)], "precede"),
  edge(20, ["task", T(21)], ["task", T(22)], "precede"),
  edge(21, ["task", T(22)], ["task", T(24)], "precede"),
  edge(22, ["task", T(23)], ["task", T(24)], "precede"),
  // 调性提炼要等竞品分析与用户访谈出结论
  edge(39, ["task", T(11)], ["task", T(13)], "precede"),
  edge(40, ["task", T(12)], ["task", T(13)], "precede"),

  // 依据：资料 / 结论 → 任务（谁用它）
  edge(23, ["note", N(1)], ["task", T(22)], "evidence"),   // 品牌手册 → 色彩
  edge(24, ["note", N(1)], ["task", T(23)], "evidence"),   // 品牌手册 → 字体
  edge(25, ["note", N(1)], ["task", T(212)], "evidence"),  // 品牌手册 → 标志细化
  edge(26, ["note", N(2)], ["task", T(11)], "evidence"),   // 竞品调研 → 竞品分析
  edge(27, ["note", N(3)], ["task", T(221)], "evidence"),  // 釉色参考 → 主色
  edge(28, ["note", N(4)], ["task", T(24)], "evidence"),   // 日式版式 → 版式网格
  edge(29, ["note", N(5)], ["task", T(12)], "evidence"),   // 茶室摄影 → 用户访谈
  edge(31, ["note", N(22)], ["task", T(22)], "evidence"),  // 访谈结论 → 色彩
  edge(32, ["note", N(23)], ["task", T(32)], "evidence"),  // 访谈结论 → 包装
  edge(33, ["note", N(24)], ["task", T(24)], "evidence"),  // 客户要求 → 版式网格

  // 产出：任务 → 它交出来的东西。
  // ⚠️ 思维导图「品牌关键词」是调性提炼的产出，不是它的输入；
  // 两张便签是用户访谈的结论 —— 产出一次、被后面的任务引用多次。
  edge(30, ["task", T(13)], ["note", N(21)], "produce"),   // 调性提炼 → 品牌关键词
  edge(34, ["task", T(13)], ["note", N(31)], "produce"),   // 调性提炼 → 调性说明
  edge(35, ["task", T(12)], ["note", N(22)], "produce"),   // 用户访谈 → 不要金色
  edge(36, ["task", T(12)], ["note", N(23)], "produce"),   // 用户访谈 → 单手开合
  edge(37, ["task", T(24)], ["note", N(32)], "produce"),   // 版式网格 → 版式规范
  edge(38, ["task", T(41)], ["note", N(33)], "produce"),   // 品牌手册 → 手册成稿
];

/* ------------------------------------------------------------------
 * 依据关系：等级和关注重点都挂在关系上
 * 同一份资料对不同任务可以是不同档、写不同的话
 * ------------------------------------------------------------------ */

function ref(id: number, task: number, note: number, level: number, ord: number, point = ""): TaskRef {
  return { id: R(id), task_id: T(task), note_id: N(note), level, ord, point };
}

export const seedTaskRefs: TaskRef[] = [
  // 品牌手册 v3（硬材料）——对三个任务的要求完全不同
  ref(1, 221, 1, 0, 0, "第 12 页的颜色规范最关键：主色限墨绿系（#2F4F3A 一带），禁止高饱和红"),
  ref(2, 222, 1, 0, 1, "第 14 页的辅助色比例：主色 60% / 辅色 30% / 点缀 10%"),
  ref(3, 23, 1, 0, 0, "第 3 章字体规范要完整收录，含商用授权说明，缺授权信息的字体一律不得采用"),
  ref(4, 212, 1, 0, 1, "标志最小使用尺寸不小于 8mm；安全空间为标志高度的 1/2"),

  // 竞品调研
  ref(5, 11, 2, 0, 0, "重点看 Sheet 2 的三家竞品配色统计表，找出色彩空位"),

  // 釉色参考
  ref(6, 221, 3, 1, 0, "釉面质感、低饱和方向；只取质感，不取具体色值"),

  // 日式杂志版式
  ref(7, 24, 4, 1, 0, "12 栏网格、页边距不小于 18mm；图文比例参考该刊内页 32-45 页"),

  // 茶室摄影集 —— 只作背景
  ref(8, 12, 5, 2, 0, ""),

  // 思维导图与便签（白板内容走 evidence，不进 task_refs；这里留空说明两者分工）
];

export const seedDocs: Doc[] = [
  {
    id: D(1), project_id: P,
    title: "调性说明",
    body: "# 品牌调性说明\n\n## 五个关键词\n\n1. **东方克制** —— 不用繁复纹样，靠结构和留白说话\n2. **留白** —— 版面留出呼吸感，信息不堆满\n3. **釉色** —— 取陶瓷釉面的温润质感，不取高饱和\n4. **低饱和** —— 全系色彩饱和度控制在 30% 以内\n5. **人文** —— 文字带温度，避免工业感措辞\n\n## 设计约束\n\n- 禁止使用金色、亮红\n- 单页主色面积不低于 55%\n",
    sort_order: 1000, created_at: "2026-10-28", updated_at: "2026-10-28",
  },
  {
    id: D(2), project_id: P,
    title: "版式规范",
    body: "# 版式规范\n\n## 网格\n\n- 12 栏网格，栏宽 68px，栏距 20px\n- 页边距：外 18mm，内 22mm（预留装订）\n\n## 字号层级\n\n| 层级 | 字号 | 字重 |\n|---|---|---|\n| 主标题 | 28pt | Bold |\n| 副标题 | 18pt | Medium |\n| 正文 | 10.5pt | Regular |\n| 注释 | 8pt | Regular |\n",
    sort_order: 2000, created_at: "2026-11-13", updated_at: "2026-11-13",
  },
];
