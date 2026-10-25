<script setup lang="ts">
import { VueDraggable } from "vue-draggable-plus";
import { ref, onMounted, onBeforeUnmount, watch, nextTick } from "vue";
import { useBoardStore } from "../store";
import { api } from "../api";
import ColumnView from "./ColumnView.vue";
import { ElMessageBox, ElMessage } from "element-plus";
import { reportError } from "../diag";

const store = useBoardStore();
const hintDismissed = ref(false);

const boardRef = ref<HTMLElement | null>(null);
const viewportRef = ref<HTMLElement | null>(null);

/** 看板缩放倍率（0.5 ~ 1.6）。Ctrl+滚轮调整，跟白板的缩放习惯一致 */
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 1.6;
const ZOOM_KEY = "kanban.boardZoom";
const zoom = ref<number>(
  Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number(localStorage.getItem(ZOOM_KEY)) || 1))
);
function setZoom(v: number) {
  zoom.value = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(v * 100) / 100));
  localStorage.setItem(ZOOM_KEY, String(zoom.value));
  scheduleMeasure();
}
function onWheel(e: WheelEvent) {
  // 只拦 Ctrl+滚轮；普通滚轮留给横向滚动，不然看板就滚不动了
  if (!e.ctrlKey) return;
  e.preventDefault();
  const step = e.deltaY > 0 ? -0.08 : 0.08;
  setZoom(zoom.value + step);
}

// ---- 中键拖动平移：跟白板 / 甘特图同一套手感（左键留给卡片拖拽）----
// 横向滚 .board；纵向滚指针所在的那一列 column-body —— 拖一下两个方向一起走。
const panning = ref(false);
let panStart: { x: number; y: number; sl: number; st: number; body: HTMLElement | null } | null =
  null;

function onBoardDown(e: PointerEvent) {
  if (e.button !== 1) return;
  e.preventDefault();
  const board = boardRef.value;
  if (!board) return;
  const body = (e.target as HTMLElement | null)?.closest(".column-body") ?? null;
  panning.value = true;
  panStart = {
    x: e.clientX,
    y: e.clientY,
    sl: board.scrollLeft,
    st: body ? body.scrollTop : 0,
    body,
  };
  window.addEventListener("pointermove", onBoardPan);
  window.addEventListener("pointerup", onBoardPanEnd);
}

function onBoardPan(e: PointerEvent) {
  const board = boardRef.value;
  if (!panStart || !board) return;
  e.preventDefault();
  board.scrollLeft = panStart.sl - (e.clientX - panStart.x);
  if (panStart.body) panStart.body.scrollTop = panStart.st - (e.clientY - panStart.y);
}

function onBoardPanEnd() {
  panning.value = false;
  panStart = null;
  window.removeEventListener("pointermove", onBoardPan);
  window.removeEventListener("pointerup", onBoardPanEnd);
}

/** 看板窄到每列不足 ~175px 时切成紧凑样式，保证一屏能看全 */
const compact = ref(false);
/** 再窄（每列不足 ~118px，比如全景布局里）切「超紧凑」：只留标题，其余元素收起 */
const ultra = ref(false);
let ro: ResizeObserver | null = null;
let rafId = 0;

function measure() {
  const w = boardRef.value?.clientWidth ?? 0;
  if (!w) return;
  // clientWidth 是 zoom 之后的值，判断列宽要用还原后的真实宽度
  const real = w / (zoom.value || 1);
  const n = Math.max(1, store.columns.length);
  const per = (real - 32 - 12 * (n - 1) - 12) / n;
  // 滞回：进紧凑用 <175、退紧凑要 >200；并且只在真的变化时赋值。
  // 否则「改 compact → 布局变 → ResizeObserver 又触发」会形成循环通知，
  // 浏览器会抛 "ResizeObserver loop completed with undelivered notifications"。
  const next = compact.value ? per < 200 : per < 175;
  if (next !== compact.value) compact.value = next;
  const nextUltra = ultra.value ? per < 140 : per < 118;
  if (nextUltra !== ultra.value) ultra.value = nextUltra;
}

/** 测量推到下一帧执行，避免在 RO 回调里同步改布局造成循环通知 */
function scheduleMeasure() {
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(measure);
}

onMounted(() => {
  measure();
  ro = new ResizeObserver(() => scheduleMeasure());
  if (boardRef.value) ro.observe(boardRef.value);
});
onBeforeUnmount(() => {
  ro?.disconnect();
  cancelAnimationFrame(rafId);
});
watch(
  () => store.columns.length,
  () => nextTick(scheduleMeasure)
);

async function onColumnDrag() {
  const order = store.columns.map((c) => c.id);
  try {
    await api.reorderColumns(store.currentProjectId!, order);
    await store.refreshColumns();
  } catch (e) {
    reportError("列排序", e);
  }
}

