<script setup lang="ts">
import { computed } from "vue";
import { VueDraggable } from "vue-draggable-plus";
import { useBoardStore } from "../store";
import { api } from "../api";
import { ElMessageBox, ElMessage } from "element-plus";
import type { Column, Task } from "../types";
import TaskCard from "./TaskCard.vue";
import NewTaskInline from "./NewTaskInline.vue";
import { ref } from "vue";
import { reportError } from "../diag";

const props = defineProps<{ column: Column }>();
const store = useBoardStore();

const colTasks = computed(() => store.sortedCol(props.column.id));
const visibleCount = computed(() => store.visibleCount(props.column.id));
const wipExceeded = computed(
  () => props.column.wip_limit != null && visibleCount.value > props.column.wip_limit
);
/** 本列完成进度（列头那条细进度条） */
const prog = computed(() => store.colProgress(props.column.id));

// A per-column writable list so drag works within & across columns.
const columnList = computed<Task[]>({
  get: () => colTasks.value,
  set: (v) => {
    store.tasksByCol[props.column.id] = v;
  },
});

// called on cross-column add and within-column reorder
async function onChange(evt: any) {
  const taskList = colTasks.value;
  const idx = evt.newIndex;
  if (idx == null || idx < 0 || idx >= taskList.length) return;
  const task = taskList[idx];
  if (!task) return;

  const before = taskList[idx - 1];
  const after = taskList[idx + 1];
  let sortOrder: number;
  if (before && after) sortOrder = (before.sort_order + after.sort_order) / 2;
  else if (before) sortOrder = before.sort_order + 1;
  else if (after) sortOrder = after.sort_order - 1;
  else sortOrder = 1;

  // 拖父任务时，它在（任意列的）子孙也跟着到这一列，紧挨着排在它后面
  const kids = store.taskDescendants(task.id);
  try {
    await api.moveTask(task.id, props.column.id, sortOrder);
    if (kids.length) {
      // 把「父 → 下一个任务」这段顺序位平均分给各个子孙，避免插值撞车
      const nextSo = after ? after.sort_order : sortOrder + kids.length + 1;
      const step = (nextSo - sortOrder) / (kids.length + 1);
      let i = 0;
      for (const kid of kids) {
        i += 1;
        await api.moveTask(kid, props.column.id, sortOrder + step * i);
      }
    }
    await store.refreshTasks();
    if (kids.length) {
      ElMessage.success(`已连同 ${kids.length} 个下级一起移入「${props.column.name}」`);
    }
  } catch (e) {
    reportError("移动任务", e);
    await store.refreshTasks(); // roll back to server state
  }
}

const dialogOpen = ref(false);

async function addTask() {
  dialogOpen.value = true;
}

async function renameColumn() {
  let value: string;
  try {
    ({ value } = await ElMessageBox.prompt("列名称", "重命名列", {
      inputValue: props.column.name,
      confirmButtonText: "保存",
      cancelButtonText: "取消",
      inputValidator: (v: string) => (v.trim() ? true : "名称不能为空"),
    }));
  } catch {
    return; // cancelled
  }
  try {
    await api.updateColumn(props.column.id, { name: value.trim() });
    await store.refreshColumns();
    ElMessage.success("已重命名");
  } catch (e) {
    reportError("重命名列", e);
  }
}

async function setWip() {
  let value: string;
  try {
    ({ value } = await ElMessageBox.prompt(
      "该列最多同时进行的任务数（留空 = 不限制）",
      "WIP 上限",
      {
        inputValue: props.column.wip_limit != null ? String(props.column.wip_limit) : "",
        confirmButtonText: "保存",
        cancelButtonText: "取消",
      }
    ));
  } catch {
    return; // cancelled
  }
  try {
    const trimmed = (value || "").trim();
    const limit = trimmed === "" ? null : Math.max(1, parseInt(trimmed, 10) || 1);
    await api.updateColumn(props.column.id, { wipLimit: limit });
    await store.refreshColumns();
    ElMessage.success(limit != null ? `已设置上限 ${limit} 个任务` : "已取消上限");
  } catch (e) {
    reportError("设置 WIP 上限", e);
  }
}

