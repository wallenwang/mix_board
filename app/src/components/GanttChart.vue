<script setup lang="ts">
/**
 * 甘特图：把任务的「计划开始 → 截止日期」画成时间轴上的条。
 *
 * 和看板是**同一批任务、同一份数据**（store.allTasks），所以：
 *  - 在看板里勾「完成」，甘特条立刻变绿；
 *  - 在甘特图里拖条的两端改日期，看板卡片的颜色（逾期/临期）立刻跟着变。
 * 条的颜色规则见 src/due.ts：绿=完成、红=逾期、橙=3天内、黄=7天内、灰=不急。
 */
import { computed, ref, watch, nextTick, onMounted, onBeforeUnmount } from "vue";
import type { Task } from "../types";
import { useBoardStore } from "../store";
import {
  parseDate,
  taskSpan,
  taskPercent,
  urgencyOf,
  URGENCY_COLOR,
} from "../due";
import TaskDialog from "./TaskDialog.vue";

const props = withDefaults(
  defineProps<{
    tasks: Task[];
    /** 白板节点里用的小尺寸版（不拖拽、字号小） */
    compact?: boolean;
  }>(),
  { compact: false }
);

const store = useBoardStore();
const DAY = 86400000;

/** 缩放的上下限：再窄日期就糊成一片，再宽一屏只剩两三天 */
const MIN_DAY_W = 3;
const MAX_DAY_W = 140;
const DAYW_KEY = "kanban.ganttDayW";
const clampDayW = (v: number) => Math.min(MAX_DAY_W, Math.max(MIN_DAY_W, Math.round(v * 10) / 10));

/** 一天占多少像素：越宽越容易看清，但一屏能看的天越少（记住上次缩放） */
function readDayW(): number {
  if (props.compact) return 18;
  try {
    const v = Number(localStorage.getItem(DAYW_KEY));
    if (v >= MIN_DAY_W && v <= MAX_DAY_W) return v;
  } catch {
    /* 读不到就用默认 */
  }
  return 30;
}
const dayW = ref(readDayW());
watch(dayW, (v) => {
  if (props.compact) return;
  try {
    localStorage.setItem(DAYW_KEY, String(v));
  } catch {
    /* 忽略配额问题 */
  }
});
const zooms = [
  { label: "日", w: 46 },
  { label: "周", w: 30 },
  { label: "月", w: 16 },
  { label: "季", w: 8 },
];

const scrollRef = ref<HTMLElement | null>(null);

/**
 * 滚轮只横向缩放时间轴（任务名那一列宽度恒定、不参与缩放）。
 * 锚点取光标下那一天：缩放前后那一天尽量停在原地，不会"一滚就跑没影"。
 */
function onTimelineWheel(e: WheelEvent) {
  if (props.compact) return; // 白板节点里的紧凑版：滚轮留给画布缩放
  const el = scrollRef.value;
  if (!el) return;
  const dy = e.deltaY;
  if (!dy) return;
  e.preventDefault();
  // 连续平滑缩放：触控板的小 delta 也能用，鼠标滚一格（约 100）≈ ±16%
  const next = clampDayW(dayW.value * Math.pow(1.0015, -dy));
  if (Math.abs(next - dayW.value) < 0.05) return;
  const rect = el.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const dayAt = (el.scrollLeft + x - nameW.value) / dayW.value;
  dayW.value = next;
  void nextTick(() => {
    const sc = scrollRef.value;
    if (!sc) return;
    sc.scrollLeft = Math.max(0, dayAt * next - (x - nameW.value));
  });
}

// ---------- 中键拖动平移（时间轴很长时不用去够滚动条） ----------
const panning = ref(false);
let panStart: { x: number; y: number; sl: number; st: number } | null = null;

function onScrollDown(e: PointerEvent) {
  if (props.compact || e.button !== 1) return;
  const el = scrollRef.value;
  if (!el) return;
  e.preventDefault();
  panning.value = true;
  panStart = { x: e.clientX, y: e.clientY, sl: el.scrollLeft, st: el.scrollTop };
  window.addEventListener("pointermove", onScrollPan);
  window.addEventListener("pointerup", onScrollPanEnd);
}

function onScrollPan(e: PointerEvent) {
  const el = scrollRef.value;
  if (!el || !panStart) return;
  e.preventDefault();
  el.scrollLeft = panStart.sl - (e.clientX - panStart.x);
  el.scrollTop = panStart.st - (e.clientY - panStart.y);
}

