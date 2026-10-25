/**
 * 预置项目：山茶间 · 品牌全案（v2）
 *
 * 为什么预置一个完整项目：一个空的看板说明不了任何问题。
 * 这一版专门用来检验「层级」这一层能力：
 *  - 任务树 5 层（T1 → T1.1 → T1.1.1 → …），一眼看得出分支是怎么拆下来的；
 *  - 整理布局按层级从左往右分列，资料（PDF / 图片 / 便签 / 文档）统一排到最右一列；
 *  - 同一份资料被多个任务引用，三档「硬依据 / 参考 / 看看就好」都挂出来。
 *
 * 位置**不是手写坐标**：先按父子关系跑一遍 layoutTree，再拼资料列。
 * 手写坐标一定会随着卡片内容变化而叠在一起，算出来才不会。
 *
 * 数据只在浏览器预览模式（mock）下注入；桌面版走真实数据库。
 */
import type { BoardEdge, BoardNote, Column, Doc, Project, Task, TaskRef, WbFile } from "./types";
import { layoutTree } from "./wb";

export const DEMO_PROJECT_NAME = "山茶间 · 品牌全案";

/** 老版本的预置项目名：加载时整份清掉，别让两个演示项目并排站着 */
export const LEGACY_DEMO_NAMES = ["山茶间 · 品牌视觉体系"];

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
  tid: 14000,
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
  { id: 101, project_id: P, name: "待办", color: "#8A9BA8", wip_limit: null, sort_order: 1000, collapsed: false },
  { id: 102, project_id: P, name: "进行中", color: "#3B7DDD", wip_limit: 3, sort_order: 2000, collapsed: false },
  { id: 103, project_id: P, name: "待评审", color: "#D9822B", wip_limit: null, sort_order: 3000, collapsed: false },
  { id: 104, project_id: P, name: "已完成", color: "#2F9E6B", wip_limit: null, sort_order: 4000, collapsed: false },
];

/* ------------------------------------------------------------------
 * 任务树：5 层封顶
 * ------------------------------------------------------------------ */

interface Spec {
  /** 任务号（T1 → 1，T1.1 → 11，T1.1.1 → 111；写成数字方便派生 id） */
  id: number;
  /** 上级任务号，null = 一级任务 */
  pid: number | null;
  col: number;
  title: string;
  desc: string;
  start: string;
  due: string;
  prio?: number;
  progress?: number;
  done?: string;
  fmt?: string;
}

