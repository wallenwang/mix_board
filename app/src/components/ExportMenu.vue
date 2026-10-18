<script setup lang="ts">
/**
 * 顶部「导出看板」菜单。
 * 看板数据的层级整理在 boardExport 里，和写作视图的「＋看板任务」共用同一份，
 * 所以导出的 Word / Markdown / 贴进文档，三处结构完全一致。
 */
import { ElMessage } from "element-plus";
import AppIcon from "./AppIcon.vue";
import { useBoardStore } from "../store";
import { boardToMarkdown } from "../exportMd";
import { markdownToDocx } from "../docx";
import { boardExportColumns } from "../boardExport";
import { downloadBlob, safeFileName } from "../exportImage";
import { reportError } from "../diag";

const store = useBoardStore();

function markdownText(): string {
  return boardToMarkdown({
    project: store.currentProject?.name ?? "项目",
    columns: boardExportColumns(),
  });
}

function baseName(): string {
  return safeFileName(store.currentProject?.name ?? "看板", "看板");
}

function guard(): boolean {
  if (!store.allTasks.length) {
    ElMessage.warning("看板上还没有任务");
    return false;
  }
  return true;
}

function exportMd() {
  if (!guard()) return;
  downloadBlob(
    new Blob([markdownText()], { type: "text/markdown;charset=utf-8" }),
    `${baseName()}.md`
  );
  ElMessage.success("已导出 Markdown");
}

function exportWord() {
  if (!guard()) return;
  try {
    const bytes = markdownToDocx(markdownText(), store.currentProject?.name ?? "看板");
    downloadBlob(
      new Blob([bytes as unknown as BlobPart], {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
      `${baseName()}.docx`
    );
    ElMessage.success("已导出 Word");
  } catch (e) {
    reportError("导出看板 Word", e);
  }
}

function onCommand(c: string) {
  if (c === "md") exportMd();
  else if (c === "word") exportWord();
}
</script>

<template>
  <el-dropdown trigger="click" @command="onCommand">
    <el-button size="small" class="export-btn">
      <AppIcon name="export" :size="14" />
      <span>导出看板</span>
    </el-button>
    <template #dropdown>
      <el-dropdown-menu>
        <el-dropdown-item command="md">导出为 Markdown（.md）</el-dropdown-item>
        <el-dropdown-item command="word">导出为 Word（.docx）</el-dropdown-item>
        <el-dropdown-item divided disabled>
          白板 → 图片 / PDF 在白板工具栏里
        </el-dropdown-item>
      </el-dropdown-menu>
    </template>
  </el-dropdown>
</template>

<style scoped>
.export-btn :deep(span) {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
</style>
