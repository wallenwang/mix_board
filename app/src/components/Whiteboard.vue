<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from "vue";
import { useBoardStore } from "../store";
import { api } from "../api";
import { ElMessage, ElMessageBox } from "element-plus";
import TaskDialog from "./TaskDialog.vue";
import FilePreview from "./FilePreview.vue";
import GanttChart from "./GanttChart.vue";
import MdEditor from "./MdEditor.vue";
import AppIcon from "./AppIcon.vue";
import { priorityOf, isImageFile, fileIcon, formatBytes, extOf, parseSource } from "../types";
import type { Task, BoardNote, BoardEdge, EdgeKind, NodeKind, WbFile, Doc } from "../types";
import {
  readAsDataURL,
  imageSize,
  sizeOfNode,
  layoutTree,
  NOTE_COLORS,
  BOX_COLORS,
  inkOn,
  inkShadowOn,
  clipToRect as clipToRectShared,
  edgeGeom,
  edgePath as edgePathShared,
} from "../wb";
import { parseOutline, flattenOutline, outlineToText } from "../outline";
import {
  DOC_MIME,
  docIdOf,
  docSummary,
  docStats,
  docNoteFields,
  appendToBody,
} from "../docnode";
import {
  renderScene,
  canvasToBlob,
  canvasToPdf,
  downloadBlob,
  safeFileName,
  loadImage,
  readNodeStyle,
  ensureFontsReady,
  type ExportNode,
  type ExportLine,
} from "../exportImage";
import { reportError } from "../diag";
import { openPrompt } from "../aiPrompt";

const store = useBoardStore();
const canvasRef = ref<HTMLElement | null>(null);

// ---- view transform (pan / zoom) ----
const panX = ref(60);
const panY = ref(30);
const zoom = ref(1);

const contentStyle = computed(() => ({
  transform: `translate(${panX.value}px, ${panY.value}px) scale(${zoom.value})`,
}));

const gridStyle = computed(() => ({
  backgroundPosition: `${panX.value}px ${panY.value}px`,
  backgroundSize: `${24 * zoom.value}px ${24 * zoom.value}px`,
}));

function screenToWorld(cx: number, cy: number) {
  const r = canvasRef.value?.getBoundingClientRect();
  if (!r) return { x: 0, y: 0 };
  return {
    x: (cx - r.left - panX.value) / zoom.value,
    y: (cy - r.top - panY.value) / zoom.value,
  };
}

function centerOfView() {
  const r = canvasRef.value?.getBoundingClientRect();
  return screenToWorld(
    (r?.left ?? 0) + (r?.width ?? 600) / 2,
    (r?.top ?? 0) + (r?.height ?? 400) / 2
  );
}

// ---- tools ----
type Tool = "select" | "note" | "text" | "mind" | "box" | "task" | "link";
const tool = ref<Tool>("select");

/* ------------------------------------------------------------------
 * 连线样式：弧线 / 直线
 * 弧线从节点的**出边方向**离开（不是简单的两点贝塞尔），所以看起来像手绘：
 * 线先垂直于卡片边缘走一小段再转弯，而不是从卡片中心直接拉一条斜线。
 * 只存本地偏好，不改数据库 —— 这是"显示方式"，不是内容。
 * ------------------------------------------------------------------ */
type EdgeStyle = "curve" | "line";
const EDGE_STYLE_KEY = "kanban.edgeStyle";
const edgeStyle = ref<EdgeStyle>(
  localStorage.getItem(EDGE_STYLE_KEY) === "line" ? "line" : "curve"
);
/* 样式菜单：点小三角、或长按连线图标都能打开 */
const edgeMenuOpen = ref(false);
let edgePressTimer: number | null = null;

function setEdgeStyle(s: EdgeStyle) {
  edgeStyle.value = s;
  localStorage.setItem(EDGE_STYLE_KEY, s);
  edgeMenuOpen.value = false;
  ElMessage.success(s === "curve" ? "连线已改为弧线（手绘感）" : "连线已改为直线");
}
function stopEdgeLongPress() {
  if (edgePressTimer) {
    clearTimeout(edgePressTimer);
    edgePressTimer = null;
  }
}
function startEdgeLongPress() {
  stopEdgeLongPress();
  edgePressTimer = window.setTimeout(() => {
    edgePressTimer = null;
    edgeMenuOpen.value = true;
  }, 460);
}
function onEdgeBtnClick() {
  // 长按已经打开了菜单，这次 click 就不要再切工具
  if (edgeMenuOpen.value) return;
  tool.value = tool.value === "link" ? "select" : "link";
}
/** 点画布别处时收起样式菜单 */
function closeEdgeMenuOnOutside(e: PointerEvent) {
  const t = e.target as HTMLElement | null;
  // 色板：点到自己或那个「配色」按钮以外就收起
  if (paletteKey.value) {
    const inPalette = !!t?.closest(".node-palette");
    const inNode = !!t?.closest(".node-tools");
    if (!inPalette && !inNode) paletteKey.value = null;
  }
  if (!edgeMenuOpen.value) return;
  if (t && t.closest(".tb-split")) return;
  edgeMenuOpen.value = false;
}
const spaceDown = ref(false);

// ---- selection (多选) ----
const selectedKeys = ref<string[]>([]);
const keyOf = (kind: "task" | "note", id: number) => `${kind}:${id}`;
const parseKey = (k: string) => ({
  kind: k.slice(0, k.indexOf(":")) as "task" | "note",
  id: Number(k.slice(k.indexOf(":") + 1)),
});
function isSelected(kind: "task" | "note", id: number) {
  return selectedKeys.value.includes(keyOf(kind, id));
}
function selectOnly(kind: "task" | "note", id: number) {
  selectedKeys.value = [keyOf(kind, id)];
}
function toggleSelect(kind: "task" | "note", id: number) {
  const k = keyOf(kind, id);
  selectedKeys.value = selectedKeys.value.includes(k)
    ? selectedKeys.value.filter((x) => x !== k)
    : [...selectedKeys.value, k];
}
function clearSelection() {
  selectedKeys.value = [];
}
/** 键盘操作作用在最后点选的那个节点上 */
const primary = computed(() => {
  const k = selectedKeys.value[selectedKeys.value.length - 1];
  return k ? parseKey(k) : null;
});

