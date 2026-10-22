<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch, computed, nextTick } from "vue";
import { ElMessage } from "element-plus";
import { useBoardStore } from "./store";
import { api } from "./api";
import ProjectSidebar from "./components/ProjectSidebar.vue";
import BoardView from "./components/BoardView.vue";
import GanttChart from "./components/GanttChart.vue";
import Whiteboard from "./components/Whiteboard.vue";
import WriteView from "./components/WriteView.vue";
import FloatWindow from "./components/FloatWindow.vue";
/**
 * ⚠️ 这三个**不要再改成 defineAsyncComponent**（2026-10-18 实测踩坑）：
 * 拆成异步分包后，窗口会先显示、重组件随后才加载挂载，
 * 用户看到的就是"界面出来了但整页假死 3~5 秒，平移缩放全无响应"。
 * 同步导入虽然不是最快，但重活全落在启动画面背后，
 * 界面一露面就是可操作的 —— 这才是"不卡"的体感。
 */
import ExportMenu from "./components/ExportMenu.vue";
import FilterBar from "./components/FilterBar.vue";
import TrashDialog from "./components/TrashDialog.vue";
import NewTaskInline from "./components/NewTaskInline.vue";
import { runSelfTest, reportError } from "./diag";

/**
 * 布局约定（2026-10-16 自适应版）：
 * 顶部 = 项目名 ｜ 看板/白板/写作（**可多选的分段控件**）｜ 浮动网页 ｜ 导出。
 *
 * - 三个开关不是单选：勾 1 个 = 全屏；勾 2 个 = 左右分屏；勾 3 个 = 三栏。
 * - ⚠️ 分栏宽度用 **flex-grow 比例**分配，不能用百分比 —— 分隔条是额外占位的固定宽度，
 *   百分比求和 100% 会让最后一栏恒定超出容器 20px 被裁掉（"显示不全"的真凶）。
 * - 主区太窄时自动切「单栏聚焦」：只渲染一栏，分段控件变成切换器；拉宽自动恢复分屏。
 * - 搜索/筛选属于「任务」，放在看板栏内部顶部；AI 只保留可拖动悬浮窗。
 */
const store = useBoardStore();
const trashOpen = ref(false);
const bootError = ref<string | null>(null);

const PANES = ["kanban", "whiteboard", "write"] as const;
type PaneKey = (typeof PANES)[number];
const PANE_LABEL: Record<PaneKey, string> = {
  kanban: "看板",
  whiteboard: "白板",
  write: "文档",
};

/** 面板开关用的小图标（线性图标比 emoji 更整齐，也不会因系统字体而变样） */
const PANE_ICON: Record<PaneKey, string> = {
  kanban: "M4 4h4.5v16H4zM9.8 4h4.5v11H9.8zM15.6 4H20v7.5h-4.4z",
  whiteboard: "M4 4h16v12H4zM12 16v4M8 20h8",
  write: "M5 3h9l5 5v13H5zM14 3v5h5",
};

const PANES_KEY = "kanban.panes";
const WIDTHS_KEY = "kanban.paneWidths";
const LEGACY_VIEW_KEY = "kanban.viewMode";
const PANE_KEY = "kanban.aiPane";
const SIDEBAR_KEY = "kanban.sidebarW";

/** 当前打开了哪几栏（顺序固定：看板 → 白板 → 写作） */
const activePanes = ref<PaneKey[]>(loadPanes());
/** 各栏的相对宽度（同一组合内已归一化，和为 1） */
const widths = ref<Record<PaneKey, number>>({ kanban: 1, whiteboard: 0.5, write: 0.5 });
/** 按「组合」记住分栏比例，切走再切回来不会乱 */
const widthStore = ref<Record<string, Partial<Record<PaneKey, number>>>>({});
/** 窄屏「单栏聚焦」时显示哪一栏 */
const focusedPane = ref<PaneKey>("kanban");

function loadPanes(): PaneKey[] {
  const isPane = (k: unknown): k is PaneKey => (PANES as readonly string[]).includes(String(k));
  try {
    const raw = JSON.parse(localStorage.getItem(PANES_KEY) || "[]");
    if (Array.isArray(raw)) {
      const list = raw.filter(isPane);
      if (list.length) return PANES.filter((k) => list.includes(k));
    }
  } catch {
    /* 忽略 */
  }
  // 兼容旧版单选值（split / quad / web → 看板）
  const legacy = localStorage.getItem(LEGACY_VIEW_KEY);
  if (legacy === "whiteboard" || legacy === "write") return [legacy];
  return ["kanban"];
}

/** AI 悬浮窗开关 / 项目侧栏宽度 */
const aiFloatOpen = ref(false);
const sidebarW = ref(240);
/** 看板栏内部：卡片区 + 下方一条常驻甘特图（同一批任务，互相联动） */
const GANTT_KEY = "kanban.gantt";
const ganttOpen = ref<boolean>(readGanttCfg().open);
const ganttRatio = ref<number>(readGanttCfg().ratio);

function readGanttCfg(): { open: boolean; ratio: number } {
  try {
    const v = JSON.parse(localStorage.getItem(GANTT_KEY) || "{}");
    const r = Number(v.ratio);
    return {
      open: v.open !== false,
      ratio: r >= 0.15 && r <= 0.8 ? r : 0.34,
    };
  } catch {
    return { open: true, ratio: 0.34 };
  }
}
function saveGanttCfg() {
  localStorage.setItem(
    GANTT_KEY,
    JSON.stringify({ open: ganttOpen.value, ratio: ganttRatio.value })
  );
}
function toggleGantt() {
  ganttOpen.value = !ganttOpen.value;
  saveGanttCfg();
}