function onScrollPanEnd() {
  panning.value = false;
  panStart = null;
  window.removeEventListener("pointermove", onScrollPan);
  window.removeEventListener("pointerup", onScrollPanEnd);
}

interface Row {
  task: Task;
  from: Date;
  to: Date;
  fromDay: number;
  days: number;
  pct: number;
  color: string;
  done: boolean;
}

const today = new Date();
today.setHours(0, 0, 0, 0);

const rows = computed<Row[]>(() =>
  props.tasks
    .map((t) => {
      const span = taskSpan(t);
      if (!span) return null;
      const from = new Date(span.from);
      from.setHours(0, 0, 0, 0);
      const to = new Date(span.to);
      to.setHours(0, 0, 0, 0);
      const days = Math.max(1, Math.round((to.getTime() - from.getTime()) / DAY) + 1);
      const u = urgencyOf(t);
      return {
        task: t,
        from,
        to,
        fromDay: Math.round((from.getTime() - today.getTime()) / DAY),
        days,
        pct: taskPercent(t),
        // 手动指定的颜色优先（点条可改），没设过才按紧迫度自动配色
        color: t.bar_color || URGENCY_COLOR[u],
        done: !!t.completed_at,
      };
    })
    .filter(Boolean) as Row[]
);

/** 时间轴范围：所有任务的最早开始到最晚截止，并包住今天 */
const range = computed(() => {
  let min = 0;
  let max = 0;
  for (const r of rows.value) {
    min = Math.min(min, r.fromDay);
    max = Math.max(max, r.fromDay + r.days - 1);
  }
  return { min: min - 2, max: max + 2 };
});

const totalDays = computed(() => range.value.max - range.value.min + 1);
const todayOffset = computed(() => -range.value.min);

/** 表头刻度：按 dayW 决定每隔几天标一次日期 */
const ticks = computed(() => {
  const step = dayW.value >= 40 ? 1 : dayW.value >= 24 ? 2 : dayW.value >= 14 ? 5 : 14;
  const out: { day: number; label: string }[] = [];
  const base = new Date(today.getTime() + range.value.min * DAY);
  for (let d = 0; d < totalDays.value; d += step) {
    const dt = new Date(base.getTime() + d * DAY);
    out.push({
      day: d,
      label: `${dt.getMonth() + 1}/${dt.getDate()}`,
    });
  }
  return out;
});

const bodyStyle = computed(() => ({
  width: `${totalDays.value * dayW.value}px`,
}));

const barStyle = (r: Row) => ({
  left: `${(r.fromDay - range.value.min) * dayW.value}px`,
  width: `${Math.max(10, r.days * dayW.value - 3)}px`,
  background: r.color,
});

// ---------- 拖条两端改日期 ----------

type Drag = {
  row: Row;
  edge: "l" | "r";
  startX: number;
  from: Date;
  to: Date;
  preview: { from: Date; to: Date };
};

const drag = ref<Drag | null>(null);

function onBarDown(r: Row, edge: "l" | "r", e: PointerEvent) {
  if (props.compact) return;
  if (e.button !== 0) return; // 中键留给画布平移，别改到日期
  e.preventDefault();
  e.stopPropagation();
  drag.value = {
    row: r,
    edge,
    startX: e.clientX,
    from: new Date(r.from),
    to: new Date(r.to),
    preview: { from: r.from, to: r.to },
  };
}

function onMove(e: PointerEvent) {
  const d = drag.value;
  if (!d) return;
  const delta = Math.round((e.clientX - d.startX) / dayW.value);
  if (delta === 0) return;
  let from = new Date(d.from);
  let to = new Date(d.to);
  if (d.edge === "r") {
    to = new Date(d.to.getTime() + delta * DAY);
  } else {
    from = new Date(d.from.getTime() + delta * DAY);
  }
  drag.value = { ...d, preview: { from, to } };
}

