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

/** el-dialog 的 v-model 桥接到 props：模板里写 @update-model-value 接不到
 *  emit('update:modelValue')（Vue 事件名转换对不上），关闭时父组件状态卡在 true，
 *  第二次点「编辑」就没反应了。 */
const visible = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit("update:modelValue", v),
});
const store = useBoardStore();

import { DELIVER_OPTIONS } from "../aiPrompt";

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

function fillFromTask() {
  const t = props.task;
  if (!t) return;
  title.value = t.title;
  description.value = t.description;
  priority.value = t.priority;
  startDate.value = t.start_date ?? null;
  dueDate.value = t.due_date ? t.due_date.slice(0, 10) : null;
  done.value = !!t.completed_at;
  progress.value = done.value ? 100 : (t.progress ?? 0);
  selectedTags.value = [...t.tags];
  composingTag.value = false;
  newTagName.value = "";
}

// ⚠️ 必须 immediate：白板里这个弹窗是 v-if 延迟挂载的，挂载时 modelValue 已为 true，
// 普通 watch 捕不到「关→开」的变化，弹窗打开就是一屏空白（用户报的"点详情没用"）。
watch(
  () => [props.modelValue, props.task?.id] as const,
  ([open]) => {
    if (open) fillFromTask();
  },
  { immediate: true }
);

/** 详情区：这条任务在结构里的位置（只读，跟给 AI 的指令同一套数据口径） */
const relations = computed(() => {
  const t = props.task;
  if (!t) return null;
  const titleOf = (id: number) => store.allTasks.find((x) => x.id === id)?.title ?? "（已删除）";
  const num = store.numberOf(t.id);
  const parent = store.taskParentOf.get(t.id);
  const kids = store.edges
    .filter((e) => e.kind === "decompose" && e.from_kind === "task" && e.to_kind === "task" && e.to_id === t.id)
    .map((e) => e.from_id);
  const prev = store.edges
    .filter((e) => e.kind === "precede" && e.to_kind === "task" && e.to_id === t.id)
    .map((e) => e.from_id);
  const next = store.edges
    .filter((e) => e.kind === "precede" && e.from_kind === "task" && e.from_id === t.id)
    .map((e) => e.to_id);
  const refs = store.refsOfTask(t.id).map((r) => ({
    name: store.notes.find((n) => n.id === r.note_id)?.text ?? "资料",
    level: r.level,
    point: r.point,
  }));
  const fmt = DELIVER_OPTIONS.find((o) => o.key === (t.deliver_fmt || "").toLowerCase());
  return { num, parent, kids, prev, next, refs, fmt };
});

/** 编辑时就能看到这张卡会是什么颜色、还剩几天 */
const preview = computed(() => {
  const fake = { due_date: dueDate.value, completed_at: done.value ? "done" : null } as Task;
  const u = urgencyOf(fake);
  return { u, color: URGENCY_COLOR[u], text: urgencyText(fake), left: daysLeft(dueDate.value) };
});

/** 模板里显示任务名用 */
function titleOf2(id: number) {
  return store.allTasks.find((x) => x.id === id)?.title ?? "（已删除）";
}

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
    v-model="visible"
    title="任务详情"
    width="560px"
    append-to-body
  >
    <div style="display: flex; flex-direction: column; gap: 16px">
      <!-- 只读的结构信息：这条任务在哪、靠什么支撑、交给谁 -->
      <div v-if="relations" class="rel-box">
        <div class="rel-row">
          <span class="rel-k">编号</span>
          <span class="rel-v">
            <b v-if="relations.num" class="rel-num">T{{ relations.num }}</b>
            <span v-else class="rel-empty">尚未编号</span>
            <span v-if="relations.fmt" class="rel-fmt">交付格式：{{ relations.fmt.label }}</span>
            <span v-else class="rel-empty">未指定交付格式</span>
          </span>
        </div>
        <div v-if="relations.parent" class="rel-row">
          <span class="rel-k">所属任务</span>
          <span class="rel-v">T{{ store.numberOf(relations.parent) }} {{ titleOf2(relations.parent) }}</span>
        </div>
        <div v-if="relations.kids.length" class="rel-row">
          <span class="rel-k">下级任务</span>
          <span class="rel-v">
            <span v-for="k in relations.kids" :key="k" class="rel-chip"
              >T{{ store.numberOf(k) }} {{ titleOf2(k) }}</span
            >
          </span>
        </div>
        <div v-if="relations.prev.length" class="rel-row">
          <span class="rel-k">前置任务</span>
          <span class="rel-v">
            <span v-for="k in relations.prev" :key="k" class="rel-chip"
              >T{{ store.numberOf(k) }} {{ titleOf2(k) }}</span
            >
          </span>
        </div>
        <div v-if="relations.next.length" class="rel-row">
          <span class="rel-k">后续任务</span>
          <span class="rel-v">
            <span v-for="k in relations.next" :key="k" class="rel-chip"
              >T{{ store.numberOf(k) }} {{ titleOf2(k) }}</span
            >
          </span>
        </div>
        <div v-if="relations.refs.length" class="rel-row">
          <span class="rel-k">依据材料</span>
          <span class="rel-v">
            <span v-for="(r, i) in relations.refs" :key="i" class="rel-chip">
              <i class="rel-lv" :class="'lv-' + r.level"></i>{{ r.name }}
              <em v-if="r.point" class="rel-point">{{ r.point }}</em>
            </span>
          </span>
        </div>
      </div>

      <div>
        <div class="field-label">标题</div>
        <el-input v-model="title" placeholder="任务标题" maxlength="200" />
      </div>

      <div>
        <div class="field-label">
          任务说明
          <span class="field-hint">卡片上显示的正文；点「AI」生成指令时，它就是「任务要求」</span>
        </div>
        <el-input
          v-model="description"
          type="textarea"
          :rows="4"
          placeholder="这个任务要做什么，写清楚一点"
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
.field-hint {
  margin-left: 8px;
  font-size: 11px;
  color: var(--text-faint);
}
/* 只读的结构信息：这条任务在哪、靠什么支撑、交给谁 */
.rel-box {
  padding: 10px 12px;
  border: 1px solid var(--hairline);
  border-radius: var(--radius-md);
  background: var(--fill-weak, rgb(0 0 0 / 3%));
  display: flex;
  flex-direction: column;
  gap: 7px;
  font-size: 12px;
}
.rel-row {
  display: flex;
  gap: 10px;
  align-items: baseline;
}
.rel-k {
  flex: 0 0 56px;
  color: var(--text-subtle);
}
.rel-v {
  flex: 1;
  min-width: 0;
  line-height: 1.7;
  color: var(--text);
}
.rel-num {
  margin-right: 10px;
  padding: 1px 7px;
  border-radius: 6px;
  background: var(--accent-soft, rgb(64 158 255 / 12%));
  color: var(--accent);
}
.rel-fmt {
  margin-left: 10px;
  color: var(--text-subtle);
}
.rel-empty {
  color: var(--text-faint);
}
.rel-chip {
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
  margin: 2px 8px 2px 0;
  padding: 1px 8px;
  border: 1px solid var(--hairline-strong);
  border-radius: 999px;
  background: var(--bg-elevated);
}
.rel-point {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-style: normal;
  color: var(--text-subtle);
}
.rel-point::before {
  content: "· ";
}
.rel-lv {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  align-self: center;
  background: var(--text-faint);
}
.rel-lv.lv-0 {
  background: #d9822b;
}
.rel-lv.lv-1 {
  background: #3b7ddd;
}
.rel-lv.lv-2 {
  background: #98a2b6;
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