/**
 * 拖中间那条分隔条改甘特高度（双击回到 1/3）。
 * 存的是**比例**不是像素 —— 窗口一缩放它还是 1/3，不会变成固定 200px。
 */
function startGanttResize(e: PointerEvent) {
  e.preventDefault();
  const host = (e.currentTarget as HTMLElement).parentElement;
  if (!host) return;
  const rect = host.getBoundingClientRect();
  const move = (ev: PointerEvent) => {
    const r = (rect.bottom - ev.clientY) / rect.height;
    ganttRatio.value = Math.min(0.8, Math.max(0.15, r));
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    saveGanttCfg();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}
function resetGanttRatio() {
  ganttRatio.value = 0.34;
  saveGanttCfg();
}

/**
 * ⚠️ flex 因子乘 1000：规范规定因子之和 < 1 时只分配「因子 × 容器高」，
 * 直接写 0.34/0.66 两边都会缩水。和主分栏是同一个坑。
 */
const ganttFlex = computed(() => ({
  board: String(Math.round((1 - ganttRatio.value) * 1000)),
  gantt: String(Math.round(ganttRatio.value * 1000)),
}));
const resizing = ref(false);

/** 看板栏顶部的「新建任务」兜底入口：不管栏被拖多窄都能建任务 */
const newTaskOpen = ref(false);
const newTaskColumnId = ref<number | null>(null);
const newTaskColId = computed(() => newTaskColumnId.value ?? store.columns[0]?.id ?? 0);

function openNewTask(colId: number) {
  newTaskColumnId.value = colId;
  newTaskOpen.value = true;
}

/* ------------------------------------------------------------------ *
 * 自适应：主区宽度 / 看板栏宽度
 * ------------------------------------------------------------------ */

/**
 * 主区太窄 → 只显示一栏（多栏挤在一屏里谁都看不清，那才是真正的"显示不全"）。
 *
 * 阈值**跟着开启的栏数走**：每栏至少要 300px 才够用，
 * 所以 3 栏需要 ~950px、2 栏 ~640px、1 栏永远够。
 * 举例：1024 宽的窗口下三栏各只有 261px（列都被挤没了），
 * 现在会自动切成"单栏 755px + 顶部切换"，比三个豆腐块好用得多。
 * ⚠️ 这里从 320 调到 300 是因为 v3 主题给窗口加了 44px 的内外留白
 *    （app-shell 10×2 + content-wrap 12×2），同样的窗口宽度下内容区比以前窄了，
 *    阈值不跟着调，1280 宽的窗口会一直卡在单栏。
 */
const PANE_MIN_W = 300;
const contentRef = ref<HTMLElement | null>(null);
const contentW = ref(0);
const contentNarrow = ref(false);
let contentRo: ResizeObserver | null = null;

function evalNarrow() {
  const n = activePanes.value.length;
  const w = contentW.value;
  if (!w) return;
  if (n <= 1) {
    contentNarrow.value = false;
    return;
  }
  const enter = n * PANE_MIN_W + 24;
  // 滞回：已经切到单栏了，要再宽出 40px 才恢复分屏（用固定值而不是百分比 ——
  // 12% 的回差在 3 栏时是 118px，会让 1280 宽的窗口也一直停在单栏，手感很迟钝）
  const next = contentNarrow.value ? w < enter + 40 : w < enter;
  if (next !== contentNarrow.value) contentNarrow.value = next;
}

function setContentEl(el: Element | null) {
  contentRef.value = (el as HTMLElement) || null;
}
watch(contentRef, (el) => {
  contentRo?.disconnect();
  contentRo = null;
  if (!el) return;
  contentRo = new ResizeObserver((entries) => {
    const w = entries[0]?.contentRect.width ?? 0;
    if (!w) return;
    contentW.value = w;
  });
  contentRo.observe(el);
});
watch(contentW, evalNarrow);
watch(() => activePanes.value.length, evalNarrow);

/**
 * 看板栏窄不窄 —— 窄了就把顶部那排筛选收进一个「筛选」气泡。
 * 以前这一排总会自己换行，栏一窄就吃掉四行高度，把列和「＋」都顶到看不见。
 */
const kanbanPaneRef = ref<HTMLElement | null>(null);
const kanbanNarrow = ref(false);
let paneRo: ResizeObserver | null = null;

/** 稳定的 ref 回调（内联箭头函数每次渲染都会变，会让 Vue 反复解绑重绑） */
function setKanbanPane(el: Element | null) {
  kanbanPaneRef.value = (el as HTMLElement) || null;
}
watch(kanbanPaneRef, (el) => {
  paneRo?.disconnect();
  paneRo = null;
  if (!el) return;
  paneRo = new ResizeObserver((entries) => {
    const w = entries[0]?.contentRect.width ?? 0;
    if (!w) return;
    // 阈值放宽到 520/570：三栏时每栏约 470，原来的 420 会让筛选组平铺成三四行，
    // 工具条比列还高；收进「筛选」气泡后工具条稳定一行。
    const next = kanbanNarrow.value ? w < 570 : w < 520;
    if (next !== kanbanNarrow.value) kanbanNarrow.value = next;
  });
  paneRo.observe(el);
});

onBeforeUnmount(() => {
  contentRo?.disconnect();
  paneRo?.disconnect();
});

/** 真正渲染出来的栏：宽屏按选择分屏，窄屏只留聚焦的那一栏 */
const visiblePanes = computed<PaneKey[]>(() =>
  contentNarrow.value ? [focusedPane.value] : activePanes.value
);
/** 分段控件的选中态：窄屏看「当前聚焦的那栏」 */
const paneOn = (k: PaneKey) =>
  contentNarrow.value ? focusedPane.value === k : activePanes.value.includes(k);

watch(activePanes, (ks) => {
  if (!ks.includes(focusedPane.value)) focusedPane.value = ks[0];
});

const comboKey = (ks: PaneKey[]) => ks.join("|");

/** 把当前组合的宽度按「记住的比例」或均分，重新归一化 */
function normalizePanes() {
  const ks = activePanes.value;
  const saved = widthStore.value[comboKey(ks)];
  if (saved) {
    const vals = ks.map((k) => Math.max(0, Number(saved[k]) || 0));
    const sum = vals.reduce((a, b) => a + b, 0);
    if (sum > 0) {
      ks.forEach((k, i) => (widths.value[k] = vals[i] / sum));
      return;
    }
  }
  const eq = 1 / ks.length;
  ks.forEach((k) => (widths.value[k] = eq));
}

function savePanes() {
  try {
    localStorage.setItem(PANES_KEY, JSON.stringify(activePanes.value));
  } catch {
    /* 忽略 */
  }
}

function saveWidths() {
  widthStore.value[comboKey(activePanes.value)] = { ...widths.value };
  try {
    localStorage.setItem(WIDTHS_KEY, JSON.stringify(widthStore.value));
  } catch {
    /* 忽略 */
  }
}

/**
 * 点一个开关。
 * 宽屏：已开的收起来，没开的加进来（至少保留一栏）。
 * 窄屏：分段控件当切换器用 —— 保证目标栏在开启列表里，然后聚焦它。
 */
function togglePane(k: PaneKey) {
  if (contentNarrow.value) {
    if (!activePanes.value.includes(k)) {
      activePanes.value = PANES.filter((x) => x === k || activePanes.value.includes(x));
      normalizePanes();
      savePanes();
    }
    focusedPane.value = k;
    return;
  }
  const cur = activePanes.value;
  if (cur.includes(k)) {
    if (cur.length === 1) {
      ElMessage({ type: "info", message: "至少要留一栏，全关掉就没内容可看了" });
      return;
    }
    activePanes.value = cur.filter((x) => x !== k);
  } else {
    activePanes.value = PANES.filter((x) => x === k || cur.includes(x));
  }
  focusedPane.value = k;
  normalizePanes();
  savePanes();
}

/** 当前打开的各栏在布局里的实际比例（防止还没归一化时出现错位） */
const activeTotal = computed(
  () => activePanes.value.reduce((s, k) => s + widths.value[k], 0) || 1
);

/** ⚠️ 必须按「正在渲染的栏」归一化：窄屏单栏聚焦时只有一栏，它得占满整宽 */
const visibleTotal = computed(
  () => visiblePanes.value.reduce((s, k) => s + widths.value[k], 0) || 1
);

/**
 * 分栏宽度用 flex-grow 比例分配，不能用 flex-basis 百分比 ——
 * 分隔条是额外占位的固定宽度，百分比求和 100% 会连分隔条一起超出容器，
 * 表现为最后一栏被裁掉一截（各分辨率恒定少 20px）。
 *
 * ⚠️⚠️ 再乘 1000：CSS Flexbox 规范 §9.7 规定「flex 因子之和小于 1 时，
 * 只分配 因子 × 容器 的宽度」（不是占满）。归一化后的 grow 恒为 0.4 左右，
 * 单栏聚焦时就会让这一栏只占 40% 宽、右边整片空白。
 * 放大到 1000 倍既保持比例，又跨过这个门槛。
 */
const paneStyle = (k: PaneKey) => ({
  flexGrow: String((widths.value[k] / visibleTotal.value) * 1000),
  flexShrink: "1",
  flexBasis: "0%",
});

/** 栏太窄时给个提示：分隔条已经拖到接近下限了 */
const paneNarrow = computed(() =>
  activePanes.value.some((k) => widths.value[k] / activeTotal.value < 0.19)
);

onMounted(() => {
  try {
    const w = JSON.parse(localStorage.getItem(WIDTHS_KEY) || "{}");
    if (w && typeof w === "object") widthStore.value = w;
  } catch {
    /* 忽略 */
  }
  normalizePanes();
  focusedPane.value = activePanes.value[0];
  try {
    const s = JSON.parse(localStorage.getItem(PANE_KEY) || "{}");
    if (typeof s.floatOpen === "boolean") aiFloatOpen.value = s.floatOpen;
  } catch {
    /* 忽略 */
  }
  const sw = Number(localStorage.getItem(SIDEBAR_KEY));
  if (Number.isFinite(sw) && sw >= 150 && sw <= 460) sidebarW.value = sw;
});

watch([aiFloatOpen], () => {
  try {
    localStorage.setItem(PANE_KEY, JSON.stringify({ floatOpen: aiFloatOpen.value }));
  } catch {
    /* 忽略 */
  }
});

onMounted(async () => {
  // 开发时先跑一遍真实后端链路自检，故障会落进 diag.log。
  // ⚠️ **生产版不要跑**：它会在用户库里建一个「__自检__」项目再删掉，
  //    中途任何一步失败就会在左侧留下一个垃圾项目（历史上已经攒了 5 个）。
  if (import.meta.env.DEV) await runSelfTest();
  const tBoot = performance.now();
  try {
    await store.loadBootstrap();
    store.applyTheme();
  } catch (e) {
    bootError.value = e instanceof Error ? e.message : String(e);
    reportError("启动加载", e);
  } finally {
    // ⚠️ 关键：**启动画面要一直盖到界面真的画出来**。
    //    之前 main.ts 里 mount 完就撤掉遮罩，但那时 store.loaded 还是 false，
    //    #app 里几乎空的；真正重的一屏（看板+白板+文档+浮窗）是在 bootstrap
    //    之后才渲染的 —— 遮罩先撤了，用户就看到"界面出来了，然后整页假死几秒"。
    //    现在遮罩留到这里：Vue 更新完 DOM（nextTick）+ 浏览器真正绘制完（双 rAF）
    //    才淡出，这段时间的卡顿全被启动画面吸收。
    await nextTick();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const sp = document.getElementById("splash");
        if (sp) {
          sp.classList.add("gone");
          window.setTimeout(() => sp.remove(), 320);
        }
        void api.diagLog(
          `BOOTPERF ready=${performance.now().toFixed(0)}ms (bootstrap@${tBoot.toFixed(0)}ms)`
        );
      });
    });
  }
  // 启动后 6 秒的帧率探针：统计掉帧次数与最长卡顿，落进 perf.log。
  // 以后再有人说"卡"，直接看这两个数就知道是渲染问题还是系统问题。
  let frames = 0;
  let slow = 0;
  let maxGap = 0;
  let last = performance.now();
  const probe = () => {
    const now = performance.now();
    const gap = now - last;
    last = now;
    frames++;
    if (gap > 50) slow++;
    if (gap > maxGap) maxGap = gap;
    if (now < tBoot + 6000) requestAnimationFrame(probe);
    else {
      void api.diagLog(
        `BOOTPERF frames=${frames} slow=${slow} maxGap=${maxGap.toFixed(0)}ms`
      );
    }
  };
  requestAnimationFrame(probe);

  /**
   * 长任务观测：浏览器会把**阻塞主线程超过 50ms** 的任务报成 longtask。
   * 启动卡顿时，这里能直接指出"是哪段时间被谁堵住了"，
   * 比盯着代码猜快得多。10 秒后一次性写进 perf.log。
   */
  try {
    const tasks: string[] = [];
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.duration < 100) continue;
        const at = (e as PerformanceEntry & {
          attribution?: { containerType?: string; name?: string }[];
        }).attribution?.[0];
        const who = at ? `${at.containerType || ""}${at.name ? ":" + at.name : ""}` : "";
        tasks.push(`${Math.round(e.duration)}ms${who ? "@" + who : ""}`);
      }
    });
    po.observe({ entryTypes: ["longtask"] });
    window.setTimeout(() => {
      po.disconnect();
      void api.diagLog(
        `LONG count=${tasks.length} list=${tasks.slice(0, 10).join(" | ") || "none"}`
      );
    }, 10000);
  } catch {
    /* 老内核不支持 longtask，忽略 */
  }
});

