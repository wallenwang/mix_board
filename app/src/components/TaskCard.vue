<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount } from "vue";
import { useBoardStore } from "../store";
import { api } from "../api";
import { priorityOf } from "../types";
import { urgencyOf, urgencyText, shortDate, URGENCY_COLOR, URGENCY_BG } from "../due";
import type { Task } from "../types";
import TaskDialog from "./TaskDialog.vue";
import AppIcon from "./AppIcon.vue";
import { ElMessageBox } from "element-plus";
import { reportError } from "../diag";

const props = defineProps<{ task: Task }>();
const store = useBoardStore();
const dialogOpen = ref(false);

const prio = computed(() => priorityOf(props.task.priority));
const taskTags = computed(() => props.task.tags.map((id) => store.tagOf(id)).filter(Boolean));

/**
 * 每分钟取一次当前时间：应用开着跨过零点后，逾期/临期的颜色会自动跟着变，
 * 不用重开页面。
 */
const now = ref(new Date());
let timer = 0;
onMounted(() => {
  timer = window.setInterval(() => (now.value = new Date()), 60000);
});
onBeforeUnmount(() => window.clearInterval(timer));

/** 紧迫度 → done/overdue/today/soon/normal，卡片左边条和日期徽章都吃它 */
const urgency = computed(() => urgencyOf(props.task, now.value));
const dueText = computed(() => urgencyText(props.task, now.value));
const isDone = computed(() => !!props.task.completed_at);

async function toggleDone(e: Event) {
  e.stopPropagation();
  await store.toggleDone(props.task.id);
}

async function quickDelete(e: Event) {
  e.stopPropagation();
  try {
    await ElMessageBox.confirm(`删除任务「${props.task.title}」？（可在回收站找回）`, "删除任务", {
      type: "warning",
      confirmButtonText: "删除",
      cancelButtonText: "取消",
    });
  } catch {
    return; // cancelled
  }
  try {
    await api.deleteTask(props.task.id);
    await store.refreshTasks();
  } catch (err) {
    reportError("删除任务", err);
  }
}

/**
 * 点卡片打开编辑。
 *
 * ⚠️ 这里**自己判点击**，不挂 @click：卡片在 SortableJS 的列表里，
 * 稍微带一点位移的点击会被它当成「拖拽」并吞掉后面的 click 事件 ——
 * 表现就是"点一下没反应"。用 pointerdown/up 比位移（< 5px）+ 时限（600ms）判，
 * 拖拽时自然不触发。
 */
const press = { x: 0, y: 0, t: 0 };
function onPressDown(e: PointerEvent) {
  const el = e.target as HTMLElement | null;
  if (el?.closest("button")) return; // 勾选框 / 删除 / 编辑按钮自己处理
  press.x = e.clientX;
  press.y = e.clientY;
  press.t = Date.now();
}
function onPressUp(e: PointerEvent) {
  if (!press.t) return;
  const moved = Math.hypot(e.clientX - press.x, e.clientY - press.y);
  const quick = Date.now() - press.t < 600;
  press.t = 0;
  if (moved < 5 && quick) openEdit();
}
function openEdit(e?: Event) {
  e?.stopPropagation();
  dialogOpen.value = true;
}
</script>