async function onUp() {
  const d = drag.value;
  drag.value = null;
  if (!d) return;
  const fmt = (x: Date) =>
    `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
  const patch: { start_date?: string; due_date?: string } = {};
  if (d.edge === "l" && fmt(d.preview.from) !== fmt(d.from)) {
    patch.start_date = fmt(d.preview.from);
  }
  if (d.edge === "r" && fmt(d.preview.to) !== fmt(d.to)) {
    patch.due_date = fmt(d.preview.to);
  }
  if (!Object.keys(patch).length) return;
  await store.setDates(d.row.task.id, patch);
}

/** 拖动中的临时位置（盖在真实值上，松手才落库） */
function liveStyle(r: Row) {
  const d = drag.value;
  if (!d || d.row.task.id !== r.task.id) return barStyle(r);
  const fmt = (x: Date) =>
    `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
  const from = d.edge === "l" ? d.preview.from : d.from;
  const to = d.edge === "r" ? d.preview.to : d.to;
  const fromDay = Math.round((from.getTime() - today.getTime()) / DAY);
  const days = Math.max(1, Math.round((to.getTime() - from.getTime()) / DAY) + 1);
  const changed =
    (d.edge === "l" && fmt(d.preview.from) !== fmt(d.from)) ||
    (d.edge === "r" && fmt(d.preview.to) !== fmt(d.to));
  return {
    left: `${(fromDay - range.value.min) * dayW.value}px`,
    width: `${Math.max(10, days * dayW.value - 3)}px`,
    background: r.color,
    opacity: changed ? 0.75 : 1,
  };
}

onMounted(() => {
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointerdown", onGlobalDown);
});
onBeforeUnmount(() => {
  window.removeEventListener("pointermove", onMove);
  window.removeEventListener("pointerup", onUp);
  window.removeEventListener("pointerdown", onGlobalDown);
});

// ---------- 点条换颜色 / 看详情 ----------

const activeTask = ref<Task | null>(null);
const dlgOpen = ref(false);
function openTask(t: Task) {
  if (drag.value) return;
  activeTask.value = t;
  dlgOpen.value = true;
}

/** 甘特条手动配色：红在最前 —— 特别紧急、火烧眉毛的那几条 */
const PAL_COLORS = [
  { hex: "#d84338", label: "紧急 · 火烧眉毛" },
  { hex: "#e6842c", label: "较急" },
  { hex: "#c9a63c", label: "一般提醒" },
  { hex: "#4a7fd4", label: "按计划推进" },
  { hex: "#2f9e6a", label: "轻松 / 收尾" },
  { hex: "#98a2b3", label: "不急" },
];
const palTask = ref<Task | null>(null);
const palPos = ref({ x: 0, y: 0 });

/** 点条：弹配色小面板（条的正上方）；白板里的紧凑版仍直接开详情 */
function openPalette(r: Row, e: MouseEvent) {
  if (drag.value) return;
  if (props.compact) {
    openTask(r.task);
    return;
  }
  const W = 196;
  const H = 216;
  palTask.value = r.task;
  palPos.value = {
    x: Math.min(window.innerWidth - W - 10, Math.max(10, e.clientX - W / 2)),
    y: Math.min(window.innerHeight - H - 10, Math.max(10, e.clientY - H - 6)),
  };
}

async function pickColor(hex: string | null) {
  if (!palTask.value) return;
  const id = palTask.value.id;
  palTask.value = null;
  await store.setBarColor(id, hex);
}

function onGlobalDown(e: PointerEvent) {
  if (!palTask.value) return;
  const t = e.target as HTMLElement | null;
  if (t?.closest(".g-palette")) return;
  palTask.value = null;
}

const nameW = computed(() => (props.compact ? 96 : 170));
</script>

