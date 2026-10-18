<script setup lang="ts">
import { ref, watch, computed } from "vue";
import { useBoardStore } from "../store";
import { api } from "../api";
import { PRIORITIES, TAG_COLORS } from "../types";
import { urgencyOf, urgencyText, daysLeft, URGENCY_COLOR } from "../due";
import type { Task } from "../types";
import { ElMessage, ElMessageBox } from "element-plus";
import { reportError } from "../diag";

const props = defineProps<{ modelValue: boolean; task: Task }>();
const emit = defineEmits<{ (e: "update:modelValue", v: boolean): void }>();
const store = useBoardStore();

const title = ref("");
const description = ref("");
const priority = ref(2);
const startDate = ref<string | null>(null);
const dueDate = ref<string | null>(null);
const progress = ref(0);
const done = ref(false);
const selectedTags = ref<number[]>([]);

// new tag composer
const composingTag = ref(false);
const newTagName = ref("");
const newTagColor = ref(TAG_COLORS[0]);

watch(
  () => props.modelValue,
  (open) => {
    if (open && props.task) {
      title.value = props.task.title;
      description.value = props.task.description;
      priority.value = props.task.priority;
      startDate.value = props.task.start_date ?? null;
      dueDate.value = props.task.due_date ? props.task.due_date.slice(0, 10) : null;
      done.value = !!props.task.completed_at;
      progress.value = done.value ? 100 : (props.task.progress ?? 0);
      selectedTags.value = [...props.task.tags];
      composingTag.value = false;
      newTagName.value = "";
    }
  }
);

/** 编辑时就能看到这张卡会是什么颜色、还剩几天 */
const preview = computed(() => {
  const fake = { due_date: dueDate.value, completed_at: done.value ? "done" : null } as Task;
  const u = urgencyOf(fake);
  return { u, color: URGENCY_COLOR[u], text: urgencyText(fake), left: daysLeft(dueDate.value) };
});

const canSave = computed(() => title.value.trim() !== "");

async function save() {
  if (!canSave.value) {
    ElMessage.warning("标题不能为空");
    return;
  }
  try {
    await api.updateTask(props.task.id, {
      title: title.value.trim(),
      description: description.value,
      priority: priority.value,
      start_date: startDate.value || null,
      due_date: dueDate.value || null,
      progress: done.value ? 100 : Math.max(0, Math.min(100, progress.value)),
      completed: done.value,
      tags: selectedTags.value,
    });
    await store.refreshTasks();
    emit("update:modelValue", false);
    ElMessage.success("已保存");
  } catch (e) {
    reportError("保存任务", e);
  }
}

async function removeTask() {
  try {
    await ElMessageBox.confirm(
      `删除任务「${props.task.title}」？（可在回收站找回）`,
      "删除任务",
      { type: "warning", confirmButtonText: "删除", cancelButtonText: "取消" }
    );
  } catch {
    return; // cancelled
  }
  try {
    await api.deleteTask(props.task.id);
    await store.refreshTasks();
    emit("update:modelValue", false);
  } catch (e) {
    reportError("删除任务", e);
  }
}

async function createTag() {
  const name = newTagName.value.trim();
  if (!name) return;
  try {
    const id = await api.createTag(store.currentProjectId!, name, newTagColor.value);
    store.tags = await api.listTags(store.currentProjectId!);
    selectedTags.value.push(id);
    newTagName.value = "";
    composingTag.value = false;
  } catch (e) {
    reportError("新建标签", e);
  }
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    @update-model-value="emit('update:modelValue', $event)"
    title="任务详情"
    width="560px"
    append-to-body
  >
    <div style="display: flex; flex-direction: column; gap: 16px">
      <div>
        <div class="field-label">标题</div>
        <el-input v-model="title" placeholder="任务标题" maxlength="200" />
      </div>

      <div>
        <div class="field-label">描述</div>
        <el-input
          v-model="description"
          type="textarea"
          :rows="4"
          placeholder="补充说明（可选）"
        />
      </div>

      <!-- 计划周期：甘特图就是拿这两个日期画条的 -->
      <div>
        <div class="field-label">计划周期（甘特图按这个画）</div>
        <div style="display: flex; gap: 8px; align-items: center">
          <el-date-picker
            v-model="startDate"
            type="date"
            placeholder="开始日期"
            value-format="YYYY-MM-DD"
            style="flex: 1"
          />
          <span style="color: var(--text-subtle)">→</span>
          <el-date-picker
            v-model="dueDate"
            type="date"
            placeholder="截止日期"
            value-format="YYYY-MM-DD"
            style="flex: 1"
          />
        </div>
        <div v-if="preview.text" class="due-hint" :style="{ color: preview.color }">
          <span class="dot" :style="{ background: preview.color }"></span>
          {{ preview.text }}
          <span v-if="preview.left != null && preview.left >= 0" class="due-hint-sub">
            （看板卡片会显示成这个颜色）
          </span>
        </div>
      </div>

      <div>
        <div class="field-label">完成进度 {{ done ? "100" : progress }}%</div>
        <el-slider v-model="progress" :min="0" :max="100" :step="5" :disabled="done" />
        <el-checkbox v-model="done">标记为已完成（左边条变绿、标题划线）</el-checkbox>
      </div>

      <div>
        <div class="field-label">优先级</div>
        <el-radio-group v-model="priority">
          <el-radio v-for="p in PRIORITIES" :key="p.value" :value="p.value">
            <span :style="{ color: p.color }">{{ p.label }}</span>
          </el-radio>
        </el-radio-group>
      </div>

      <div>
        <div class="field-label">标签</div>
        <div style="display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px">
          <el-check-tag
            v-for="tg in store.tags"
            :key="tg.id"
            :checked="selectedTags.includes(tg.id)"
            @change="(c: boolean) => {
              if (c) selectedTags.push(tg.id);
              else selectedTags = selectedTags.filter((x) => x !== tg.id);
            }"
            :style="{
              background: selectedTags.includes(tg.id) ? tg.color : 'var(--bg-sunken)',
              color: selectedTags.includes(tg.id) ? '#fff' : 'var(--text)',
            }"
          >
            {{ tg.name }}
          </el-check-tag>
        </div>

        <div v-if="!composingTag">
          <el-button link size="small" @click="composingTag = true">+ 新建标签</el-button>
        </div>
        <div v-else style="display: flex; gap: 8px; align-items: center">
          <el-input v-model="newTagName" placeholder="标签名" style="width: 140px" size="small" />
          <el-color-picker v-model="newTagColor" size="small" />
          <el-button size="small" type="primary" @click="createTag">添加</el-button>
          <el-button size="small" @click="composingTag = false">取消</el-button>
        </div>
      </div>
    </div>

    <template #footer>
      <div style="display: flex; justify-content: space-between">
        <el-button type="danger" text @click="removeTask">删除任务</el-button>
        <div>
          <el-button @click="emit('update:modelValue', false)">取消</el-button>
          <el-button type="primary" :disabled="!canSave" @click="save">保存</el-button>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.field-label {
  font-size: 13px;
  color: var(--text-subtle);
  margin-bottom: 6px;
}
.due-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 7px;
  font-size: 12px;
  font-weight: 600;
}
.due-hint .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.due-hint-sub {
  color: var(--text-subtle);
  font-weight: 400;
}
</style>