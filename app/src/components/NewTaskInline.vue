<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { useBoardStore } from "../store";
import { api } from "../api";
import { PRIORITIES, TAG_COLORS } from "../types";
import { ElMessage } from "element-plus";
import { reportError } from "../diag";

const props = defineProps<{ modelValue: boolean; columnId: number }>();
const emit = defineEmits<{ (e: "update:modelValue", v: boolean): void }>();
const store = useBoardStore();

const title = ref("");
const description = ref("");
const priority = ref(2);
const dueDate = ref<string | null>(null);
const selectedTags = ref<number[]>([]);
const composingTag = ref(false);
const newTagName = ref("");
const newTagColor = ref(TAG_COLORS[0]);

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      title.value = "";
      description.value = "";
      priority.value = 2;
      dueDate.value = null;
      selectedTags.value = [];
      composingTag.value = false;
      newTagName.value = "";
    }
  }
);

const canSave = computed(() => title.value.trim() !== "");

async function save() {
  if (!canSave.value) return;
  try {
    await api.createTask({
      project_id: store.currentProjectId!,
      column_id: props.columnId,
      title: title.value.trim(),
      description: description.value,
      priority: priority.value,
      due_date: dueDate.value,
      tags: selectedTags.value,
    });
    await store.refreshTasks();
    emit("update:modelValue", false);
    ElMessage.success("已创建任务");
  } catch (e) {
    reportError("新建任务", e);
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
    @update:model-value="emit('update:modelValue', $event)"
    title="新建任务"
    width="520px"
    append-to-body
  >
    <div style="display: flex; flex-direction: column; gap: 16px">
      <div>
        <div class="field-label">标题</div>
        <el-input v-model="title" placeholder="要做什么？" maxlength="200" @keyup.enter="save" />
      </div>

      <div>
        <div class="field-label">描述</div>
        <el-input v-model="description" type="textarea" :rows="3" placeholder="补充说明（可选）" />
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
        <div class="field-label">截止日期</div>
        <el-date-picker
          v-model="dueDate"
          type="datetime"
          placeholder="可选"
          style="width: 100%"
          value-format="YYYY-MM-DDTHH:mm:ss"
        />
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
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" :disabled="!canSave" @click="save">创建</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.field-label {
  font-size: 13px;
  color: var(--text-subtle);
  margin-bottom: 6px;
}
</style>