/** 通用拖拽：统一管光标、选中态与事件解绑 */
function dragBar(cursor: string, onMove: (ev: PointerEvent) => void) {
  resizing.value = true;
  const prevCursor = document.body.style.cursor;
  const prevSelect = document.body.style.userSelect;
  document.body.style.cursor = cursor;
  document.body.style.userSelect = "none";
  const up = () => {
    resizing.value = false;
    document.body.style.cursor = prevCursor;
    document.body.style.userSelect = prevSelect;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", up);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", up);
}

/** 拖项目侧栏的右边框调宽（上限跟着窗口走，别让侧栏把主区挤没） */
function startResizeSidebar(e: PointerEvent) {
  if (e.button !== 0) return;
  e.preventDefault();
  dragBar("col-resize", (ev) => {
    const cap = Math.max(180, Math.min(460, window.innerWidth * 0.34));
    sidebarW.value = Math.min(cap, Math.max(150, ev.clientX));
  });
  const save = () => {
    try {
      localStorage.setItem(SIDEBAR_KEY, String(sidebarW.value));
    } catch {
      /* 忽略 */
    }
    window.removeEventListener("pointerup", save);
  };
  window.addEventListener("pointerup", save);
}

/**
 * 拖第 i 条分隔条：它左边是 activePanes[i-1]、右边是 activePanes[i]。
 * 只在这两栏之间倒腾宽度，其余栏不动，所以总和恒为 1（不会漂）。
 */