<template>
  <div class="gantt" :class="{ compact }">
    <div class="g-tools" v-if="!compact">
      <span class="g-count">{{ rows.length }} 个任务</span>
      <div class="g-zoom">
        <button
          v-for="z in zooms"
          :key="z.label"
          class="g-zbtn"
          :class="{ on: dayW === z.w }"
          @click="dayW = z.w"
        >
          {{ z.label }}
        </button>
      </div>
      <span class="g-scale" :title="`当前缩放：一天 ${dayW} px`">{{ dayW }}px/天</span>
      <span class="g-tip">点条换颜色 · 拖条两端改日期 · 滚轮缩放时间轴 · 中键拖动平移</span>
    </div>

    <div v-if="!rows.length" class="g-empty">
      还没有带「截止日期」的任务。<br />在任务详情里填上截止日期，就会出现在这张图上。
    </div>

    <div
      v-else
      ref="scrollRef"
      class="g-scroll"
      :class="{ panning }"
      @wheel="onTimelineWheel"
      @pointerdown="onScrollDown"
    >
      <div class="g-head" :style="{ '--name-w': nameW + 'px' }">
        <div class="g-name g-name-head">任务</div>
        <div class="g-timeline" :style="bodyStyle">
          <div
            v-for="t in ticks"
            :key="t.day"
            class="g-tick"
            :style="{ left: `${t.day * dayW}px`, width: `${dayW * 2}px` }"
          >
            {{ t.label }}
          </div>
          <div class="g-today" :style="{ left: `${todayOffset * dayW}px` }"></div>
        </div>
      </div>

      <div class="g-rows">
        <div
          v-for="r in rows"
          :key="r.task.id"
          class="g-row"
          :class="{ done: r.done }"
          :style="{ '--name-w': nameW + 'px' }"
        >
          <div class="g-name" :title="r.task.title" @click="openTask(r.task)">
            <span class="g-dot" :style="{ background: r.color }"></span>
            {{ r.task.title }}
          </div>
          <div class="g-track" :style="bodyStyle">
            <div
              class="g-week"
              v-for="w in Math.ceil(totalDays / 7)"
              :key="w"
              :style="{ left: `${(w - 1) * 7 * dayW}px`, width: `${7 * dayW}px` }"
            ></div>
            <div
              class="g-bar"
              :class="{ hasFill: r.pct > 0 && r.pct < 100 }"
              :style="liveStyle(r)"
              :title="`${r.task.title}（${r.done ? '已完成' : r.pct + '%'}）— 点一下换颜色`"
              @click="openPalette(r, $event)"
            >
              <span class="g-fill" :style="{ width: `${r.pct}%` }"></span>
              <span
                class="g-handle l"
                @pointerdown="onBarDown(r, 'l', $event)"
              ></span>
              <span
                class="g-handle r"
                @pointerdown="onBarDown(r, 'r', $event)"
              ></span>
            </div>
            <div
              class="g-today"
              :style="{ left: `${todayOffset * dayW}px` }"
            ></div>
          </div>
        </div>
      </div>
    </div>

    <TaskDialog v-if="activeTask" v-model="dlgOpen" :task="activeTask" />

    <!-- 甘特条配色小面板：点条弹出 -->
    <div
      v-if="palTask"
      class="g-palette"
      :style="{ left: palPos.x + 'px', top: palPos.y + 'px' }"
      @pointerdown.stop
    >
      <div class="gp-head" :title="palTask.title">{{ palTask.title }}</div>
      <div class="gp-grid">
        <button
          v-for="c in PAL_COLORS"
          :key="c.hex"
          class="gp-sw"
          :class="{ on: palTask.bar_color === c.hex }"
          :style="{ background: c.hex }"
          :title="c.label"
          @click="pickColor(c.hex)"
        ></button>
      </div>
      <button class="gp-auto" title="清掉手动颜色，按截止日期紧迫度自动配色" @click="pickColor(null)">
        ⟲ 跟随到期状态
      </button>
      <button class="gp-detail" @click="openTask(palTask); palTask = null">任务详情…</button>
    </div>
  </div>
</template>