async function addColumn() {
  let value: string;
  try {
    ({ value } = await ElMessageBox.prompt("列名称", "新建列", {
      confirmButtonText: "创建",
      cancelButtonText: "取消",
      inputValidator: (v: string) => (v.trim() ? true : "名称不能为空"),
    }));
  } catch {
    return; // user cancelled the dialog
  }
  try {
    await api.createColumn(store.currentProjectId!, value.trim());
    await store.refreshColumns();
    ElMessage.success(`已新建列「${value.trim()}」`);
  } catch (e) {
    reportError("新建列", e);
  }
}
</script>

<template>
  <div class="board-wrap">
    <!-- explains what columns are, until the user has tasks to look at -->
    <div v-if="store.totalTaskCount === 0 && !hintDismissed" class="board-hint">
      <span>
        💡 「<b>列</b>」= 任务走的流程阶段：<b>待办 → 进行中 → 待评审 → 已完成</b>
        。点列底部「+ 添加任务」建任务，按住卡片拖到下一列就代表推进；
        列标题旁的 <b>⋯</b> 可以改名、删除、设上限。右侧白板和这里显示同一批任务。
      </span>
      <button class="hint-close" @click="hintDismissed = true">✕</button>
    </div>

    <div
      ref="viewportRef"
      class="board-viewport"
      :class="{ panning }"
      title="Ctrl + 滚轮缩放，普通滚轮横向滚动，按住鼠标中键拖动平移"
      @wheel="onWheel"
      @pointerdown="onBoardDown"
      @auxclick.prevent
    >
    <div ref="boardRef" class="board" :class="{ compact, ultra }" :style="{ zoom: String(zoom) }">
      <VueDraggable
        v-model="store.columns"
        :animation="200"
        ghost-class="ghost"
        handle=".column-drag"
        class="columns-row"
        @end="onColumnDrag"
      >
        <ColumnView
          v-for="element in store.columns"
          :key="element.id"
          :column="element"
        />
      </VueDraggable>

      <div class="column add-column" @click="addColumn">
        <span style="color: var(--text-subtle)">+ 添加列</span>
      </div>
    </div>

      <!-- 缩放控件：贴在右下角，不挡看板内容 -->
      <div class="board-zoom" @pointerdown.stop @mousedown.stop>
        <button title="缩小" @click="setZoom(zoom - 0.1)">−</button>
        <button class="bz-pct" title="恢复 100%" @click="setZoom(1)">
          {{ Math.round(zoom * 100) }}%
        </button>
        <button title="放大" @click="setZoom(zoom + 0.1)">＋</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.board-wrap {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
}
.board-viewport {
  position: relative;
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
}
/* 中键拖动平移中：抓手光标 + 禁文字选择，跟白板/甘特图一致 */
.board-viewport.panning,
.board-viewport.panning * {
  cursor: grabbing;
  user-select: none;
}
.board-zoom {
  position: absolute;
  right: 14px;
  bottom: 12px;
  z-index: 6;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 3px 6px;
  border: 1px solid var(--hairline-strong);
  border-radius: 999px;
  background: var(--bg-elevated);
  box-shadow: var(--shadow-1);
  opacity: 0.62;
  transition: opacity 0.15s var(--ease-out);
}
.board-viewport:hover .board-zoom {
  opacity: 1;
}
.board-zoom button {
  width: 24px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: var(--text-subtle);
  font-size: 13px;
  line-height: 22px;
  cursor: pointer;
}
.board-zoom button:hover {
  background: var(--accent-soft);
  color: var(--accent);
}
.board-zoom .bz-pct {
  width: auto;
  min-width: 42px;
  padding: 0 4px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.board-hint {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin: 12px 20px 0;
  padding: 10px 14px;
  background: var(--bg-sunken);
  border: 1px dashed var(--border);
  border-radius: 8px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-subtle);
}
.hint-close {
  border: none;
  background: transparent;
  color: var(--text-subtle);
  cursor: pointer;
  font-size: 12px;
  padding: 2px;
  flex: none;
}
.columns-row {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  height: 100%;
  /* 撑满剩余宽度让每列平分；不够时靠列的 min-width 撑出横向滚动 */
  flex: 1 1 auto;
}
.add-column {
  flex: 0 0 118px;
  max-width: 118px;
  background: transparent;
  border: 1px dashed var(--border);
  align-items: center;
  justify-content: center;
  min-height: 80px;
  cursor: pointer;
  font-size: 13px;
}

/* ============================================================================
 * 看板栏被拖得很窄时：把这句「列 = 流程阶段」的说明收起来。
 * 它是一整段文字，在窄栏里会竖着排几十行，把列和「＋ 添加任务」全顶到看不见。
 * ⚠️ 容器查询块留在样式末尾。
 * ==========================================================================*/
@container (max-width: 520px) {
  .board-hint {
    display: none;
  }
}
</style>