function startResizePane(i: number, e: PointerEvent) {
  if (e.button !== 0) return;
  e.preventDefault();
  const row = (e.currentTarget as HTMLElement).parentElement as HTMLElement | null;
  if (!row) return;
  const left = activePanes.value[i - 1];
  const right = activePanes.value[i];
  if (!left || !right) return;

  const norm = activePanes.value.map((k) => widths.value[k] / activeTotal.value);
  const before = norm.slice(0, i - 1).reduce((a, b) => a + b, 0);
  const pair = norm[i - 1] + norm[i];
  // 单栏最小 12%（保留足够触达宽度）
  const min = Math.min(0.12, pair / 2);

  dragBar("col-resize", (ev) => {
    const r = row.getBoundingClientRect();
    if (!r.width) return;
    const ratio = (ev.clientX - r.left) / r.width;
    const w = Math.min(Math.max(ratio - before, min), pair - min);
    widths.value[left] = w;
    widths.value[right] = pair - w;
  });
  const save = () => {
    saveWidths();
    window.removeEventListener("pointerup", save);
  };
  window.addEventListener("pointerup", save);
}

/** 双击分隔条：当前打开的几栏均分 */
function equalizePanes() {
  const ks = activePanes.value;
  const eq = 1 / ks.length;
  ks.forEach((k) => (widths.value[k] = eq));
  saveWidths();
}