<style scoped>
.gantt {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  height: 100%;
  background: var(--bg);
  overflow: hidden;
}
/* 白板节点里用：节点容器只有 min-height，得自己兜一个高度 */
.gantt.compact {
  min-height: 180px;
}
.g-tools {
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 7px 12px;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  color: var(--text-subtle);
}
.g-zoom {
  display: flex;
  gap: 2px;
}
.g-zbtn {
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-subtle);
  border-radius: 5px;
  padding: 2px 9px;
  font-size: 12px;
  cursor: pointer;
}
.g-zbtn.on {
  border-color: var(--accent, #409eff);
  color: var(--accent, #409eff);
  background: rgba(64, 158, 255, 0.1);
}
.g-tip {
  margin-left: auto;
  opacity: 0.8;
}
/* 当前缩放刻度：滚轮调完心里有数 */
.g-scale {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 5px;
  background: var(--bg-sunken, rgba(127, 127, 127, 0.1));
  color: var(--text-subtle);
  flex: none;
}
.g-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  color: var(--text-subtle);
  font-size: 13px;
  line-height: 2;
  padding: 30px;
}
.g-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
/* 平移中：光标变成抓手，并且别让文字被选中 */
.g-scroll.panning {
  cursor: grabbing;
  user-select: none;
}
/* 滚轮缩放时间轴时，任务名那一列始终贴在左边，不会跟着跑掉 */
.g-row .g-name {
  position: sticky;
  left: 0;
  z-index: 2;
  background: var(--bg);
}
.g-head {
  display: flex;
  position: sticky;
  top: 0;
  z-index: 3;
  background: var(--bg);
  border-bottom: 1px solid var(--border);
  /* 同上：表头也要跨过整条时间轴，左侧「任务」标题才能一直吸附在左边 */
  width: max-content;
  min-width: 100%;
}
.g-row {
  display: flex;
  border-bottom: 1px solid var(--border);
  width: max-content;
  min-width: 100%;
}
.g-name {
  flex: none;
  width: var(--name-w);
  padding: 6px 10px;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  border-right: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 6px;
}
.g-name-head {
  color: var(--text-subtle);
  position: sticky;
  left: 0;
  z-index: 2;
  background: var(--bg);
}
.g-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: none;
}
.g-timeline {
  position: relative;
  height: 28px;
  flex: none;
}
.g-tick {
  position: absolute;
  top: 6px;
  font-size: 11px;
  color: var(--text-subtle);
  border-left: 1px solid var(--border);
  padding-left: 3px;
  height: 22px;
}
.g-rows {
  /* 关键：整行必须和"名字列 + 整条时间轴"一样宽。
     若只写 min-width:100%，行宽会被限制在可视宽度内，
     左边那列 sticky 滚出几百px 后就没有"可吸附空间"了 —— 任务名会跟着跑掉。 */
  width: max-content;
  min-width: 100%;
}
.g-row {
  display: flex;
  border-bottom: 1px solid var(--border);
}
.g-row:hover .g-name {
  background: var(--bg-elevated, var(--bg));
}
.g-track {
  position: relative;
  height: 32px;
  flex: none;
}
.g-week {
  position: absolute;
  top: 0;
  bottom: 0;
  border-left: 1px dashed var(--border);
  opacity: 0.55;
  pointer-events: none;
}
.g-bar {
  position: absolute;
  top: 8px;
  height: 17px;
  border-radius: 5px;
  cursor: pointer;
  overflow: visible;
  box-shadow: var(--shadow);
}
.g-bar:hover {
  filter: brightness(1.08);
}
/* 条内深色填充 = 进度百分比 */
.g-fill {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  border-radius: 5px 0 0 5px;
  background: rgba(0, 0, 0, 0.22);
  pointer-events: none;
}
.g-handle {
  position: absolute;
  top: -3px;
  width: 7px;
  height: 23px;
  cursor: ew-resize;
  border-radius: 3px;
}
.g-handle.l {
  left: -3px;
}
.g-handle.r {
  right: -3px;
}
.g-bar:hover .g-handle {
  background: rgba(255, 255, 255, 0.85);
}
.g-today {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  background: var(--danger);
  opacity: 0.7;
  pointer-events: none;
  z-index: 1;
}
.g-row.done .g-name {
  text-decoration: line-through;
  opacity: 0.6;
}

/* ---- 甘特条配色小面板 ---- */
.g-palette {
  position: fixed;
  z-index: 1600;
  width: 196px;
  background: var(--bg-elevated, #fff);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: var(--shadow-lg, 0 10px 30px rgba(0, 0, 0, 0.16));
  padding: 9px 10px 8px;
  cursor: default;
}
.gp-head {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-bottom: 8px;
}
.gp-grid {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 6px;
  margin-bottom: 8px;
}
.gp-sw {
  width: 22px;
  height: 22px;
  border-radius: 6px;
  border: 2px solid transparent;
  cursor: pointer;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.12);
}
.gp-sw:hover {
  transform: scale(1.12);
}
.gp-sw.on {
  border-color: var(--accent, #409eff);
}
.gp-auto,
.gp-detail {
  display: block;
  width: 100%;
  text-align: left;
  border: none;
  background: transparent;
  color: var(--text);
  font-size: 12px;
  padding: 5px 6px;
  border-radius: 6px;
  cursor: pointer;
}
.gp-auto:hover {
  background: var(--bg-sunken, rgba(127, 127, 127, 0.1));
}
.gp-detail {
  color: var(--accent, #409eff);
}
.gp-detail:hover {
  background: rgba(64, 158, 255, 0.1);
}

/* ---- 白板节点里的紧凑版 ---- */
.gantt.compact .g-name {
  font-size: 11px;
  padding: 4px 6px;
}
.gantt.compact .g-track {
  height: 26px;
}
.gantt.compact .g-bar {
  top: 7px;
  height: 13px;
}
.gantt.compact .g-scroll {
  overflow: auto;
}
</style>