const SPECS: Spec[] = [
  // ================= 一级：T1 品牌策略 =================
  {
    id: 1, pid: null, col: 102, title: "品牌策略", prio: 1,
    desc: "先把「卖给谁、凭什么买」说清楚。\n这一层只做判断，不做视觉；下面的分支都是它的证据链。",
    start: "2026-10-24", due: "2026-11-06", progress: 45,
  },
  {
    id: 11, pid: 1, col: 103, title: "市场研究", prio: 1,
    desc: "摸清同类品牌在做什么、客户真正在意什么。",
    start: "2026-10-24", due: "2026-10-31", progress: 80,
  },
  {
    id: 111, pid: 11, col: 104, title: "竞品拆解", prio: 2,
    desc: "挑 3 家直接竞品，拆标志、配色、包装三件事。",
    start: "2026-10-24", due: "2026-10-27", progress: 100, done: "2026-10-27 16:20",
  },
  {
    id: 1111, pid: 111, col: 104, title: "视觉对照表", prio: 2,
    desc: "把三家竞品的视觉要素并排放，标出还没被占住的空位。",
    start: "2026-10-25", due: "2026-10-27", progress: 100, done: "2026-10-27 15:40",
  },
  {
    id: 11111, pid: 1111, col: 104, title: "色彩抽样", prio: 3,
    desc: "每家抽 6 个主色值，统计饱和度分布，找低饱和那条线。",
    start: "2026-10-26", due: "2026-10-27", progress: 100, done: "2026-10-27 11:00", fmt: "sheet",
  },
  {
    id: 1112, pid: 111, col: 103, title: "机会点归纳", prio: 2,
    desc: "从对照表里拧出 3 条可差异化的机会点，逐条给依据。",
    start: "2026-10-27", due: "2026-10-30", progress: 60,
  },
  {
    id: 112, pid: 11, col: 103, title: "用户访谈", prio: 2,
    desc: "访谈 8 位目标客群，问「什么让你觉得廉价」。",
    start: "2026-10-25", due: "2026-10-30", progress: 50,
  },
  {
    id: 1121, pid: 112, col: 103, title: "访谈提纲", prio: 3,
    desc: "12 个问题，分消费场景、审美偏好、价格锚点三段。",
    start: "2026-10-25", due: "2026-10-26", progress: 90,
  },
  {
    id: 11211, pid: 1121, col: 103, title: "问题试访", prio: 3,
    desc: "先找 2 个人试问一遍，把听不懂的题改掉再正式约人。",
    start: "2026-10-26", due: "2026-10-27", progress: 40,
  },
  {
    id: 12, pid: 1, col: 102, title: "定位与调性", prio: 1,
    desc: "把研究结论收敛成一句定位 + 五个关键词。",
    start: "2026-10-31", due: "2026-11-06", progress: 30,
  },
  {
    id: 121, pid: 12, col: 102, title: "关键词提炼", prio: 1,
    desc: "每个关键词配一句解释和一条设计约束，否则执行时各理解各的。",
    start: "2026-11-01", due: "2026-11-04", progress: 55,
  },
  {
    id: 1211, pid: 121, col: 102, title: "关键词验证", prio: 2,
    desc: "拿关键词给 5 个客户方的人做盲选，看理解是否一致。",
    start: "2026-11-03", due: "2026-11-05", progress: 20,
  },
  {
    id: 12111, pid: 1211, col: 101, title: "焦点小组", prio: 3,
    desc: "组织一场 6 人小组，验证关键词是否被误读。",
    start: "2026-11-04", due: "2026-11-05", progress: 0,
  },

  // ================= 一级：T2 视觉系统 =================
  {
    id: 2, pid: null, col: 102, title: "视觉系统", prio: 1,
    desc: "标志、色彩、字体版式三件事互为约束，顺序不能打乱。",
    start: "2026-11-06", due: "2026-11-24", progress: 35,
  },
  {
    id: 21, pid: 2, col: 102, title: "标志设计", prio: 1,
    desc: "从草图到标准化制图，交付可用于印刷的矢量文件。",
    start: "2026-11-06", due: "2026-11-13", progress: 50,
  },
  {
    id: 211, pid: 21, col: 103, title: "草图方案", prio: 2,
    desc: "手绘 20 个方向，收敛到 3 个可深化的方案。",
    start: "2026-11-06", due: "2026-11-09", progress: 70,
  },
  {
    id: 212, pid: 21, col: 101, title: "标准化制图", prio: 2,
    desc: "网格、安全空间、最小尺寸、单色反白版本，一样不能少。",
    start: "2026-11-09", due: "2026-11-13", progress: 10,
  },
  {
    id: 22, pid: 2, col: 102, title: "色彩系统", prio: 1,
    desc: "主色、辅助色及使用比例，输出色卡表。",
    start: "2026-11-09", due: "2026-11-17", progress: 40,
  },
  {
    id: 221, pid: 22, col: 102, title: "主色阶梯", prio: 2,
    desc: "主色及其 5 级明度阶梯，标注各场景用途。",
    start: "2026-11-09", due: "2026-11-12", progress: 60, fmt: "pdf",
  },
  {
    id: 222, pid: 22, col: 101, title: "辅助色板", prio: 3,
    desc: "12 色辅助板 + 60/30/10 的面积比例。",
    start: "2026-11-12", due: "2026-11-17", progress: 0,
  },
  {
    id: 23, pid: 2, col: 102, title: "字体与版式", prio: 2,
    desc: "定字号层级和网格系统，手册和包装共用这一套骨架。",
    start: "2026-11-13", due: "2026-11-24", progress: 25,
  },
  {
    id: 231, pid: 23, col: 102, title: "字体选型", prio: 2,
    desc: "中英文字体、字重与字号层级，必须写清商用授权。",
    start: "2026-11-13", due: "2026-11-17", progress: 40,
  },
  {
    id: 232, pid: 23, col: 101, title: "网格规则", prio: 3,
    desc: "12 栏网格、页边距、行距，出一页带标注的规范样张。",
    start: "2026-11-17", due: "2026-11-24", progress: 0,
  },

  // ================= 一级：T3 应用延展 =================
  {
    id: 3, pid: null, col: 101, title: "应用延展", prio: 2,
    desc: "把视觉系统落到具体物料上，顺便验证它撑不撑得住。",
    start: "2026-11-24", due: "2026-12-05", progress: 0,
  },
  {
    id: 31, pid: 3, col: 101, title: "包装系统", prio: 2,
    desc: "三款主打产品的包装结构与平面，结构要能单手开合。",
    start: "2026-11-24", due: "2026-12-01", progress: 0,
  },
  {
    id: 311, pid: 31, col: 101, title: "结构打样", prio: 3,
    desc: "白样打两版，先验证开合手感再谈视觉。",
    start: "2026-11-24", due: "2026-11-27", progress: 0,
  },
  {
    id: 312, pid: 31, col: 101, title: "平面视觉", prio: 3,
    desc: "包装展开面的图形与文字排布，出血 3mm。",
    start: "2026-11-27", due: "2026-12-01", progress: 0,
  },
  {
    id: 32, pid: 3, col: 101, title: "空间导视", prio: 3,
    desc: "展厅入口形象墙、区域指示、产品标签。",
    start: "2026-12-01", due: "2026-12-05", progress: 0,
  },

  // ================= 一级：T4 交付提案 =================
  {
    id: 4, pid: null, col: 101, title: "交付提案", prio: 1,
    desc: "整理成果，向客户交付并现场提案。",
    start: "2026-12-05", due: "2026-12-12", progress: 0,
  },
  {
    id: 41, pid: 4, col: 101, title: "品牌手册", prio: 2,
    desc: "标志、色彩、字体、版式、应用范例，编成一本能长期用的手册。",
    start: "2026-12-05", due: "2026-12-09", progress: 0, fmt: "word",
  },
  {
    id: 42, pid: 4, col: 101, title: "提案汇报", prio: 2,
    desc: "20 分钟讲清设计逻辑、方案展示、落地建议。",
    start: "2026-12-09", due: "2026-12-12", progress: 0, fmt: "ppt",
  },
];