/**
 * 白板上的文档卡片点「↗ 去文档」→ 这里把文档栏打开。
 * WriteView 自己监听 store.docFocus 去切到对应文档，不用互相直接调用。
 */
watch(
  () => store.docFocus?.seq,
  () => {
    focusedPane.value = "write";
    if (!activePanes.value.includes("write")) {
      activePanes.value = PANES.filter((k) => k === "write" || activePanes.value.includes(k));
      normalizePanes();
      savePanes();
    }
  }
);

/**
 * 白板右键图片「发送到文档」→ 先把文档栏亮出来，
 * 真正插到光标处由 WriteView 监听 docInsert 完成。
 */
watch(
  () => store.docInsert?.seq,
  () => {
    focusedPane.value = "write";
    if (!activePanes.value.includes("write")) {
      activePanes.value = PANES.filter((k) => k === "write" || activePanes.value.includes(k));
      normalizePanes();
      savePanes();
    }
  }
);
</script>

<template>
  <div
    class="app-shell"
    v-if="store.loaded"
    :class="{ resizing }"
    :style="{ '--sidebar-w': sidebarW + 'px' }"
  >
    <ProjectSidebar @open-trash="trashOpen = true" />
    <div
      class="sidebar-divider"
      :class="{ active: resizing }"
      title="左右拖动调整项目栏宽度，双击恢复默认"
      @pointerdown="startResizeSidebar"
      @dblclick="sidebarW = 240"
    ></div>

    <div class="main">
      <div class="main-header">
        <div class="main-title" v-if="store.currentProject">
          <span class="proj-emoji">{{ store.currentProject.icon }}</span>
          <span class="proj-name">{{ store.currentProject.name }}</span>
        </div>

        <!-- 三个开关：宽屏是「多选分屏」，窄屏自动变成「切换器」 -->
        <div v-if="store.currentProject" class="view-switch" role="tablist">
          <button
            v-for="k in PANES"
            :key="k"
            class="pane-toggle"
            :class="['iv-' + k, { on: paneOn(k) }]"
            :title="
              contentNarrow
                ? '切到「' + PANE_LABEL[k] + '」'
                : paneOn(k)
                  ? '再点一次收起这一栏'
                  : '点一下把它加进分屏'
            "
            @click="togglePane(k)"
          >
            <svg
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              stroke-width="1.7"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path :d="PANE_ICON[k]" />
            </svg>
            <span class="pane-toggle-text">{{ PANE_LABEL[k] }}</span>
          </button>
        </div>

        <button
          v-if="store.currentProject"
          class="ghost-toggle float-toggle"
          :class="{ on: aiFloatOpen }"
          title="浮动浏览器：按住窗口顶部随手拖，可盖在任何内容上；再点一次收起"
          @click="aiFloatOpen = !aiFloatOpen"
        >
          <svg
            viewBox="0 0 24 24"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <rect x="3" y="4" width="18" height="16" rx="2.5" />
            <path d="M8 4v16" />
          </svg>
          <span class="float-toggle-text">浮动网页</span>
        </button>

        <div class="header-spacer"></div>
        <ExportMenu v-if="store.currentProject" />
      </div>

      <div
        v-if="store.currentProject && contentNarrow && activePanes.length > 1"
        class="narrow-note"
      >
        <span class="nn-dot"></span>
        窗口偏窄，已临时只显示<b>{{ PANE_LABEL[focusedPane] }}</b>一栏 · 点上方按钮换栏，拉宽窗口自动恢复分屏
      </div>

      <!-- 外面这层只负责内边距（卡片四周的留白），
           把 padding 放在 .content 之外，是为了让「各栏宽之和 + 分隔条宽 = 内容宽」这条校验继续成立 -->
      <div v-if="store.currentProject" class="content-wrap">
        <div :ref="setContentEl" class="content">
          <template v-for="(p, i) in visiblePanes" :key="p">
          <div
            v-if="i > 0"
            class="pane-divider"
            :class="{ active: resizing, tight: paneNarrow }"
            title="左右拖动调整宽度，双击均分"
            @pointerdown="startResizePane(i, $event)"
            @dblclick="equalizePanes"
          >
            <span class="divider-grip"></span>
          </div>

          <div
            class="pane"
            :class="'pane-' + p"
            :style="paneStyle(p)"
            :ref="p === 'kanban' ? setKanbanPane : undefined"
          >
            <template v-if="p === 'kanban'">
              <!-- 任务相关的东西都归看板：新建 / 搜索 / 筛选 / 总进度 -->
              <div class="board-tools">
                <el-dropdown
                  v-if="store.columns.length"
                  trigger="click"
                  placement="bottom-start"
                  @command="openNewTask"
                >
                  <button class="newtask-btn" title="新建任务：先选放到哪一列">
                    <svg
                      viewBox="0 0 24 24"
                      width="13"
                      height="13"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2.2"
                      stroke-linecap="round"
                    >
                      <path d="M12 5v14M5 12h14" />
                    </svg>
                    <span v-if="!kanbanNarrow">新建任务</span>
                  </button>
                  <template #dropdown>
                    <el-dropdown-menu>
                      <el-dropdown-item v-for="c in store.columns" :key="c.id" :command="c.id">
                        放到「{{ c.name }}」
                      </el-dropdown-item>
                    </el-dropdown-menu>
                  </template>
                </el-dropdown>

                <!-- 宽的时候就平铺；栏被拖窄了收进「筛选」气泡，别把工具条撑成四行 -->
                <FilterBar v-if="!kanbanNarrow" />
                <el-popover
                  v-else
                  trigger="click"
                  placement="bottom-start"
                  :width="260"
                  popper-class="filter-pop"
                >
                  <template #reference>
                    <button class="ghost-toggle filter-chip" title="搜索 / 优先级 / 标签筛选">
                      <svg
                        viewBox="0 0 24 24"
                        width="14"
                        height="14"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.8"
                        stroke-linecap="round"
                      >
                        <path d="M4 6h16M7 12h10M10 18h4" />
                      </svg>
                      <span>筛选</span>
                      <span v-if="store.hasFilter" class="filter-dot"></span>
                    </button>
                  </template>
                  <FilterBar stacked />
                </el-popover>

                <div class="tools-spacer"></div>
                <button
                  class="ghost-toggle gantt-chip"
                  :class="{ on: ganttOpen }"
                  :title="
                    ganttOpen
                      ? '收起下方甘特图'
                      : '在下方展开甘特图：按计划开始/截止日期看排期，条的两端能拖着改日期'
                  "
                  @click="toggleGantt"
                >
                  <svg
                    viewBox="0 0 24 24"
                    width="14"
                    height="14"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.8"
                    stroke-linecap="round"
                  >
                    <path d="M4 6h9M4 12h13M4 18h6" />
                  </svg>
                  <span v-if="!kanbanNarrow">{{ ganttOpen ? "收起甘特" : "甘特图" }}</span>
                </button>
                <div
                  v-if="store.projectProgress.total && !kanbanNarrow"
                  class="proj-progress"
                  :title="`共 ${store.projectProgress.total} 个任务，已完成 ${store.projectProgress.done} 个`"
                >
                  <span v-if="store.overdueTasks.length" class="pp-overdue">
                    ⚠ {{ store.overdueTasks.length }} 个逾期
                  </span>
                  <div class="pp-bar">
                    <div
                      class="pp-fill"
                      :style="{
                        width: store.projectProgress.pct + '%',
                        background:
                          store.projectProgress.pct === 100 ? 'var(--ok)' : 'var(--accent)',
                      }"
                    ></div>
                  </div>
                  <span class="pp-text">
                    {{ store.projectProgress.done }}/{{ store.projectProgress.total }}
                    <b>{{ store.projectProgress.pct }}%</b>
                  </span>
                </div>
              </div>
              <!-- 上：看板卡片区；下：一条常驻甘特图（高度可拖，默认占 1/3） -->
              <div class="kanban-main">
                <BoardView class="kanban-board" :style="{ flexGrow: ganttFlex.board }" />
                <!-- 一个任务都没有时不占地方；建了第一个任务它就出现 -->
                <template v-if="ganttOpen && store.allTasks.length">
                  <div
                    class="kanban-split"
                    title="上下拖动调整甘特图高度，双击恢复 1/3"
                    @pointerdown="startGanttResize"
                    @dblclick="resetGanttRatio"
                  >
                    <span class="ks-grip"></span>
                  </div>
                  <div class="kanban-gantt" :style="{ flexGrow: ganttFlex.gantt }">
                    <GanttChart :tasks="store.allTasks" />
                  </div>
                </template>
              </div>
            </template>
            <Whiteboard v-else-if="p === 'whiteboard'" />
            <WriteView v-else />
          </div>
          </template>
        </div>
      </div>

      <div class="empty-board" v-else>
        <div class="empty-card">
          <span class="empty-mark">
            <svg
              viewBox="0 0 24 24"
              width="26"
              height="26"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <rect x="3.2" y="3.2" width="17.6" height="17.6" rx="3" />
              <path d="M3.2 9.6h6.4" />
              <path d="M9.6 9.6v11.2" />
              <path d="M14.2 20.8v-3.6a2.6 2.6 0 0 1 2.6-2.6h4" />
            </svg>
          </span>
          <div class="empty-eyebrow">建筑室内设计 · 专业工作台</div>
          <div class="empty-title">还没有项目</div>
          <div class="empty-rule"></div>
          <div class="empty-sub">
            点左侧「新建项目」开始。每个项目自带 4 个默认的列：待办 → 进行中 → 待评审 → 已完成。<br />
            看板管任务、白板画思路、写作写正文 —— 顶部三个开关可同时勾上，分屏对照着用。
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- shown instead of a blank screen if startup fails -->
  <div v-else-if="bootError" class="boot-error">
    <div class="boot-error-box">
      <div style="font-size: 40px; margin-bottom: 12px">⚠️</div>
      <div style="font-weight: 600; margin-bottom: 8px">启动时出错了</div>
      <div class="boot-error-msg">{{ bootError }}</div>
      <el-button type="primary" style="margin-top: 16px" @click="() => location.reload()">
        重试
      </el-button>
    </div>
  </div>

  <TrashDialog v-model="trashOpen" />
  <NewTaskInline v-if="store.currentProject" v-model="newTaskOpen" :column-id="newTaskColId" />

  <!-- 浮动 AI 网页面板：位置/尺寸都记住 -->
  <FloatWindow v-if="store.loaded" v-model="aiFloatOpen" />
