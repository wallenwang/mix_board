<script setup lang="ts">
/**
 * 顶部「导出」菜单。
 *
 * 看板数据的层级整理在 boardExport 里，和写作视图的「＋看板任务」共用同一份；
 * 图片 / PDF / 网页三种走 boardsExport（和白板导出共用 canvas 渲染器）。
 */
import { ElMessage } from "element-plus";
import AppIcon from "./AppIcon.vue";
import { useBoardStore } from "../store";
import { boardToMarkdown } from "../exportMd";
import { markdownToDocx } from "../docx";
import { boardExportColumns } from "../boardExport";
import { downloadBlob, safeFileName } from "../exportImage";
import { exportBoardPng, exportBoardPdf, exportBoardHtml } from "../boardsExport";
import type { BoardSceneInput } from "../boardScene";
import { reportError } from "../diag";

const store = useBoardStore();

function sceneInput(): BoardSceneInput {
  return {
    projectName: store.currentProject?.name ?? "看板",
    columns: store.columns,
    tasksByCol: store.tasksByCol,
    tagNames: (t) =>
      t.tags
        .map((id) => store.tags.find((x) => x.id === id)?.name)
        .filter((n): n is string => !!n),
  };
}

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

async function exportPng() {
  if (!guard()) return;
  try {
    const { w, h } = await exportBoardPng(sceneInput());
    ElMessage.success(`已导出图片 ${w}×${h}`);
  } catch (e) {
    reportError("导出看板图片", e);
  }
}

function exportPdf() {
  if (!guard()) return;
  try {
    exportBoardPdf(sceneInput());
    ElMessage.info("已打开打印窗口 —— 目标打印机选「另存为 PDF」即可");
  } catch (e) {
    reportError("导出看板 PDF", e);
  }
}

function exportHtml() {
  if (!guard()) return;
  try {
    exportBoardHtml(sceneInput());
    ElMessage.success("已导出网页，双击用浏览器打开就能看");
  } catch (e) {
    reportError("导出看板网页", e);
  }
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
  if (c === "png") void exportPng();
  else if (c === "pdf") exportPdf();
  else if (c === "html") exportHtml();
  else if (c === "md") exportMd();
  else if (c === "word") exportWord();
}
</script>

<template>
  <el-dropdown trigger="click" @command="onCommand">
    <el-button size="small" class="export-btn">
      <AppIcon name="export" :size="14" />
      <span>导出</span>
    </el-button>
    <template #dropdown>
      <el-dropdown-menu>
        <el-dropdown-item command="png">🖼 图片（.png 长图）</el-dropdown-item>
        <el-dropdown-item command="pdf">🖨 打印 / 存为 PDF（A4，一列一页）</el-dropdown-item>
        <el-dropdown-item command="html">🌐 网页（.html，双击即看）</el-dropdown-item>
        <el-dropdown-item command="md" divided>📝 Markdown（.md）</el-dropdown-item>
        <el-dropdown-item command="word">📄 Word（.docx）</el-dropdown-item>
        <el-dropdown-item divided disabled>
          白板 → 图片 / PDF 在白板工具栏的「更多」里
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
