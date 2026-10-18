<script setup lang="ts">
import { ref, watch } from "vue";
import { api } from "../api";
import type { TrashItem } from "../types";
import { ElMessage, ElMessageBox } from "element-plus";
import { reportError } from "../diag";

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ (e: "update:modelValue", v: boolean): void }>();

const items = ref<TrashItem[]>([]);
const loading = ref(false);

async function load() {
  loading.value = true;
  try {
    items.value = await api.listTrash();
  } catch (e) {
    reportError("加载回收站", e);
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) load();
  }
);

async function restore(id: number) {
  try {
    await api.restoreTask(id);
    ElMessage.success("已恢复");
    await load();
  } catch (e) {
    reportError("恢复任务", e);
  }
}

async function purge(id: number) {
  try {
    await ElMessageBox.confirm("彻底删除后无法恢复，确定吗？", "彻底删除", {
      type: "warning",
      confirmButtonText: "删除",
      cancelButtonText: "取消",
    });
  } catch {
    return; // cancelled
  }
  try {
    await api.purgeTask(id);
    ElMessage.success("已彻底删除");
    await load();
  } catch (e) {
    reportError("彻底删除", e);
  }
}

async function emptyAll() {
  try {
    await ElMessageBox.confirm("清空回收站中的所有任务？此操作不可恢复。", "清空回收站", {
      type: "warning",
      confirmButtonText: "清空",
      cancelButtonText: "取消",
    });
  } catch {
    return; // cancelled
  }
  try {
    await api.emptyTrash();
    ElMessage.success("回收站已清空");
    await load();
  } catch (e) {
    reportError("清空回收站", e);
  }
}
</script>

<template>
  <el-drawer
    :model-value="modelValue"
    @update:model-value="emit('update:modelValue', $event)"
    title="回收站"
    size="420px"
  >
    <div v-loading="loading" style="height: 100%">
      <div v-if="items.length" style="margin-bottom: 12px">
        <el-button type="danger" text @click="emptyAll">清空回收站</el-button>
      </div>

      <div
        v-for="it in items"
        :key="it.id"
        style="display: flex; align-items: center; gap: 8px; padding: 10px; border-bottom: 1px solid var(--border)"
      >
        <div style="flex: 1; min-width: 0">
          <div style="font-weight: 500">{{ it.title }}</div>
          <div style="font-size: 12px; color: var(--text-subtle)">
            {{ it.project_name }} · {{ it.column_name }}
          </div>
        </div>
        <el-button size="small" @click="restore(it.id)">恢复</el-button>
        <el-button size="small" type="danger" text @click="purge(it.id)">删除</el-button>
      </div>

      <el-empty v-if="!items.length && !loading" description="回收站是空的" />
    </div>
  </el-drawer>
</template>