/** 布局常量：列间距比原来宽 —— 一眼能看出「这是下一层」，而不是同一列挤着 */
const GAP_X = 420;
const GAP_Y = 40;
/** 任务卡实际高度跟内容走（实测 107~150px）；预置数据按 130 估，
 *  比真实高度略大一点，既不叠，也不会把整棵树撑得老长 */
const CARD_H = 130;
const BASE_X = 120;
const BASE_Y = 130;

function buildTasks(): Task[] {
  // 子 → 父，跟白板的分解边同一个方向
  const treeEdges = SPECS.filter((s) => s.pid != null).map((s) => ({
    from: `task:${T(s.id)}`,
    to: `task:${T(s.pid as number)}`,
  }));
  const keys = SPECS.map((s) => `task:${T(s.id)}`);
  const pos = layoutTree(keys, treeEdges, GAP_X, GAP_Y, CARD_H, () => CARD_H);

  return SPECS.map((s, i) => {
    const p = pos.get(`task:${T(s.id)}`) ?? { x: 0, y: i * (CARD_H + GAP_Y) };
    return {
      id: T(s.id),
      project_id: P,
      column_id: s.col,
      title: s.title,
      description: s.desc,
      priority: s.prio ?? 2,
      due_date: s.due,
      start_date: s.start,
      progress: s.progress ?? null,
      bar_color: null,
      sort_order: s.id * 10,
      created_at: "2026-10-24 09:00",
      updated_at: "2026-10-30 18:00",
      completed_at: s.done ?? null,
      tags: [],
      wx: BASE_X + p.x,
      wy: BASE_Y + p.y,
      seq: i + 1,
      deliver_fmt: s.fmt ?? "",
    };
  });
}

export const seedTasks: Task[] = buildTasks();

/* ------------------------------------------------------------------
 * 资料列：所有非任务节点统一排在最右一列
 * （PDF / 图片 / 便签 / 文字 / 文档卡片，外加一个分组框）
 * ------------------------------------------------------------------ */

/** 最深一层任务的 x + 一个列间距 = 资料列的位置 */
const MAT_X = Math.max(...seedTasks.map((t) => t.wx)) + GAP_X;

function box(id: number, text: string, color: string, cluster: string, x: number, y: number, h: number): BoardNote {
  return {
    id: N(id), project_id: P, x, y, text, color, kind: "box",
    w: 340, h, file_id: null,
    meta: JSON.stringify({ cluster }), role: "", group_kind: "",
  };
}
function fileNode(id: number, text: string, file_id: number, x: number, y: number): BoardNote {
  return {
    id: N(id), project_id: P, x, y, text, color: "#FFFFFF", kind: "file",
    w: 268, h: 78, file_id,
    meta: "", role: "", group_kind: "",
  };
}
function noteNode(
  id: number, text: string, color: string, kind: BoardNote["kind"], x: number, y: number,
  w = 260, h = 92
): BoardNote {
  return {
    id: N(id), project_id: P, x, y, text, color, kind,
    w, h, file_id: null,
    meta: "", role: "", group_kind: "",
  };
}