</template>

<style scoped>
/* ---------------- 主区 ---------------- */
.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* 顶栏：留白更大、没有底线 —— 它和下面的内容同属一张白卡 */
.main-header {
  flex: none;
  display: flex;
  align-items: center;
  /* 窄了就换行，而不是把右边的导出挤出屏幕 */
  flex-wrap: wrap;
  gap: 10px 14px;
  padding: 12px clamp(14px, 1.2vw, 22px) 10px;
  background: transparent;
  position: relative;
}

.main-title {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  max-width: min(340px, 36vw);
  font-size: 16.5px;
  font-weight: 650;
  letter-spacing: 0.02em;
}
/* 项目图标装进一枚浅色圆角方块里，和参考稿一致 */
.proj-emoji {
  flex: none;
  width: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 15px;
  border-radius: 9px;
  background: var(--bg-sunken);
  box-shadow: inset 0 0 0 1px var(--hairline);
}
.proj-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.header-spacer {
  flex: 1 1 8px;
  min-width: 0;
}

/* 窄屏提示条 */
.narrow-note {
  flex: none;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px clamp(12px, 1.1vw, 20px);
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--text-subtle);
  background: var(--accent-soft);
  border-bottom: 1px solid var(--hairline);
}
.narrow-note b {
  color: var(--accent);
  font-weight: 650;
  margin: 0 2px;
}
.nn-dot {
  flex: none;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--accent);
}