<template>
  <div
    class="task-card"
    :class="[`priority-${task.priority}`, `urg-${urgency}`, { done: isDone }]"
    :style="{ '--urg': URGENCY_COLOR[urgency] }"
    title="点击卡片编辑任务"
    @pointerdown="onPressDown"
    @pointerup="onPressUp"
  >
    <div class="task-row">
      <button
        class="task-check"
        :class="{ on: isDone }"
        :title="isDone ? '取消完成' : '标记为已完成'"
        @click="toggleDone"
      >
        {{ isDone ? "✓" : "" }}
      </button>

      <div class="task-title">
        <span
          v-if="store.numberOf(task.id)"
          class="task-seq"
          :title="'任务编号 T' + store.numberOf(task.id) + '：跟 AI 交代时直接说这个号'"
          >T{{ store.numberOf(task.id) }}</span
        >{{ task.title }}
        <span
          v-if="store.taskChildCount(task.id)"
          class="task-kids"
          title="这个任务有下级任务，拖动它时下级会一起跟着走"
          >▸ {{ store.taskChildCount(task.id) }}</span
        >
      </div>
      <div class="task-acts">
        <button class="task-act" title="编辑任务（标题 / 备注 / 日期 / 优先级 / 标签）" @click.stop="openEdit($event)">
          <AppIcon name="edit" :size="12" :stroke="1.9" />
        </button>
        <button class="task-act del" title="删除任务" @click.stop="quickDelete($event)">
          <AppIcon name="close" :size="12" :stroke="2" />
        </button>
      </div>
    </div>

    <div v-if="task.description" class="task-desc">{{ task.description }}</div>

    <div v-if="taskTags.length" class="task-tags">
      <span
        v-for="tg in taskTags"
        :key="tg!.id"
        class="task-tag"
        :style="{ background: tg!.color }"
        >{{ tg!.name }}</span
      >
    </div>

    <div class="task-meta" v-if="task.due_date || task.priority !== 2">
      <span v-if="task.priority !== 2" :style="{ color: prio.color, fontWeight: 600 }">
        {{ prio.label }}
      </span>
      <span
        v-if="task.due_date"
        class="task-due"
        :class="`u-${urgency}`"
        :style="{ color: URGENCY_COLOR[urgency], background: URGENCY_BG[urgency] }"
        :title="`计划 ${shortDate(task.start_date) || '今天'} → ${shortDate(task.due_date)}`"
      >
        <AppIcon :name="isDone ? 'checkCircle' : 'calendar'" :size="11" :stroke="1.9" />
        {{ shortDate(task.due_date) }}
        <b v-if="dueText" class="due-left">{{ dueText }}</b>
      </span>
    </div>

    <TaskDialog v-model="dialogOpen" :task="task" />
  </div>
</template>

<style scoped>
.task-row {
  display: flex;
  align-items: flex-start;
  gap: 7px;
}
/* 完成勾选框：点它不打开详情（stopPropagation 在 toggleDone 里） */
.task-check {
  flex: none;
  width: 16px;
  height: 16px;
  margin-top: 2px;
  border-radius: 5px;
  border: 1.5px solid var(--border-strong);
  background: transparent;
  color: #fff;
  font-size: 11px;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  padding: 0;
  transition: background 0.15s var(--ease), border-color 0.15s var(--ease),
    transform 0.12s var(--ease);
}
.task-check:hover {
  border-color: var(--urg, var(--accent));
}
.task-check:active {
  transform: scale(0.9);
}
.task-check.on {
  background: var(--ok);
  border-color: var(--ok);
}
.task-title {
  flex: 1;
  min-width: 0;
}
/* 任务编号：窄栏里也只占三个字符，不挤标题 */
.task-seq {
  display: inline-block;
  margin-right: 4px;
  padding: 0 3px;
  border-radius: 3px;
  font-size: 9px;
  font-weight: 700;
  line-height: 13px;
  color: var(--text-subtle);
  background: rgb(0 0 0 / 5%);
  vertical-align: 1px;
}
/* 卡片右上角的动作：平时藏着，悬停才浮出来。
   ⚠️ 用绝对定位而不是占位 —— 栏宽只有 130px 时，两个隐藏按钮会白吃掉 40px，
   标题被挤成一行四个字。浮层不占位，也不会有 hover 时的跳动。 */
.task-row {
  position: relative;
}
.task-acts {
  position: absolute;
  top: -3px;
  right: -3px;
  display: flex;
  align-items: center;
  gap: 1px;
  padding: 1px;
  border-radius: 7px;
  background: var(--bg-elevated);
  box-shadow: 0 0 0 1px var(--hairline);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.14s var(--ease);
}
.task-card:hover .task-acts,
.task-card:focus-within .task-acts {
  opacity: 1;
  pointer-events: auto;
}
.task-act {
  width: 20px;
  height: 20px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-faint);
  cursor: pointer;
  transition: background 0.12s var(--ease), color 0.12s var(--ease);
}
.task-act:hover {
  background: var(--accent-soft);
  color: var(--accent);
}
.task-act.del:hover {
  background: color-mix(in srgb, var(--danger) 14%, transparent);
  color: var(--danger);
}
.due-left {
  margin-left: 5px;
  font-weight: 600;
}
/* 完成了：整张卡退到背景里，但左边条保持绿色，一眼知道这事做完了 */
.task-card.done {
  opacity: 0.62;
}
.task-card.done .task-title {
  text-decoration: line-through;
  text-decoration-color: var(--urg);
}
</style>