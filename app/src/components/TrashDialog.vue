<script setup lang="ts">
/**
 * 回收站。
 *
 * 两类东西都在这儿：
 *  - 删除的**任务**（tasks.deleted_at）
 *  - 删除的**白板卡片**（board_notes.deleted_at：便签 / 导图 / 资料 / 文档卡）
 *
 * 保留天数存在全局设置 trash_days：30 / 60 / 0（永不清理）。
 * 到期清理在「打开项目」时顺手跑（Rust 侧 purge_expired_notes），不占界面线程。
 */
import { ref, watch } from "vue";
import { api } from "../api";
import type { TrashItem, NoteTrashItem } from "../types";
import { ElMessage, ElMessageBox } from "element-plus";
import { reportError } from "../diag";
import { useBoardStore } from "../store";

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ (e: "update:modelValue", v: boolean): void }>();
const store = useBoardStore();

const items = ref<TrashItem[]>([]);
const noteItems = ref<NoteTrashItem[]>([]);
const loading = ref(false);
const keepDays = ref(30);

const KIND_LABEL: Record<string, string> = {
  note: "便签",
  mind: "思维导图",
  text: "文字",
  file: "资料",
  doc: "文档卡",
  box: "分组框",
  gantt: "甘特图",
};

async function load() {
  loading.value = true;
  try {
    items.value = await api.listTrash();
    noteItems.value = await api.listDeletedNotes();
    const s: any = await api.getSettings().catch(() => ({}));
    if (s && typeof s.trash_days === "number") keepDays.value = s.trash_days;
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

async function setKeepDays(v: number) {
  keepDays.value = v;
  try {
    await api.setSetting("trash_days", String(v));
    ElMessage.success(v ? `回收站保留 ${v} 天，超期自动清理` : "已关闭自动清理");
  } catch (e) {
    reportError("保存保留天数", e);
  }
}

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

/* ---------------- 白板卡片 ---------------- */

async function restoreNote(id: number) {
  try {
    await api.restoreNote(id);
    await store.refreshBoard();
    ElMessage.success("卡片已回到白板");
    await load();
  } catch (e) {
    reportError("恢复卡片", e);
  }
}

async function purgeNote(id: number) {
  try {
    await ElMessageBox.confirm(
      "彻底删除后无法恢复（资料的文件本体也会删掉），确定吗？",
      "彻底删除卡片",
      { type: "warning", confirmButtonText: "删除", cancelButtonText: "取消" }
    );
  } catch {
    return;
  }
  try {
    await api.purgeNote(id);
    ElMessage.success("已彻底删除");
    await load();
  } catch (e) {
    reportError("彻底删除卡片", e);
  }
}

async function emptyNotes() {
  if (!noteItems.value.length) return;
  try {
    await ElMessageBox.confirm(
      `清空回收站里的 ${noteItems.value.length} 张白板卡片？此操作不可恢复。`,
      "清空白板卡片",
      { type: "warning", confirmButtonText: "清空", cancelButtonText: "取消" }
    );
  } catch {
    return;
  }
  try {
    for (const n of [...noteItems.value]) await api.purgeNote(n.id);
    ElMessage.success("已清空");
    await load();
  } catch (e) {
    reportError("清空白板卡片", e);
  }
}
</script>

<template>
  <el-drawer
    :model-value="modelValue"
    @update:model-value="emit('update:modelValue', $event)"
    title="回收站"
    size="460px"
  >
    <div v-loading="loading" style="height: 100%">
      <!-- 保留策略 -->
      <div class="trash-keep">
        <span>自动清理：</span>
        <el-radio-group :model-value="keepDays" size="small" @update:model-value="setKeepDays">
          <el-radio-button :value="30">30 天</el-radio-button>
          <el-radio-button :value="60">60 天</el-radio-button>
          <el-radio-button :value="0">永不</el-radio-button>
        </el-radio-group>
        <span class="trash-keep-tip">删除的东西先放这儿，过期才真删</span>
      </div>

      <!-- 任务 -->
      <div class="trash-sec">
        <span>任务</span>
        <el-button v-if="items.length" type="danger" text size="small" @click="emptyAll">
          清空
        </el-button>
      </div>
      <div
        v-for="it in items"
        :key="'t' + it.id"
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
      <div v-if="!items.length" class="trash-empty">没有删除的任务</div>

      <!-- 白板卡片 -->
      <div class="trash-sec">
        <span>白板卡片</span>
        <el-button v-if="noteItems.length" type="danger" text size="small" @click="emptyNotes">
          清空
        </el-button>
      </div>
      <div
        v-for="it in noteItems"
        :key="'n' + it.id"
        style="display: flex; align-items: center; gap: 8px; padding: 10px; border-bottom: 1px solid var(--border)"
      >
        <div style="flex: 1; min-width: 0">
          <div style="font-weight: 500; overflow: hidden; text-overflow: ellipsis">
            {{ it.text || it.file_name || "（空卡片）" }}
          </div>
          <div style="font-size: 12px; color: var(--text-subtle)">
            {{ KIND_LABEL[it.kind] || it.kind }} · 删除于 {{ it.deleted_at || "" }}
          </div>
        </div>
        <el-button size="small" @click="restoreNote(it.id)">放回白板</el-button>
        <el-button size="small" type="danger" text @click="purgeNote(it.id)">删除</el-button>
      </div>
      <div v-if="!noteItems.length" class="trash-empty">没有删除的卡片</div>
    </div>
  </el-drawer>
</template>

<style scoped>
.trash-keep {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 2px 12px;
  font-size: 12.5px;
  color: var(--text-subtle);
  flex-wrap: wrap;
}
.trash-keep-tip {
  font-size: 11.5px;
  opacity: 0.8;
}
.trash-sec {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 14px 0 6px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--hairline, var(--border));
  font-size: 12px;
  font-weight: 650;
  letter-spacing: 0.04em;
  color: var(--text-subtle);
}
.trash-empty {
  padding: 12px 4px;
  font-size: 12.5px;
  color: var(--text-subtle);
}
</style>