/* ---------------- 分栏 ---------------- */
/* 外壳只负责四周留白。⚠️ 内边距必须放在 .content 外面：
   否则「各栏宽 + 分隔条宽 = 内容宽」这条校验会失配，看起来像又被裁了一截 */
.content-wrap {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  padding: 0 8px 8px;
}
.content {
  flex: 1;
  display: flex;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
}
/* 每一栏都是一张独立的浅色卡片：圆角 + 一枚极细内环，四周不再有分栏线 */
.pane {
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: 14px;
  background: var(--bg-sunken);
  box-shadow: inset 0 0 0 1px var(--border);
}
/* 写作栏作为容器查询的上下文：窄了就自动把文档列表折成顶部横条 */
.pane-write {
  container-type: inline-size;
}
/* 白板栏同理：窄了工具栏收紧 */
.pane-whiteboard {
  container-type: inline-size;
}

/* 可拖拽分隔条：视觉上只是一段 12px 的空气，悬停才浮出把手 */
.pane-divider {
  width: 8px;
  flex: none;
  position: relative;
  background: transparent;
  cursor: col-resize;
  display: flex;
  align-items: center;
  justify-content: center;
  touch-action: none;
}
.pane-divider::before {
  content: "";
  position: absolute;
  inset: 0 -4px;
}
.pane-divider::after {
  display: none;
}
.divider-grip {
  width: 2px;
  height: 24px;
  border-radius: 999px;
  background: var(--border-strong);
  opacity: 0;
  transition: opacity 0.16s var(--ease-out), height 0.2s var(--ease-out),
    background 0.16s var(--ease-out);
}
.pane-divider:hover .divider-grip,
.pane-divider.active .divider-grip {
  opacity: 1;
  background: var(--accent);
  height: 40px;
}
/* 某一栏已经很窄了：提醒还能双击均分 */
.pane-divider.tight .divider-grip {
  background: var(--brand-2);
  opacity: 1;
}

/* 项目侧栏的右边框：拖它调宽（热区做宽一点，好抓） */
.sidebar-divider {
  flex: none;
  width: 6px;
  cursor: col-resize;
  background: transparent;
  position: relative;
  z-index: 3;
  transition: background 0.16s var(--ease-out);
}
.sidebar-divider::before {
  content: "";
  position: absolute;
  inset: 0 -4px;
}
.sidebar-divider::after {
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  right: 3px;
  width: 1px;
  background: var(--side-border);
}
.sidebar-divider:hover,
.sidebar-divider.active {
  background: var(--accent-soft);
}

/* ---------------- 看板栏顶部工具条 ---------------- */
.board-tools {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 10px 12px 6px;
  background: transparent;
  position: relative;
}
.tools-spacer {
  flex: 1 1 8px;
  min-width: 0;
}

/* 新建任务：墨色实底胶囊 —— 渐变只留给侧栏那一个 CTA，画面里不出现第二块彩色 */
.newtask-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 30px;
  padding: 0 13px;
  font-family: inherit;
  font-size: 12.5px;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: var(--bg-elevated);
  background: var(--text);
  border: 1px solid transparent;
  border-radius: 9px;
  cursor: pointer;
  flex: none;
  box-shadow: 0 2px 6px -3px rgba(33, 31, 28, 0.4);
  transition: transform 0.16s var(--ease-out), box-shadow 0.16s var(--ease-out),
    background 0.16s var(--ease-out);
}
.newtask-btn:hover {
  transform: translateY(-1px);
  box-shadow: 0 6px 14px -6px rgba(33, 31, 28, 0.45);
}
.newtask-btn:active {
  transform: translateY(0);
}
html.dark .newtask-btn {
  color: #1a1917;
  background: #f0ede7;
}
html.dark .newtask-btn:hover {
  background: #ffffff;
}

