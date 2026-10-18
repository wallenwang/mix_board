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
/** 看板窄到每列不足 ~175px 时切成紧凑样式，保证一屏能看全 */
const compact = ref(false);
/** 再窄（每列不足 ~118px，比如全景布局里）切「超紧凑」：只留标题，其余元素收起 */
const ultra = ref(false);
let ro: ResizeObserver | null = null;
let rafId = 0;

function measure() {
  const w = boardRef.value?.clientWidth ?? 0;
  if (!w) return;
  const n = Math.max(1, store.columns.length);
  const per = (w - 32 - 12 * (n - 1) - 12) / n;
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

    <div ref="boardRef" class="board" :class="{ compact, ultra }">
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