async function removeColumn() {
  const count = visibleCount.value;
  try {
    await ElMessageBox.confirm(
      count > 0
        ? `列「${props.column.name}」中有 ${count} 个任务，删除后这些任务也会一并删除。继续？`
        : `删除列「${props.column.name}」？`,
      "删除列",
      { type: "warning", confirmButtonText: "删除", cancelButtonText: "取消" }
    );
  } catch {
    return; // cancelled
  }
  try {
    await api.deleteColumn(props.column.id);
    await store.refreshColumns();
    await store.refreshTasks();
    ElMessage.success(`已删除列「${props.column.name}」`);
  } catch (e) {
    reportError("删除列", e);
  }
}

async function toggleCollapse() {
  try {
    await api.updateColumn(props.column.id, { collapsed: !props.column.collapsed });
    await store.refreshColumns();
  } catch (e) {
    reportError("折叠/展开列", e);
  }
}

async function onCommand(c: string) {
  if (c === "rename") renameColumn();
  else if (c === "wip") setWip();
  else if (c === "delete") removeColumn();
  else if (c === "collapse") toggleCollapse();
}
</script>

<template>
  <div class="column" :class="{ 'wip-exceeded': wipExceeded }">
    <div class="column-header">
      <span class="drag-handle column-drag" title="拖动调整列顺序">⠿</span>
      <span class="col-dot" :style="{ background: column.color }"></span>
      <span class="column-title" :title="column.name" @dblclick="renameColumn">
        {{ column.name }}
      </span>
      <span v-if="column.wip_limit != null" class="column-wip">上限 {{ column.wip_limit }}</span>
      <span class="column-count">{{ visibleCount }}</span>
      <el-dropdown trigger="click" @command="onCommand">
        <button class="column-more" title="列设置：重命名 / 上限 / 折叠 / 删除">⋯</button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="rename">重命名</el-dropdown-item>
            <el-dropdown-item command="wip">设置 WIP 上限</el-dropdown-item>
            <el-dropdown-item command="collapse">
              {{ column.collapsed ? "展开" : "折叠" }}
            </el-dropdown-item>
            <el-dropdown-item command="delete" divided>删除列</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </div>

    <!-- 本列完成进度：勾选任务即时反映 -->
    <div v-if="prog.total" class="column-progress" :title="`已完成 ${prog.done} / ${prog.total}`">
      <div class="cp-bar">
        <div
          class="cp-fill"
          :style="{
            width: prog.pct + '%',
            background: prog.pct === 100 ? 'var(--ok)' : column.color,
          }"
        ></div>
      </div>
      <span class="cp-text" :class="{ all: prog.pct === 100 }">{{ prog.done }}/{{ prog.total }}</span>
    </div>

    <template v-if="!column.collapsed">
      <VueDraggable
        v-model="columnList"
        :animation="200"
        ghost-class="ghost"
        group="tasks"
        class="column-body"
        @add="onChange"
        @update="onChange"
      >
        <div
          v-for="element in columnList"
          :key="element.id"
          v-show="store.matchFilter(element)"
          :data-column-id="column.id"
          :class="{ 'task-child': store.taskDepth(element.id) > 0 }"
          :style="{ paddingLeft: Math.min(store.taskDepth(element.id), 4) * 16 + 'px' }"
        >
          <TaskCard :task="element" />
        </div>
      </VueDraggable>

      <div class="column-footer">
        <el-button
          class="add-task-btn"
          text
          title="在这个列的末尾添加一个任务"
          @click="addTask"
        >
          + 添加任务
        </el-button>
      </div>
    </template>

    <!-- inline new-task dialog reused for this column -->
    <NewTaskInline v-model="dialogOpen" :column-id="column.id" />
  </div>
</template>