/** 文档卡片：meta 里必须带 doc_id，否则双击它会提示「这篇文档已经被删除了」 */
function docNode(id: number, title: string, docId: number, x: number, y: number): BoardNote {
  return {
    id: N(id), project_id: P, x, y, text: title, color: "#DCEFE4", kind: "doc",
    w: 268, h: 120, file_id: null,
    meta: JSON.stringify({ doc: { doc_id: docId, title } }), role: "", group_kind: "",
  };
}

export const seedNotes: BoardNote[] = [
  // 分组框：把两份「硬依据」圈在一起（整理时框和里面的资料一起走）
  box(11, "硬性依据", "#D9822B", "strong", MAT_X, BASE_Y, 300),
  fileNode(1, "品牌手册 v3", F(1), MAT_X + 18, BASE_Y + 52),
  fileNode(2, "竞品调研", F(2), MAT_X + 18, BASE_Y + 148),

  // 其余资料顺着这一列往下排
  fileNode(3, "釉色参考", F(3), MAT_X, BASE_Y + 330),
  fileNode(4, "茶室摄影集", F(4), MAT_X, BASE_Y + 428),
  fileNode(5, "日式杂志版式", F(5), MAT_X, BASE_Y + 526),

  noteNode(21, "客户三条硬要求：不要金色、包装能单手开、11 月底必须出片", "#F4E3C3", "note", MAT_X, BASE_Y + 626, 268, 104),
  noteNode(22, "二次评审意见：标志再收一点，别像茶园 logo", "#F4E3C3", "note", MAT_X, BASE_Y + 748, 268, 96),
  noteNode(23, "版式参考：日式杂志 12 栏", "#E7E2F3", "text", MAT_X, BASE_Y + 862, 268, 56),

  // 文档卡片：点开就是右边文档栏里的那一篇
  docNode(31, "调性说明", D(1), MAT_X, BASE_Y + 936),
  docNode(32, "版式规范", D(2), MAT_X, BASE_Y + 1074),

  // 思维导图分支：浮在这里；只有连进树里的导图节点才会被整理布局重排
  noteNode(41, "品牌关键词", "#E7E2F3", "mind", MAT_X, BASE_Y + 1214, 268, 64),
  noteNode(42, "东方克制 / 留白 / 釉色 / 低饱和 / 人文", "#E7E2F3", "mind", MAT_X, BASE_Y + 1296, 268, 96),
];

export const seedAssets: WbFile[] = [
  { id: F(1), project_id: P, name: "品牌手册 v3.pdf", ext: "pdf", mime: "application/pdf", size: 8650752, path: "附件/品牌手册-v3.pdf", created_at: "2026-10-24" },
  { id: F(2), project_id: P, name: "竞品调研.csv", ext: "csv", mime: "text/csv", size: 2467, path: "附件/竞品调研.csv", created_at: "2026-10-25" },
  { id: F(3), project_id: P, name: "釉色参考.png", ext: "png", mime: "image/png", size: 1258291, path: "附件/釉色参考.png", created_at: "2026-10-26" },
  { id: F(4), project_id: P, name: "茶室摄影集.pdf", ext: "pdf", mime: "application/pdf", size: 12582912, path: "附件/茶室摄影集.pdf", created_at: "2026-10-26" },
  { id: F(5), project_id: P, name: "日式杂志版式.pdf", ext: "pdf", mime: "application/pdf", size: 4718592, path: "附件/日式杂志版式.pdf", created_at: "2026-10-27" },
];

/* ------------------------------------------------------------------
 * 连线：分解（子→父）/ 先后 / 依据 / 产出
 * ------------------------------------------------------------------ */

function edge(id: number, from: [string, number], to: [string, number], kind: BoardEdge["kind"]): BoardEdge {
  return {
    id: E(id), project_id: P,
    from_kind: from[0] as BoardEdge["from_kind"], from_id: from[1],
    to_kind: to[0] as BoardEdge["to_kind"], to_id: to[1],
    kind, strength: 0,
  };
}