// ---- 平移：中键 / 按住空格 + 左键 ----
let panning = false;
function startPan(e: MouseEvent | PointerEvent) {
  panning = true;
  const start = { mx: e.clientX, my: e.clientY, px: panX.value, py: panY.value };
  const move = (ev: MouseEvent) => {
    if (!panning) return;
    panX.value = start.px + (ev.clientX - start.mx);
    panY.value = start.py + (ev.clientY - start.my);
  };
  const up = () => {
    panning = false;
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}

// ---- 左键框选 ----
const marquee = ref<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
const marqueeStyle = computed(() => {
  const m = marquee.value;
  if (!m) return {};
  return {
    left: Math.min(m.x0, m.x1) + "px",
    top: Math.min(m.y0, m.y1) + "px",
    width: Math.abs(m.x1 - m.x0) + "px",
    height: Math.abs(m.y1 - m.y0) + "px",
  };
});

function startMarquee(e: MouseEvent) {
  const startW = screenToWorld(e.clientX, e.clientY);
  let moved = false;
  const move = (ev: MouseEvent) => {
    const w = screenToWorld(ev.clientX, ev.clientY);
    if (!moved && Math.hypot(w.x - startW.x, w.y - startW.y) * zoom.value < 4) return;
    moved = true;
    marquee.value = { x0: startW.x, y0: startW.y, x1: w.x, y1: w.y };
  };
  const up = () => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    const m = marquee.value;
    marquee.value = null;
    if (!moved || !m) {
      clearSelection();
      return;
    }
    const x0 = Math.min(m.x0, m.x1);
    const x1 = Math.max(m.x0, m.x1);
    const y0 = Math.min(m.y0, m.y1);
    const y1 = Math.max(m.y0, m.y1);
    const hits: string[] = [];
    for (const t of store.allTasks) {
      const p = posOf("task", t.id);
      if (p.x < x1 && p.x + TASK_W > x0 && p.y < y1 && p.y + TASK_H > y0)
        hits.push(keyOf("task", t.id));
    }
    for (const n of store.notes) {
      // 分组框本身不进选择集：否则「多选后成组」会把框套进框
      if (n.kind === "box") continue;
      const p = posOf("note", n.id);
      const s = noteSize(n);
      if (p.x < x1 && p.x + s.w > x0 && p.y < y1 && p.y + s.h > y0)
        hits.push(keyOf("note", n.id));
    }
    selectedKeys.value = hits;
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}

const dragOver = ref(false);

function isChrome(t: HTMLElement | null) {
  return !!t?.closest(
    ".wb-node, .wb-toolbar, .wb-hint, .wb-empty, .wb-mode, .edge-menu, .ref-menu"
  );
}

function bgDown(e: MouseEvent) {
  // 点空白先收起浮层（点在浮层上时，浮层自己 stop 了 pointerdown，走不到这里）
  if (edgePick.value) edgePick.value = null;
  if (refPick.value) refPick.value = null;
  // 中键：任何地方都能平移
  if (e.button === 1) {
    e.preventDefault();
    startPan(e);
    return;
  }
  if (e.button !== 0) return;
  if (isChrome(e.target as HTMLElement)) return;
  if (spaceDown.value) {
    e.preventDefault();
    startPan(e);
    return;
  }
  if (tool.value === "box") {
    startDrawBox(e);
    return;
  }
  if (
    tool.value === "note" ||
    tool.value === "text" ||
    tool.value === "mind" ||
    tool.value === "task"
  ) {
    void createAtPointer(e);
    return;
  }
  if (tool.value === "link") {
    linkFrom.value = null;
    return;
  }
  startMarquee(e);
}

function onWheel(e: WheelEvent) {
  const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
  const nz = Math.min(2.5, Math.max(0.25, zoom.value * factor));
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const cx = e.clientX - r.left;
  const cy = e.clientY - r.top;
  const wx = (cx - panX.value) / zoom.value;
  const wy = (cy - panY.value) / zoom.value;
  zoom.value = nz;
  panX.value = cx - wx * nz;
  panY.value = cy - wy * nz;
}

function zoomBy(f: number) {
  const nz = Math.min(2.5, Math.max(0.25, zoom.value * f));
  const r = canvasRef.value?.getBoundingClientRect();
  if (!r) {
    zoom.value = nz;
    return;
  }
  const cx = r.width / 2;
  const cy = r.height / 2;
  const wx = (cx - panX.value) / zoom.value;
  const wy = (cy - panY.value) / zoom.value;
  zoom.value = nz;
  panX.value = cx - wx * nz;
  panY.value = cy - wy * nz;
}

function resetView() {
  panX.value = 60;
  panY.value = 30;
  zoom.value = 1;
}

// ---- node geometry ----
const TASK_W = 190;
const TASK_H = 72;

/** 圆形导图节点用固定直径 —— 胶囊的宽高比在圆里不成立 */
const MIND_CIRCLE_D = 108;
function noteSize(n: BoardNote) {
  if (kindOf(n) === "mind" && lookOf(n).shape === "circle") {
    return { w: MIND_CIRCLE_D, h: MIND_CIRCLE_D };
  }
  return sizeOfNode((n.kind || "note") as NodeKind, n.w, n.h);
}
function taskById(id: number): Task | undefined {
  return store.allTasks.find((t) => t.id === id);
}
function noteById(id: number): BoardNote | undefined {
  return store.notes.find((n) => n.id === id);
}
function kindOf(n: BoardNote): NodeKind {
  return (n.kind || "note") as NodeKind;
}

// default position mirrors the kanban layout until the user drags a node
/**
 * 还没被手动摆过的任务，自动找一个空位。
 * 注意：**不能用列索引/列内序号算位置** —— 任务一换列位置就会跳，
 * 正好撞到别的节点上，看起来就像"白板里少了一个节点"。
 * 这里改成：按任务 id 顺序在网格里占坑，并躲开所有已占用的坐标。
 */
function autoTaskPos(t: Task) {
  const COLS = 4;
  const STEP_X = 250;
  const STEP_Y = 120;
  // 顶部要躲开悬浮工具栏（它会换行，高度不固定），否则最上面一排节点被压住点不动
  const TOP_GUARD = 110;
  const taken = new Set<string>();
  for (const x of store.allTasks) {
    if (x.wx != null && x.wy != null) taken.add(`${Math.round(x.wx)},${Math.round(x.wy)}`);
  }
  for (const n of store.notes) taken.add(`${Math.round(n.x)},${Math.round(n.y)}`);

  const all = store.allTasks.slice().sort((a, b) => a.id - b.id);
  let slot = 0;
  for (const x of all) {
    if (x.wx != null && x.wy != null) continue; // 已有固定位置，不占网格槽
    let p = { x: 20, y: 20 };
    for (;;) {
      p = { x: (slot % COLS) * STEP_X + 20, y: Math.floor(slot / COLS) * STEP_Y + TOP_GUARD };
      slot += 1;
      if (!taken.has(`${p.x},${p.y}`)) break;
    }
    taken.add(`${p.x},${p.y}`);
    if (x.id === t.id) return p;
  }
  return { x: 20, y: TOP_GUARD };
}

const drafts = ref<Record<string, { x: number; y: number }>>({});

function posOf(kind: "task" | "note", id: number) {
  const d = drafts.value[keyOf(kind, id)];
  if (d) return d;
  if (kind === "task") {
    const t = taskById(id);
    if (!t) return { x: 0, y: 0 };
    return t.wx != null && t.wy != null ? { x: t.wx, y: t.wy } : autoTaskPos(t);
  }
  const n = noteById(id);
  return n ? { x: n.x, y: n.y } : { x: 0, y: 0 };
}

function posOfKey(key: string) {
  const { kind, id } = parseKey(key);
  return posOf(kind, id);
}

function sizeAt(kind: "task" | "note", id: number) {
  if (kind === "task") return { w: TASK_W, h: TASK_H };
  const n = noteById(id);
  return n ? noteSize(n) : { w: 0, h: 0 };
}

// clear state when switching projects
watch(
  () => store.currentProjectId,
  () => {
    drafts.value = {};
    editingNote.value = null;
    editingTask.value = null;
    clearSelection();
    previews.value = {};
    undoStack.length = 0;
    redoStack.length = 0;
    syncHistLen();
    linkFrom.value = null;
  }
);

// ---- 撤销 / 重做 ----
interface Op {
  label: string;
  undo: () => Promise<unknown>;
  redo: () => Promise<unknown>;
}
const undoStack: Op[] = [];
const redoStack: Op[] = [];
const undoLen = ref(0);
const redoLen = ref(0);
function syncHistLen() {
  undoLen.value = undoStack.length;
  redoLen.value = redoStack.length;
}
function pushOp(op: Op) {
  undoStack.push(op);
  if (undoStack.length > 80) undoStack.shift();
  redoStack.length = 0;
  syncHistLen();
}
// 便签撤销后再重做会拿到新的自增 id，用映射链换算
const remap = new Map<string, string>();
const nk = (id: number) => `n:${id}`;
function R(key: string): number {
  let cur = key;
  let guard = 0;
  while (remap.has(cur) && guard++ < 30) cur = remap.get(cur)!;
  return Number(cur.slice(2));
}

async function doUndo() {
  const op = undoStack.pop();
  if (!op) return;
  syncHistLen();
  try {
    await op.undo();
    redoStack.push(op);
    await store.refreshTasks();
    await store.refreshBoard();
    ElMessage.info(`已撤销：${op.label}`);
  } catch (e) {
    reportError("撤销", e);
  }
  syncHistLen();
}
async function doRedo() {
  const op = redoStack.pop();
  if (!op) return;
  syncHistLen();
  try {
    await op.redo();
    undoStack.push(op);
    await store.refreshTasks();
    await store.refreshBoard();
  } catch (e) {
    reportError("重做", e);
  }
  syncHistLen();
}

// ---- 拖动节点（多选整组一起动；拖父节点会带上它下面的整棵子树） ----
async function applyPos(kind: string, id: number, p: { x: number; y: number }) {
  if (kind === "task") await api.setTaskPos(id, p.x, p.y);
  else await api.updateNote(id, { x: p.x, y: p.y });
}

/**
 * 把起点集合扩展成「起点 + 它们的全部后代」。
 * 父子关系来自白板连线（from = 父，to = 子）：只有向下收集，
 * 所以拖父节点时下级跟着走，拖子节点时父节点不动；数据里有环也不会死循环。
 */
/**
 * 取出一组节点及其所有后代，用于「移动父节点时带着子节点一起走」。
 *
 * ⚠️ 分解边的方向是**子 → 父**（from 是子、to 是父），所以找后代要
 * 反过来「顺着 to 找 from」。方向搞反会变成「移动子节点拖动整棵树」。
 *
 * 只顺着分解边走：移动任务不该把它的资料（依据）或前后环节（先后）一起拖走，
 * 那些是独立摆放的东西。
 */
function withDescendants(roots: string[]): string[] {
  const all = new Set(roots);
  const queue = [...roots];
  while (queue.length) {
    const cur = queue.shift() as string;
    for (const e of store.edges) {
      if (e.kind !== "decompose") continue;
      if (`${e.to_kind}:${e.to_id}` !== cur) continue;
      const child = `${e.from_kind}:${e.from_id}`;
      if (all.has(child)) continue;
      all.add(child);
      queue.push(child);
    }
  }
  return [...all];
}

/**
 * 某个节点是否被分组框"收纳"了 —— 判据是**整个卡片都在框内**。
 *
 * 早先用的是"中心点在框内"，太松：卡片只要压住框边一点就算这一组的，
 * 拖框时会连带把框外那张卡一起拖走，看上去就是"碰一下就粘上"。
 * 改成完全包含之后，成员关系与肉眼看到的一致；想收进组就整张拖进去，
 * 露出一半就是没进去。
 *
 * 留 0.5 的容差，避免浮点位置让"刚好贴着边"的卡片判不进来。
 */
function insideBox(box: BoardNote, kind: "task" | "note", id: number): boolean {
  if (kind === "note" && id === box.id) return false;
  const p = posOf(kind, id);
  const s = sizeAt(kind, id);
  if (!s.w || !s.h) return false;
  const bp = posOf("note", box.id);
  const bs = noteSize(box);
  const t = 0.5;
  return (
    p.x >= bp.x - t &&
    p.y >= bp.y - t &&
    p.x + s.w <= bp.x + bs.w + t &&
    p.y + s.h <= bp.y + bs.h + t
  );
}

/**
 * 分组框里收纳的全部节点（任务 + 各种白板节点，**包括套在里面的小分组框**）。
 * 拖动分组框时这些节点一起平移 —— 成员关系是纯几何算出来的，
 * 所以把卡片拖进/拖出框子，它就自动加入/退出这一组，不用额外存标记。
 */
function nodesInBox(box: BoardNote): string[] {
  const out: string[] = [];
  for (const t of store.allTasks) {
    if (insideBox(box, "task", t.id)) out.push(keyOf("task", t.id));
  }
  for (const n of store.notes) {
    if (n.id === box.id) continue;
    if (insideBox(box, "note", n.id)) out.push(keyOf("note", n.id));
  }
  return out;
}

async function startDrag(e: PointerEvent, kind: "task" | "note", id: number) {
  if (e.button !== 0) return;
  if ((e.target as HTMLElement).closest("textarea, input, button, .node-port, .node-resize"))
    return;
  e.preventDefault();
  e.stopPropagation();

  if (tool.value === "link") {
    void handleLinkClick(kind, id);
    return;
  }

  // Shift + 拖动便签/资料 = 复制一份再拖走。
  // 复制体共享同一份数据（file_id 相同），只是白板上多一个位置 ——
  // 这样同一个资料可以摆两处、分别放进不同强度的框里。
  // 任务卡不参与复制（任务是唯一实体，复制会造成两个 T1）。
  if (e.shiftKey && kind === "note" && !isSelected(kind, id)) {
    const src = noteById(id);
    if (src && store.currentProjectId != null) {
      try {
        const nid = await api.createNote({
          project_id: src.project_id,
          x: src.x + 24,
          y: src.y + 24,
          text: src.text,
          color: src.color,
          kind: src.kind,
          w: src.w,
          h: src.h,
          file_id: src.file_id,
          meta: src.meta,
        });
        await store.refreshBoard();
        // 拖的是新副本，原节点留在原地
        id = nid;
        selectOnly("note", nid);
        ElMessage.info("已复制一份（数据仍指向同一份资料）");
      } catch (err) {
        reportError("复制节点", err);
      }
    }
  } else if (e.ctrlKey || e.metaKey) toggleSelect(kind, id);
  else if (!isSelected(kind, id)) selectOnly(kind, id);

  // 实际被拖的是「选中的节点」+「它们的所有后代」
  const moveKeys = new Set(withDescendants(selectedKeys.value.slice()));
  // 拖分组框 = 拖整个分区：框里的节点全都跟着走（框套框会一并带走）
  for (const k of [...moveKeys]) {
    const { kind: kk, id: ii } = parseKey(k);
    if (kk !== "note") continue;
    const n = noteById(ii);
    if (!n || kindOf(n) !== "box") continue;
    for (const mk of nodesInBox(n)) moveKeys.add(mk);
  }
  const moving = [...moveKeys].map((k) => {
    const { kind: kk, id: ii } = parseKey(k);
    return { key: k, kind: kk, id: ii, start: posOf(kk, ii) };
  });
  const startScreen = { x: e.clientX, y: e.clientY };
  let moved = false;

  function move(ev: PointerEvent) {
    const dx = (ev.clientX - startScreen.x) / zoom.value;
    const dy = (ev.clientY - startScreen.y) / zoom.value;
    if (!moved && Math.hypot(dx, dy) < 3) return;
    moved = true;
    for (const m of moving) {
      drafts.value[m.key] = { x: m.start.x + dx, y: m.start.y + dy };
    }
  }

  async function up() {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    if (!moved) return;
    const changes: { m: (typeof moving)[number]; to: { x: number; y: number } }[] = [];
    for (const m of moving) {
      const to = drafts.value[m.key];
      if (to) changes.push({ m, to });
    }
    try {
      for (const { m, to } of changes) {
        await applyPos(m.kind, m.id, to);
        if (m.kind === "task") {
          const t = taskById(m.id);
          if (t) {
            t.wx = to.x;
            t.wy = to.y;
          }
        } else {
          const n = noteById(m.id);
          if (n) {
            n.x = to.x;
            n.y = to.y;
          }
        }
      }
      // 整次拖动合成一个撤销步骤（之前是每个节点一步，撤销得按好几次）
      if (changes.length) {
        pushOp({
          label: changes.length > 1 ? `移动 ${changes.length} 个节点` : "移动卡片",
          undo: async () => {
            for (const { m } of changes) await applyPos(m.kind, m.id, m.start);
          },
          redo: async () => {
            for (const { m, to } of changes) await applyPos(m.kind, m.id, to);
          },
        });
      }
    } catch (err) {
      reportError("移动节点", err);
    } finally {
      for (const m of moving) delete drafts.value[m.key];
    }
  }
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

// ---- task detail dialog ----
const activeTaskId = ref<number | null>(null);
const dialogOpen = ref(false);
const activeTask = computed<Task | null>(
  () => (activeTaskId.value != null ? taskById(activeTaskId.value) ?? null : null)
);
function openTask(id: number) {
  activeTaskId.value = id;
  dialogOpen.value = true;
}

// ---- 任务标题就地改 ----
const editingTask = ref<number | null>(null);
const taskDraft = ref("");
const taskInput = ref<HTMLInputElement | HTMLInputElement[] | null>(null);

async function focusTaskInput() {
  await nextTick();
  const el = Array.isArray(taskInput.value) ? taskInput.value[0] : taskInput.value;
  el?.focus();
  el?.select?.();
}
async function startEditTask(t: Task) {
  editingTask.value = t.id;
  taskDraft.value = t.title;
  await focusTaskInput();
}
async function commitTaskTitle(t: Task) {
  if (editingTask.value !== t.id) return;
  editingTask.value = null;
  const v = taskDraft.value.trim();
  if (!v || v === t.title) return;
  try {
    await api.updateTask(t.id, { title: v });
    t.title = v;
  } catch (e) {
    reportError("改任务标题", e);
  }
}

// ---- 任务就地编辑：标题 + 备注，全在卡片里写，不弹窗 ----
const editingTaskFull = ref<number | null>(null);
const taskDraftTitle = ref("");
const taskDraftDesc = ref("");
const taskFullTitleInput = ref<HTMLInputElement | HTMLInputElement[] | null>(null);

async function startEditTaskFull(t: Task) {
  selectOnly("task", t.id);
  editingTask.value = null;
  editingTaskFull.value = t.id;
  taskDraftTitle.value = t.title;
  taskDraftDesc.value = t.description ?? "";
  await nextTick();
  const el = Array.isArray(taskFullTitleInput.value)
    ? taskFullTitleInput.value[0]
    : taskFullTitleInput.value;
  el?.focus();
}

function cancelEditTaskFull() {
  editingTaskFull.value = null;
}

async function commitTaskFull(t: Task) {
  if (editingTaskFull.value !== t.id) return;
  editingTaskFull.value = null;
  const title = taskDraftTitle.value.trim();
  const desc = taskDraftDesc.value.trim();
  if (!title) {
    ElMessage.warning("标题不能为空");
    return;
  }
  if (title === t.title && desc === (t.description ?? "")) return;
  try {
    await api.updateTask(t.id, { title, description: desc });
    // 先就地改掉这一份，白板卡片立刻变；
    // 再拉一次数据，让看板等其它视图同步（只靠 refreshTasks 时看板列表不会立刻刷）
    t.title = title;
    t.description = desc;
    await store.refreshTasks();
    ElMessage.success("已保存");
  } catch (e) {
    reportError("保存任务", e);
  }
}

// ---- 便签 / 导图节点文字 ----
const editingNote = ref<number | null>(null);
const editText = ref("");
const editArea = ref<HTMLTextAreaElement | HTMLTextAreaElement[] | null>(null);

async function focusEditor() {
  await nextTick();
  const el = Array.isArray(editArea.value) ? editArea.value[0] : editArea.value;
  el?.focus();
  el?.select?.();
}

async function startEditNote(n: BoardNote) {
  if (n.kind === "file") {
    openPreview(n);
    return;
  }
  // 文档卡片双击 = 在白板上直接改这篇 Markdown
  if (n.kind === "doc") {
    openDocEditor(n);
    return;
  }
  // 甘特图节点没有文字可改，双击交给节点内部自己处理
  if (n.kind === "gantt") return;
  editingNote.value = n.id;
  editText.value = n.text;
  await focusEditor();
}

async function commitNoteText(n: BoardNote) {
  if (editingNote.value !== n.id) return;
  editingNote.value = null;
  const txt = editText.value;
  if (txt === n.text) return;
  const old = n.text;
  try {
    await api.updateNote(n.id, { text: txt });
    n.text = txt;
    pushOp({
      label: "改文字",
      undo: () => api.updateNote(n.id, { text: old }),
      redo: () => api.updateNote(n.id, { text: txt }),
    });
  } catch (e) {
    reportError("保存文字", e);
  }
}

// ---- 新建节点 ----
const KIND_DEFAULT: Record<NodeKind, { text: string; color: string }> = {
  note: { text: "", color: "#FFF9C4" },
  text: { text: "文本", color: "transparent" },
  mind: { text: "主题", color: "#409EFF" },
  box: { text: "分组", color: "#409EFF" },
  file: { text: "", color: "#FFFFFF" },
  gantt: { text: "甘特图", color: "#FFFFFF" },
  doc: { text: "文档", color: "#FFFFFF" },
};

function opCreate(id: number, fields: Parameters<typeof api.createNote>[0]): Op {
  let live = id;
  return {
    label: "新建卡片",
    undo: () => api.deleteNote(R(nk(live))),
    redo: async () => {
      const nid = await api.createNote(fields);
      remap.set(nk(live), nk(nid));
      live = nid;
      return nid;
    },
  };
}

async function createNode(kind: NodeKind, x: number, y: number, opts: { edit?: boolean } = {}) {
  if (store.currentProjectId == null) return null;
  const d = KIND_DEFAULT[kind];
  const s = sizeOfNode(kind, null, null);
  const fields = {
    project_id: store.currentProjectId,
    x,
    y,
    text: d.text,
    color: d.color,
    kind,
    w: s.w,
    h: s.h,
    file_id: null as number | null,
    meta: "",
  };
  try {
    const id = await api.createNote(fields);
    pushOp(opCreate(id, fields));
    await store.refreshBoard();
    selectOnly("note", id);
    if (opts.edit) {
      const n = noteById(id);
      if (n) await startEditNote(n);
    }
    return id;
  } catch (e) {
    reportError("新建卡片", e);
    return null;
  }
}

async function createAtPointer(e: MouseEvent) {
  const w = screenToWorld(e.clientX, e.clientY);
  const t = tool.value;
  if (t === "task") {
    await addTaskAt(w.x - TASK_W / 2, w.y - TASK_H / 2);
    if (!e.shiftKey) tool.value = "select";
    return;
  }
  const kind: NodeKind =
    t === "mind" ? "mind" : t === "box" ? "box" : t === "text" ? "text" : "note";
  await createNode(kind, w.x - 40, w.y - 20, { edit: kind !== "box" });
  if (!e.shiftKey) tool.value = "select";
}

/**
 * 在白板上直接建一个任务。
 *
 * 建的是**真任务**，跟看板里新建的完全一样：会落到看板第一列，
 * 所以看板那边刷新就能看到，不用同步两份数据。
 */
async function addTaskAt(wx: number, wy: number): Promise<number | null> {
  if (store.currentProjectId == null) return null;
  const col = store.columns[0];
  if (!col) {
    ElMessage.warning("这个项目还没有看板列，请先在看板里建一列");
    return null;
  }
  try {
    const id = await api.createTask({
      project_id: store.currentProjectId,
      column_id: col.id,
      title: "新任务",
    });
    await api.setTaskPos(id, wx, wy);
    await store.refreshTasks();
    const t = taskById(id);
    if (t) {
      selectOnly("task", id);
      await startEditTask(t);
    }
    return id;
  } catch (e) {
    reportError("新建任务", e);
    return null;
  }
}

async function addNote() {
  const at = centerOfView();
  await createNode("note", at.x - 80, at.y - 60, { edit: true });
}

/** 甘特图节点：放在视图中央，内容 = 当前项目的全部任务 */
async function addGantt() {
  const at = centerOfView();
  await createNode("gantt", at.x - 310, at.y - 150);
}

// ---- 删除 ----
async function removeNote(n: BoardNote) {
  try {
    await ElMessageBox.confirm(
      n.kind === "file" ? `删除资料「${n.text}」？文件本体也会一起删掉。` : "删除这张卡片？",
      "删除",
      { type: "warning", confirmButtonText: "删除", cancelButtonText: "取消" }
    );
  } catch {
    return;
  }
  await doRemoveNote(n);
}

async function doRemoveNote(n: BoardNote) {
  const snapshot: BoardNote = { ...n };
  const edgeSnaps = store.edges.filter(
    (e) =>
      (e.from_kind === "note" && e.from_id === n.id) || (e.to_kind === "note" && e.to_id === n.id)
  );
  try {
    if (snapshot.kind !== "file") {
      let live = n.id;
      pushOp({
        label: "删除卡片",
        undo: async () => {
          const nid = await api.createNote({
            project_id: snapshot.project_id,
            x: snapshot.x,
            y: snapshot.y,
            text: snapshot.text,
            color: snapshot.color,
            kind: snapshot.kind,
            w: snapshot.w,
            h: snapshot.h,
            file_id: snapshot.file_id,
            meta: snapshot.meta,
          });
          remap.set(nk(live), nk(nid));
          live = nid;
          for (const e of edgeSnaps) {
            await api.createEdge(
              snapshot.project_id,
              e.from_kind,
              R(nk(e.from_id)),
              e.to_kind,
              R(nk(e.to_id))
            );
          }
        },
        redo: () => api.deleteNote(R(nk(live))),
      });
    }
    await api.deleteNote(n.id);
    await store.refreshBoard();
  } catch (e) {
    reportError("删除卡片", e);
  }
}

async function removeSelection() {
  const keys = [...selectedKeys.value];
  if (!keys.length) return;
  const tasks = keys
    .filter((k) => k.startsWith("task:"))
    .map((k) => taskById(Number(k.slice(5))))
    .filter(Boolean) as Task[];
  const notes = keys
    .filter((k) => k.startsWith("note:"))
    .map((k) => noteById(Number(k.slice(5))))
    .filter(Boolean) as BoardNote[];
  const parts: string[] = [];
  if (tasks.length) parts.push(`${tasks.length} 个任务`);
  if (notes.length) parts.push(`${notes.length} 张卡片`);
  try {
    await ElMessageBox.confirm(`删除选中的 ${parts.join(" + ")}？`, "删除", {
      type: "warning",
      confirmButtonText: "删除",
      cancelButtonText: "取消",
    });
  } catch {
    return;
  }
  try {
    for (const n of notes) await doRemoveNote(n);
    for (const t of tasks) await api.deleteTask(t.id);
    await store.refreshTasks();
    await store.refreshBoard();
    clearSelection();
  } catch (e) {
    reportError("批量删除", e);
  }
}

/* ------------------------------------------------------------------
 * 配色：从固定色板自选（不再只能"点一下换下一个颜色"）
 * 打开的那张卡片的 key 存在 paletteKey，同一时刻只开一个。
 * 分组框（分区）走同一套色板，只是颜色集换成 BOX_COLORS。
 * ------------------------------------------------------------------ */
const paletteKey = ref<string | null>(null);

function togglePalette(n: BoardNote) {
  const k = keyOf("note", n.id);
  paletteKey.value = paletteKey.value === k ? null : k;
}

function paletteOf(n: BoardNote) {
  return (n.kind === "box" ? BOX_COLORS : NOTE_COLORS) as readonly string[];
}

function sameColor(a?: string, b?: string) {
  return (a || "").toLowerCase() === (b || "").toLowerCase();
}

async function setNoteColor(n: BoardNote, color: string, close = true) {
  try {
    await api.updateNote(n.id, { color });
    // n 是 ref 数组里的响应式对象，直接改属性就会重绘（不像 meta，那个要 refreshBoard）
    n.color = color;
    if (close) paletteKey.value = null;
  } catch (e) {
    reportError("换颜色", e);
  }
}

function onCustomColor(n: BoardNote, e: Event) {
  const v = (e.target as HTMLInputElement).value;
  if (v) void setNoteColor(n, v);
}

/* ------------------------------------------------------------------
 * 节点外观：形状 / 圆角
 * 存在 board_notes.meta.look 里 —— 不新建表、不改 Rust 侧结构。
 * ⚠️ 拖动时每帧都会读它，所以用 Map 按「id + meta」缓存，别每次都 JSON.parse。
 * ------------------------------------------------------------------ */
type NodeLook = { shape?: "capsule" | "circle"; radius?: number };
const lookCache = new Map<string, NodeLook>();

function lookOf(n: BoardNote): NodeLook {
  const key = `${n.id}|${n.meta || ""}`;
  const hit = lookCache.get(key);
  if (hit) return hit;
  let look: NodeLook = {};
  try {
    const m = JSON.parse(n.meta || "{}");
    look = (m.look || {}) as NodeLook;
  } catch {
    look = {};
  }
  if (lookCache.size > 400) lookCache.clear();
  lookCache.set(key, look);
  return look;
}

/* 字色跟着底色走：浅底 → 深墨字，深底 → 白字。
   颜色种类就那么几个，缓存一下，拖动时每帧调用也不心疼。 */
const inkCache = new Map<string, { "--ink": string; "--ink-shadow": string }>();
function inkStyle(bg: string) {
  const key = bg || "transparent";
  const hit = inkCache.get(key);
  if (hit) return hit;
  const v = { "--ink": inkOn(key), "--ink-shadow": inkShadowOn(key) };
  if (inkCache.size > 200) inkCache.clear();
  inkCache.set(key, v);
  return v;
}

async function patchLook(n: BoardNote, patch: NodeLook) {
  const look = { ...lookOf(n), ...patch };
  try {
    let m: Record<string, unknown> = {};
    try {
      m = JSON.parse(n.meta || "{}");
    } catch {
      m = {};
    }
    m.look = look;
    const meta = JSON.stringify(m);
    await api.updateNote(n.id, { meta });
    n.meta = meta;
    // ⚠️ notes 里的对象不是深层响应式的：只改属性界面不会重绘，必须让 store 重建数组
    await store.refreshBoard();
  } catch (e) {
    reportError("调整外观", e);
  }
}

/** 导图节点：胶囊 ↔ 圆形 */
async function toggleMindShape(n: BoardNote) {
  await patchLook(n, { shape: lookOf(n).shape === "circle" ? "capsule" : "circle" });
}

/** 便签圆角：直角 → 小 → 大 → 特大，循环 */
const NOTE_RADII = [0, 8, 16, 26];
async function cycleRadius(n: BoardNote) {
  const cur = lookOf(n).radius ?? 16;
  const i = NOTE_RADII.indexOf(cur);
  const next = NOTE_RADII[(i + 1) % NOTE_RADII.length];
  await patchLook(n, { radius: next });
}

/* ------------------------------------------------------------------
 * 分组框的约束强度：强依据 / 参考 / 弱参考
 *
 * 它回答的是「这一批材料整体有多硬」，跟任务卡上那一排资料等级不是一回事：
 * 任务卡上的等级挂在 task_refs 这条关系上（同一份资料对不同任务可以不同档），
 * 分组框的强度只表示这一堆东西的性质，作用是
 *   a) 画布上一眼看出哪块是硬材料；
 *   b) 从框里拖资料到任务时，给那条依据一个合适的默认等级。
 *
 * 三档对应任务卡上的三档等级，用同一套意思，换个更好懂的词：
 *   强依据 = 必须遵守、参考 = 可以参考、弱参考 = 仅作背景。
 * 不用"背景"这个词，因为它抽象；"弱参考"跟"强依据"对得上，一眼知道是弱的那头。
 *
 * 默认就是"参考"——所以新框天生带着一个可点的标签，不需要先"标强度"。
 * 存在 meta.cluster 里，跟 meta.look 用同一个 JSON 字段，不加数据库列；
 * 老框没有这个键，按缺省当"参考"，不用迁移。
 * ------------------------------------------------------------------ */
type ClusterStrength = "strong" | "ref" | "weak";
const CLUSTER_META: {
  v: ClusterStrength;
  label: string;
  hint: string;
  color: string;
}[] = [
  {
    v: "strong",
    label: "强依据",
    hint: "强依据：这一组是硬材料，结论有冲突时以它为准（拖到任务上默认算「必须遵守」）",
    color: "#D9822B",
  },
  {
    v: "ref",
    label: "参考",
    hint: "参考：有启发但不强制，没有冲突时补充进来（默认档）",
    color: "#3B7DDD",
  },
  {
    v: "weak",
    label: "弱参考",
    hint: "弱参考：只用来了解语境，别当依据引用（拖到任务上默认算「仅作背景」）",
    color: "#98A2B6",
  },
];
/** 强度 → 依据默认等级（0 必须遵守 / 1 可以参考 / 2 仅作背景） */
const CLUSTER_LEVEL: Record<ClusterStrength, number> = { strong: 0, ref: 1, weak: 2 };
const CLUSTER_MAP = new Map(CLUSTER_META.map((m) => [m.v, m]));
/** 点一下循环的次序 */
const CLUSTER_CYCLE: ClusterStrength[] = ["strong", "ref", "weak"];

function metaField(n: BoardNote): Record<string, unknown> {
  try {
    return JSON.parse(n.meta || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** 框的强度；没标过（或根本不是框）一律当"参考" */
function strengthOf(n: BoardNote | undefined): ClusterStrength {
  if (!n || n.kind !== "box") return "ref";
  const v = metaField(n).cluster;
  if (v === "strong" || v === "ref" || v === "weak") return v as ClusterStrength;
  // 老数据里可能存着已废弃的 "bg"，按弱参考处理
  if (v === "bg") return "weak";
  return "ref";
}

/** 写强度：同时把框的边框/标题色换成该档的标准色，一眼能分辨。之后仍可手动改色。 */
async function setStrength(n: BoardNote, v: ClusterStrength) {
  const m = metaField(n);
  m.cluster = v;
  const meta = JSON.stringify(m);
  const color = CLUSTER_MAP.get(v)?.color ?? n.color;
  try {
    await api.updateNote(n.id, { meta, color });
    await store.refreshBoard();
  } catch (e) {
    reportError("设置约束强度", e);
  }
}

/** 点一下换下一档：强依据 → 参考 → 弱参考 → 强依据 */
async function cycleStrength(n: BoardNote) {
  const i = CLUSTER_CYCLE.indexOf(strengthOf(n));
  await setStrength(n, CLUSTER_CYCLE[(i + 1) % CLUSTER_CYCLE.length]);
}

/** 这个节点被哪个分组框收着：取面积最小的那个（套框时算最里面一层） */
function boxOf(kind: "task" | "note", id: number): BoardNote | null {
  let best: BoardNote | null = null;
  let bestArea = Infinity;
  for (const b of store.notes) {
    if (b.kind !== "box") continue;
    if (!insideBox(b, kind, id)) continue;
    const sz = noteSize(b);
    const area = sz.w * sz.h;
    if (area < bestArea) {
      bestArea = area;
      best = b;
    }
  }
  return best;
}

/** 资料所在分组的强度；没有框或没标注就是 null（拖线时按 1 参考处理） */
function clusterOfNote(n: BoardNote): ClusterStrength | null {
  const b = boxOf("note", n.id);
  return b ? strengthOf(b) : null;
}

/** 选中集合里除分组框之外的节点 —— 成组只看这些 */
function groupableKeys(): string[] {
  return selectedKeys.value.filter((k) => {
    const { kind, id } = parseKey(k);
    if (kind !== "note") return true;
    return noteById(id)?.kind !== "box";
  });
}

/* ------------------------------------------------------------------
 * 拖出一个分组框
 *
 * 两件事一起做：拖出范围 = 按这个范围建框；点一下没拖 = 放一个默认大小的
 * （原来「点一下放一个」的习惯保留，不打断肌肉记忆）。
 * ------------------------------------------------------------------ */
const boxDraft = ref<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

/**
 * 预览矩形：**只写世界坐标**。
 *
 * 这个 div 挂在 .wb-content 里面，而 .wb-content 自己已经带了
 * `translate(panX, panY) scale(zoom)`；再乘一遍 zoom、再加一遍 pan，
 * 预览就会和鼠标错开一大截（偏移量正好等于画布的平移量）。
 * 框选矩形（marqueeStyle）一直是这么写的，照它来就对齐了。
 */
const boxDraftStyle = computed(() => {
  const d = boxDraft.value;
  if (!d) return {};
  return {
    left: Math.min(d.x0, d.x1) + "px",
    top: Math.min(d.y0, d.y1) + "px",
    width: Math.abs(d.x1 - d.x0) + "px",
    height: Math.abs(d.y1 - d.y0) + "px",
  };
});

/** 按世界坐标矩形建一个框；太小的当"点一下"，用默认尺寸 */
async function createBoxInRect(x0: number, y0: number, x1: number, y1: number) {
  const left = Math.min(x0, x1);
  const top = Math.min(y0, y1);
  const w = Math.abs(x1 - x0);
  const h = Math.abs(y1 - y0);
  const small = w < 80 || h < 60;
  const id = await createNode("box", small ? left - 40 : left, small ? top - 20 : top);
  if (id == null) return;
  if (!small) {
    try {
      await api.updateNote(id, { w: Math.round(w), h: Math.round(h) });
      await store.refreshBoard();
    } catch (e) {
      reportError("调整分组框大小", e);
    }
  }
  const n = noteById(id);
  if (small && n) await startEditNote(n);
}

function startDrawBox(e: MouseEvent) {
  const startW = screenToWorld(e.clientX, e.clientY);
  let moved = false;
  const move = (ev: MouseEvent) => {
    const w = screenToWorld(ev.clientX, ev.clientY);
    if (!moved && Math.hypot(w.x - startW.x, w.y - startW.y) * zoom.value < 5) return;
    moved = true;
    boxDraft.value = { x0: startW.x, y0: startW.y, x1: w.x, y1: w.y };
  };
  const up = (ev: MouseEvent) => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    const d = boxDraft.value;
    boxDraft.value = null;
    const w = screenToWorld(ev.clientX, ev.clientY);
    if (!moved || !d) {
      void createBoxInRect(startW.x, startW.y, startW.x, startW.y);
    } else {
      void createBoxInRect(d.x0, d.y0, d.x1, d.y1);
    }
    if (!ev.shiftKey) tool.value = "select";
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}

/**
 * 把选中的卡片一次装进分组框。
 *
 * 成因不看框内有什么，只看选中了什么：包围盒 + 一圈留白就是新框的大小，
 * 框建好后成员关系仍由「中心点落在框内」自动算出，不需要写成员表。
 */
async function groupSelection() {
  const keys = groupableKeys();
  if (keys.length < 2) {
    ElMessage.info("先选中至少两张卡片（Ctrl 点选或直接框选），再点分组");
    return;
  }
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const k of keys) {
    const { kind, id } = parseKey(k);
    const p = posOf(kind, id);
    const sz = sizeAt(kind, id);
    if (!sz.w || !sz.h) continue;
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x + sz.w);
    y1 = Math.max(y1, p.y + sz.h);
  }
  if (!Number.isFinite(x0)) return;
  const pad = 34;
  const keep = [...selectedKeys.value];
  const id = await createNode("box", x0 - pad, y0 - pad - 12);
  if (id == null) return;
  try {
    await api.updateNote(id, {
      w: Math.round(x1 - x0 + pad * 2),
      h: Math.round(y1 - y0 + pad * 2 + 12),
    });
    await store.refreshBoard();
  } catch (e) {
    reportError("调整分组框大小", e);
  }
  // createNode 会把选中改成新建的框，这里把原来的选择还回去
  selectedKeys.value = keep;
  ElMessage.success(`已把 ${keys.length} 张卡片装进分组框，框角可以点「强度」标一下`);
}

/** 工具栏那个「分组框」按钮：有选中就直接成组，没选中才进入画框模式 */
async function onBoxTool() {
  if (groupableKeys().length >= 2) {
    await groupSelection();
    return;
  }
  tool.value = "box";
  ElMessage.info("拖出一个范围就是分组框；直接点一下则放一个默认大小的");
}

function startResizeNode(e: PointerEvent, n: BoardNote) {
  e.preventDefault();
  e.stopPropagation();
  const sx = e.clientX;
  const sy = e.clientY;
  const s0 = noteSize(n);
  const move = (ev: PointerEvent) => {
    n.w = Math.max(60, Math.round(s0.w + (ev.clientX - sx) / zoom.value));
    n.h = Math.max(32, Math.round(s0.h + (ev.clientY - sy) / zoom.value));
  };
  const up = async () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    try {
      await api.updateNote(n.id, { w: n.w, h: n.h });
    } catch (err) {
      reportError("调整大小", err);
    }
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

// ---- 浮动菜单：图片右键 / 从端口拖到空白处 ----
interface FloatMenuPos {
  x: number;
  y: number;
}
const imgMenu = ref<(FloatMenuPos & { noteId: number }) | null>(null);
const typeMenu = ref<
  | (FloatMenuPos & {
      from: { kind: "task" | "note"; id: number; role: "in" | "out" };
      wx: number;
      wy: number;
    })
  | null
>(null);

/** 菜单别跑出画布 —— 在右下角右键时整块翻到光标左侧 */
function clampMenu(x: number, y: number, w = 216, h = 260): FloatMenuPos {
  const r = canvasRef.value?.getBoundingClientRect();
  const maxX = (r?.width ?? 900) - w - 10;
  const maxY = (r?.height ?? 700) - h - 10;
  return { x: Math.max(10, Math.min(x, maxX)), y: Math.max(10, Math.min(y, maxY)) };
}

function closeMenus() {
  imgMenu.value = null;
  typeMenu.value = null;
}

/** 右键图片卡片：只有图片才有"发送到文档"的意义 */
function onNoteMenu(e: MouseEvent, n: BoardNote) {
  if (kindOf(n) !== "file") return;
  const f = fileOf(n);
  if (!f || !isImageFile(f)) return;
  e.preventDefault();
  e.stopPropagation();
  const r = canvasRef.value?.getBoundingClientRect();
  if (!r) return;
  const p = clampMenu(e.clientX - r.left, e.clientY - r.top, 220, 140);
  typeMenu.value = null;
  imgMenu.value = { ...p, noteId: n.id };
}

/** 把白板上的图片发到文档：以 data URL 直接写进 Markdown，插到光标处 */
async function sendImageToDoc(n: BoardNote | undefined) {
  imgMenu.value = null;
  if (!n) return;
  const f = fileOf(n);
  if (!f) return;
  if (!store.docs.length) {
    ElMessage.warning("这个项目还没有文档，先在「文档」栏新建一篇");
    return;
  }
  try {
    const url = previews.value[f.id] || (await api.readAssetDataUrl(f.id));
    const alt = (f.name || "图片").replace(/[[\]]/g, "").trim();
    store.insertIntoDoc(`![${alt}](${url})`);
    ElMessage.success(`已把「${f.name}」发到文档光标处`);
  } catch (e) {
    reportError("发送图片到文档", e);
    ElMessage.warning("这张图读不出来，文件可能已经不在了");
  }
}

/** 菜单里用：当前右键的那张图片卡片 */
function imgMenuNote(): BoardNote | undefined {
  return imgMenu.value ? noteById(imgMenu.value.noteId) : undefined;
}
function previewFromMenu() {
  const n = imgMenuNote();
  imgMenu.value = null;
  if (n) openPreview(n);
}
async function revealFromMenu() {
  const n = imgMenuNote();
  imgMenu.value = null;
  if (n) await revealFile(n);
}

/** 端口拖到空白处时，可以就地长出哪些节点 */
type MenuKind = NodeKind | "task";

const NODE_TYPES: { kind: MenuKind; label: string; hint: string }[] = [
  { kind: "task", label: "任务", hint: "看板上会同步出现，可以继续往下拆" },
  { kind: "note", label: "便签", hint: "随手记一句" },
  { kind: "text", label: "文字", hint: "纯文字标签" },
  { kind: "mind", label: "思维导图", hint: "继续长分支" },
  { kind: "box", label: "分组框", hint: "圈一块分区" },
  { kind: "file", label: "图片 / 资料", hint: "上传一张图，自动连上" },
  { kind: "doc", label: "文档", hint: "新建一篇 Markdown" },
  { kind: "gantt", label: "甘特图", hint: "看时间轴进度" },
];

/**
 * 端点拖到空白 → 选「图片 / 资料」时，先弹文件选择框。
 * 选好文件后再建成图片节点并连回原来的节点（这里暂存菜单的位置与连线方向）。
 */
const portFileOpen = ref(false);
const portFileCtx = ref<{
  wx: number;
  wy: number;
  from: { kind: "task" | "note"; id: number; role: "in" | "out" };
} | null>(null);

function openTypeMenu(
  clientX: number,
  clientY: number,
  from: { kind: "task" | "note"; id: number; role: "in" | "out" },
  world: { x: number; y: number }
) {
  const r = canvasRef.value?.getBoundingClientRect();
  if (!r) return;
  const p = clampMenu(clientX - r.left, clientY - r.top, 232, 300);
  imgMenu.value = null;
  typeMenu.value = { ...p, from, wx: world.x, wy: world.y };
}

/** 在菜单里选的类型 → 建成节点，并按端口方向自动连上 */
async function createFromTypeMenu(kind: MenuKind) {
  const m = typeMenu.value;
  typeMenu.value = null;
  if (!m || store.currentProjectId == null) return;
  // 任务不是白板节点，走任务那条路：建成真任务，再按端口方向连上
  if (kind === "task") {
    const from = m.from;
    const id = await addTaskAt(m.wx - TASK_W / 2, m.wy - TASK_H / 2);
    if (id == null) return;
    if (from.role === "out") {
      await connect({ kind: from.kind, id: from.id }, { kind: "task", id });
    } else {
      await connect({ kind: "task", id }, { kind: from.kind, id: from.id });
    }
    return;
  }
  // 图片/资料要先让用户选文件，选完再建节点（位置与连线方向先存着）
  if (kind === "file") {
    portFileCtx.value = { wx: m.wx, wy: m.wy, from: m.from };
    portFileOpen.value = true;
    return;
  }
  let nid: number | null = null;
  if (kind === "doc") {
    try {
      const did = await api.createDoc(store.currentProjectId, "未命名文档", "");
      await store.refreshDocs();
      const d = store.docById(did);
      if (d) {
        nid = await placeDocNode(d, { x: m.wx, y: m.wy });
        store.focusDoc(d.id);
      }
    } catch (e) {
      reportError("新建文档", e);
    }
  } else {
    const s = sizeOfNode(kind, null, null);
    nid = await createNode(kind, m.wx - s.w / 2, m.wy - s.h / 2, {
      edit: kind === "note" || kind === "text" || kind === "mind",
    });
  }
  if (nid == null) return;
  if (m.from.role === "out") await connect(m.from, { kind: "note", id: nid });
  else await connect({ kind: "note", id: nid }, m.from);
  await store.refreshBoard();
}

/** 端口菜单选了「图片 / 资料」→ 用户选完文件，建成图片节点并连回原节点 */
async function onPortFilePicked(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = "";
  const ctx = portFileCtx.value;
  portFileOpen.value = false;
  portFileCtx.value = null;
  if (!ctx || !files.length) return;
  const ids = await importFiles(files, { x: ctx.wx, y: ctx.wy });
  const nid = ids[0];
  if (nid == null) return;
  if (ctx.from.role === "out") await connect(ctx.from, { kind: "note", id: nid });
  else await connect({ kind: "note", id: nid }, ctx.from);
  await store.refreshBoard();
}

/**
 * 工具栏「文档」按钮：新建一篇 Markdown + 立刻往白板上放一张卡片，
 * 并且把右边的「文档」栏打开定位到这一篇 —— 点一下就能开始写。
 */
async function addDocNode() {
  const pid = store.currentProjectId;
  if (pid == null) return null;
  try {
    const did = await api.createDoc(pid, "未命名文档", "");
    await store.refreshDocs();
    const d = store.docById(did);
    if (!d) return null;
    const nid = await placeDocNode(d, centerOfView());
    store.focusDoc(d.id);
    ElMessage.success("已新建文档，右边「文档」栏可以直接写");
    return nid;
  } catch (e) {
    reportError("新建文档", e);
    return null;
  }
}

// ---- edges ----
/** 正在拉的线：从哪个节点的哪个端口出发、光标现在在哪（都是世界坐标） */
const linking = ref<{
  kind: "task" | "note";
  id: number;
  role: "in" | "out";
  ax: number;
  ay: number;
  x: number;
  y: number;
} | null>(null);
const linkFrom = ref<{ kind: "task" | "note"; id: number } | null>(null);

/**
 * a 顺着连线能不能走到 b（判断新连线会不会绕成圈）。
 *
 * 分解边方向是子 → 父，所以这里走的是**向上的父级链**：
 * 从 a 出发顺着 to 走，能到 b 就说明 b 是 a 的祖先。
 */
function reachable(aKind: string, aId: number, bKind: string, bId: number): boolean {
  const kids = new Map<string, { kind: string; id: number }[]>();
  for (const e of store.edges) {
    // from 是子、to 是父：子的邻居是父
    const k = `${e.from_kind}:${e.from_id}`;
    const arr = kids.get(k);
    const v = { kind: e.to_kind as string, id: e.to_id };
    if (arr) arr.push(v);
    else kids.set(k, [v]);
  }
  const seen = new Set<string>([`${aKind}:${aId}`]);
  const queue = [`${aKind}:${aId}`];
  while (queue.length) {
    const cur = queue.shift() as string;
    for (const n of kids.get(cur) ?? []) {
      if (n.kind === bKind && n.id === bId) return true;
      const key = `${n.kind}:${n.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push(key);
    }
  }
  return false;
}

async function connect(
  from: { kind: "task" | "note"; id: number },
  to: { kind: string; id: number }
) {
  if (store.currentProjectId == null) return;
  if (from.kind === to.kind && from.id === to.id) return;
  const toKind = to.kind as "task" | "note";

  const same = store.edges.find(
    (e) =>
      e.from_kind === from.kind &&
      e.from_id === from.id &&
      e.to_kind === toKind &&
      e.to_id === to.id
  );
  if (same) {
    ElMessage.info("这两个卡片已经连上了");
    return;
  }

  // 反着连过一次 —— 用户其实是想调换上下级，直接把那条反过来
  const rev = store.edges.find(
    (e) =>
      e.from_kind === toKind &&
      e.from_id === to.id &&
      e.to_kind === from.kind &&
      e.to_id === from.id
  );
  // 资料 → 任务：这是"这个任务用这份材料"，也就是依据关系。
  // 其余情况按默认的分解走，用户点连线菜单可以改。
  //
  // ⚠️ 分解边的方向是**子 → 父**：from 是子级、to 是上级。
  // 箭头指向被支撑的一方，跟依据（资料→任务）、先后（前置→后续）一致。
  // 用户的操作方向仍是「先拖上级、再拖下级」，建边时反过来存。
  const autoKind: EdgeKind =
    from.kind === "note" && toKind === "task" ? "evidence" : "decompose";
  // 依据边：from 是资料、to 是任务，方向不用改。
  // 分解边：from 是上级、to 是下级，但库里存的是「子 → 父」，要对调。
  const flip = autoKind === "decompose";
  const a = flip ? { kind: toKind, id: to.id } : { kind: from.kind, id: from.id };
  const b = flip ? { kind: from.kind, id: from.id } : { kind: toKind, id: to.id };
  try {
    if (rev) {
      await api.deleteEdge(rev.id);
      await api.createEdge(store.currentProjectId, a.kind, a.id, b.kind, b.id, autoKind);
      if (autoKind === "evidence") {
        await api.setTaskRef(store.currentProjectId, to.id, from.id, 1);
      }
      await store.refreshBoard();
      ElMessage.success("已反转上下级方向（箭头指向被支撑的一方）");
      return;
    }
    // 会绕成圈：建「子 → 父」之前先看父的祖先链里有没有子。
    // reachable 走的是向上的父级链，所以是 reachable(父, 子)。
    if (reachable(from.kind, from.id, toKind, to.id)) {
      ElMessage.warning("这两个卡片已经在同一条上下级链上了，再连会绕成圈");
      return;
    }
    await api.createEdge(store.currentProjectId, a.kind, a.id, b.kind, b.id, autoKind);
    if (autoKind === "evidence") {
      // 默认等级跟着资料所在分组走：强依据→必须遵守、参考→可以参考、弱参考→仅作背景。
      // 没放进任何分组就按「必须遵守」—— 无框默认强，宁可过严再调低，
      // 反过来漏掉硬约束的代价更大。任务卡上仍可随时改档。
      const src = noteById(from.id);
      const st = src ? clusterOfNote(src) : null;
      await api.setTaskRef(
        store.currentProjectId,
        to.id,
        from.id,
        st ? CLUSTER_LEVEL[st] : 0
      );
    }
    await store.refreshBoard();
    if (autoKind === "evidence") {
      ElMessage.success("已作为依据挂到这个任务上（任务卡底部可以改等级）");
    }
  } catch (e) {
    reportError("连接节点", e);
  }
}

async function handleLinkClick(kind: "task" | "note", id: number) {
  if (!linkFrom.value) {
    linkFrom.value = { kind, id };
    ElMessage.info("已选中【上级】，再点它的【下级】卡片（箭头会从下级指向上级）");
    return;
  }
  const from = linkFrom.value;
  linkFrom.value = null;
  await connect(from, { kind, id });
}

/** 工具栏「更多」里的动作 —— 不常点，放到下拉里，主栏就清爽了 */
function onToolbarMore(cmd: string) {
  if (cmd === "mind-tasks") makeMindFromTasks();
  else if (cmd === "outline") openOutlineDialog();
  else if (cmd === "doc-pick") openDocPicker();
  else if (cmd === "png") exportBoardImage("png");
  else if (cmd === "pdf") exportBoardImage("pdf");
}

/** 端口在画布上的世界坐标：in = 左边中点，out = 右边中点 */
function portAnchor(kind: "task" | "note", id: number, role: "in" | "out") {
  const p = posOf(kind, id);
  const s = sizeAt(kind, id);
  return {
    x: role === "out" ? p.x + s.w : p.x,
    y: p.y + s.h / 2,
  };
}

/**
 * 从节点两端的圆形端口拉线（像节点式编辑器那样）：
 * - 右边「输出」：本节点是上级 —— 松手落在谁身上，谁就成为它的下级；
 * - 左边「输入」：本节点是下级 —— 松手落在谁身上，谁就成为它的上级。
 * 两种拖法都会自动判对方向，不用再记「先点谁、后点谁」。
 */
function startLinkPort(e: PointerEvent, kind: "task" | "note", id: number, role: "in" | "out") {
  e.preventDefault();
  e.stopPropagation();
  const anchor = portAnchor(kind, id, role);
  function upd(ev: PointerEvent) {
    const w = screenToWorld(ev.clientX, ev.clientY);
    linking.value = { kind, id, role, ax: anchor.x, ay: anchor.y, x: w.x, y: w.y };
  }
  async function up(ev: PointerEvent) {
    window.removeEventListener("pointermove", upd);
    window.removeEventListener("pointerup", up);
    linking.value = null;
    if (store.currentProjectId == null) return;
    const el = document
      .elementFromPoint(ev.clientX, ev.clientY)
      ?.closest("[data-node-kind]") as HTMLElement | null;
    if (!el) {
      // 松手在空白处：就地弹一个"要新建什么"的菜单，选完自动连上
      openTypeMenu(ev.clientX, ev.clientY, { kind, id, role }, screenToWorld(ev.clientX, ev.clientY));
      return;
    }
    const toKind = el.getAttribute("data-node-kind") as "task" | "note";
    const toId = Number(el.getAttribute("data-node-id"));
    if (toKind === kind && toId === id) return;
    if (role === "out") await connect({ kind, id }, { kind: toKind, id: toId });
    else await connect({ kind: toKind, id: toId }, { kind, id });
  }
  upd(e);
  window.addEventListener("pointermove", upd);
  window.addEventListener("pointerup", up);
}

function centerOf(kind: "task" | "note", id: number) {
  const p = posOf(kind, id);
  const s = sizeAt(kind, id);
  return { x: p.x + s.w / 2, y: p.y + s.h / 2 };
}

/** 从矩形中心朝目标方向，把点推到矩形边框上 —— 连线贴边走，不会画进卡片里面 */
function clipToRect(
  c: { x: number; y: number },
  toward: { x: number; y: number },
  s: { w: number; h: number }
) {
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (!dx && !dy) return { x: c.x, y: c.y };
  const hw = Math.max(1, s.w / 2);
  const hh = Math.max(1, s.h / 2);
  const k = Math.min(hw / (Math.abs(dx) || 1e-6), hh / (Math.abs(dy) || 1e-6));
  return { x: c.x + dx * k, y: c.y + dy * k };
}

/** 每条可见连线的四个端点（都吸附在节点边框上） */
const visibleEdgeGeom = computed(() =>
  visibleEdges.value.map((e) => {
    const fk = e.from_kind as "task" | "note";
    const tk = e.to_kind as "task" | "note";
    const a = centerOf(fk, e.from_id);
    const b = centerOf(tk, e.to_id);
    const p1 = clipToRect(a, b, sizeAt(fk, e.from_id));
    const p2 = clipToRect(b, a, sizeAt(tk, e.to_id));
    const g = edgeGeom(a, b, p1, p2, edgeStyle.value);
    return { e, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, d: g.d, angle: g.angle };
  })
);

function unit(dx: number, dy: number) {
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len };
}

/**
 * 连线路径。
 *
 * 直线：两个边界点直接连。
 *
 * 弧线：用**固定水平控制臂**的三次贝塞尔 —— 也就是思维导图那种 S 形：
 * 线先从卡片边缘水平走出去，中途拐弯，再水平进入目标卡片。
 * ⚠️ 不要用"沿出边法线外推"的写法：当两个卡片垂直堆叠时，法线方向和连线方向
 * 几乎重合，控制点共线，曲线就退化成直线了（手绘感全没了）。
 * 只有近乎垂直对齐（|dx| < 24）时才改用垂直臂，否则会绕出一个很怪的圈。
 */
function edgePath(
  a: { x: number; y: number },
  b: { x: number; y: number },
  p1: { x: number; y: number },
  p2: { x: number; y: number }
) {
  // 几何只有一份真源：wb.ts 的 edgeGeom —— 导出 canvas 调的也是它，
  // 否则「屏幕是弧线、导出来是直线」这种失真永远修不完。
  return edgePathShared(a, b, p1, p2, edgeStyle.value);
}

/** 拖拽中那条临时线也跟随当前样式 */
const linkingPathD = computed(() => {
  const l = linking.value;
  if (!l) return "";
  const p = { x: l.ax, y: l.ay };
  const q = { x: l.x, y: l.y };
  return edgePathShared(p, q, p, q, edgeStyle.value);
});

const nodeExists = (kind: "task" | "note", id: number) =>
  kind === "task" ? taskById(id) != null : noteById(id) != null;

const visibleEdges = computed(() =>
  store.edges.filter((e) => nodeExists(e.from_kind, e.from_id) && nodeExists(e.to_kind, e.to_id))
);

/** 点中的连线：在点击处浮出短工具条。先选中再操作，避免单击就把线删掉 */
const edgePick = ref<{ id: number; x: number; y: number } | null>(null);

/** 四种关系。默认分解，其余三种只在真要表达时才动，平时界面是干净的 */
const EDGE_KIND_META: { kind: EdgeKind; label: string; short: string; hint: string }[] = [
  {
    kind: "decompose",
    label: "父子",
    short: "父集拆出子集",
    hint: "父集 → 子集：上面是父集，往下拆出子集；父子关系会决定任务编号",
  },
  {
    kind: "precede",
    label: "先后",
    short: "前置完成才轮到",
    hint: "前置 → 后续：前一项完成，后一项才能开始（时间顺序，不是父子）",
  },
  {
    kind: "evidence",
    label: "依据",
    short: "材料支撑任务",
    hint: "材料 → 任务：这份资料是任务的依据，任务用它做事",
  },
  {
    kind: "produce",
    label: "产出",
    short: "任务交出结果",
    hint: "任务 → 成果：任务是父集，交出来的文档或成果是子集",
  },
];

/** 世界坐标 → 画布内像素（工具条不跟着缩放，所以不能用世界坐标） */
function worldToScreen(x: number, y: number) {
  return { x: x * zoom.value + panX.value, y: y * zoom.value + panY.value };
}

/** 菜单贴边处理：靠近右边界就往回收，上方不够高就翻到点击点下面 */
const edgeMenuEl = ref<HTMLElement | null>(null);
const edgeMenuFlip = ref(false);

async function placeEdgeMenu() {
  await nextTick();
  const el = edgeMenuEl.value;
  const box = canvasRef.value;
  const p = edgePick.value;
  if (!el || !box || !p) return;
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const maxX = box.clientWidth - w / 2 - 10;
  const minX = w / 2 + 10;
  const x = Math.min(maxX, Math.max(minX, p.x));
  if (x !== p.x) edgePick.value = { ...p, x };
  // 菜单默认浮在点击点上方（translate -100%），上方装不下就翻下来
  edgeMenuFlip.value = p.y - h - 16 < 6;
}

function openEdgeMenu(e: BoardEdge, ev: MouseEvent) {
  const r = canvasRef.value?.getBoundingClientRect();
  edgePick.value = {
    id: e.id,
    x: ev.clientX - (r?.left ?? 0),
    y: ev.clientY - (r?.top ?? 0),
  };
  void placeEdgeMenu();
}

const edgeMenuKind = computed<EdgeKind | "">(
  () => store.edges.find((e) => e.id === edgePick.value?.id)?.kind ?? ""
);

async function setEdgeKind(kind: EdgeKind) {
  const cur = edgePick.value;
  if (!cur) return;
  try {
    await api.updateEdge(cur.id, { kind });
    await store.refreshBoard();
  } catch (e) {
    reportError("改连线类型", e);
  }
}

/**
 * 支撑类关系的等级（强依据 / 参考 / 弱参考）。
 *
 * 「所有支撑都有等级」：子任务是父任务的依据、资料是任务的依据，
 * 两者都按这三档来。同一个资料连到两个任务，两条线可以各是各的档。
 *
 * 存储位置按关系类型分开：
 * - 依据（资料→任务）：task_refs.level（还带关注重点）
 * - 分解（子→父）：board_edges.strength
 */
const LEVEL_META = [
  { v: 0, label: "强依据", hint: "不得违反；冲突时以它为准" },
  { v: 1, label: "参考", hint: "可用于补充，不构成强制要求" },
  { v: 2, label: "弱参考", hint: "仅供理解语境，不作论据" },
];

/** 这条边算不算「支撑」（有等级可调） */
function isSupportEdge(): boolean {
  const k = edgeMenuKind.value;
  return k === "decompose" || k === "evidence";
}

/** 读当前等级：依据查 task_refs，分解查 strength */
function edgeLevel(): number {
  const cur = edgePick.value;
  if (!cur) return 1;
  const e = store.edges.find((x) => x.id === cur.id);
  if (!e) return 1;
  if (e.kind === "evidence") {
    const r = store.refsOfTask(e.to_id).find((x) => x.note_id === e.from_id);
    return r ? r.level : 1;
  }
  return e.strength ?? 0;
}

async function setEdgeLevel(level: number) {
  const cur = edgePick.value;
  if (!cur) return;
  const e = store.edges.find((x) => x.id === cur.id);
  if (!e) return;
  try {
    if (e.kind === "evidence") {
      // 依据：等级记在关系上（task_refs），同一份资料对不同任务可以不同档
      await api.setTaskRef(store.currentProjectId!, e.to_id, e.from_id, level);
    } else {
      // 分解：子任务对父任务的重要程度记在边上
      await api.updateEdge(e.id, { strength: level });
    }
    await store.refreshBoard();
  } catch (err) {
    reportError("改依据等级", err);
  }
}

/** 菜单里的删除：按当前选中的 id 删，模板里就不用写复杂表达式 */
async function removeEdgeById() {
  const id = edgePick.value?.id;
  if (id == null) return;
  const e = store.edges.find((x) => x.id === id);
  if (e) await removeEdge(e);
}

async function removeEdge(e: BoardEdge) {
  try {
    await api.deleteEdge(e.id);
    if (edgePick.value?.id === e.id) edgePick.value = null;
    await store.refreshBoard();
  } catch (err) {
    reportError("删除连线", err);
  }
}

// ---- 依据三档：等级挂在关系上，同一份资料对不同任务可以是不同档 ----
const REF_LEVELS: { v: number; label: string; hint: string }[] = [
  { v: 0, label: "必须遵守", hint: "冲突时以它为准" },
  { v: 1, label: "可以参考", hint: "没冲突时补充进来" },
  { v: 2, label: "仅作背景", hint: "只用来理解语境，不引用" },
];

function refLabel(level: number) {
  return REF_LEVELS.find((x) => x.v === level)?.label ?? "可以参考";
}

/** 资料节点在任务卡上的短名：文件名优先，其次节点文字 */
function noteLabel(noteId: number): string {
  const n = store.notes.find((x) => x.id === noteId);
  if (!n) return "资料";
  const f = n.file_id ? store.assets.find((a) => a.id === n.file_id) : null;
  const raw = (f?.name || n.text || "资料").trim() || "资料";
  return raw.length > 12 ? raw.slice(0, 11) + "…" : raw;
}

/** 点一下换一档：必须遵守 → 可以参考 → 仅作背景 → 必须遵守 */
/**
 * 依据气泡：点任务卡上的资料标签打开。
 *
 * 为什么不是"点一下循环换档"：这样点完看不出当前是第几档，也放不下要点。
 * 要点是给 AI 唯一能拿到材料内容的入口，必须有个能写字的地方。
 */
const refPick = ref<{
  taskId: number;
  noteId: number;
  level: number;
  x: number;
  y: number;
} | null>(null);
const refPoint = ref("");
const refMenuEl = ref<HTMLElement | null>(null);
const refMenuFlip = ref(false);

async function placeRefMenu() {
  await nextTick();
  const el = refMenuEl.value;
  const box = canvasRef.value;
  const p = refPick.value;
  if (!el || !box || !p) return;
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const maxX = box.clientWidth - w / 2 - 10;
  const minX = w / 2 + 10;
  const x = Math.min(maxX, Math.max(minX, p.x));
  const maxY = box.clientHeight - h - 10;
  const y = Math.max(10, Math.min(maxY, p.y));
  if (x !== p.x || y !== p.y) refPick.value = { ...p, y };
  refMenuFlip.value = false;
}

function openRefMenu(e: MouseEvent, taskId: number, noteId: number, level: number) {
  const r = canvasRef.value?.getBoundingClientRect();
  refPick.value = {
    taskId,
    noteId,
    level,
    x: e.clientX - (r?.left ?? 0),
    y: e.clientY - (r?.top ?? 0) + 18,
  };
  refPoint.value = store.refsOfTask(taskId).find((x) => x.note_id === noteId)?.point ?? "";
  void placeRefMenu();
}

function closeRefMenu() {
  refPick.value = null;
}

async function setRefLevel(level: number) {
  const p = refPick.value;
  if (!p) return;
  try {
    await store.setRef(p.taskId, p.noteId, level);
    refPick.value = { ...p, level };
  } catch (e) {
    reportError("改依据等级", e);
  }
}

async function saveRefPoint() {
  const p = refPick.value;
  if (!p) return;
  try {
    await store.setRef(p.taskId, p.noteId, p.level, refPoint.value.trim());
    ElMessage.success("要点已存，下次生成指令会带上");
    closeRefMenu();
  } catch (e) {
    reportError("保存要点", e);
  }
}

async function removeRefFromMenu() {
  const p = refPick.value;
  if (!p) return;
  closeRefMenu();
  await dropRef(p.taskId, p.noteId);
}

async function dropRef(taskId: number, noteId: number) {
  try {
    await store.dropRef(taskId, noteId);
  } catch (e) {
    reportError("移除依据", e);
  }
}

// ---- 给 AI 的指令 ----
// 拼装逻辑在 aiPrompt.ts 里（白板任务卡和看板卡片共用同一份），这里只负责打开弹窗
function openAiPrompt(t: Task) {
  openPrompt(store, t.id);
}

// ---- 树：任务 / 导图共用一套父子关系（就是白板连线） ----
function parentKeyOf(key: string): string | null {
  const { kind, id } = parseKey(key);
  const e = store.edges.find((x) => x.to_kind === kind && x.to_id === id);
  if (!e) return null;
  const exists =
    e.from_kind === "task" ? taskById(e.from_id) != null : noteById(e.from_id) != null;
  if (!exists) return null;
  return keyOf(e.from_kind as "task" | "note", e.from_id);
}

/** Tab：加下一级。任务是加子任务，便签/导图是加分支 */
async function addChildOfKey(key: string) {
  const { kind, id } = parseKey(key);
  if (kind === "task") await addChildTask(id);
  else await addChildNote(id);
}

/** Enter / Ctrl+Enter：加同级 */
async function addSiblingOfKey(key: string) {
  const { kind, id } = parseKey(key);
  const parent = parentKeyOf(key);
  if (parent) {
    await addChildOfKey(parent);
    return;
  }
  if (kind === "task") await addSiblingTask(id);
  else {
    const at = centerOfView();
    await createNode("mind", at.x, at.y, { edit: true });
  }
}

async function addChildTask(parentId: number) {
  const p = taskById(parentId);
  if (!p || store.currentProjectId == null) return;
  try {
    const nid = await api.createTask({
      project_id: p.project_id,
      column_id: p.column_id,
      title: "新子任务",
      priority: p.priority,
    });
    // 分解边方向：子 → 父（箭头指向被支撑的一方）
    await api.createEdge(store.currentProjectId, "task", nid, "task", parentId);
    await store.refreshTasks();
    // 必须把连线也刷进 store，否则紧接着的「加同级」找不到父节点
    await store.refreshBoard();
    pushOp({
      label: "新建子任务",
      undo: () => api.deleteTask(nid).then(() => store.refreshTasks()),
      redo: () => api.restoreTask(nid).then(() => store.refreshTasks()),
    });
    // 边方向是子 → 父，所以父的子级是「to_id = 父」的那些边的 from
    const kids = store.edges.filter(
      (e) => e.from_kind === "task" && e.to_id === parentId && e.to_kind === "task"
    ).length;
    const pos = posOf("task", parentId);
    const np = { x: pos.x + 260, y: pos.y + Math.max(0, kids - 1) * TASK_H + 8 };
    await api.setTaskPos(nid, np.x, np.y);
    const t = taskById(nid);
    if (t) {
      t.wx = np.x;
      t.wy = np.y;
      selectOnly("task", nid);
      await startEditTask(t);
    }
  } catch (e) {
    reportError("新建子任务", e);
  }
}

async function addSiblingTask(id: number) {
  const t = taskById(id);
  if (!t || store.currentProjectId == null) return;
  const pos = posOf("task", id);
  try {
    const nid = await api.createTask({
      project_id: t.project_id,
      column_id: t.column_id,
      title: "新任务",
      priority: t.priority,
    });
    await store.refreshTasks();
    pushOp({
      label: "新建任务",
      undo: () => api.deleteTask(nid).then(() => store.refreshTasks()),
      redo: () => api.restoreTask(nid).then(() => store.refreshTasks()),
    });
    const np = { x: pos.x, y: pos.y + TASK_H + 10 };
    await api.setTaskPos(nid, np.x, np.y);
    const nt = taskById(nid);
    if (nt) {
      nt.wx = np.x;
      nt.wy = np.y;
      selectOnly("task", nid);
      await startEditTask(nt);
    }
  } catch (e) {
    reportError("新建任务", e);
  }
}

async function addChildNote(parentId: number) {
  const p = noteById(parentId);
  if (!p) return;
  const kids = store.edges.filter(
    (e) => e.from_kind === "note" && e.to_id === parentId && e.to_kind === "note"
  ).length;
  const id = await createNode("mind", p.x + 250, p.y + kids * 62, { edit: false });
  if (id == null || store.currentProjectId == null) return;
  try {
    // 导图父子同样子 → 父，跟任务树的箭头方向保持一致
    await api.createEdge(store.currentProjectId, "note", id, "note", parentId);
    await store.refreshBoard();
    const n = noteById(id);
    if (n) await startEditNote(n);
  } catch (e) {
    reportError("添加子节点", e);
  }
}

async function ensureMindRoot() {
  const roots = store.notes.filter((n) => n.kind === "mind");
  if (roots.length) return roots[0];
  const at = centerOfView();
  const id = await createNode("mind", at.x - 90, at.y - 40, { edit: true });
  return id != null ? noteById(id) ?? null : null;
}

// ---- 整理：任务树 + 导图树一起排 ----
const mindCount = computed(() => store.notes.filter((n) => n.kind === "mind").length);

/** 会被布局吸收的挂靠节点：导图分支 + 上传的资料（便签/分组框保持用户摆的位置） */
function absorbable(key: string) {
  const { kind, id } = parseKey(key);
  if (kind !== "note") return false;
  const n = noteById(id);
  return !!n && (n.kind === "mind" || n.kind === "file");
}

async function layoutMind(silent = false) {
  const keys: string[] = [];
  const inSet = new Set<string>();
  for (const t of store.allTasks) {
    const k = keyOf("task", t.id);
    keys.push(k);
    inSet.add(k);
  }
  for (const n of store.notes) {
    if (n.kind !== "mind") continue;
    const k = keyOf("note", n.id);
    keys.push(k);
    inSet.add(k);
  }
  if (!keys.length) {
    ElMessage.warning("白板上还没有任务或导图节点");
    return;
  }
  const allEdges = store.edges.map((e) => ({
    from: keyOf(e.from_kind, e.from_id),
    to: keyOf(e.to_kind, e.to_id),
  }));
  // 把挂在树上的资料卡片也吸进来一起排
  let grew = true;
  while (grew) {
    grew = false;
    for (const e of allEdges) {
      if (inSet.has(e.from) && !inSet.has(e.to) && absorbable(e.to)) {
        inSet.add(e.to);
        keys.push(e.to);
        grew = true;
      } else if (inSet.has(e.to) && !inSet.has(e.from) && absorbable(e.from)) {
        inSet.add(e.from);
        keys.push(e.from);
        grew = true;
      }
    }
  }

  const treeEdges = allEdges.filter((e) => inSet.has(e.from) && inSet.has(e.to));
  const pos = layoutTree(keys, treeEdges, 250, 28, 72);
  const roots = keys.filter((k) => !treeEdges.some((e) => e.to === k));
  const anchorKey = roots[0] ?? keys[0];
  const base = pos.get(anchorKey);
  if (!base) return;
  const anchor = posOfKey(anchorKey);

  // 排完之后如果最上面一排落进工具栏范围，整体往下挪一挪
  const laidYs: number[] = [];
  for (const k of keys) {
    const p = pos.get(k);
    if (p) laidYs.push(anchor.y + (p.y - base.y));
  }
  const minLaidY = laidYs.length ? Math.min(...laidYs) : 0;
  const dy = minLaidY < 110 ? 110 - minLaidY : 0;

  try {
    for (const k of keys) {
      const p = pos.get(k);
      if (!p) continue;
      const x = Math.round(anchor.x + (p.x - base.x));
      const y = Math.round(anchor.y + (p.y - base.y) + dy);
      const { kind, id } = parseKey(k);
      const cur = posOf(kind, id);
      if (Math.abs(cur.x - x) < 1 && Math.abs(cur.y - y) < 1) continue;
      if (kind === "task") {
        await api.setTaskPos(id, x, y);
        const t = taskById(id);
        if (t) {
          t.wx = x;
          t.wy = y;
        }
      } else {
        await api.updateNote(id, { x, y });
        const n = noteById(id);
        if (n) {
          n.x = x;
          n.y = y;
        }
      }
    }
    if (!silent) ElMessage.success(`已重排 ${keys.length} 个节点成树`);
  } catch (e) {
    reportError("整理布局", e);
  }
}

/** 把当前看板的列 + 任务一键铺成思维导图分支 */
async function makeMindFromTasks() {
  if (store.currentProjectId == null) return;
  const pid = store.currentProjectId;
  const anchor = centerOfView();
  const mk = async (text: string, x: number, y: number, color: string) => {
    const fields = {
      project_id: pid,
      x,
      y,
      text,
      color,
      kind: "mind" as NodeKind,
      w: 190,
      h: 46,
      file_id: null as number | null,
      meta: "",
    };
    const id = await api.createNote(fields);
    pushOp(opCreate(id, fields));
    return id;
  };
  try {
    const rootId = await mk(
      store.currentProject?.name ?? "项目",
      anchor.x - 340,
      anchor.y - 60,
      "#409EFF"
    );
    let ci = 0;
    for (const c of store.columns) {
      const tasks = store.sortedCol(c.id);
      if (!tasks.length) continue;
      const cid = await mk(c.name, anchor.x, anchor.y + ci * 200 - 60, c.color || "#67C23A");
      await api.createEdge(pid, "note", rootId, "note", cid);
      let ti = 0;
      for (const t of tasks) {
        const tid = await mk(t.title, anchor.x + 250, anchor.y + ci * 200 + ti * 54 - 60, "#909399");
        await api.createEdge(pid, "note", cid, "note", tid);
        ti++;
      }
      ci++;
    }
    await store.refreshBoard();
    await layoutMind(true);
    ElMessage.success("已按看板任务生成思维导图");
  } catch (e) {
    reportError("任务转导图", e);
  }
}

// ---- 文本 / Markdown 大纲 → 思维导图 ----
const outlineOpen = ref(false);
const outlineText = ref("");
const outlineStrip = ref(true);
const outlineAttach = ref(false);
const outlineShowPreview = ref(false);

const OUTLINE_SAMPLE = `山茶间品牌
  品牌定位
    目标客群：25-35 岁都市女性
    价格带：中高端
  视觉规范
    主色：山茶红
    字体：思源宋体
门店体验
  动线设计
  陈列主题`;

const outlineParsed = computed(() =>
  parseOutline(outlineText.value, { stripMarks: outlineStrip.value })
);
const outlineCount = computed(() => outlineParsed.value.count);
const outlineStats = computed(() => {
  const r = outlineParsed.value;
  if (!r.count) return "还没识别到内容";
  const base = `${r.count} 个节点 · ${r.maxDepth} 层 · ${r.roots.length} 个顶层`;
  return r.count > 5 && r.roots.length > 5
    ? `${base}（顶层有点多，看看缩进对不对？）`
    : base;
});
/** 内容不空但顶层太碎 → 提醒一句，多半是缩进没生效 */
const outlineWarn = computed(
  () => !outlineCount.value || (outlineCount.value > 5 && outlineParsed.value.roots.length > 5)
);
const outlinePreview = computed(() => outlineToText(outlineParsed.value.roots));

/**
 * 指定「这份大纲要挂到哪个节点下面」。
 * 为 null 时用当前选中的节点 —— 从文档卡片点「🧠 转导图」进来时要显式指定，
 * 否则用户可能已经点别的地方去了，挂错节点。
 */
const outlineAttachKey = ref<{ kind: "task" | "note"; id: number } | null>(null);

/** 当前选中的节点（可以把整份大纲挂到它下面） */
const outlineAttachTarget = computed(() => outlineAttachKey.value ?? primary.value);
const outlineAttachLabel = computed(() => {
  const t = outlineAttachTarget.value;
  if (!t) return "";
  const label =
    t.kind === "task" ? taskById(t.id)?.title ?? "" : noteById(t.id)?.text || "";
  return label ? label.slice(0, 12) : "选中的节点";
});

function openOutlineDialog(prefill = "") {
  if (prefill) outlineText.value = prefill;
  outlineOpen.value = true;
  outlineShowPreview.value = false;
  outlineAttach.value = false;
  outlineAttachKey.value = null;
}

function fillOutlineSample() {
  outlineText.value = OUTLINE_SAMPLE;
  outlineShowPreview.value = false;
}

async function onOutlineFilePicked(e: Event) {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0];
  input.value = "";
  if (!f) return;
  if (f.size > 2 * 1024 * 1024) {
    ElMessage.warning("文件超过 2MB 了，先截一段再粘进来吧");
    return;
  }
  try {
    outlineText.value = await f.text();
    outlineShowPreview.value = false;
  } catch (err) {
    reportError("读取大纲文件", err);
  }
}

interface OutlineBuild {
  noteIds: number[];
  box: { x0: number; y0: number; x1: number; y1: number };
}

/**
 * 按解析结果在画布上铺出 mind 节点 + 父子连线。
 * 位置先用 layoutTree 按临时 key 算好，再整体平移到落点。
 */
async function createOutlineOnBoard(): Promise<OutlineBuild | null> {
  const pid = store.currentProjectId;
  if (pid == null) return null;
  const res = outlineParsed.value;
  if (!res.count) return null;

  const flat = flattenOutline(res.roots);
  const keys = flat.map((f) => f.key);
  const treeEdges = flat
    .filter((f) => f.parentKey)
    .map((f) => ({ from: f.parentKey as string, to: f.key }));
  const pos = layoutTree(keys, treeEdges, 250, 28, 72);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const k of keys) {
    const p = pos.get(k);
    if (!p) continue;
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + 190);
    maxY = Math.max(maxY, p.y + 46);
  }
  if (!isFinite(minX)) return null;

  const attach = outlineAttach.value ? outlineAttachTarget.value : null;
  let ax: number;
  let ay: number;
  if (attach) {
    const ap = posOf(attach.kind, attach.id);
    const as = sizeAt(attach.kind, attach.id);
    ax = Math.round(ap.x + as.w + 60);
    ay = Math.round(ap.y);
  } else {
    const c = centerOfView();
    ax = Math.round(c.x - (maxX - minX) / 2);
    ay = Math.round(c.y - (maxY - minY) / 2);
  }

  const idByKey = new Map<string, number>();
  const ids: number[] = [];
  const noteFieldsOf = (f: { key: string; text: string; depth: number }) => {
    const p = pos.get(f.key) ?? { x: 0, y: 0 };
    return {
      project_id: pid,
      x: ax + Math.round(p.x - minX),
      y: ay + Math.round(p.y - minY),
      text: f.text,
      color: f.depth === 0 ? "#409EFF" : f.depth === 1 ? "#67C23A" : "#909399",
      kind: "mind" as NodeKind,
      w: 190,
      h: 46,
      file_id: null as number | null,
      meta: "",
    };
  };
  // 分批并发创建，节点多的时候不至于一个一个等 IPC
  for (let i = 0; i < flat.length; i += 16) {
    const chunk = flat.slice(i, i + 16);
    const got = await Promise.all(chunk.map((f) => api.createNote(noteFieldsOf(f))));
    chunk.forEach((f, k) => {
      idByKey.set(f.key, got[k]);
      ids.push(got[k]);
    });
  }
  const edgePairs: [number, number][] = [];
  for (const f of flat) {
    if (!f.parentKey) continue;
    const a = idByKey.get(f.parentKey);
    const b = idByKey.get(f.key);
    if (a != null && b != null) edgePairs.push([a, b]);
  }
  if (attach) {
    for (const f of flat) {
      if (f.parentKey) continue;
      const b = idByKey.get(f.key);
      if (b != null) edgePairs.push([attach.id, b]);
    }
  }
  for (let i = 0; i < edgePairs.length; i += 16) {
    const chunk = edgePairs.slice(i, i + 16);
    await Promise.all(
      chunk.map(([a, b]) => api.createEdge(pid, "note", a, "note", b))
    );
  }

  return {
    noteIds: ids,
    box: { x0: ax, y0: ay, x1: ax + (maxX - minX), y1: ay + (maxY - minY) },
  };
}

/** 把视口对到一块矩形上（生成完直接让用户看见新导图） */
function focusRect(x0: number, y0: number, x1: number, y1: number) {
  const r = canvasRef.value?.getBoundingClientRect();
  const w = x1 - x0;
  const h = y1 - y0;
  if (!r || w <= 0 || h <= 0) return;
  const padTop = 130;
  const pad = 70;
  const z = Math.min(
    1.2,
    Math.max(0.3, Math.min((r.width - pad * 2) / w, (r.height - padTop - pad) / h))
  );
  zoom.value = z;
  panX.value = (r.width - w * z) / 2 - x0 * z;
  panY.value = padTop + (r.height - padTop - pad - h * z) / 2 - y0 * z;
}

async function buildOutlineOnBoard() {
  if (!outlineCount.value) {
    ElMessage.warning("先粘一段大纲文本，或者打开一个 md / txt 文件");
    return;
  }
  try {
    const built = await createOutlineOnBoard();
    if (!built) return;
    await store.refreshBoard();
    let live = built.noteIds;
    pushOp({
      label: "文本转导图",
      undo: async () => {
        for (const id of live) await api.deleteNote(id);
        await store.refreshBoard();
      },
      redo: async () => {
        const again = await createOutlineOnBoard();
        if (again) live = again.noteIds;
        await store.refreshBoard();
      },
    });
    outlineOpen.value = false;
    await nextTick();
    focusRect(built.box.x0, built.box.y0, built.box.x1, built.box.y1);
    ElMessage.success(`已按大纲生成 ${built.noteIds.length} 个导图节点`);
  } catch (e) {
    reportError("文本转导图", e);
  }
}

// 白板上传的 md / txt 资料，也能一键丢进这个对话框
const OUTLINE_FILE_EXTS = ["md", "markdown", "txt", "text", "log", "adoc"];
function isTextOutlineNode(n: BoardNote) {
  const f = store.fileById(n.file_id);
  if (!f) return false;
  return OUTLINE_FILE_EXTS.includes((f.ext || "").toLowerCase());
}
function b64ToText(dataUrl: string): string {
  const i = dataUrl.indexOf(",");
  const b64 = i >= 0 ? dataUrl.slice(i + 1) : dataUrl;
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return "";
  }
}
async function outlineFromFile(n: BoardNote) {
  const f = store.fileById(n.file_id);
  if (!f) return;
  try {
    const url = await api.readAssetDataUrl(f.id);
    const txt = b64ToText(url);
    if (!txt.trim()) {
      ElMessage.warning("这个文件没读出文字（可能是编码不常见）");
      return;
    }
    openOutlineDialog(txt.slice(0, 200000));
    ElMessage.info("内容已填入对话框，确认无误后点「生成导图」");
  } catch (e) {
    reportError("读取资料内容", e);
  }
}

/**
 * 把上传的 .md / .txt 资料「转成文档」：读出内容建成写作栏里的正式文档，
 * 再把这张资料卡片换成文档卡片。之后就能在白板上直接改，不再是只读附件。
 * 原来的资料实体保留（不删文件），只是卡片指向变了。
 */
async function fileToDoc(n: BoardNote) {
  const pid = store.currentProjectId;
  const f = store.fileById(n.file_id);
  if (pid == null || !f) return;
  try {
    const url = await api.readAssetDataUrl(f.id);
    const txt = b64ToText(url);
    if (!txt.trim()) {
      ElMessage.warning("这个文件没读出文字（可能是编码不常见）");
      return;
    }
    const title = (f.name || "未命名文档").replace(/\.(md|markdown|txt|text|log)$/i, "");
    const docId = await api.createDoc(pid, title, txt);
    await store.refreshDocs();
    const d = store.docById(docId);
    if (!d) return;
    const fields = docNoteFields(pid, d, n.x, n.y, sizeOfNode("doc", null, null));
    const meta = fields.meta;
    await api.updateNote(n.id, {
      kind: "doc",
      text: title,
      color: "#FFFFFF",
      file_id: null,
      meta,
    });
    await store.refreshBoard();
    const nn = noteById(n.id);
    if (nn) await startEditNote(nn);
    ElMessage.success("已转成文档，双击卡片就能在白板里改");
  } catch (e) {
    reportError("转成文档", e);
  }
}

// ---- 文档节点：白板 ↔ 写作模块的 Markdown 文档 ----

/** 这张卡片指向哪篇文档 */
function docOf(n: BoardNote): Doc | undefined {
  return store.docById(docIdOf(n));
}

/**
 * 文档卡片的展示数据（摘要 / 字数 / 标题数），**按 doc_id 缓存**。
 *
 * 为什么不能直接在模板里调 `docSummary(doc.body)`：
 * 模板里的方法调用每次重渲染都会跑一遍，而拖动卡片是每帧都重渲染的 ——
 * 一篇 3 万字的文档算一次约 1ms，10 张卡片拖起来就是每帧 10ms，直接掉帧。
 * 放进 computed 之后，只有「文档内容变了」才重算，拖动时是零开销。
 * 同一篇文档被多张卡片引用时也只算一次（`m.has(id)` 去重）。
 */
interface DocCardMeta {
  title: string;
  summary: string;
  chars: number;
  headings: number;
}

const docCardMeta = computed(() => {
  const m = new Map<number, DocCardMeta>();
  for (const n of store.notes) {
    const id = docIdOf(n);
    if (id == null || m.has(id)) continue;
    const d = store.docById(id);
    if (!d) continue;
    const st = docStats(d.body);
    m.set(id, {
      title: d.title,
      summary: docSummary(d.body),
      chars: st.chars,
      headings: st.headings,
    });
  }
  return m;
});

/** 取某张文档卡片的缓存展示数据（没有 = 原文档已删） */
function docCardOf(n: BoardNote): DocCardMeta | undefined {
  const id = docIdOf(n);
  return id == null ? undefined : docCardMeta.value.get(id);
}

/** 放一张文档卡片到画布（写作栏拖过来 / 工具栏选文档 / 从别的卡片复制都用它） */
async function placeDocNode(doc: Doc, at: { x: number; y: number }) {
  const pid = store.currentProjectId;
  if (pid == null || !doc) return null;
  const s = sizeOfNode("doc", null, null);
  const fields = docNoteFields(pid, doc, at.x - s.w / 2, at.y - 40, s);
  try {
    const id = await api.createNote(fields);
    pushOp(opCreate(id, fields));
    await store.refreshBoard();
    selectOnly("note", id);
    return id;
  } catch (e) {
    reportError("放文档卡片", e);
    return null;
  }
}

/** 工具栏「📄 插入文档」：挑一篇已有文档放上来；一篇都没有就问要不要新建 */
const docPickOpen = ref(false);
const docPickTarget = ref<{ kind: "task" | "note"; id: number } | null>(null);

function openDocPicker(parent: { kind: "task" | "note"; id: number } | null = null) {
  docPickTarget.value = parent;
  docPickOpen.value = true;
}

async function pickDoc(doc: Doc) {
  const parent = docPickTarget.value;
  docPickOpen.value = false;
  docPickTarget.value = null;
  let at: { x: number; y: number };
  if (parent) {
    const p = posOf(parent.kind, parent.id);
    const sz = sizeAt(parent.kind, parent.id);
    at = { x: p.x + sz.w + 70, y: p.y };
  } else {
    at = centerOfView();
  }
  const id = await placeDocNode(doc, at);
  if (id && parent) {
    await api.createEdge(store.currentProjectId as number, parent.kind, parent.id, "note", id);
    await store.refreshBoard();
  }
}

/** 在文档卡片上就地编辑正文：弹窗里用所见即所得编辑器写，改完直接落 docs 表 */
const docEditOpen = ref(false);
const docEditId = ref<number | null>(null);
const docEditTitle = ref("");
const docEditBody = ref("");
const docEditRef = ref<InstanceType<typeof MdEditor> | null>(null);

function openDocEditor(n: BoardNote) {
  const d = docOf(n);
  if (!d) {
    ElMessage.warning("这篇文档已经被删除了");
    return;
  }
  docEditId.value = d.id;
  docEditTitle.value = d.title;
  docEditBody.value = d.body;
  docEditOpen.value = true;
}

async function saveDocEditor() {
  const id = docEditId.value;
  if (id == null) return;
  const title = docEditTitle.value.trim() || "未命名文档";
  // ⚠️ 必须向编辑器要当前值，不能信 docEditBody：
  // Vditor 的 input 回调有防抖，弹窗里刚打完字立刻点保存时它可能还没触发，
  // 那样存下去的就是打开弹窗那一刻的旧内容（用户会以为"保存没生效"）。
  const body = docEditRef.value?.getValue() ?? docEditBody.value;
  docEditBody.value = body;
  try {
    await api.updateDoc(id, { title, body });
    const d = store.docById(id);
    if (d) {
      d.title = title;
      d.body = body;
      d.updated_at = new Date().toLocaleString("sv-SE");
    }
    // 卡片上的标题快照跟着改，导出图片 / 大纲时才不会显示旧名字
    for (const n of store.notes) {
      if (docIdOf(n) === id) {
        await api.updateNote(n.id, { text: title });
        n.text = title;
      }
    }
    docEditOpen.value = false;
    // 通知写作栏：这篇正文变了，它正开着同一篇的话要跟着刷新
    store.touchDoc(id);
    ElMessage.success("文档已保存");
  } catch (e) {
    reportError("保存文档", e);
  }
}

/** 「↗ 去写作栏打开」：切到写作栏并定位到这篇文档 */
function gotoWriteDoc(n: BoardNote) {
  const d = docOf(n);
  if (!d) {
    ElMessage.warning("这篇文档已经被删除了");
    return;
  }
  store.focusDoc(d.id);
}

/** 文档 → 思维导图：把正文按标题 / 缩进层级铺成导图，根节点挂在这张卡片下面 */
async function mindFromDoc(n: BoardNote) {
  const d = docOf(n);
  if (!d) {
    ElMessage.warning("这篇文档已经被删除了");
    return;
  }
  const body = d.body.trim();
  if (!body) {
    ElMessage.warning("文档还是空的，先写点内容再转导图");
    return;
  }
  openOutlineDialog(body.slice(0, 200000));
  outlineAttach.value = true;
  // 显式指定挂到这张文档卡片下面（不能依赖"当前选中"，用户可能已经点去别处了）
  outlineAttachKey.value = { kind: "note", id: n.id };
  ElMessage.info("已把这篇文档的正文填进对话框，确认后点「生成导图」");
}

/** 任意节点 → 写入文档：把节点文字追加进某篇 Markdown（反方向） */
const docWriteOpen = ref(false);
const docWriteChunk = ref("");
const docWriteFrom = ref<{ kind: "task" | "note"; id: number } | null>(null);

function openDocWriter(kind: "task" | "note", id: number) {
  const t = kind === "task" ? taskById(id) : undefined;
  const n = kind === "note" ? noteById(id) : undefined;
  const text =
    kind === "task"
      ? [t?.title ?? "", t?.description ?? ""].filter(Boolean).join("\n\n")
      : (n?.text ?? "");
  if (!text.trim()) {
    ElMessage.warning("这个节点还没有内容");
    return;
  }
  docWriteFrom.value = { kind, id };
  docWriteChunk.value = text.trim();
  docWriteOpen.value = true;
}

async function confirmWriteIntoDoc(doc: Doc) {
  const pid = store.currentProjectId;
  if (pid == null || !doc) return;
  try {
    // 没选已有文档时，把标题也带上，读起来更像一节正文
    const withHead = docWriteChunk.value.includes("\n")
      ? `## ${doc.title || "小节"}\n\n${docWriteChunk.value}`
      : `- ${docWriteChunk.value}`;
    const next = appendToBody(doc.body, withHead);
    await api.updateDoc(doc.id, { body: next });
    doc.body = next;
    doc.updated_at = new Date().toLocaleString("sv-SE");
    docWriteOpen.value = false;
    ElMessage.success(`已写入「${doc.title || "未命名文档"}」`);

    // 顺手在白板上放一张卡片指向它（还没有指向这篇文档的卡片时才放）
    const hasNode = store.notes.some((x) => docIdOf(x) === doc.id);
    if (!hasNode && docWriteFrom.value) {
      const at = centerOfView();
      await placeDocNode(doc, at);
    }
  } catch (e) {
    reportError("写入文档", e);
  }
}

/** 在弹窗里当场新建一篇文档并写入 */
async function createDocAndWrite() {
  const pid = store.currentProjectId;
  if (pid == null) return;
  try {
    const { value } = await ElMessageBox.prompt("新文档标题", "新建文档并写入", {
      confirmButtonText: "新建并写入",
      cancelButtonText: "取消",
      inputPlaceholder: docWriteChunk.value.slice(0, 20) || "未命名文档",
      inputValue: docWriteChunk.value.slice(0, 20) || "未命名文档",
    });
    const title = String(value || "").trim() || "未命名文档";
    const id = await api.createDoc(pid, title, `${docWriteChunk.value}\n`);
    await store.refreshDocs();
    const d = store.docById(id);
    docWriteOpen.value = false;
    if (d) {
      await placeDocNode(d, centerOfView());
      ElMessage.success("已新建文档并放了一张卡片到白板");
    }
  } catch {
    /* 用户取消 */
  }
}

/** 「📥 收内容」：列出白板上能搬进这篇文档的节点，点一个就追加进去 */
const docCollectOpen = ref(false);
const docCollectDoc = ref<Doc | null>(null);

const docCollectItems = computed(() => {
  const out: { key: string; kind: string; text: string; kindLabel: string }[] = [];
  for (const n of store.notes) {
    const k = kindOf(n);
    if (k === "doc" || k === "gantt") continue;
    const text = k === "file" ? labelOf(n) : n.text;
    if (!text || !text.trim()) continue;
    out.push({
      key: keyOf("note", n.id),
      kind: "note",
      text: text.trim(),
      kindLabel: k === "file" ? "资料" : k === "mind" ? "导图" : k === "text" ? "文本" : "便签",
    });
  }
  for (const t of store.allTasks) {
    const text = [t.title, t.description].filter(Boolean).join("\n\n");
    if (!text.trim()) continue;
    out.push({ key: keyOf("task", t.id), kind: "task", text: text.trim(), kindLabel: "任务" });
  }
  return out;
});

function openDocWriterTo(n: BoardNote) {
  const d = docOf(n);
  if (!d) {
    ElMessage.warning("这篇文档已经被删除了");
    return;
  }
  docCollectDoc.value = d;
  docCollectOpen.value = true;
}

/** 点某个节点 → 把它写进目标文档（复用 appendToBody 的空行分隔） */
async function collectNodeInto(key: string) {
  const d = docCollectDoc.value;
  const item = docCollectItems.value.find((x) => x.key === key);
  if (!d || !item) return;
  try {
    const bullet = item.text.includes("\n") ? `### ${item.text.split("\n")[0]}\n\n${item.text}` : `- ${item.text}`;
    const next = appendToBody(d.body, bullet);
    await api.updateDoc(d.id, { body: next });
    d.body = next;
    d.updated_at = new Date().toLocaleString("sv-SE");
    ElMessage.success(`已收进「${d.title || "未命名文档"}」`);
  } catch (e) {
    reportError("收内容到文档", e);
  }
}

// ---- 节点 ↔ 资料：引用 / 溯源 / 反查 ----

/** 便签上记的"来自哪份资料" */
function sourceOf(n: BoardNote) {
  return parseSource(n.meta);
}

/** 点便签上的 📍 来源标记 → 回去看原资料 */
async function openSource(n: BoardNote) {
  const s = sourceOf(n);
  if (!s) return;
  const f = store.fileById(s.file_id);
  if (!f) {
    ElMessage.warning("原资料已经被删掉了");
    return;
  }
  previewTarget.value = f;
  previewOpen.value = true;
}

/** 预览弹窗里点「引用到白板」 */
async function onCite(payload: { file: WbFile; quote: string }) {
  const pid = store.currentProjectId;
  if (pid == null) return;
  const f = payload.file;
  const quote = (payload.quote || "").trim();
  const sel = primary.value;
  let x: number;
  let y: number;
  let parent: { kind: "task" | "note"; id: number } | null = null;
  if (sel) {
    const p = posOf(sel.kind, sel.id);
    const s = sizeAt(sel.kind, sel.id);
    x = p.x + s.w + 60;
    y = p.y;
    parent = { kind: sel.kind, id: sel.id };
  } else {
    const c = centerOfView();
    x = c.x - 120;
    y = c.y - 60;
  }
  const text = quote || f.name;
  const meta = JSON.stringify({ src: { file_id: f.id, name: f.name, quote } });
  try {
    const fields = {
      project_id: pid,
      x: Math.round(x),
      y: Math.round(y),
      text,
      color: "#FFF9C4",
      kind: "note" as NodeKind,
      w: 250,
      h: quote.length > 60 ? 180 : 132,
      file_id: null as number | null,
      meta,
    };
    const id = await api.createNote(fields);
    pushOp(opCreate(id, fields));
    if (parent) await api.createEdge(pid, parent.kind, parent.id, "note", id);
    await store.refreshBoard();
    previewOpen.value = false;
    selectOnly("note", id);
    ElMessage.success(quote ? "已把这一段引到白板" : "已把这份资料引到白板");
  } catch (e) {
    reportError("引用到白板", e);
  }
}

/** 反查：这份资料被哪些节点引用了 */
const refsOpen = ref(false);
const refsFile = ref<WbFile | null>(null);
const refsList = computed(() => {
  const f = refsFile.value;
  if (!f) return [] as { key: string; label: string; kind: string }[];
  const out: { key: string; label: string; kind: string }[] = [];
  for (const n of store.notes) {
    // 1) 直接作为资料卡片挂着的
    if (n.file_id === f.id) {
      out.push({ key: keyOf("note", n.id), label: n.text || f.name, kind: "资料卡片" });
      continue;
    }
    // 2) 从它引出来的便签
    const s = parseSource(n.meta);
    if (s && s.file_id === f.id) {
      const t = (s.quote || n.text || "").replace(/\s+/g, " ").slice(0, 26);
      out.push({ key: keyOf("note", n.id), label: t || "（便签）", kind: "引用便签" });
    }
  }
  return out;
});

function showRefs(n: BoardNote) {
  const f = store.fileById(n.file_id);
  if (!f) return;
  refsFile.value = f;
  refsOpen.value = true;
}

function jumpToRef(key: string) {
  const { kind, id } = parseKey(key);
  selectOnly(kind, id);
  const p = posOf(kind, id);
  const s = sizeAt(kind, id);
  const r = canvasRef.value?.getBoundingClientRect();
  if (r) {
    zoom.value = Math.max(0.8, Math.min(1.4, zoom.value));
    panX.value = r.width / 2 - (p.x + s.w / 2) * zoom.value;
    panY.value = r.height / 2 - (p.y + s.h / 2) * zoom.value;
  }
  refsOpen.value = false;
}

// ---- 导出：白板 / 导图 → PNG / PDF ----
/** 把当前白板（任务 + 各类节点 + 连线）翻译成画布要的"场景" */
async function buildScene() {
  const nodes: ExportNode[] = [];
  const elOf = (kind: "task" | "note", id: number) =>
    canvasRef.value?.querySelector(
      `[data-node-kind="${kind}"][data-node-id="${id}"]`
    ) as HTMLElement | null;
  /** 文字样式在子元素上，父元素只有背景/圆角/阴影 */
  const TEXT_SEL: Record<string, string> = {
    note: ".note-text",
    mind: ".mind-text",
    text: ".text-body",
    doc: ".doc-head",
    file: ".file-name",
    gantt: "",
    box: ".box-title",
    task: ".tn-title",
  };
  const domStyle = (kind: "task" | "note", id: number, k: string) =>
    readNodeStyle(elOf(kind, id), TEXT_SEL[k] ?? "");
  /** 真实渲染尺寸：任务卡高度是内容撑开的，写死常量会和屏幕对不上 */
  const domSize = (kind: "task" | "note", id: number, dw: number, dh: number) => {
    const el = elOf(kind, id);
    return { w: el?.offsetWidth || dw, h: el?.offsetHeight || dh };
  };

  for (const t of store.allTasks) {
    const p = posOf("task", t.id);
    const size = domSize("task", t.id, TASK_W, TASK_H);
    const pr = prio(t);
    // 屏幕上 .tn-sub 那一行：列名 · 优先级 · 截止 · 子节点数
    const sub: string[] = [];
    const cn = colName(t);
    if (cn) sub.push(cn);
    if (t.priority !== 2) sub.push(pr.label);
    if (t.due_date) sub.push("📅");
    const kids = store.taskChildCount(t.id);
    if (kids) sub.push(`▸ ${kids}`);
    nodes.push({
      kind: "task",
      x: p.x,
      y: p.y,
      w: size.w,
      h: size.h,
      title: t.title,
      body: t.description,
      accent: pr.color,
      done: !!t.completed_at,
      sub,
      subColor: pr.color,
      // 编号与依据都要画进导出图，屏幕上有的缺一个就对不上
      seq: numOf(t),
      refs: store.refsOfTask(t.id).map((r) => ({
        label: noteLabel(r.note_id),
        level: r.level,
      })),
      style: domStyle("task", t.id, "task"),
    });
  }
  const imgJobs: Promise<void>[] = [];
  for (const n of store.notes) {
    const p = posOf("note", n.id);
    const natural = noteSize(n);
    const size = domSize("note", n.id, natural.w, natural.h);
    const k = kindOf(n);
    const node: ExportNode = {
      kind: k,
      x: p.x,
      y: p.y,
      w: size.w,
      h: size.h,
      title: k === "file" ? labelOf(n) : n.text,
      color: n.color,
      // 分组框的强度标签要跟着进导出图，否则图和屏幕差一块
      cluster: k === "box" ? strengthOf(n) : null,
      style: domStyle("note", n.id, k),
    };
    if (k === "mind") node.shape = lookOf(n).shape === "circle" ? "circle" : "capsule";
    if (k === "doc") {
      const d = docCardOf(n);
      node.title = d?.title || n.text || "（文档已删除）";
      node.summary = d?.summary || "";
    }
    if (k === "file") {
      node.body = sizeTextOf(n);
      const url = previewOf(n);
      if (url) {
        imgJobs.push(
          loadImage(url).then((img) => {
            node.image = img;
          })
        );
      }
    }
    nodes.push(node);
  }
  await Promise.all(imgJobs);
  // 中文字体没就绪就画，换行位置会和屏幕对不上
  await ensureFontsReady();

  // 连线几何直接用屏幕上那一份：同一条 SVG path（曲线/直线）+ 同一套箭头方向
  const host = canvasRef.value ?? document.documentElement;
  const cs = getComputedStyle(host);
  const varOf = (name: string, fallback: string) =>
    cs.getPropertyValue(name).trim() || fallback;
  const EDGE_COLOR: Record<string, string> = {
    decompose: varOf("--edge-parent", "#a8b6c8"),
    precede: varOf("--edge-order", "#cf8a28"),
    evidence: varOf("--edge-source", "#2f9e6a"),
    produce: varOf("--edge-output", "#7a5cc4"),
  };
  // 线宽跟屏幕上的 .edge-line.k-* 对齐，否则导出图里四种关系会挤成一样粗细
  const EDGE_W: Record<string, number> = {
    decompose: 1.6,
    precede: 2.4,
    evidence: 1.8,
    produce: 3.4,
  };
  const lines: ExportLine[] = visibleEdgeGeom.value.map((g) => ({
    d: g.d,
    x1: g.x1,
    y1: g.y1,
    x2: g.x2,
    y2: g.y2,
    angle: g.angle,
    color: EDGE_COLOR[g.e.kind] ?? EDGE_COLOR.decompose,
    width: EDGE_W[g.e.kind] ?? 1.7,
    kind: g.e.kind,
  }));

  const bg =
    cs.backgroundColor && cs.backgroundColor !== "rgba(0, 0, 0, 0)" ? cs.backgroundColor : "#ffffff";

  return { nodes, lines, bg, title: store.currentProject?.name ?? "白板" };
}

async function exportBoardImage(kind: "png" | "pdf") {
  if (!store.allTasks.length && !store.notes.length) {
    ElMessage.warning("白板还是空的，没东西可导");
    return;
  }
  try {
    const scene = await buildScene();
    // 2 倍分辨率：投影/打印也不糊
    const canvas = renderScene(scene, 2);
    const base = safeFileName(`${store.currentProject?.name ?? "白板"}-白板`);
    if (kind === "png") {
      const blob = await canvasToBlob(canvas);
      downloadBlob(blob, `${base}.png`);
      ElMessage.success(`已导出图片 ${canvas.width}×${canvas.height}`);
    } else {
      const bytes = await canvasToPdf(canvas);
      downloadBlob(new Blob([bytes as unknown as BlobPart], { type: "application/pdf" }), `${base}.pdf`);
      ElMessage.success("已导出 PDF（单页，按长边排版）");
    }
  } catch (e) {
    reportError("导出白板", e);
  }
}

// ---- 上传资料 ----
/** 上传对话框：所有入口统一走它，里面放「看得见」的原生 file input */
const uploadOpen = ref(false);
const uploadTarget = ref<{ kind: "task" | "note"; id: number } | null>(null);
const previews = ref<Record<number, string>>({});
const pendingPreview = new Set<number>();

// 资料预览弹窗
const previewOpen = ref(false);
const previewTarget = ref<WbFile | null>(null);
function openPreview(n: BoardNote) {
  const f = fileOf(n);
  if (!f) {
    ElMessage.warning("找不到这份资料（可能已被删除）");
    return;
  }
  previewTarget.value = f;
  previewOpen.value = true;
}

/**
 * 上传入口：不再用 JS 调 input.click()。
 * 旧方案（隐藏 input + 程序化 click）在个别 Edge 环境会被静默拦截——
 * 系统弹窗压根不出现，只能靠超时提示，用户看到的就是「点了没反应」。
 * 现在统一弹应用内对话框，里面的 file input 由用户直接点击，是真控件，
 * 不存在被拦的空间（和 GitHub / 微信网页版的自定义上传按钮同一原理）。
 */
function pickFiles() {
  uploadTarget.value = null;
  uploadOpen.value = true;
}

/** 把资料挂到某个节点下（上传完自动连线成子节点） */
function pickFilesFor(kind: "task" | "note", id: number) {
  uploadTarget.value = { kind, id };
  uploadOpen.value = true;
}

async function onDialogFiles(e: Event) {
  uploadOpen.value = false;
  await onFilesPicked(e);
}

async function onFilesPicked(e: Event) {
  const el = e.target as HTMLInputElement;
  const files = Array.from(el.files ?? []);
  el.value = "";
  const target = uploadTarget.value;
  uploadTarget.value = null;
  if (!files.length) return;
  if (target) await importFilesAsChildren(files, target);
  else await importFiles(files);
}

async function ensurePreview(fileId: number, size: number) {
  if (previews.value[fileId] !== undefined || pendingPreview.has(fileId)) return;
  if (size > 14 * 1024 * 1024) {
    previews.value = { ...previews.value, [fileId]: "" };
    return;
  }
  pendingPreview.add(fileId);
  try {
    const url = await api.readAssetDataUrl(fileId);
    previews.value = { ...previews.value, [fileId]: url };
  } catch {
    previews.value = { ...previews.value, [fileId]: "" };
  } finally {
    pendingPreview.delete(fileId);
  }
}

watch(
  () => store.notes.map((n) => `${n.kind}:${n.file_id ?? ""}`).join("|"),
  () => {
    for (const n of store.notes) {
      if (n.kind !== "file" || !n.file_id) continue;
      const f = store.fileById(n.file_id);
      if (f && isImageFile(f)) void ensurePreview(f.id, f.size);
    }
  },
  { immediate: true }
);

/** 上传一份文件，返回记录与建议尺寸 */
/** 文件内容指纹：同一份文件第二次拖进来时直接复用已有的资产，不重复占空间 */
async function sha256Of(file: File): Promise<string> {
  try {
    const buf = await file.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return "";
  }
}

/** 按资料记录算出卡片建议尺寸 */
async function sizeForFile(rec: WbFile, dataUrl?: string): Promise<{ w: number; h: number }> {
  if (!isImageFile(rec)) return { w: 240, h: 96 };
  let url = dataUrl;
  if (!url) {
    try {
      url = await api.readAssetDataUrl(rec.id);
    } catch {
      url = undefined;
    }
  }
  const dim = url ? await imageSize(url) : null;
  if (!dim) return { w: 240, h: 200 };
  const s = Math.min(260 / dim.w, 210 / dim.h, 1);
  return {
    w: Math.max(90, Math.round(dim.w * s)),
    h: Math.max(50, Math.round(dim.h * s)) + 34,
  };
}

async function uploadOne(pid: number, f: File) {
  const hash = await sha256Of(f);
  if (hash) {
    const hit = await api.findAssetByHash(pid, hash);
    if (hit) {
      const size = await sizeForFile(hit);
      ElMessage.info(`「${f.name}」之前传过，直接复用同一份资料`);
      return { rec: hit, ...size };
    }
  }
  const dataUrl = await readAsDataURL(f);
  const rec: WbFile = await api.importAsset(pid, f.name, f.type || "", dataUrl, hash);
  const size = await sizeForFile(rec, dataUrl);
  return { rec, ...size };
}

async function importFiles(files: File[], at?: { x: number; y: number }): Promise<number[]> {
  const pid = store.currentProjectId;
  if (pid == null) {
    ElMessage.warning("先在左侧选一个项目，再把资料放上来");
    return [];
  }
  let placed = 0;
  const made: number[] = [];
  const p0 = at ?? centerOfView();
  const startX = Math.round(p0.x - 80);
  const cursor = { x: startX, y: Math.round(p0.y - 40) };
  for (const f of files) {
    if (f.size > 64 * 1024 * 1024) {
      ElMessage.warning(`「${f.name}」超过 64MB，已跳过`);
      continue;
    }
    try {
      const { rec, w, h } = await uploadOne(pid, f);
      if (cursor.x > startX + 1020) {
        cursor.x = startX;
        cursor.y += 260;
      }
      const fields = {
        project_id: pid,
        x: cursor.x,
        y: cursor.y,
        text: f.name,
        color: "#FFFFFF",
        kind: "file",
        w,
        h,
        file_id: rec.id,
        meta: "",
      };
      cursor.x += w + 20;
      const id = await api.createNote(fields);
      pushOp(opCreate(id, fields));
      placed++;
      made.push(id);
    } catch (err) {
      reportError(`上传「${f.name}」`, err);
    }
  }
  await store.refreshBoard();
  if (placed) ElMessage.success(`已把 ${placed} 份资料放上白板`);
  return made;
}

/** 挂到节点下：自动建子卡片 + 连线，摆到它右边一层 */
async function importFilesAsChildren(
  files: File[],
  target: { kind: "task" | "note"; id: number }
) {
  const pid = store.currentProjectId;
  if (pid == null) return;
  const base = { ...posOf(target.kind, target.id) };
  let existing = store.edges.filter(
    (e) => e.from_kind === target.kind && e.from_id === target.id
  ).length;
  let placed = 0;
  for (const f of files) {
    if (f.size > 64 * 1024 * 1024) {
      ElMessage.warning(`「${f.name}」超过 64MB，已跳过`);
      continue;
    }
    try {
      const { rec, w, h } = await uploadOne(pid, f);
      const fields = {
        project_id: pid,
        x: Math.round(base.x + 260),
        y: Math.round(base.y + existing * 110),
        text: f.name,
        color: "#FFFFFF",
        kind: "file",
        w,
        h,
        file_id: rec.id,
        meta: "",
      };
      const id = await api.createNote(fields);
      pushOp(opCreate(id, fields));
      await api.createEdge(pid, target.kind, target.id, "note", id);
      existing++;
      placed++;
    } catch (err) {
      reportError(`上传「${f.name}」`, err);
    }
  }
  await store.refreshBoard();
  if (placed) ElMessage.success(`已把 ${placed} 份资料挂到该节点下`);
}

/** 拖的是不是文件（dragover 阶段只有 types 可用，files 通常是空的） */
function dragHasFiles(e: DragEvent) {
  const dt = e.dataTransfer;
  if (!dt) return false;
  if (Array.from(dt.types ?? []).includes("Files")) return true;
  return (dt.files?.length ?? 0) > 0;
}

/** 拖的是不是写作栏的 Markdown 文档（自定义 MIME） */
function dragHasDoc(e: DragEvent) {
  const dt = e.dataTransfer;
  if (!dt) return false;
  return Array.from(dt.types ?? []).includes(DOC_MIME);
}

/** 从写作栏拖过来的文档卡片：读出 doc id */
function draggedDocId(e: DragEvent): number | null {
  try {
    const raw = e.dataTransfer?.getData(DOC_MIME);
    if (!raw) return null;
    const o = JSON.parse(raw);
    const id = Number(o?.id);
    return Number.isFinite(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * 让文件能落到这里。**必须 preventDefault**，否则浏览器给"🚫 禁止"光标、根本放不下来。
 * ⚠️ 另外：`dropEffect` 不能无脑设成 "copy" —— 拖拽源的 `effectAllowed` 不含 copy 时，
 * 浏览器会把 dropEffect 判成 "none"，照样显示 🚫。所以只在允许时才设。
 */
function allowFileDrop(e: DragEvent) {
  e.preventDefault();
  const dt = e.dataTransfer;
  if (!dt) return;
  const ea = dt.effectAllowed ?? "";
  if (!ea || ea === "all" || ea === "uninitialized" || ea.indexOf("copy") >= 0) {
    dt.dropEffect = "copy";
  }
}

function onDragOver(e: DragEvent) {
  // 文档卡片和文件一样要能被放下来，但别把 effectAllowed 管太死
  if (dragHasDoc(e)) {
    e.preventDefault();
    dragOver.value = true;
    return;
  }
  if (!dragHasFiles(e)) return;
  allowFileDrop(e);
  dragOver.value = true;
}
function onDragLeave(e: DragEvent) {
  if (!(e.currentTarget as HTMLElement)?.contains(e.relatedTarget as Node)) dragOver.value = false;
}
// 窗口级兜底：文件被拖到白板以外的地方（侧边栏 / 工具栏 / 看板）时，
// 浏览器默认会直接把这个文件打开，看起来就像应用出了故障 —— 这里一律拦掉，
// 并且顺手把它导进来（落在画布外也不至于白拖一场）。
function onWinDragOver(e: DragEvent) {
  if (dragHasDoc(e)) {
    e.preventDefault();
    return;
  }
  if (!dragHasFiles(e)) return;
  allowFileDrop(e);
}
function onWinDrop(e: DragEvent) {
  if (dragHasDoc(e)) {
    // 落在画布外的文档卡片：夹到画布可见范围里，别让用户白拖一场
    const r = canvasRef.value?.getBoundingClientRect();
    if (!r) return;
    if (
      e.clientX >= r.left &&
      e.clientX <= r.right &&
      e.clientY >= r.top &&
      e.clientY <= r.bottom
    ) {
      return; // 画布内 → onDrop 处理（带 .stop）
    }
    e.preventDefault();
    const id = draggedDocId(e);
    const d = id == null ? undefined : store.docById(id);
    if (!d) return;
    const cx = Math.min(Math.max(e.clientX, r.left + 120), r.right - 120);
    const cy = Math.min(Math.max(e.clientY, r.top + 190), r.bottom - 100);
    void placeDocNode(d, screenToWorld(cx, cy));
    return;
  }
  if (!dragHasFiles(e)) return;
  e.preventDefault();
  const r = canvasRef.value?.getBoundingClientRect();
  if (
    r &&
    e.clientX >= r.left &&
    e.clientX <= r.right &&
    e.clientY >= r.top &&
    e.clientY <= r.bottom
  ) {
    return; // 落在画布内 → 交给 onDrop（它带 .stop，不会冒泡到这里）
  }
  const files = Array.from(e.dataTransfer?.files ?? []);
  if (!files.length) return;
  // 落在画布外：把落点夹到画布可见范围内最近的地方
  let cx = e.clientX;
  let cy = e.clientY;
  if (r) {
    cx = Math.min(Math.max(e.clientX, r.left + 90), r.right - 90);
    cy = Math.min(Math.max(e.clientY, r.top + 170), r.bottom - 90);
  }
  const w = screenToWorld(cx, cy);
  void importFiles(files, { x: w.x, y: w.y });
}

async function onDrop(e: DragEvent) {
  dragOver.value = false;

  // ① 写作栏拖过来的 Markdown 文档 → 放一张文档卡片
  const docId = draggedDocId(e);
  if (docId != null) {
    const d = store.docById(docId);
    if (!d) {
      ElMessage.warning("这篇文档已经不在了");
      return;
    }
    const nodeEl = (e.target as HTMLElement).closest("[data-node-kind]") as HTMLElement | null;
    if (nodeEl) {
      // 落在某张卡片上 → 成为它的下级
      const kind = nodeEl.getAttribute("data-node-kind") as "task" | "note";
      const pid = Number(nodeEl.getAttribute("data-node-id"));
      const p = posOf(kind, pid);
      const sz = sizeAt(kind, pid);
      const id = await placeDocNode(d, { x: p.x + sz.w + 70, y: p.y });
      if (id && store.currentProjectId != null) {
        await api.createEdge(store.currentProjectId, kind, pid, "note", id);
        await store.refreshBoard();
      }
      return;
    }
    await placeDocNode(d, screenToWorld(e.clientX, e.clientY));
    return;
  }

  // ② 外部文件 → 上传成资料卡片（原有逻辑）
  const files = Array.from(e.dataTransfer?.files ?? []);
  if (!files.length) return;
  const nodeEl = (e.target as HTMLElement).closest("[data-node-kind]") as HTMLElement | null;
  if (nodeEl) {
    const kind = nodeEl.getAttribute("data-node-kind") as "task" | "note";
    const id = Number(nodeEl.getAttribute("data-node-id"));
    const isFileCard = kind === "note" && noteById(id)?.kind === "file";
    if (!isFileCard) {
      await importFilesAsChildren(files, { kind, id });
      return;
    }
  }
  await importFiles(files, screenToWorld(e.clientX, e.clientY));
}
async function onPaste(e: ClipboardEvent) {
  const el = e.target as HTMLElement | null;
  if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
  const files: File[] = [];
  for (const it of Array.from(e.clipboardData?.items ?? [])) {
    if (it.kind === "file") {
      const f = it.getAsFile();
      if (f) files.push(f);
    }
  }
  if (!files.length) return;
  e.preventDefault();
  if (store.currentProjectId == null) return;
  await importFiles(files, centerOfView());
}

// ---- 文件卡片 ----
function fileOf(n: BoardNote): WbFile | undefined {
  return store.fileById(n.file_id);
}
function iconOf(n: BoardNote) {
  return fileIcon(fileOf(n)?.ext ?? extOf(n.text));
}
function labelOf(n: BoardNote) {
  return fileOf(n)?.name ?? n.text ?? "资料";
}
function sizeTextOf(n: BoardNote) {
  const f = fileOf(n);
  return f ? formatBytes(f.size) : "";
}
function previewOf(n: BoardNote) {
  return n.file_id ? previews.value[n.file_id] : "";
}
function isImgNode(n: BoardNote) {
  return isImageFile(fileOf(n));
}
async function openFile(n: BoardNote) {
  if (n.file_id == null) return;
  try {
    await api.openAsset(n.file_id);
  } catch (e) {
    reportError("打开资料", e);
  }
}
async function revealFile(n: BoardNote) {
  if (n.file_id == null) return;
  try {
    await api.revealAsset(n.file_id);
  } catch (e) {
    reportError("定位资料", e);
  }
}

// ---- 视图 / 清理 ----
function allBoxes() {
  const boxes: { x: number; y: number; w: number; h: number }[] = [];
  for (const t of store.allTasks) {
    const p = posOf("task", t.id);
    boxes.push({ x: p.x, y: p.y, w: TASK_W, h: TASK_H });
  }
  for (const n of store.notes) {
    const p = posOf("note", n.id);
    const s = noteSize(n);
    boxes.push({ x: p.x, y: p.y, w: s.w, h: s.h });
  }
  return boxes;
}

function fitView() {
  const r = canvasRef.value?.getBoundingClientRect();
  const boxes = allBoxes();
  if (!r || !boxes.length) {
    resetView();
    return;
  }
  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  const maxX = Math.max(...boxes.map((b) => b.x + b.w));
  const maxY = Math.max(...boxes.map((b) => b.y + b.h));
  // 顶部给悬浮工具栏留空间，否则「适应」之后最上面一排会被工具栏压住
  const pad = 50;
  const padTop = 130;
  const availW = r.width - pad * 2;
  const availH = r.height - padTop - pad;
  const z = Math.min(
    1.8,
    Math.max(0.25, Math.min(availW / (maxX - minX || 1), availH / (maxY - minY || 1)))
  );
  zoom.value = z;
  panX.value = (r.width - (maxX - minX) * z) / 2 - minX * z;
  panY.value = padTop + (availH - (maxY - minY) * z) / 2 - minY * z;
}

async function clearBoard() {
  if (!store.notes.length) {
    ElMessage.info("白板上还没有卡片");
    return;
  }
  try {
    await ElMessageBox.confirm(
      "会清空本项目白板上的所有便签 / 思维导图 / 资料卡片（上传的文件也会删除），看板任务不受影响。",
      "清空白板",
      { type: "warning", confirmButtonText: "清空", cancelButtonText: "取消" }
    );
  } catch {
    return;
  }
  try {
    for (const n of [...store.notes]) {
      if (n.kind === "file" && n.file_id != null) await api.deleteAsset(n.file_id);
      else await api.deleteNote(n.id);
    }
    await store.refreshBoard();
    undoStack.length = 0;
    redoStack.length = 0;
    syncHistLen();
    ElMessage.success("白板已清空");
  } catch (e) {
    reportError("清空白板", e);
  }
}

// ---- keyboard ----
function onKey(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  // 事件源头是输入框/文本域 → 用户正在打字，绝不抢键
  // （注意用 e.target 而不是 document.activeElement：冒泡过程中元素可能已被移除，
  //   activeElement 会提前变，靠它判断会在"标题按 Enter 提交"时误触发快捷键）
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
  // 没点白板、焦点还留在别处输入框里 → 也让位
  const active = document.activeElement as HTMLElement | null;
  if (
    active &&
    active !== canvasRef.value &&
    active !== document.body &&
    (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable)
  )
    return;

  const sel = primary.value;
  const ctrl = e.ctrlKey || e.metaKey;

  if (e.code === "Space") {
    spaceDown.value = true;
    e.preventDefault();
    return;
  }
  if (ctrl && e.key.toLowerCase() === "z") {
    e.preventDefault();
    void (e.shiftKey ? doRedo() : doUndo());
    return;
  }
  if (e.key === "Escape") {
    clearSelection();
    editingNote.value = null;
    editingTask.value = null;
    linkFrom.value = null;
    tool.value = "select";
    return;
  }
  // Ctrl+G = 把选中的几张卡片装进一个分组框
  if (ctrl && e.key.toLowerCase() === "g") {
    e.preventDefault();
    void groupSelection();
    return;
  }
  if (!sel) return;

  // Tab = 下一级（子任务 / 导图分支）
  if (e.key === "Tab") {
    e.preventDefault();
    void addChildOfKey(keyOf(sel.kind, sel.id));
    return;
  }
  // Enter 或 Ctrl+Enter = 同级
  if (e.key === "Enter") {
    e.preventDefault();
    void addSiblingOfKey(keyOf(sel.kind, sel.id));
    return;
  }
  if (e.key === "Delete" || e.key === "Backspace") {
    e.preventDefault();
    void removeSelection();
    return;
  }
  if (e.key === "F2") {
    e.preventDefault();
    if (sel.kind === "task") {
      const tt = taskById(sel.id);
      if (tt) void startEditTask(tt);
    } else {
      const n = noteById(sel.id);
      if (n) void startEditNote(n);
    }
  }
}
function onKeyUp(e: KeyboardEvent) {
  if (e.code === "Space") spaceDown.value = false;
}

/** 点白板任意位置（含卡片）都把焦点收回画布，免得别处的输入框吃掉快捷键 */
function grabFocus() {
  canvasRef.value?.focus({ preventScroll: true });
}

onMounted(() => {
  window.addEventListener("keydown", onKey);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("paste", onPaste as unknown as EventListener);
  window.addEventListener("dragenter", onWinDragOver);
  window.addEventListener("dragover", onWinDragOver);
  window.addEventListener("drop", onWinDrop);
  // 点别处收起「连线样式」菜单
  window.addEventListener("pointerdown", closeEdgeMenuOnOutside);
  // 点别处收起右键菜单 / 新建节点菜单
  window.addEventListener("pointerdown", closeMenusOnOutside);
  canvasRef.value?.addEventListener("pointerdown", grabFocus, true);
  // 启动卡顿排查：白板挂载完（含首屏节点渲染）耗时
  void api.diagLog(
    `WB mounted nodes=${store.notes.length} t=${performance.now().toFixed(0)}ms`
  );
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey);
  window.removeEventListener("keyup", onKeyUp);
  window.removeEventListener("paste", onPaste as unknown as EventListener);
  window.removeEventListener("dragenter", onWinDragOver);
  window.removeEventListener("dragover", onWinDragOver);
  window.removeEventListener("drop", onWinDrop);
  window.removeEventListener("pointerdown", closeEdgeMenuOnOutside);
  window.removeEventListener("pointerdown", closeMenusOnOutside);
  stopEdgeLongPress();
  canvasRef.value?.removeEventListener("pointerdown", grabFocus, true);
});

/** 菜单内部点击不算"点别处" */
function closeMenusOnOutside(e: PointerEvent) {
  if (!imgMenu.value && !typeMenu.value) return;
  const t = e.target as HTMLElement | null;
  if (t?.closest(".wb-menu")) return;
  closeMenus();
}

// ---- display helpers ----
const isEmpty = computed(() => store.allTasks.length === 0 && store.notes.length === 0);
const selCount = computed(() => selectedKeys.value.length);

function colName(t: Task) {
  return store.columns.find((c) => c.id === t.column_id)?.name ?? "";
}
function prio(t: Task) {
  return priorityOf(t.priority);
}
/** 层级编号（1 / 2.1 / 2.1.3），按当前父子关系实时算 */
const numOf = (t: Task) => store.numberOf(t.id);
</script>

<template>
  <div
    ref="canvasRef"
    class="wb-canvas"
    tabindex="-1"
    :class="{
      'drop-active': dragOver,
      linking: !!linkFrom,
      'dragging-link': !!linking,
      'link-mode': tool === 'link',
      'space-pan': spaceDown,
    }"
    :style="gridStyle"
    @mousedown="bgDown"
    @wheel.prevent="onWheel"
    @dragenter.prevent="onDragOver"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop.prevent.stop="onDrop"
    @contextmenu.prevent
    @auxclick.prevent
  >
    <!-- 工具栏 -->
    <div class="wb-toolbar">
      <!-- 工具：只留图标（选中态有底色，悬停有说明），工具栏从 19 个按钮收到 11 个 -->
      <div class="tb-group">
        <button
          class="tb ico"
          :class="{ on: tool === 'select' }"
          title="选择：左键点选、空白处拖框选多个、拖动可整组移动"
          @click="tool = 'select'"
        >
          <AppIcon name="select" :size="17" />
        </button>
        <button
          class="tb ico"
          :class="{ on: tool === 'note' }"
          title="便签：点空白处放一张（按住 Shift 可连续放）"
          @click="tool = 'note'"
        >
          <AppIcon name="note" :size="17" />
        </button>
        <button
          class="tb ico"
          :class="{ on: tool === 'text' }"
          title="文字标签"
          @click="tool = 'text'"
        >
          <AppIcon name="text" :size="17" />
        </button>
        <button
          class="tb ico"
          :class="{ on: tool === 'mind' }"
          title="思维导图节点"
          @click="tool = 'mind'"
        >
          <AppIcon name="mind" :size="17" />
        </button>
        <button
          class="tb ico"
          :class="{ on: tool === 'box' }"
          title="分组框：拖出一个范围就建框；已经选中多张卡片时点它 = 直接装进一个框（Ctrl+G）"
          @click="onBoxTool"
        >
          <AppIcon name="box" :size="17" />
        </button>
        <button
          class="tb ico"
          :class="{ on: tool === 'task' }"
          title="任务：点空白处建一个（看板上同步出现，可以继续往下拆子任务）"
          @click="tool = 'task'"
        >
          <AppIcon name="task" :size="17" />
        </button>

        <!-- 连线：主体切换连线模式；右下小三角换线条样式（长按主体也能调出来） -->
        <div class="tb-split" :class="{ on: tool === 'link' }">
          <button
            class="tb ico tb-main"
            title="连线：点两个卡片建立连线，也可以直接拖卡片两端的圆点；长按可切换线条样式"
            @click="onEdgeBtnClick"
            @pointerdown="startEdgeLongPress"
            @pointerup="stopEdgeLongPress"
            @pointerleave="stopEdgeLongPress"
          >
            <AppIcon name="link" :size="17" class="ico-link" />
          </button>
          <button
            class="tb-caret"
            title="线条样式：直线 / 弧线"
            @click.stop="edgeMenuOpen = !edgeMenuOpen"
          >
            <AppIcon name="arrowDown" :size="9" :stroke="2.6" />
          </button>
          <div v-if="edgeMenuOpen" class="tb-pop" @pointerdown.stop>
            <div class="tb-pop-h">连线样式</div>
            <button :class="{ on: edgeStyle === 'curve' }" @click="setEdgeStyle('curve')">
              <AppIcon name="edgeCurve" :size="20" />
              <span>弧线<small>手绘感，转弯柔和</small></span>
            </button>
            <button :class="{ on: edgeStyle === 'line' }" @click="setEdgeStyle('line')">
              <AppIcon name="edgeLine" :size="20" />
              <span>直线<small>干净利落，指向明确</small></span>
            </button>
          </div>
        </div>
      </div>

      <span class="tb-sep"></span>

      <div class="tb-group">
        <button
          class="tb ico"
          title="上传资料：PDF / Word / Excel / 图片 / 视频（也可以直接把文件拖进画布）"
          @click="pickFiles"
        >
          <AppIcon name="upload" :size="17" class="ico-upload" />
        </button>
        <button
          class="tb ico"
          title="新建文档：新建一篇 Markdown、放一张文档卡片，右侧「文档」栏同时打开可以直接写"
          @click="addDocNode"
        >
          <AppIcon name="doc" :size="17" class="ico-doc" />
        </button>
        <button
          class="tb ico"
          title="整理布局：把任务树 / 导图树重新排布（Tab 长出来的分支都在内）"
          @click="layoutMind()"
        >
          <AppIcon name="tree" :size="17" class="ico-layout" />
        </button>
        <button
          class="tb ico"
          title="在白板上放一张甘特图（和看板同一批任务，勾完成 / 改日期两边实时联动）"
          @click="addGantt"
        >
          <AppIcon name="gantt" :size="17" class="ico-gantt" />
        </button>
      </div>

      <span class="tb-sep"></span>

      <!-- 不常点的都收进这里，工具栏才不显得繁复 -->
      <el-dropdown trigger="click" placement="bottom-start" @command="onToolbarMore">
        <button class="tb" title="更多：转导图 / 导出白板">
          更多<AppIcon name="arrowDown" :size="9" :stroke="2.4" />
        </button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="mind-tasks" :disabled="store.allTasks.length === 0">
              ✨ 把看板任务铺成思维导图
            </el-dropdown-item>
            <el-dropdown-item command="outline">📄 缩进文本 / Markdown 大纲转导图</el-dropdown-item>
            <el-dropdown-item command="doc-pick" :disabled="!store.docs.length">
              🔗 把已有文档放到白板上
            </el-dropdown-item>
            <el-dropdown-item command="png" divided>🖼 导出白板为 PNG 图片</el-dropdown-item>
            <el-dropdown-item command="pdf">📄 导出白板为单页 PDF</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>

      <span class="tb-sep"></span>

      <div class="tb-group">
        <button class="tb" title="缩小" @click="zoomBy(1 / 1.15)">
          <AppIcon name="minus" :size="16" />
        </button>
        <span class="wb-zoom" title="点一下复位视图" @click="resetView">
          {{ Math.round(zoom * 100) }}%
        </span>
        <button class="tb" title="放大" @click="zoomBy(1.15)">
          <AppIcon name="plus" :size="16" />
        </button>
        <button class="tb" title="缩放到刚好装下所有卡片" @click="fitView">
          <AppIcon name="fit" :size="16" /><span class="tb-txt">适应</span>
        </button>
      </div>

      <span class="tb-sep"></span>

      <div class="tb-group">
        <button class="tb" :disabled="!undoLen" title="撤销（Ctrl+Z）" @click="doUndo">
          <AppIcon name="undo" :size="16" />
        </button>
        <button class="tb" :disabled="!redoLen" title="重做（Ctrl+Shift+Z）" @click="doRedo">
          <AppIcon name="redo" :size="16" />
        </button>
        <button class="tb danger" title="清空本项目白板" @click="clearBoard">
          <AppIcon name="broom" :size="16" />
        </button>
      </div>

      <span class="tb-sep"></span>

      <!-- 完整操作说明收在这里，底部那条提示就能保持很短 —— 窄栏里也不会被截成半句话 -->
      <el-popover trigger="click" placement="bottom-end" :width="330" popper-class="wb-help-pop">
        <template #reference>
          <button class="tb" title="操作说明 / 快捷键">
            <AppIcon name="help" :size="16" />
          </button>
        </template>
        <div class="wb-help">
          <div class="wh-h">白板怎么用</div>
          <ul>
            <li><b>左键</b>点选；空白处拖动 = 框选多张，可整组拖</li>
            <li>拖<b>父节点</b>时，它的下级会一起走</li>
            <li><b>中键</b>或按住<b>空格</b>+左键 = 平移画布；<b>滚轮</b> = 缩放</li>
            <li>
              拖卡片<span class="hint-port out"></span>右侧圆点到别的卡片 → 本卡片当<b>上级</b>
            </li>
            <li>
              拖卡片<span class="hint-port in"></span>左侧圆点到别的卡片 → 本卡片当<b>下级</b>
            </li>
            <li><b>Tab</b> 加下一级 · <b>Enter</b> 加同级 · <b>Delete</b> 删除 · <b>F2</b> 改名</li>
            <li><b>双击</b>改文字；选中后用工具栏挂资料、写进文档</li>
          </ul>
        </div>
      </el-popover>
    </div>

    <div class="wb-mode" v-if="tool !== 'select'">
      <template v-if="tool === 'link'"
        >连线模式：先点【上级】卡片，再点它的【下级】。也可以直接拖卡片两端的圆点来连线。</template
      >
      <template v-else-if="tool === 'box'"
        >分组框：按住左键拖出一个范围，松开就成框；直接点一下则放一个默认大小的</template
      >
      <template v-else>在空白处点一下就能放下（按住 Shift 连续放）</template>
      <button class="wb-mode-x" @click="tool = 'select'">✕</button>
    </div>

    <div class="wb-hint">
      中键平移 · 滚轮缩放 · 拖圆点连线 · 双击改文字 · <b>？</b> 看全部快捷键
      <template v-if="selCount"> · 已选 {{ selCount }} 个</template>
    </div>

    <!-- 连线短菜单：点线才出来，不与常驻 UI 抢位置 -->
    <div
      v-if="edgePick"
      ref="edgeMenuEl"
      class="edge-menu"
      :class="{ flip: edgeMenuFlip }"
      :style="{ left: edgePick.x + 'px', top: edgePick.y + 'px' }"
      @pointerdown.stop
      @mousedown.stop
      @mouseup.stop
      @click.stop
      @contextmenu.prevent.stop
    >
      <button class="em-del" title="删除这条连线" @click="removeEdgeById">
        <AppIcon name="trash" :size="14" />
        <span>删除</span>
      </button>
      <div class="em-grid">
        <button
          v-for="m in EDGE_KIND_META"
          :key="m.kind"
          class="em-kind"
          :class="['k-' + m.kind, { on: edgeMenuKind === m.kind }]"
          :title="m.hint"
          @click="setEdgeKind(m.kind)"
        >
          <i class="em-dot"></i>
          <b>{{ m.label }}</b>
          <small>{{ m.short }}</small>
        </button>
      </div>
      <!-- 支撑类关系可以调等级：同一个资料连两个任务，两条线各是各的档 -->
      <div v-if="isSupportEdge()" class="em-levels">
        <button
          v-for="l in LEVEL_META"
          :key="l.v"
          class="em-lv"
          :class="{ on: edgeLevel() === l.v }"
          :title="l.hint"
          @click="setEdgeLevel(l.v)"
        >
          {{ l.label }}
        </button>
      </div>
    </div>

    <!-- 依据气泡：换档 + 写要点。要点是 AI 唯一能读到材料内容的地方 -->
    <div
      v-if="refPick"
      ref="refMenuEl"
      class="ref-menu"
      :style="{ left: refPick.x + 'px', top: refPick.y + 'px' }"
      @pointerdown.stop
      @mousedown.stop
      @mouseup.stop
      @click.stop
      @contextmenu.prevent.stop
    >
      <div class="rm-head" :title="noteLabel(refPick.noteId)">{{ noteLabel(refPick.noteId) }}</div>
      <div class="rm-levels">
        <button
          v-for="lv in REF_LEVELS"
          :key="lv.v"
          class="rm-lv"
          :class="['lv-' + lv.v, { on: refPick.level === lv.v }]"
          :title="lv.hint"
          @click="setRefLevel(lv.v)"
        >
          {{ lv.label }}
        </button>
      </div>
      <textarea
        v-model="refPoint"
        class="rm-point"
        rows="3"
        placeholder="这份材料里，这个任务该重点看哪儿？例如：第 12 页的颜色规范最关键；主色限墨绿，禁止高饱和红"
        @keydown.stop
      ></textarea>
      <div class="rm-foot">
        <button class="rm-del" title="把这份资料从这个任务上移除" @click="removeRefFromMenu">
          移除
        </button>
        <span class="rm-tip">写清楚看哪儿，文件本身要一并传给 AI</span>
        <button class="rm-save" @click="saveRefPoint">保存</button>
      </div>
    </div>

    <div class="wb-content" :style="contentStyle">
      <!-- 框选矩形 -->
      <div v-if="marquee" class="wb-marquee" :style="marqueeStyle"></div>
      <!-- 拖出一个分组框时，先给一块虚线预览，松开才真正建 -->
      <div v-if="boxDraft" class="wb-boxdraft" :style="boxDraftStyle">
        <span>松开就建成分组框</span>
      </div>

      <!-- 分组框在最底层 -->
      <div
        v-for="n in store.notes.filter((x) => kindOf(x) === 'box')"
        :key="'b' + n.id"
        class="wb-node box-node"
        :data-node-kind="'note'"
        :data-node-id="n.id"
        :class="{
          sel: isSelected('note', n.id),
          'pal-open': paletteKey === keyOf('note', n.id),
        }"
        :style="[
          inkStyle(n.color),
          {
            left: posOf('note', n.id).x + 'px',
            top: posOf('note', n.id).y + 'px',
            width: noteSize(n).w + 'px',
            height: noteSize(n).h + 'px',
            borderColor: n.color,
            background: `color-mix(in srgb, ${n.color} 9%, transparent)`,
          },
        ]"
        @pointerdown="startDrag($event, 'note', n.id)"
        @dblclick="startEditNote(n)"
      >
        <!-- 名称和强度标签并排：左边说"这是什么区"，右边说"这区有多硬"。
             标签常显，不选中也能看见，因为它本身就是分区的一部分信息。 -->
        <div class="box-head">
          <div class="box-title" :style="{ background: n.color }">
            <template v-if="editingNote === n.id">
              <input
                v-model="editText"
                class="box-input"
                @pointerdown.stop
                @keydown.enter="commitNoteText(n)"
                @blur="commitNoteText(n)"
              />
            </template>
            <template v-else>{{ n.text || "分组" }}</template>
          </div>
          <button
            class="box-cluster"
            :class="'cs-' + strengthOf(n)"
            :title="CLUSTER_MAP.get(strengthOf(n))?.hint + '（点一下换下一档）'"
            @pointerdown.stop
            @click.stop="cycleStrength(n)"
          >
            {{ CLUSTER_MAP.get(strengthOf(n))?.label }}
          </button>
        </div>
        <div class="node-tools">
          <button title="加下一级（Tab）" @pointerdown.stop @click.stop="addChildNote(n.id)">
            ＋子
          </button>
          <button
            title="分区颜色：点开色板自选（也可以取任意颜色）"
            :class="{ on: paletteKey === keyOf('note', n.id) }"
            @pointerdown.stop
            @click.stop="togglePalette(n)"
          >
            <AppIcon name="palette" :size="13" />
          </button>
          <button title="编辑文字" @pointerdown.stop @click.stop="startEditNote(n)">✎</button>
          <button title="上传资料挂到这个节点下" @pointerdown.stop @click.stop="pickFilesFor('note', n.id)">
            📎
          </button>
          <button title="删除" @pointerdown.stop @click.stop="removeNote(n)">✕</button>

          <!-- 分区色板：选完自动收起 -->
          <div
            v-if="paletteKey === keyOf('note', n.id)"
            class="node-palette"
            @pointerdown.stop
            @click.stop
          >
            <button
              v-for="c in paletteOf(n)"
              :key="c"
              class="np-sw"
              :class="{ on: sameColor(n.color, c) }"
              :style="{ background: c }"
              :title="c"
              @click.stop="setNoteColor(n, c)"
            ></button>
            <label class="np-custom" title="自定义颜色">
              <input type="color" :value="n.color" @input="onCustomColor(n, $event)" />
              <AppIcon name="plus" :size="10" />
            </label>
          </div>
        </div>
        <span class="node-resize" title="拖动改大小" @pointerdown="startResizeNode($event, n)"></span>
      </div>

      <!-- 连线：两端吸附在卡片边框上，不画进卡片内部；箭头指向下级 -->
      <svg class="wb-edges">
        <defs>
          <!-- 箭头颜色必须跟着线走：marker 不继承 stroke，只能一种关系一个 -->
          <marker
            v-for="m in EDGE_KIND_META"
            :id="'wb-arrow-' + m.kind"
            :key="m.kind"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="5.5"
            markerHeight="5.5"
            orient="auto-start-reverse"
          >
            <path :class="'mk-' + m.kind" d="M0 0 L10 5 L0 10 z" />
          </marker>
          <marker
            id="wb-arrow-live"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="5.5"
            markerHeight="5.5"
            orient="auto-start-reverse"
          >
            <path d="M0 0 L10 5 L0 10 z" />
          </marker>
        </defs>
        <g v-for="g in visibleEdgeGeom" :key="g.e.id">
          <path
            class="edge-line"
            :class="['k-' + g.e.kind, { picked: edgePick && edgePick.id === g.e.id }]"
            :d="g.d"
            :marker-end="'url(#wb-arrow-' + g.e.kind + ')'"
          />
          <path class="edge-hit" :d="g.d" @click.stop="openEdgeMenu(g.e, $event)" />
        </g>
        <path
          v-if="linking"
          class="edge-line linking"
          :class="linking.role"
          :d="linkingPathD"
          marker-end="url(#wb-arrow-live)"
        />
      </svg>

      <!-- 任务节点 -->
      <div
        v-for="t in store.allTasks"
        :key="'t' + t.id"
        class="wb-node task-node"
        :class="{ sel: isSelected('task', t.id) }"
        :data-node-kind="'task'"
        :data-node-id="t.id"
        :style="{
          left: posOf('task', t.id).x + 'px',
          top: posOf('task', t.id).y + 'px',
          width: TASK_W + 'px',
          borderLeftColor: prio(t).color,
        }"
        @pointerdown="startDrag($event, 'task', t.id)"
        @dblclick="startEditTask(t)"
      >
        <div v-if="editingTaskFull === t.id" class="tn-edit" @pointerdown.stop @dblclick.stop>
          <input
            ref="taskFullTitleInput"
            v-model="taskDraftTitle"
            class="tn-input"
            placeholder="标题"
            @keydown.enter.prevent="commitTaskFull(t)"
            @keydown.esc="cancelEditTaskFull"
          />
          <textarea
            v-model="taskDraftDesc"
            class="tn-desc-input"
            placeholder="在这里写说明 / 备注…"
            @keydown.esc="cancelEditTaskFull"
          ></textarea>
          <div class="tn-edit-actions">
            <button title="保存" @click.stop="commitTaskFull(t)">保存</button>
            <button title="取消（Esc）" @click.stop="cancelEditTaskFull">取消</button>
          </div>
        </div>
        <template v-else>
          <input
            v-if="editingTask === t.id"
            ref="taskInput"
            v-model="taskDraft"
            class="tn-input"
            @pointerdown.stop
            @keydown.enter="commitTaskTitle(t)"
            @blur="commitTaskTitle(t)"
            @keydown.esc="editingTask = null"
          />
          <div v-else class="tn-title">
            <span
              v-if="numOf(t)"
              class="tn-seq"
              :title="'任务编号 T' + numOf(t) + '：跟 AI 交代时直接说这个号就行'"
              >T{{ numOf(t) }}</span
            >{{ t.title }}
          </div>
          <div class="tn-sub">
            <span class="tn-col" :style="{ color: prio(t).color }">{{ colName(t) }}</span>
            <span v-if="t.priority !== 2" :style="{ color: prio(t).color }">{{ prio(t).label }}</span>
            <span v-if="t.due_date" class="tn-due">📅</span>
            <span v-if="store.taskChildCount(t.id)" class="tn-kids"
              >▸ {{ store.taskChildCount(t.id) }}</span
            >
          </div>
          <div v-if="t.description" class="tn-desc" :title="t.description">{{ t.description }}</div>
          <div v-if="store.refsOfTask(t.id).length" class="tn-refs" @pointerdown.stop>
            <span
              v-for="r in store.refsOfTask(t.id)"
              :key="r.id"
              class="tn-ref"
              :class="'lv-' + r.level"
              :title="
                refLabel(r.level) +
                '：' +
                noteLabel(r.note_id) +
                (r.point ? '\n要点：' + r.point : '\n还没写要点') +
                '（点开可以换档、写要点）'
              "
              @pointerdown.stop
              @click.stop="openRefMenu($event, t.id, r.note_id, r.level)"
              @contextmenu.prevent.stop="dropRef(t.id, r.note_id)"
            >
              <span v-if="r.point" class="tn-ref-dot"></span>{{ noteLabel(r.note_id) }}
            </span>
          </div>
        </template>

        <div class="node-tools">
          <button title="加下一级 / 子任务（Tab）" @pointerdown.stop @click.stop="addChildTask(t.id)">
            ＋子
          </button>
          <button title="加同级（Enter）" @pointerdown.stop @click.stop="addSiblingTask(t.id)">
            ＋同
          </button>
            <button
              title="上传资料挂到这个节点下"
              @pointerdown.stop
              @click.stop="pickFilesFor('task', t.id)"
            >
              📎
            </button>
            <button
              title="把这个任务写进一篇 Markdown 文档"
              @pointerdown.stop
              @click.stop="openDocWriter('task', t.id)"
            >
              📝
            </button>
          <button
            title="就地编辑标题和备注（不弹窗）"
            @pointerdown.stop
            @click.stop="startEditTaskFull(t)"
          >
            ✎ 编辑
          </button>
          <button
            class="tb-ai"
            title="复制成给 AI 的指令（自动带上任务说明、资料等级、上下游）"
            @pointerdown.stop
            @click.stop="openAiPrompt(t)"
          >
            AI
          </button>
          <button title="打开完整任务详情" @pointerdown.stop @click.stop="openTask(t.id)">
            详情
          </button>
        </div>
        <span
          class="node-port in"
          title="输入端口：把别的卡片拖到这里 → 它就成为这张卡片的上级"
          @pointerdown="startLinkPort($event, 'task', t.id, 'in')"
        ></span>
        <span
          class="node-port out"
          title="输出端口：从这里拖到另一张卡片 → 那张卡片成为它的下级"
          @pointerdown="startLinkPort($event, 'task', t.id, 'out')"
        ></span>
      </div>

      <!-- 便签 / 文本 / 导图 / 资料 -->
      <div
        v-for="n in store.notes.filter((x) => kindOf(x) !== 'box')"
        :key="'n' + n.id"
        class="wb-node"
        :class="[
          `k-${kindOf(n)}`,
          {
            sel: isSelected('note', n.id),
            linkfrom: linkFrom?.kind === 'note' && linkFrom?.id === n.id,
            round: kindOf(n) === 'mind' && lookOf(n).shape === 'circle',
          },
        ]"
        :data-node-kind="'note'"
        :data-node-id="n.id"
        :style="[
          inkStyle(n.color),
          {
            left: posOf('note', n.id).x + 'px',
            top: posOf('note', n.id).y + 'px',
            width: noteSize(n).w + 'px',
            minHeight: noteSize(n).h + 'px',
            background:
              kindOf(n) === 'file' || kindOf(n) === 'gantt' || kindOf(n) === 'doc'
                ? undefined
                : n.color,
            borderColor: kindOf(n) === 'mind' ? n.color : undefined,
            borderRadius:
              kindOf(n) === 'note' && lookOf(n).radius != null
                ? lookOf(n).radius + 'px'
                : undefined,
          },
        ]"
        @pointerdown="startDrag($event, 'note', n.id)"
        @dblclick="startEditNote(n)"
        @contextmenu.prevent="onNoteMenu($event, n)"
      >
        <!-- 甘特图节点：和看板同一批任务，勾完成 / 改日期两边实时联动 -->
        <template v-if="kindOf(n) === 'gantt'">
          <GanttChart :tasks="store.allTasks" compact />
        </template>

        <!-- 上传的资料 -->
        <template v-else-if="kindOf(n) === 'file'">
          <!-- 缩略图不绑点击：选择模式下点卡片就是选中 / 拖动，看大图请用悬浮的「👁 预览」 -->
          <div v-if="isImgNode(n)" class="file-thumb" title="选中后可拖动；看大图点 👁 预览">
            <img v-if="previewOf(n)" :src="previewOf(n)" draggable="false" alt="" />
            <div v-else class="file-thumb-wait">图片加载中…</div>
          </div>
          <div class="file-meta">
            <span class="file-icon">{{ iconOf(n) }}</span>
            <span class="file-name" :title="labelOf(n)">{{ labelOf(n) }}</span>
            <span class="file-size">{{ sizeTextOf(n) }}</span>
          </div>
        </template>

        <!-- 文档卡片：关联写作栏的 Markdown，正文改动两边实时同步 -->
        <template v-else-if="kindOf(n) === 'doc'">
          <div class="doc-head">
            <span class="doc-ico">📄</span>
            <span class="doc-title" :title="docCardOf(n)?.title || n.text">{{
              docCardOf(n)?.title || n.text || "（文档已删除）"
            }}</span>
          </div>
          <div v-if="docCardOf(n)" class="doc-sum">
            {{ docCardOf(n)!.summary || "（空文档）" }}
          </div>
          <div v-else class="doc-gone">原文档已被删除，正文还在卡片里</div>
          <div v-if="docCardOf(n)" class="doc-foot">
            <span>{{ docCardOf(n)!.chars }} 字</span>
            <span v-if="docCardOf(n)!.headings">· {{ docCardOf(n)!.headings }} 标题</span>
            <span class="doc-edit-hint">双击编辑</span>
          </div>
        </template>

        <!-- 思维导图节点 -->
        <template v-else-if="kindOf(n) === 'mind'">
          <template v-if="editingNote === n.id">
            <textarea
              ref="editArea"
              v-model="editText"
              class="note-edit mind-edit"
              @pointerdown.stop
              @blur="commitNoteText(n)"
              @keydown.esc="editingNote = null"
            ></textarea>
          </template>
          <span v-else class="mind-text">{{ n.text || "主题" }}</span>
        </template>

        <!-- 纯文本 -->
        <template v-else-if="kindOf(n) === 'text'">
          <template v-if="editingNote === n.id">
            <textarea
              ref="editArea"
              v-model="editText"
              class="note-edit"
              @pointerdown.stop
              @blur="commitNoteText(n)"
              @keydown.esc="editingNote = null"
            ></textarea>
          </template>
          <div v-else class="text-body">{{ n.text || "双击写点什么" }}</div>
        </template>

        <!-- 便签 -->
        <template v-else>
          <template v-if="editingNote === n.id">
            <textarea
              ref="editArea"
              v-model="editText"
              class="note-edit"
              placeholder="写点想法…"
              @pointerdown.stop
              @blur="commitNoteText(n)"
              @keydown.esc="editingNote = null"
            ></textarea>
          </template>
          <template v-else>
            <div class="note-text">{{ n.text || "（双击编辑）" }}</div>
            <button
              v-if="sourceOf(n)"
              class="note-src"
              :title="`来自「${sourceOf(n)?.name}」—— 点一下打开原资料`"
              @pointerdown.stop
              @click.stop="openSource(n)"
            >
              📍 {{ sourceOf(n)?.name }}
            </button>
          </template>
        </template>

        <!-- 悬浮操作 -->
        <div class="node-tools">
          <template v-if="kindOf(n) === 'doc'">
            <button title="在白板上直接编辑这篇 Markdown" @pointerdown.stop @click.stop="openDocEditor(n)">
              ✎ 编辑
            </button>
            <button
              title="把这篇文档的正文按标题层级转成思维导图，挂在这张卡片下面"
              @pointerdown.stop
              @click.stop="mindFromDoc(n)"
            >
              🧠 转导图
            </button>
            <button title="切到「文档」栏打开这篇" @pointerdown.stop @click.stop="gotoWriteDoc(n)">
              ↗ 去文档
            </button>
            <button
              title="把别的节点内容追加进这篇文档"
              @pointerdown.stop
              @click.stop="openDocWriterTo(n)"
            >
              📥 收内容
            </button>
          </template>
          <template v-else-if="kindOf(n) === 'file'">
            <button title="在应用内预览" @pointerdown.stop @click.stop="openPreview(n)">👁 预览</button>
            <button
              v-if="isTextOutlineNode(n)"
              title="把这份 md / txt 大纲转成思维导图"
              @pointerdown.stop
              @click.stop="outlineFromFile(n)"
            >
              🧠 转导图
            </button>
            <button
              v-if="isTextOutlineNode(n)"
              title="把这份 md / txt 变成写作栏里的正式文档（之后能在白板上直接改）"
              @pointerdown.stop
              @click.stop="fileToDoc(n)"
            >
              📝 转文档
            </button>
            <button title="用系统程序打开" @pointerdown.stop @click.stop="openFile(n)">↗ 打开</button>
            <button
              title="看看这份资料被哪些节点引用了"
              @pointerdown.stop
              @click.stop="showRefs(n)"
            >
              🔎 引用
            </button>
            <button title="在文件夹中显示" @pointerdown.stop @click.stop="revealFile(n)">📁</button>
          </template>
          <template v-else-if="kindOf(n) === 'mind'">
            <button title="加下一级（Tab）" @pointerdown.stop @click.stop="addChildNote(n.id)">
              ＋子
            </button>
            <button
              title="加同级（Enter）"
              @pointerdown.stop
              @click.stop="addSiblingOfKey(keyOf('note', n.id))"
            >
              ＋同
            </button>
            <button
              title="配色：展开色板自选（也可以自定义任意颜色）"
              :class="{ on: paletteKey === keyOf('note', n.id) }"
              @pointerdown.stop
              @click.stop="togglePalette(n)"
            >
              <AppIcon name="palette" :size="13" />
            </button>
            <button
              :title="lookOf(n).shape === 'circle' ? '切回胶囊节点' : '切成圆形节点'"
              @pointerdown.stop
              @click.stop="toggleMindShape(n)"
            >
              <AppIcon
                :name="lookOf(n).shape === 'circle' ? 'shapeCircle' : 'shapeCapsule'"
                :size="13"
              />
            </button>
            <button title="编辑文字" @pointerdown.stop @click.stop="startEditNote(n)">✎</button>
            <button
              title="上传资料挂到这个节点下"
              @pointerdown.stop
              @click.stop="pickFilesFor('note', n.id)"
            >
              📎
            </button>
          </template>
          <template v-else>
            <button title="加下一级（Tab）" @pointerdown.stop @click.stop="addChildNote(n.id)">
              ＋子
            </button>
            <button
              title="配色：展开色板自选（也可以自定义任意颜色）"
              :class="{ on: paletteKey === keyOf('note', n.id) }"
              @pointerdown.stop
              @click.stop="togglePalette(n)"
            >
              <AppIcon name="palette" :size="13" />
            </button>
            <button
              v-if="kindOf(n) === 'note'"
              title="便签圆角：直角 / 小 / 大 / 特大"
              @pointerdown.stop
              @click.stop="cycleRadius(n)"
            >
              <AppIcon name="shapeRound" :size="13" />
            </button>
            <button title="编辑文字" @pointerdown.stop @click.stop="startEditNote(n)">✎</button>
            <button
              title="上传资料挂到这个节点下"
              @pointerdown.stop
              @click.stop="pickFilesFor('note', n.id)"
            >
              📎
            </button>
            <button
              title="把这个节点的内容写进一篇 Markdown 文档"
              @pointerdown.stop
              @click.stop="openDocWriter('note', n.id)"
            >
              📝
            </button>
          </template>
          <button title="删除" @pointerdown.stop @click.stop="removeNote(n)">✕</button>

          <!-- 色板：点「配色」展开，选完自动收起 -->
          <div
            v-if="paletteKey === keyOf('note', n.id)"
            class="node-palette"
            @pointerdown.stop
            @click.stop
          >
            <button
              v-for="c in paletteOf(n)"
              :key="c"
              class="np-sw"
              :class="{ on: sameColor(n.color, c) }"
              :style="{ background: c }"
              :title="c"
              @click.stop="setNoteColor(n, c)"
            ></button>
            <label class="np-custom" title="自定义颜色">
              <input type="color" :value="n.color" @input="onCustomColor(n, $event)" />
              <AppIcon name="plus" :size="10" />
            </label>
          </div>
        </div>

        <span
          class="node-port in"
          title="输入端口：把别的卡片拖到这里 → 它就成为这张卡片的上级"
          @pointerdown="startLinkPort($event, 'note', n.id, 'in')"
        ></span>
        <span
          class="node-port out"
          title="输出端口：从这里拖到另一张卡片 → 那张卡片成为它的下级"
          @pointerdown="startLinkPort($event, 'note', n.id, 'out')"
        ></span>
        <span class="node-resize" title="拖动改大小" @pointerdown="startResizeNode($event, n)"></span>
      </div>
    </div>

    <!-- 图片右键菜单：发送到文档 / 预览 / 定位文件 -->
    <div
      v-if="imgMenu"
      class="wb-menu"
      :style="{ left: imgMenu.x + 'px', top: imgMenu.y + 'px' }"
      @pointerdown.stop
      @click.stop
      @contextmenu.prevent
    >
      <div class="wm-h">
        <span class="wm-ico">🖼</span>
        <span class="wm-name">{{ imgMenuNote()?.text || "图片" }}</span>
      </div>
      <button class="wm-item wm-primary" @click="sendImageToDoc(imgMenuNote())">
        <span class="wm-label">📄 发送到文档</span>
        <span class="wm-sub">插到光标处</span>
      </button>
      <button class="wm-item" @click="previewFromMenu">
        <span class="wm-label">👁 预览</span>
      </button>
      <button class="wm-item" @click="revealFromMenu">
        <span class="wm-label">📁 在文件夹中显示</span>
      </button>
    </div>

    <!-- 从端口拖到空白处：就地选一种节点建出来，并自动连上 -->
    <div
      v-if="typeMenu"
      class="wb-menu wb-type-menu"
      :style="{ left: typeMenu.x + 'px', top: typeMenu.y + 'px' }"
      @pointerdown.stop
      @click.stop
      @contextmenu.prevent
    >
      <div class="wm-h">
        <span class="wm-ico">＋</span>
        <span class="wm-name">{{ typeMenu.from.role === "out" ? "新建下级" : "新建上级" }}</span>
      </div>
      <button
        v-for="t in NODE_TYPES"
        :key="t.kind"
        class="wm-item"
        @click="createFromTypeMenu(t.kind)"
      >
        <span class="wm-label">{{ t.label }}</span>
        <span class="wm-sub">{{ t.hint }}</span>
      </button>
    </div>

    <!-- empty state -->
    <div v-if="isEmpty" class="wb-empty">
      <div style="font-size: 34px; margin-bottom: 8px">🧠</div>
      <div style="font-weight: 600; margin-bottom: 6px">这是白板</div>
      <div class="wb-empty-sub">
        左侧看板里的任务会自动出现在这里：选中它按 <b>Tab</b> 就能长出子任务，<b>Enter</b>
        加同级；<br />
        再点节点上的 <b>📎</b> 就能把资料挂到它下面，整理成一条条分支。<br />
        <b>文档</b>栏里的 Markdown 文档按住 <b>⠿</b> 拖进来，就能在白板里直接改那篇文档。
      </div>
      <div class="wb-empty-actions">
        <el-button size="small" type="primary" @click="pickFiles">📎 上传资料</el-button>
        <el-button size="small" @click="addNote">🗒 新建便签</el-button>
        <el-button size="small" @click="ensureMindRoot()">🧠 开始画导图</el-button>
      </div>
    </div>

    <TaskDialog v-if="activeTask" v-model="dialogOpen" :task="activeTask" />
    <FilePreview v-model="previewOpen" :file="previewTarget" @cite="onCite" />

    <!-- 📄 插入文档：从写作栏的 Markdown 文档里挑一篇放上白板 -->
    <el-dialog
      v-model="docPickOpen"
      title="插入 Markdown 文档到白板"
      width="480px"
      append-to-body
      class="wb-docpick-dialog"
    >
      <div v-if="!store.docs.length" class="dp-empty">
        当前项目还没有文档。<br />
        先到<b>文档</b>栏写一篇（或者直接把 .md 文件拖进白板），再回到这里插入。
      </div>
      <div v-else class="dp-list">
        <div v-for="d in store.docs" :key="d.id" class="dp-item" @click="pickDoc(d)">
          <span class="dp-ico">📄</span>
          <div class="dp-main">
            <div class="dp-title">{{ d.title || "未命名文档" }}</div>
            <div class="dp-sum">{{ docSummary(d.body, 60) || "（空文档）" }}</div>
          </div>
          <span class="dp-stat">{{ docStats(d.body).chars }} 字</span>
        </div>
      </div>
      <div class="dp-hint">
        也可以直接在<b>文档</b>栏的文档列表里按住拖到白板上 —— 落在某张卡片上就成为它的下级。
      </div>
      <template #footer>
        <el-button @click="docPickOpen = false">关闭</el-button>
      </template>
    </el-dialog>

    <!-- 文档卡片就地编辑：白板上直接改这篇 Markdown，改完落回写作栏 -->
    <el-dialog
      v-model="docEditOpen"
      :title="`编辑文档 · ${docEditTitle || '未命名文档'}`"
      width="820px"
      append-to-body
      class="wb-docedit-dialog"
    >
      <div class="de-head">
        <input v-model="docEditTitle" class="de-title" placeholder="文档标题" />
      </div>
      <MdEditor ref="docEditRef" v-model="docEditBody" />
      <div class="de-foot">
        <span class="de-hint">
          保存后，「文档」栏里打开的这篇、白板上所有指向它的卡片，内容都会一起更新。
        </span>
        <el-button @click="docEditOpen = false">取消</el-button>
        <el-button type="primary" @click="saveDocEditor">保存</el-button>
      </div>
    </el-dialog>

    <!-- 把节点内容写进文档（选目标文档） -->
    <el-dialog
      v-model="docWriteOpen"
      title="写进 Markdown 文档"
      width="520px"
      append-to-body
      class="wb-docwrite-dialog"
    >
      <div class="dw-label">要写入的内容</div>
      <textarea v-model="docWriteChunk" class="dw-text" rows="5"></textarea>
      <div class="dw-label" style="margin-top: 12px">选一篇文档追加进去</div>
      <div v-if="!store.docs.length" class="dp-empty">当前项目还没有文档，可以直接新建一篇。</div>
      <div v-else class="dw-list">
        <div v-for="d in store.docs" :key="d.id" class="dw-item" @click="confirmWriteIntoDoc(d)">
          <span class="dp-ico">📄</span>
          <span class="dw-title">{{ d.title || "未命名文档" }}</span>
          <span class="dp-stat">{{ docStats(d.body).chars }} 字</span>
        </div>
      </div>
      <template #footer>
        <el-button @click="docWriteOpen = false">取消</el-button>
        <el-button type="primary" @click="createDocAndWrite">＋ 新建文档并写入</el-button>
      </template>
    </el-dialog>

    <!-- 文档卡片「📥 收内容」：把白板上别的节点搬进这篇文档 -->
    <el-dialog
      v-model="docCollectOpen"
      :title="`收内容到 · ${docCollectDoc?.title || '文档'}`"
      width="560px"
      append-to-body
      class="wb-doccollect-dialog"
    >
      <div v-if="!docCollectItems.length" class="dp-empty">
        白板上还没有带文字的节点，先建个便签或写个任务再来收。
      </div>
      <div v-else class="dc-list">
        <div v-for="it in docCollectItems" :key="it.key" class="dc-item" @click="collectNodeInto(it.key)">
          <span class="dc-kind">{{ it.kindLabel }}</span>
          <span class="dc-text">{{ it.text.slice(0, 60) }}</span>
          <span class="dc-go">收进去 →</span>
        </div>
      </div>
      <template #footer>
        <el-button @click="docCollectOpen = false">关闭</el-button>
      </template>
    </el-dialog>

    <!-- 端口菜单里选「图片 / 资料」：先选文件，再自动建节点并连上 -->
    <el-dialog v-model="portFileOpen" title="选择图片或资料" width="440px" append-to-body>
      <label class="up-zone">
        <input class="up-input" type="file" multiple @change="onPortFilePicked" />
        <div class="up-ico">🖼</div>
        <div class="up-main">点击这里选择文件</div>
        <div class="up-sub">图片 / PDF / 文档都行 —— 选完自动建成节点，并连到刚才那个节点上</div>
      </label>
      <template #footer>
        <el-button @click="portFileOpen = false">取消</el-button>
      </template>
    </el-dialog>

    <!-- 上传资料：对话框里是「看得见」的原生 file input，用户直接点真控件。
         旧方案（JS click 隐藏 input）在个别 Edge 下会被静默拦截，已弃用。 -->
    <el-dialog
      v-model="uploadOpen"
      :title="uploadTarget ? '上传资料（挂到所选节点下）' : '上传资料'"
      width="460px"
      append-to-body
      class="wb-upload-dialog"
    >
      <label class="up-zone">
        <input class="up-input" type="file" multiple @change="onDialogFiles" />
        <div class="up-ico">📎</div>
        <div class="up-main">点击这里选择文件（可多选）</div>
        <div class="up-sub">图片 / PDF / Word / Excel / PPT / 音视频 / 文本……</div>
      </label>
      <div class="up-native">
        <span>选不出来？用这个原生选择框：</span>
        <input type="file" multiple @change="onDialogFiles" />
      </div>
      <div class="up-alt">
        也可以把文件直接<b>拖进白板</b>，或复制图片后按 <b>Ctrl+V</b> 粘贴。
      </div>
    </el-dialog>

    <!-- 反查：这份资料被哪些节点引用了 -->
    <el-dialog
      v-model="refsOpen"
      title="这份资料被谁引用了"
      width="520px"
      append-to-body
      class="wb-refs-dialog"
    >
      <div class="rf-file">📎 {{ refsFile?.name }}</div>
      <div v-if="!refsList.length" class="rf-empty">
        还没有任何节点引用它。<br />
        <span class="rf-hint">在资料卡片或预览弹窗上点「📌 引用到白板」就能建立引用。</span>
      </div>
      <div v-else class="rf-list">
        <div v-for="r in refsList" :key="r.key" class="rf-item" @click="jumpToRef(r.key)">
          <span class="rf-kind">{{ r.kind }}</span>
          <span class="rf-label">{{ r.label }}</span>
          <span class="rf-go">跳过去 →</span>
        </div>
      </div>
      <template #footer>
        <el-button @click="refsOpen = false">关闭</el-button>
      </template>
    </el-dialog>

    <!-- 文本 / Markdown 大纲 → 思维导图 -->
    <el-dialog
      v-model="outlineOpen"
      title="文本 / Markdown 转思维导图"
      width="820px"
      append-to-body
      class="wb-outline-dialog"
    >
      <div class="ol-tip">
        每行一个节点，<b>父节点不缩进，子节点比上一级多缩进一点</b>（空格或 Tab 都行，几个空格不限）。<br />
        也认 Markdown 的 <code>#</code> 标题、<code>-</code> / <code>1.</code> 列表、<code>- [ ]</code> 待办；
        代码块、表格、分隔线会自动跳过。填好后点「生成导图」，或直接按 <b>Ctrl+Enter</b>。
      </div>

      <div class="ol-tools">
        <label class="ol-openfile">
          <input
            type="file"
            accept=".md,.markdown,.txt,.text,.log,.adoc,text/plain,text/markdown"
            @change="onOutlineFilePicked"
          />
          📂 打开 md / txt
        </label>
        <el-button size="small" @click="fillOutlineSample">🧩 放个示例</el-button>
        <el-button size="small" :disabled="!outlineText" @click="outlineText = ''">清空</el-button>
        <el-checkbox v-model="outlineStrip" size="small">去掉 Markdown 标记</el-checkbox>
        <span class="ol-stats" :class="{ warn: outlineWarn }">{{ outlineStats }}</span>
      </div>

      <el-input
        v-model="outlineText"
        type="textarea"
        :rows="14"
        resize="vertical"
        class="ol-input"
        placeholder="在这里粘贴大纲文本，例如：&#10;山茶间品牌&#10;  品牌定位&#10;    目标客群&#10;  视觉规范"
        @keydown.ctrl.enter.prevent="buildOutlineOnBoard"
      />

      <div class="ol-preview-head">
        <a @click="outlineShowPreview = !outlineShowPreview">
          {{ outlineShowPreview ? "▾" : "▸" }} 看看识别成什么样
        </a>
      </div>
      <pre v-if="outlineShowPreview" class="ol-preview">{{ outlinePreview || "（还没有内容）" }}</pre>

      <div v-if="outlineAttachTarget" class="ol-attach">
        <el-checkbox v-model="outlineAttach" size="small">
          挂到当前选中的「{{ outlineAttachLabel }}」下面
        </el-checkbox>
      </div>

      <template #footer>
        <el-button @click="outlineOpen = false">取消</el-button>
        <el-button type="primary" :disabled="!outlineCount" @click="buildOutlineOnBoard">
          生成导图
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.wb-canvas {
  position: relative;
  flex: 1;
  min-width: 0;
  height: 100%;
  /* ⚠️ 必须 clip 不能 hidden：hidden 仍是滚动容器，浏览器为了把获得焦点的节点
     「滚动到可见」会偷偷改变 scrollTop，把绝对定位的悬浮工具栏顶出画布顶端。 */
  overflow: clip;
  cursor: default;
  user-select: none;
  background-color: var(--bg);
  /* 制图坐标纸：点阵再淡一档，靠纸面的"呼吸感"而不是格线抢注意力 */
  background-image: radial-gradient(circle at 1px 1px, var(--hairline-strong) 1px, transparent 0);
  background-repeat: repeat;
}
/* 纸面的四周压暗一点点：让画布中间"亮"起来，节点像浮在光里 */
.wb-canvas::before {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 0;
  background: radial-gradient(
    115% 95% at 50% 12%,
    transparent 52%,
    color-mix(in srgb, var(--text) 4%, transparent) 100%
  );
}
/* 文件选择框：不用 display:none —— 个别环境下它的 click() 会被拦掉，
   表现就是「点上传按钮毫无反应」。挪出可视区的小透明元素最稳。 */
.wb-file-input {
  position: fixed;
  left: -40px;
  top: 0;
  width: 1px;
  height: 1px;
  opacity: 0.01;
  border: 0;
  padding: 0;
  z-index: -1;
}
.wb-canvas.space-pan {
  cursor: grab;
}
.wb-canvas.linking {
  cursor: crosshair;
}
.wb-canvas.drop-active::after {
  content: "松手：拖到卡片上=挂到该节点下，拖到空白=自由摆放";
  position: absolute;
  inset: 8px;
  border: 2px dashed var(--accent, #0079bf);
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  color: var(--accent, #0079bf);
  background: rgb(0 121 191 / 6%);
  pointer-events: none;
  z-index: 30;
}

.wb-marquee {
  position: absolute;
  border: 1px solid var(--accent, #0079bf);
  background: rgb(64 158 255 / 12%);
  border-radius: 2px;
  pointer-events: none;
  z-index: 40;
}

/* ---------- 工具栏：悬浮玻璃条 ---------- */
.wb-toolbar {
  position: absolute;
  top: 10px;
  left: 10px;
  right: 10px;
  z-index: 25;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 3px;
  padding: 5px 7px;
  background: color-mix(in srgb, var(--bg-elevated) 90%, transparent);
  backdrop-filter: blur(10px);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: var(--shadow-md);
}
.tb-group {
  display: flex;
  align-items: center;
  gap: 2px;
}
.tb-sep {
  width: 1px;
  height: 16px;
  background: var(--border);
  margin: 0 4px;
}
.tb {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 27px;
  padding: 0 9px;
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
  /* 线性图标比 emoji 轻，颜色要深一档才不显得发灰 */
  color: color-mix(in srgb, var(--text) 74%, transparent);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 7px;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.13s var(--ease), color 0.13s var(--ease),
    border-color 0.13s var(--ease);
}
.tb:hover:not(:disabled) {
  background: var(--bg-sunken);
  color: var(--text);
}
.tb.on {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 650;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 22%, transparent);
}
/* 纯图标工具：方形按钮，图标居中 */
.tb.ico {
  padding: 0;
  width: 29px;
  justify-content: center;
  line-height: 1;
}
/* 统一放大到 18px —— 参考稿的图标在这个尺度上最清楚 */
.tb .app-icon {
  width: 18px;
  height: 18px;
}

/* ---------------- 连线：拆分按钮 + 样式菜单 ---------------- */
.tb-split {
  position: relative;
  display: inline-flex;
  align-items: center;
  height: 27px;
  border: 1px solid transparent;
  border-radius: 7px;
}
.tb-split.on {
  background: var(--accent-soft);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 22%, transparent);
}
.tb-split .tb-main {
  width: 26px;
  height: 100%;
  border-radius: 7px 0 0 7px;
}
.tb-split.on .tb-main,
.tb-split.on .tb-caret {
  color: var(--accent);
}
/* 右侧小三角：不抢主体，只提示「这里有菜单」 */
.tb-caret {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 13px;
  height: 100%;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--text-faint);
  cursor: pointer;
  border-radius: 0 7px 7px 0;
}
.tb-caret:hover {
  background: var(--bg-sunken);
  color: var(--text);
}
/* 样式菜单：挂在按钮正下方 */
.tb-pop {
  position: absolute;
  top: calc(100% + 7px);
  left: 0;
  z-index: 40;
  width: 198px;
  padding: 6px;
  border-radius: var(--radius-md);
  background: var(--bg-elevated);
  box-shadow: var(--shadow-md), var(--shadow-ring);
}
.tb-pop-h {
  padding: 4px 8px 6px;
  font-size: 10.5px;
  letter-spacing: 0.1em;
  color: var(--text-faint);
}
.tb-pop button {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 9px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text);
  font-family: inherit;
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
  transition: background 0.14s var(--ease-out);
}
.tb-pop button:hover {
  background: var(--bg-sunken);
}
.tb-pop button.on {
  background: var(--accent-soft);
  color: var(--accent);
}
.tb-pop button span {
  display: flex;
  flex-direction: column;
  gap: 1px;
  line-height: 1.35;
}
.tb-pop button small {
  font-size: 10.5px;
  font-weight: 400;
  color: var(--text-faint);
}
.tb-pop button.on small {
  color: color-mix(in srgb, var(--accent) 68%, var(--text-faint));
}
.tb-txt {
  font-size: 12px;
}
.tb.danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--danger) 14%, transparent);
  color: var(--danger);
}
.tb:disabled {
  opacity: 0.38;
  cursor: not-allowed;
}
/* 上传对话框：大热区包着原生 file input（标准 label 转发，无 JS click）；
   下面另给一个完全原生的选择框兜底，双保险 */