/* 筛选气泡按钮：有筛选条件时亮一个小点 */
.filter-chip {
  margin-left: 0;
  height: 28px;
  padding: 0 10px;
}
.filter-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
  flex: none;
}

/* 项目总进度 + 逾期提醒 */
.proj-progress {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-subtle);
  flex: none;
}
.pp-bar {
  width: clamp(72px, 8vw, 118px);
  height: 5px;
  border-radius: 999px;
  background: var(--bg-sunken);
  overflow: hidden;
}
.pp-fill {
  height: 100%;
  border-radius: 999px;
  transition: width 0.34s var(--ease-out);
}
.pp-text {
  font-variant-numeric: tabular-nums;
}
.pp-text b {
  color: var(--text);
  font-weight: 650;
}
.pp-overdue {
  color: var(--danger);
  font-weight: 600;
}

/* 看板栏很窄时：顶部工具条不换行，改横向滚动 ——
   否则它自己会堆成 3~4 行，把列和「＋ 添加任务」顶到看不见 */
.pane-kanban {
  container-type: inline-size;
}

/* ---------------- 看板栏：卡片区 + 下方甘特 ---------------- */
.kanban-main {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
/* 两块都用 grow 分高度（因子已经乘过 1000，见 ganttFlex 的注释） */
.kanban-board {
  flex-grow: 1;
  flex-shrink: 1;
  flex-basis: 0;
  min-height: 0;
}
.kanban-gantt {
  flex-grow: 0.34;
  flex-shrink: 1;
  flex-basis: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  border-top: 1px solid var(--hairline);
  overflow: hidden;
}
/* 上下分隔条：视觉 7px，热区上下各扩 4px */
.kanban-split {
  flex: none;
  height: 7px;
  position: relative;
  cursor: row-resize;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  touch-action: none;
  z-index: 3;
}
.kanban-split::before {
  content: "";
  position: absolute;
  inset: -4px 0;
}
.ks-grip {
  width: 34px;
  height: 3px;
  border-radius: 999px;
  background: var(--border-strong);
  opacity: 0;
  transition: opacity 0.16s var(--ease-out), width 0.2s var(--ease-out);
}
.kanban-split:hover .ks-grip {
  opacity: 0.9;
  width: 56px;
}
.kanban-gantt .gantt {
  background: transparent;
}
/* 栏一窄，甘特工具条那行说明会把工具栏撑成三行 → 先藏小字，再藏计数 */
@container (max-width: 640px) {
  .kanban-gantt :deep(.g-tip) {
    display: none;
  }
  .kanban-gantt :deep(.g-tools) {
    flex-wrap: nowrap;
    gap: 8px;
  }
}
@container (max-width: 430px) {
  .kanban-gantt :deep(.g-count) {
    display: none;
  }
  .kanban-gantt :deep(.g-tools) {
    padding: 6px 8px;
  }
}
@container (max-width: 480px) {
  .board-tools {
    flex-wrap: nowrap;
    overflow-x: auto;
    gap: 5px;
    padding: 6px 9px;
  }
  .board-tools::-webkit-scrollbar {
    height: 0;
  }
  .board-tools .ghost-toggle {
    padding: 0 8px;
    height: 26px;
  }
}

/* ---------------- 空状态 ---------------- */
.empty-board {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: clamp(16px, 3vw, 40px);
  overflow: auto;
}
.empty-card {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  max-width: min(520px, 100%);
  padding: clamp(24px, 3vw, 40px) clamp(20px, 3vw, 44px);
  border-radius: var(--radius-xl);
  background: var(--bg-elevated);
  box-shadow: var(--shadow-ring), var(--shadow-md);
  overflow: hidden;
}
/* 四角定位角标：制图图纸的味道 */
.empty-card::before,
.empty-card::after {
  content: "";
  position: absolute;
  width: 14px;
  height: 14px;
  border-color: var(--brand-2);
  border-style: solid;
  opacity: 0.5;
}
.empty-card::before {
  top: 10px;
  left: 10px;
  border-width: 1px 0 0 1px;
}
.empty-card::after {
  bottom: 10px;
  right: 10px;
  border-width: 0 1px 1px 0;
}
.empty-mark {
  width: 54px;
  height: 54px;
  border-radius: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  background: linear-gradient(150deg, var(--accent) 0%, #1b47ab 100%);
  box-shadow: 0 8px 22px -8px color-mix(in srgb, var(--accent) 70%, transparent),
    inset 0 1px 0 rgba(255, 255, 255, 0.28);
  margin-bottom: 14px;
}
.empty-eyebrow {
  font-family: var(--font-serif);
  font-size: 11.5px;
  letter-spacing: 0.22em;
  color: var(--brand-2);
  margin-bottom: 6px;
}
.empty-title {
  font-family: var(--font-serif);
  font-size: 21px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--text);
}
.empty-rule {
  width: 34px;
  height: 1px;
  background: var(--hairline-strong);
  margin: 12px 0 14px;
}
.empty-sub {
  font-size: 12.5px;
  line-height: 1.95;
  color: var(--text-subtle);
  text-align: center;
}

.boot-error {
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
}
.boot-error-box {
  text-align: center;
  max-width: 460px;
  padding: 24px;
}
.boot-error-msg {
  font-size: 12px;
  color: var(--text-subtle);
  word-break: break-all;
  line-height: 1.5;
}
</style>