export const seedEdges: BoardEdge[] = (() => {
  const out: BoardEdge[] = [];
  let n = 1;
  // 分解：子 → 父。拆得越细的层级越"弱"，顺势把三档颜色演出来
  // （强=红 / 参考=橙 / 弱=灰虚线；真实项目里可以按重要性随便调）
  for (const s of SPECS) {
    if (s.pid == null) continue;
    const depth = String(s.id).length - 1; // T1.1 = 1 层
    const one = edge(n++, ["task", T(s.id)], ["task", T(s.pid)], "decompose");
    one.strength = depth <= 1 ? 0 : depth === 2 ? 1 : 2;
    out.push(one);
  }
  // 先后：同级 / 相邻阶段的前后依赖
  const precede: [number, number][] = [
    [1, 2], [2, 3], [3, 4],
    [11, 12], [21, 22], [22, 23],
    [111, 1112], [1111, 1112],
    [1121, 11211], [121, 1211], [1211, 12111],
    [211, 212], [221, 222], [231, 232], [311, 312],
  ];
  for (const [a, b] of precede) out.push(edge(n++, ["task", T(a)], ["task", T(b)], "precede"));

  // 依据：资料 → 用它的任务
  const evidence: [number, number][] = [
    [N(1), T(212)], [N(1), T(221)], [N(1), T(231)],
    [N(2), T(111)], [N(2), T(1112)],
    [N(3), T(221)],
    [N(4), T(112)],
    [N(5), T(232)],
    [N(21), T(31)], [N(21), T(312)],
    [N(22), T(211)],
    [N(23), T(232)],
  ];
  for (const [a, b] of evidence) out.push(edge(n++, ["note", a], ["task", b], "evidence"));

  // 产出：任务 → 交出来的东西
  out.push(edge(n++, ["task", T(121)], ["note", N(41)], "produce")); // 关键词提炼 → 导图
  out.push(edge(n++, ["task", T(232)], ["note", N(32)], "produce")); // 网格规则 → 版式规范
  out.push(edge(n++, ["task", T(41)], ["note", N(31)], "produce")); // 品牌手册 → 调性说明
  return out;
})();

/* ------------------------------------------------------------------
 * 依据关系：等级挂在关系上（同一份资料对不同任务可以是不同档）
 * ------------------------------------------------------------------ */

function ref(id: number, task: number, note: number, level: number, ord: number, point = ""): TaskRef {
  return { id: R(id), task_id: T(task), note_id: N(note), level, ord, point };
}

export const seedTaskRefs: TaskRef[] = [
  ref(1, 221, 1, 0, 0, "第 12 页颜色规范：主色限墨绿系（#2F4F3A 一带），禁止高饱和红"),
  ref(2, 231, 1, 0, 0, "第 3 章字体规范要完整收录，含商用授权说明；缺授权的字体一律不用"),
  ref(3, 212, 1, 0, 1, "标志最小使用尺寸不小于 8mm；安全空间为标志高度的 1/2"),

  ref(4, 111, 2, 0, 0, "重点看 Sheet2 三家竞品配色统计，找出还没被占住的色彩空位"),
  ref(5, 1112, 2, 1, 1, "只看结论页就行，数据细节不用细抠"),

  ref(6, 221, 3, 1, 0, "釉面质感、低饱和方向；只取质感，不取具体色值"),
  ref(7, 232, 5, 1, 0, "12 栏网格、页边距不小于 18mm；参考 32-45 页内页"),
  ref(8, 112, 4, 2, 0, ""), // 茶室摄影集只当背景氛围，别引用具体画面
];

export const seedDocs: Doc[] = [
  {
    id: D(1), project_id: P,
    title: "调性说明",
    body: "# 品牌调性说明\n\n## 五个关键词\n\n1. **东方克制** —— 不用繁复纹样，靠结构和留白说话\n2. **留白** —— 版面留出呼吸感，信息不堆满\n3. **釉色** —— 取陶瓷釉面的温润质感，不取高饱和\n4. **低饱和** —— 全系色彩饱和度控制在 30% 以内\n5. **人文** —— 文字带温度，避免工业感措辞\n\n## 设计约束\n\n- 禁止使用金色、亮红\n- 单页主色面积不低于 55%\n",
    sort_order: 1000, created_at: "2026-11-04", updated_at: "2026-11-04",
  },
  {
    id: D(2), project_id: P,
    title: "版式规范",
    body: "# 版式规范\n\n## 网格\n\n- 12 栏网格，栏宽 68px，栏距 20px\n- 页边距：外 18mm，内 22mm（预留装订）\n\n## 字号层级\n\n| 层级 | 字号 | 字重 |\n|---|---|---|\n| 主标题 | 28pt | Bold |\n| 副标题 | 18pt | Medium |\n| 正文 | 10.5pt | Regular |\n| 注释 | 8pt | Regular |\n",
    sort_order: 2000, created_at: "2026-11-20", updated_at: "2026-11-20",
  },
];