.up-zone {
  position: relative;
  display: block;
  padding: 26px 16px;
  text-align: center;
  border: 1.5px dashed var(--border, #c0c4cc);
  border-radius: 10px;
  background: var(--bg-sunken, #f7f8fa);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.up-zone:hover {
  border-color: var(--accent, #0079bf);
  background: var(--bg, #fff);
}
.up-input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  cursor: pointer;
  font-size: 0;
}
.up-ico {
  font-size: 30px;
  margin-bottom: 6px;
}
.up-main {
  font-size: 14px;
  font-weight: 600;
}
.up-sub {
  margin-top: 4px;
  font-size: 12px;
  color: var(--text-subtle, #909399);
}
.up-native {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
  font-size: 12px;
  color: var(--text-subtle, #909399);
}
.up-native input {
  font-size: 12px;
  max-width: 280px;
}
.up-alt {
  margin-top: 12px;
  font-size: 12px;
  color: var(--text-subtle, #909399);
  text-align: center;
}
/* 「打开 md / txt」= label 包原生 input，外观仿小按钮 */
.ol-openfile {
  display: inline-flex;
  align-items: center;
  position: relative;
  height: 24px;
  padding: 0 11px;
  font-size: 12px;
  border-radius: 5px;
  border: 1px solid var(--border, #dcdfe6);
  background: var(--bg, #fff);
  color: var(--text, #606266);
  cursor: pointer;
  user-select: none;
  overflow: hidden;
}
.ol-openfile:hover {
  color: var(--accent, #0079bf);
  border-color: var(--accent, #0079bf);
}
.ol-openfile input {
  position: absolute;
  inset: 0;
  width: 100%;
  opacity: 0;
  cursor: pointer;
  font-size: 0;
}
.wb-zoom {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--text-subtle);
  min-width: 42px;
  text-align: center;
  cursor: pointer;
  border-radius: 7px;
  padding: 4px 0;
  transition: background 0.13s var(--ease), color 0.13s var(--ease);
}
.wb-zoom:hover {
  background: var(--bg-sunken);
  color: var(--text);
}

/* 模式提示（连线 / 放节点） */
.wb-mode {
  position: absolute;
  bottom: 44px;
  left: 10px;
  z-index: 25;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--accent-fg);
  background: var(--accent);
  border-radius: 999px;
  padding: 5px 13px;
  box-shadow: var(--shadow-md);
}
.wb-mode-x {
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 11px;
  padding: 0;
  opacity: 0.8;
}
.wb-mode-x:hover {
  opacity: 1;
}

.tn-kids {
  color: var(--accent);
  font-weight: 600;
}

.wb-hint {
  position: absolute;
  bottom: 8px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 20;
  max-width: calc(100% - 20px);
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--text-subtle);
  background: color-mix(in srgb, var(--bg-elevated) 92%, transparent);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 4px 14px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
}

.wb-content {
  position: absolute;
  top: 0;
  left: 0;
  transform-origin: 0 0;
}

/* 连线短菜单：点线才出现，宽度压在 280px 内，删除固定在最左并隔开 */
.edge-menu {
  position: absolute;
  z-index: 40;
  display: flex;
  align-items: stretch;
  gap: 5px;
  padding: 5px;
  border-radius: var(--radius-md);
  background: var(--bg-elevated);
  border: 1px solid var(--hairline);
  box-shadow: var(--shadow-pop, 0 8px 24px rgb(0 0 0 / 14%));
  /* 浮在点击点上方，免得盖住被点的那根线 */
  transform: translate(-50%, calc(-100% - 8px));
  white-space: nowrap;
}
.edge-menu.flip {
  transform: translate(-50%, 12px);
}
.edge-menu button {
  border: none;
  background: transparent;
  color: var(--text);
  cursor: pointer;
}
.edge-menu button:hover {
  background: var(--fill-weak, rgb(0 0 0 / 6%));
}
/* 删除：最左一条竖排，警告色，和关系项拉开 */
.edge-menu .em-del {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  width: 44px;
  border-radius: 7px;
  background: rgb(220 83 70 / 9%);
  color: var(--danger);
  font-size: 11.5px;
  line-height: 1;
  font-weight: 600;
}
.edge-menu .em-del:hover {
  background: rgb(220 83 70 / 18%);
}
/* 四种关系两列两行：比一字排开窄一半，也不至于竖成长条 */
.edge-menu .em-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 2px;
}
/* 关系项：左边一个色点，右边两行（关系名 + 一句话说明） */
.edge-menu .em-kind {
  display: grid;
  grid-template-columns: auto auto;
  grid-template-rows: auto auto;
  column-gap: 6px;
  align-items: center;
  padding: 4px 8px 4px 7px;
  border-radius: 6px;
  text-align: left;
}
.edge-menu .em-dot {
  grid-row: 1 / span 2;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--edge-parent);
}
.edge-menu .em-kind b {
  font-size: 12.5px;
  line-height: 16px;
  font-weight: 600;
}
.edge-menu .em-kind small {
  font-size: 10px;
  line-height: 13px;
  color: var(--text-faint);
}
.edge-menu .em-kind.k-decompose .em-dot {
  background: var(--edge-parent);
}
.edge-menu .em-kind.k-precede .em-dot {
  background: var(--edge-order);
}
.edge-menu .em-kind.k-evidence .em-dot {
  background: var(--edge-source);
}
.edge-menu .em-kind.k-produce .em-dot {
  background: var(--edge-output);
}
.edge-menu .em-kind.on {
  background: var(--accent-soft);
}
.edge-menu .em-kind.on b {
  color: var(--accent);
}
.edge-menu .em-kind.on small {
  color: var(--accent);
  opacity: 0.75;
}

.wb-edges {
  position: absolute;
  top: 0;
  left: 0;
  width: 1px;
  height: 1px;
  overflow: visible;
  pointer-events: none;
}
/* 连线：细实线 + 末端箭头，方向一眼可读（from = 上级 → to = 下级） */
#wb-arrow path {
  fill: var(--text-faint);
}
#wb-arrow-live path {
  fill: var(--accent);
}
/* 工具栏图标按含义上色：绿=内容、紫=结构、琥珀=时间、蓝=连接。
   只改图标颜色，按钮的底色和选中态都不动，避免整条工具栏变花。 */
.tb .app-icon.ico-upload,
.tb .app-icon.ico-doc {
  color: var(--ic-doc);
}
.tb .app-icon.ico-layout {
  color: var(--ic-board);
}
.tb .app-icon.ico-gantt {
  color: var(--ic-gantt);
}
.tb .app-icon.ico-link {
  color: var(--ic-kanban);
}

.edge-line {
  fill: none;
  stroke: var(--text-faint);
  stroke-width: 1.7;
  stroke-linecap: round;
}
/* 四种关系：线型 + 一种克制的颜色。只给四种语义上色，别的地方保持中性，
   否则画布上一片彩线反而看不出重点 */
.edge-line.k-decompose {
  stroke: var(--edge-parent);
  stroke-width: 1.6;
}
.edge-line.k-precede {
  stroke: var(--edge-order);
  stroke-width: 2.2;
}
.edge-line.k-evidence {
  stroke: var(--edge-source);
  stroke-width: 1.8;
  stroke-dasharray: 1 5;
  stroke-linecap: round;
}
.edge-line.k-produce {
  stroke: var(--edge-output);
  stroke-width: 3;
  opacity: 0.62;
}
/* 箭头 fill 跟着关系走 */
.mk-decompose {
  fill: var(--edge-parent);
}
.mk-precede {
  fill: var(--edge-order);
}
.mk-evidence {
  fill: var(--edge-source);
}
.mk-produce {
  fill: var(--edge-output);
}
/* 点中的那条线：亮一档，配合菜单指示"改的是它" */
.edge-line.picked {
  stroke: var(--accent);
  stroke-width: 2.6;
  opacity: 1;
}
.edge-line.linking {
  stroke: var(--accent);
  stroke-width: 2;
  stroke-dasharray: 5 4;
  animation: wb-dash 0.55s linear infinite;
}
@keyframes wb-dash {
  to {
    stroke-dashoffset: -9;
  }
}
.edge-hit {
  fill: none;
  stroke: transparent;
  stroke-width: 16;
  pointer-events: stroke;
  cursor: pointer;
}

.wb-node {
  position: absolute;
  cursor: grab;
  touch-action: none;
  border-radius: var(--radius-md);
}
.wb-node:active {
  cursor: grabbing;
}
/* 悬停时抬到最上层，避免悬浮工具条被旁边的卡片压住 */
.wb-node:hover {
  z-index: 4;
}
/* 选中：柔光环而不是硬描边 */
.wb-node.sel {
  outline: none;
  box-shadow: 0 0 0 2px var(--accent), 0 0 0 6px var(--accent-faint), var(--shadow-md);
}
.wb-node.linkfrom {
  outline: none;
  box-shadow: 0 0 0 2px var(--brand-2), 0 0 0 6px var(--brand-2-soft), var(--shadow-md);
}

/* 任务卡 */
.task-node {
  min-height: 58px;
  background: var(--bg-elevated);
  border-radius: var(--radius-md);
  border-left: 3px solid var(--accent);
  padding: 9px 11px;
  box-shadow: var(--shadow-ring), var(--shadow-sm);
  display: flex;
  flex-direction: column;
  gap: 4px;
  transition: box-shadow 0.2s var(--ease-out), transform 0.2s var(--ease-out);
}
.task-node:hover {
  box-shadow: var(--shadow-ring), var(--shadow);
  transform: translateY(-1px);
}
.tn-title {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.35;
  word-break: break-word;
  color: var(--text);
}
.tn-input {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  background: transparent;
  border: none;
  outline: none;
  border-bottom: 1px dashed var(--accent, #0079bf);
  width: 100%;
  padding: 0;
}
.tn-sub {
  display: flex;
  gap: 8px;
  font-size: 11px;
  color: var(--text-subtle);
}
.tn-col {
  color: var(--text-subtle);
}
/* 任务编号：一眼能念出来的短标号，跟 AI 说话时直接说 T2 */
.tn-seq {
  display: inline-block;
  margin-right: 5px;
  padding: 0 4px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 700;
  line-height: 15px;
  letter-spacing: 0.02em;
  color: var(--text-subtle);
  background: var(--fill-weak, rgb(0 0 0 / 5%));
  vertical-align: 1px;
}
/* 依据 chip：三档用明暗区分，不用颜色堆叠 —— 一张卡上挂五份材料也不会花 */
.tn-refs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}
.tn-ref {
  max-width: 100%;
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 10px;
  line-height: 15px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  border: 1px solid transparent;
}
/* 必须遵守：实心深色 */
.tn-ref.lv-0 {
  color: var(--bg-elevated);
  background: var(--text-subtle);
}
/* 可以参考：描边 */
.tn-ref.lv-1 {
  color: var(--text);
  border-color: var(--hairline-strong);
  background: var(--bg-elevated);
}
/* 仅作背景：灰字虚线 */
.tn-ref.lv-2 {
  color: var(--text-faint);
  border-style: dashed;
  border-color: var(--hairline-strong);
}
.tn-ref:hover {
  filter: brightness(0.96);
}
.tn-desc {
  margin-top: 3px;
  font-size: 11px;
  line-height: 1.4;
  color: var(--text-subtle);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 44px;
  overflow: hidden;
}
.tn-edit {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.tn-desc-input {
  width: 100%;
  min-height: 54px;
  resize: vertical;
  font: inherit;
  font-size: 11px;
  line-height: 1.4;
  color: var(--text-subtle);
  background: transparent;
  border: 1px dashed var(--border);
  border-radius: 6px;
  padding: 4px 6px;
  outline: none;
}
.tn-edit-actions {
  display: flex;
  gap: 6px;
}
.tn-edit-actions button {
  height: 20px;
  padding: 0 8px;
  font-size: 11px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--bg-elevated, #fff);
  color: var(--text);
  cursor: pointer;
}
.tn-edit-actions button:first-child {
  border-color: var(--accent, #0079bf);
  color: var(--accent, #0079bf);
  font-weight: 600;
}

/* 便签 */
.k-note {
  border-radius: var(--radius-md);
  padding: 11px 12px;
  box-shadow: var(--shadow-ring), var(--shadow-sm), var(--inner-light);
  color: var(--ink, #2b2b2b);
}
.note-text {
  font-size: 12.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  overflow: hidden;
}
.note-edit {
  width: 100%;
  min-height: 80px;
  resize: none;
  border: none;
  outline: none;
  background: transparent;
  font: inherit;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--ink, #2b2b2b);
}

/* 文本标签 */
.k-text {
  border: 1px dashed transparent;
  padding: 7px 9px;
  display: flex;
  align-items: center;
  transition: border-color 0.18s var(--ease-out);
}
.k-text:hover {
  border-color: var(--border-strong);
}
.text-body {
  font-family: var(--font-serif);
  font-size: 16px;
  font-weight: 600;
  line-height: 1.5;
  letter-spacing: 0.05em;
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-word;
}

/* 思维导图节点：纯色胶囊，靠一层柔光而不是描边立住 */
.k-mind {
  border: none;
  border-radius: 999px;
  padding: 9px 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 5px 16px -7px rgba(17, 24, 39, 0.6), var(--inner-light);
}
/* 圆形导图节点：直径固定，内容居中换行 */
.k-mind.round {
  border-radius: 50%;
  padding: 12px;
  text-align: center;
}
.mind-text {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--ink, #fff);
  line-height: 1.4;
  letter-spacing: 0.02em;
  text-align: center;
  word-break: break-word;
  text-shadow: var(--ink-shadow, none);
}
.mind-edit {
  color: var(--ink, #fff);
  min-height: 30px;
  text-align: center;
}

/* 分组框：1px 虚线就够，2px 太重 */
.box-node {
  border: 1px dashed;
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--text) 3%, transparent);
}
/* 顶部一整行：名称胶囊 + 强度徽章，用 flex 排，长标题先让位给徽章 */
.box-head {
  position: absolute;
  top: -12px;
  left: 12px;
  right: 12px;
  display: flex;
  align-items: center;
  gap: 6px;
  /* 这一条横带别挡住拖框：只有两个胶囊本身可点 */
  pointer-events: none;
}
.box-head > * {
  pointer-events: auto;
}
.box-title {
  min-width: 0;
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  color: var(--ink, #fff);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 强度徽章：白底彩字，跟左侧的框色标题条区分开
   （两个都做成实底同色，就看不出哪个是名字、哪个是等级） */
.box-cluster {
  flex: none;
  padding: 1px 8px;
  border: 1px solid transparent;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  line-height: 16px;
  cursor: pointer;
  background: var(--bg-elevated);
  color: var(--text-faint);
}
.box-cluster.cs-strong {
  color: #c1701f;
  border-color: #d9822b;
}
.box-cluster.cs-ref {
  color: #2f6ac4;
  border-color: #3b7ddd;
}
.box-cluster.cs-weak {
  color: #78828f;
  border-color: #98a2b6;
}
html.dark .box-cluster.cs-strong {
  color: #e9a35c;
}
html.dark .box-cluster.cs-ref {
  color: #8db2f2;
}
html.dark .box-cluster.cs-weak {
  color: #a8b2c0;
}

/* 拖出分组框时的预览：比框选矩形更像"即将生成的框" */
.wb-boxdraft {
  position: absolute;
  z-index: 3;
  border: 1.5px dashed var(--brand-2, #b8763f);
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--brand-2, #b8763f) 7%, transparent);
  pointer-events: none;
}
.wb-boxdraft span {
  position: absolute;
  top: -11px;
  left: 12px;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--brand-2, #b8763f);
  color: #fff;
  font-size: 11px;
  line-height: 18px;
  white-space: nowrap;
}

.box-input {
  border: none;
  background: transparent;
  color: var(--ink, #fff);
  font-size: 12px;
  font-weight: 600;
  outline: none;
  width: 120px;
}

/* 分组框永远垫在最下层：悬停也不许浮上来，否则会盖住框里的卡片 */
.box-node,
.box-node:hover,
.box-node.sel {
  z-index: 0;
}
/* ---------- 依据气泡：换档 + 写要点 ---------- */
.ref-menu {
  position: absolute;
  z-index: 40;
  width: 300px;
  padding: 12px;
  transform: translate(-50%, 0);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-md);
  background: var(--bg-elevated);
  box-shadow: var(--shadow-2);
}
.rm-head {
  margin-bottom: 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.rm-levels {
  display: flex;
  gap: 4px;
  margin-bottom: 8px;
}
.rm-lv {
  flex: 1;
  padding: 4px 0;
  border: 1px solid var(--hairline-strong);
  border-radius: 5px;
  background: var(--bg);
  color: var(--text-subtle);
  font-size: 11px;
  line-height: 16px;
  cursor: pointer;
}
.rm-lv:hover {
  border-color: var(--accent);
}
/* 三档跟任务卡上的小标签用同一套视觉，点开前后不会认成两个东西 */
.rm-lv.lv-0.on {
  background: var(--text-subtle);
  border-color: var(--text-subtle);
  color: var(--bg-elevated);
}
.rm-lv.lv-1.on {
  border-color: var(--text);
  color: var(--text);
  font-weight: 600;
}
.rm-lv.lv-2.on {
  border-style: dashed;
  border-color: var(--text-subtle);
  color: var(--text-subtle);
  font-weight: 600;
}
.rm-point {
  width: 100%;
  padding: 7px 9px;
  border: 1px solid var(--hairline-strong);
  border-radius: 5px;
  background: var(--bg);
  color: var(--text);
  font-family: inherit;
  font-size: 12px;
  line-height: 1.6;
  resize: vertical;
  outline: none;
}
.rm-point:focus {
  border-color: var(--accent);
}
.rm-foot {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
}
.rm-tip {
  flex: 1;
  font-size: 10px;
  line-height: 1.4;
  color: var(--text-faint);
}
.rm-del,
.rm-save {
  flex: none;
  padding: 4px 10px;
  border-radius: 5px;
  font-size: 11px;
  cursor: pointer;
}
.rm-del {
  border: 1px solid var(--danger, #d9534f);
  background: transparent;
  color: var(--danger, #d9534f);
}
.rm-del:hover {
  background: color-mix(in srgb, var(--danger, #d9534f) 10%, transparent);
}
.rm-save {
  border: 1px solid var(--accent);
  background: var(--accent);
  color: #fff;
}
/* 写过要点的标签带一个小圆点：一眼能看出这条已经能传给 AI 了 */
.tn-ref-dot {
  display: inline-block;
  width: 4px;
  height: 4px;
  margin-right: 3px;
  border-radius: 50%;
  background: currentColor;
  vertical-align: middle;
  opacity: 0.75;
}

/* 只有色板展开时才临时抬起来，不然色块会被框里的卡片压住点不到 */
.box-node.pal-open {
  z-index: 7;
}
/* 分组框的操作按钮放到底部右边：顶部要留给「标题 + 强度标签」，
   否则一悬停就被工具条盖住，强度标签点不到 */
.box-node .node-tools {
  top: auto;
  bottom: 10px;
  right: 16px;
}

/* ---- 白板浮动菜单（右键图片 / 从端口拖到空白处） ---- */
.wb-menu {
  position: absolute;
  z-index: 60;
  min-width: 200px;
  padding: 5px;
  border-radius: 11px;
  background: var(--bg-elevated, #fff);
  border: 1px solid var(--hairline, var(--border));
  box-shadow: var(--shadow-lg, 0 12px 32px rgb(0 0 0 / 18%));
  animation: wb-menu-in 0.12s var(--ease-out, ease-out);
}
@keyframes wb-menu-in {
  from {
    opacity: 0;
    transform: translateY(-3px) scale(0.98);
  }
}
.wm-h {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px 6px;
  font-size: 11px;
  color: var(--text-faint, var(--text-subtle));
  border-bottom: 1px solid var(--hairline, var(--border));
  margin-bottom: 4px;
}
.wm-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 170px;
}
.wm-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 9px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}
.wm-item:hover {
  background: var(--bg-sunken, rgba(127, 127, 127, 0.1));
}
.wm-label {
  flex: 1;
  white-space: nowrap;
}
.wm-sub {
  font-size: 10.5px;
  color: var(--text-faint, var(--text-subtle));
  white-space: nowrap;
}
.wm-primary .wm-label {
  font-weight: 600;
  color: var(--accent);
}
.wb-type-menu {
  min-width: 224px;
}

/* 资料卡 */
.k-file {
  /* 相框式：四周一圈白边，底部留宽放文件名（拍立得的做法） */
  background: #fff;
  border: 1px solid var(--hairline);
  border-radius: 7px;
  padding: 6px 6px 0;
  box-shadow: var(--shadow-sm);
  /* 这里不能用 overflow:hidden —— 悬浮工具条浮在卡片边框外，一旦被裁，
     按钮就变成"看得见、点不到"。圆角改由内部子元素各自负责。 */
  overflow: visible;
  display: flex;
  flex-direction: column;
}
/* 缩略图只给很小的圆角，接近方图；底部文件名条由 .file-meta 自己留白 */
.k-file .file-thumb {
  border-radius: 3px;
}
.k-file .file-meta {
  border-radius: 0;
  padding: 9px 4px 10px;
}
/* 非图片资料卡片只有一个 .file-meta，四角都要圆 */
.k-file .file-meta:first-child {
  border-radius: 4px;
}
.file-thumb {
  flex: 1;
  min-height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-sunken);
  overflow: hidden;
  cursor: zoom-in;
}
.file-thumb img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
  pointer-events: none;
}
.file-thumb-wait {
  font-size: 11px;
  color: var(--text-subtle);
}
.file-meta {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 8px;
  font-size: 11px;
  border-top: 1px solid var(--border);
  background: var(--bg-elevated, var(--bg));
}
.file-icon {
  flex: none;
}
.file-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
}
.file-size {
  flex: none;
  color: var(--text-subtle);
}

/* ---------- 悬浮操作条 ----------
   贴在卡片上沿外侧，**不侵占左右两侧** —— 那两块是输入/输出端口的地盘，
   以前连线按钮在左上角、操作条在右上角，卡片一窄就叠在一起。 */
.node-tools {
  position: absolute;
  top: -16px;
  right: 6px;
  display: flex;
  align-items: center;
  gap: 1px;
  padding: 2px;
  border-radius: var(--radius-md);
  background: var(--bg-elevated);
  box-shadow: var(--shadow-ring), var(--shadow-md);
  opacity: 0;
  transform: translateY(3px);
  transition: opacity 0.18s var(--ease-out), transform 0.18s var(--ease-out);
  z-index: 6;
  pointer-events: none;
}
.wb-node:hover .node-tools,
.wb-node.sel .node-tools {
  opacity: 1;
  transform: none;
  pointer-events: auto;
}
.node-tools button {
  height: 21px;
  padding: 0 7px;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-family: inherit;
  font-size: 11px;
  font-weight: 500;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-subtle);
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.12s var(--ease), color 0.12s var(--ease);
}
.node-tools button:hover {
  background: var(--accent-soft);
  color: var(--accent);
}
/* 「AI」是这一排里唯一主动去找它才点的按钮，给它一点分量 */
.node-tools button.tb-ai {
  color: var(--accent);
  font-weight: 700;
  letter-spacing: 0.04em;
}
.node-tools button.on {
  background: var(--accent-soft);
  color: var(--accent);
}

/* ---------- 色板 ----------
   会自己收起的浮层：贴在被点按钮下方，不改变工具条高度。
   注意 .node-tools button 的通用样式会命中这里，所以下面全部用更高优先级覆盖。 */
.node-tools .node-palette {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 7px;
  border-radius: 10px;
  background: var(--bg-elevated);
  box-shadow: var(--shadow-ring), var(--shadow-md);
  cursor: default;
  z-index: 8;
  animation: np-in 0.14s var(--ease-out);
}
@keyframes np-in {
  from {
    opacity: 0;
    transform: translateY(-3px);
  }
}
.node-tools .node-palette .np-sw {
  width: 17px;
  height: 17px;
  padding: 0;
  border-radius: 5px;
  border: none;
  box-shadow: inset 0 0 0 1px rgb(0 0 0 / 12%);
  cursor: pointer;
  transition: transform 0.12s var(--ease-out), box-shadow 0.12s var(--ease-out);
}
.node-tools .node-palette .np-sw:hover {
  transform: scale(1.14);
  background: var(--bg-elevated);
}
.node-tools .node-palette .np-sw.on {
  box-shadow:
    inset 0 0 0 1px rgb(0 0 0 / 12%),
    0 0 0 2px var(--bg-elevated),
    0 0 0 3.5px var(--accent);
}
.node-tools .node-palette .np-custom {
  position: relative;
  width: 17px;
  height: 17px;
  border-radius: 5px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-subtle);
  cursor: pointer;
  background: conic-gradient(
    #f87171,
    #fbbf24,
    #34d399,
    #38bdf8,
    #a78bfa,
    #f87171
  );
  box-shadow: inset 0 0 0 1px rgb(0 0 0 / 12%);
}
.node-tools .node-palette .np-custom input {
  position: absolute;
  inset: 0;
  opacity: 0;
  width: 100%;
  height: 100%;
  border: none;
  padding: 0;
  cursor: pointer;
}
.node-tools .node-palette .np-custom .app-icon {
  color: #fff;
  filter: drop-shadow(0 1px 1px rgb(0 0 0 / 45%));
}

/* ---------- 输入 / 输出端口 ----------
   右侧圆点 = 输出（本卡片当上级）；左侧圆点 = 输入（本卡片当下级）。
   平时完全隐藏，鼠标移到卡片上才出现 —— 常显的两个小圆点在几十张卡片时很吵。
   正在拖线时全部半显，指示哪些地方可以落点。 */
.node-port {
  position: absolute;
  top: 50%;
  width: 13px;
  height: 13px;
  box-sizing: border-box;
  border-radius: 50%;
  background: var(--bg-elevated);
  border: 2px solid var(--accent);
  cursor: crosshair;
  z-index: 5;
  opacity: 0;
  transition: opacity 0.13s var(--ease), transform 0.13s var(--ease),
    background 0.13s var(--ease);
}
/* 视觉还是小圆点，但抓取热区放大一圈，好点 */
.node-port::before {
  content: "";
  position: absolute;
  inset: -7px;
  border-radius: 50%;
}
.node-port.in {
  left: -7px;
  transform: translateY(-50%);
  border-color: var(--brand-2);
}
.node-port.out {
  right: -7px;
  transform: translateY(-50%);
}
.wb-node:hover .node-port,
.wb-node.sel .node-port,
.wb-canvas.link-mode .node-port {
  opacity: 1;
}
/* 拖线中：所有端口半显，指出能连到哪儿；光标停在哪个卡片上，那个卡片全亮 */
.wb-canvas.dragging-link .node-port {
  opacity: 0.35;
}
.wb-canvas.dragging-link .wb-node:hover .node-port {
  opacity: 1;
}
.node-port:hover {
  transform: translateY(-50%) scale(1.3);
  background: var(--accent);
}
.node-port.in:hover {
  background: var(--brand-2);
}

/* 底部提示条里用的小圆点示意 */
.hint-port {
  display: inline-block;
  width: 9px;
  height: 9px;
  margin: 0 3px;
  border-radius: 50%;
  border: 1.6px solid var(--accent);
  vertical-align: middle;
}
.hint-port.in {
  border-color: var(--brand-2);
}

.node-resize {
  position: absolute;
  right: -3px;
  bottom: -3px;
  width: 14px;
  height: 14px;
  border-radius: 3px;
  border: 1px solid var(--border);
  background: var(--bg-elevated, #fff);
  cursor: nwse-resize;
  opacity: 0;
  transition: opacity 0.12s;
}
.wb-node:hover .node-resize {
  opacity: 0.85;
}

/* 空白引导 */
.wb-empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  pointer-events: none;
  padding: 0 20px;
}
.wb-empty-sub {
  font-size: 13px;
  color: var(--text-subtle);
  line-height: 1.8;
}
.wb-empty-actions {
  display: flex;
  gap: 8px;
  margin-top: 14px;
  pointer-events: auto;
}

/* 文本 / Markdown 转导图 */
.ol-tip {
  font-size: 13px;
  line-height: 1.9;
  color: var(--text-subtle);
  background: var(--bg-soft, rgba(64, 158, 255, 0.08));
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 10px;
}
.ol-tip b {
  color: var(--accent, #409eff);
}
.ol-tip code {
  font-family: Consolas, Monaco, monospace;
  background: rgba(127, 127, 127, 0.16);
  border-radius: 4px;
  padding: 1px 5px;
  font-size: 12px;
}
.ol-tools {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.ol-stats {
  margin-left: auto;
  font-size: 12px;
  color: var(--text-subtle);
}
.ol-stats.warn {
  color: #e6a23c;
}
.ol-input :deep(textarea) {
  font-family: Consolas, Monaco, "Courier New", monospace;
  font-size: 13px;
  line-height: 1.7;
}
.ol-preview-head {
  margin: 8px 0 0;
  font-size: 12px;
}
.ol-preview-head a {
  color: var(--accent, #409eff);
  cursor: pointer;
  user-select: none;
}
.ol-preview {
  margin: 6px 0 0;
  max-height: 180px;
  overflow: auto;
  white-space: pre;
  font-family: Consolas, Monaco, monospace;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-subtle);
  background: rgba(127, 127, 127, 0.08);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
}
.ol-attach {
  display: block;
  margin-top: 10px;
}

/* 便签上的「来自哪份资料」标记 */
.note-src {
  margin-top: 6px;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  line-height: 1.6;
  padding: 1px 6px;
  border: 1px solid color-mix(in srgb, var(--ink, #0079bf) 34%, transparent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--ink, #0079bf) 12%, transparent);
  color: var(--ink, #0079bf);
  opacity: 0.86;
  cursor: pointer;
}
.note-src:hover {
  opacity: 1;
  background: color-mix(in srgb, var(--ink, #0079bf) 20%, transparent);
}

/* 反查弹窗 */
.rf-file {
  font-size: 13px;
  color: var(--text);
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: rgba(127, 127, 127, 0.08);
  margin-bottom: 10px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rf-empty {
  font-size: 13px;
  color: var(--text-subtle);
  line-height: 1.9;
  padding: 12px 4px;
}
.rf-hint {
  font-size: 12px;
}
.rf-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 46vh;
  overflow: auto;
}
.rf-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
}
.rf-item:hover {
  border-color: var(--accent, #0079bf);
  background: rgba(64, 158, 255, 0.08);
}
.rf-kind {
  flex: none;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 10px;
  background: rgba(127, 127, 127, 0.16);
  color: var(--text-subtle);
}
.rf-label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
}
.rf-go {
  flex: none;
  font-size: 12px;
  color: var(--accent, #0079bf);
}

/* ---------- 文档卡片（关联写作栏的 Markdown） ---------- */
.k-doc {
  overflow: visible; /* .node-tools 浮在边框外，别裁掉 */
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  border-radius: 11px;
  background: var(--bg-elevated);
  box-shadow: var(--shadow-sm);
  cursor: default;
  transition: box-shadow 0.15s var(--ease), border-color 0.15s var(--ease);
}
.k-doc:hover {
  box-shadow: var(--shadow-md);
  border-color: var(--border-strong);
  border-left-color: var(--accent);
}
.doc-head {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}
.doc-ico {
  flex: none;
  font-size: 13px;
}
.doc-title {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.doc-sum {
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-subtle);
  /* 摘要最多三行，超出省略 —— 卡片再大也不会把白板撑乱 */
  display: -webkit-box;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.doc-gone {
  font-size: 12px;
  color: #e6a23c;
  line-height: 1.6;
}
.doc-foot {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--text-subtle);
  margin-top: auto;
}
.doc-edit-hint {
  margin-left: auto;
  opacity: 0.65;
}

/* ---------- 文档相关弹窗 ---------- */
.dp-empty {
  font-size: 13px;
  line-height: 1.9;
  color: var(--text-subtle);
  text-align: center;
  padding: 26px 8px;
}
.dp-list {
  max-height: 380px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.dp-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
  color: var(--text);
}
.dp-item:hover {
  border-color: var(--accent, #0079bf);
  background: rgba(64, 158, 255, 0.08);
}
.dp-ico {
  flex: none;
}
.dp-main {
  flex: 1;
  min-width: 0;
}
.dp-title {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dp-sum {
  font-size: 11px;
  color: var(--text-subtle);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dp-stat {
  flex: none;
  font-size: 11px;
  color: var(--text-subtle);
}
.dp-hint {
  font-size: 12px;
  line-height: 1.8;
  color: var(--text-subtle);
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid var(--border);
}

.de-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}
.de-title {
  flex: 1;
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
  background: transparent;
  border: none;
  border-bottom: 1px dashed var(--border);
  outline: none;
  padding: 3px 2px;
}
.de-title:focus {
  border-bottom-color: var(--accent, #0079bf);
}
.de-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}
.de-hint {
  flex: 1;
  font-size: 12px;
  color: var(--text-subtle);
  line-height: 1.6;
}

.dw-label {
  font-size: 12px;
  color: var(--text-subtle);
  margin-bottom: 5px;
}
.dw-text {
  width: 100%;
  box-sizing: border-box;
  resize: vertical;
  font-family: Consolas, "Cascadia Mono", "Microsoft YaHei", monospace;
  font-size: 13px;
  line-height: 1.7;
  color: var(--text);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 7px;
  padding: 8px 10px;
  outline: none;
}
.dw-list {
  max-height: 240px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.dw-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
}
.dw-item:hover {
  border-color: var(--accent, #0079bf);
  background: rgba(64, 158, 255, 0.08);
}
.dw-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
}

.dc-list {
  max-height: 400px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.dc-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
}
.dc-item:hover {
  border-color: var(--accent, #0079bf);
  background: rgba(64, 158, 255, 0.08);
}
.dc-kind {
  flex: none;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 10px;
  background: rgba(127, 127, 127, 0.16);
  color: var(--text-subtle);
}
.dc-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text);
}
.dc-go {
  flex: none;
  font-size: 12px;
  color: var(--accent, #0079bf);
}

/* ============================================================================
 * 白板栏被拖窄时：工具栏收紧，竖着的空间留给画布。
 * ⚠️ 容器查询块必须留在样式文件末尾，否则会被后面同优先级的规则盖掉。
 * ==========================================================================*/
@container (max-width: 560px) {
  .wb-toolbar {
    padding: 4px 5px;
    gap: 2px;
    border-radius: 10px;
  }
  .tb {
    height: 24px;
    padding: 0 6px;
    font-size: 11px;
    gap: 2px;
  }
  .tb-sep {
    height: 14px;
    margin: 0 2px;
  }
}
@container (max-width: 400px) {
  .wb-hint {
    display: none;
  }
  .wb-mode {
    bottom: 10px;
    font-size: 11px;
    padding: 4px 10px;
  }
  /* 窄到一行放不下时改成横向滚动：堆成四行会把画布顶端吃掉 120px。
     留一条 4px 的细滚动条当提示，用户知道右边还有东西。 */
  .wb-toolbar {
    flex-wrap: nowrap;
    overflow-x: auto;
    overflow-y: hidden;
    padding: 4px 6px;
  }
  .wb-toolbar > * {
    flex: none;
  }
  .wb-toolbar::-webkit-scrollbar {
    height: 4px;
  }
  .wb-toolbar::-webkit-scrollbar-thumb {
    background: var(--border-strong);
    border-radius: 4px;
  }
}
</style>
