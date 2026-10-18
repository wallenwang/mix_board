<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { api, isTauri } from "../api";
import type { DataOverview, ProjectStat } from "../api";
import { reportError } from "../diag";
import { clearMockState } from "../mock";
import AppIcon from "./AppIcon.vue";

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ (e: "update:modelValue", v: boolean): void }>();

const open = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit("update:modelValue", v),
});

const loading = ref(false);
const overview = ref<DataOverview | null>(null);
const failMsg = ref("");

// 换位置
const step = ref<"view" | "pick">("view");
const target = ref("");
const busy = ref(false);

const dbName = computed(() => {
  const f = overview.value?.db_file || "";
  const i = f.lastIndexOf("\\");
  return i >= 0 ? f.slice(i + 1) : f;
});

function fmtSize(n?: number) {
  const v = n || 0;
  if (v <= 0) return "0";
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

async function load() {
  loading.value = true;
  failMsg.value = "";
  try {
    overview.value = await api.dataOverview();
  } catch (e) {
    overview.value = null;
    failMsg.value = String(e);
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.modelValue,
  (v) => {
    if (v) {
      step.value = "view";
      target.value = "";
      void load();
    }
  }
);

async function reveal() {
  try {
    await api.openDataDir();
  } catch (e) {
    reportError("打开数据文件夹", e);
  }
}

async function copyPath() {
  const p = overview.value?.path || "";
  if (!p) return;
  try {
    await navigator.clipboard.writeText(p);
    ElMessage.success("路径已复制");
  } catch {
    ElMessage.warning("复制失败，手动选中上面的路径复制即可");
  }
}

async function openProject(p: ProjectStat) {
  try {
    await api.openProjectDir(p.id);
  } catch (e) {
    reportError("打开项目文件夹", e);
    ElMessage.warning(String(e));
  }
}

async function pick() {  try {
    const p = await api.pickFolder();
    if (p) target.value = p;
  } catch (e) {
    ElMessage.warning(String(e));
  }
}

/** 浏览器预览模式专用：清掉这个浏览器里存的演示数据 */
async function clearLocal() {  try {
    await ElMessageBox.confirm(
      "会清掉这个浏览器里存的所有项目、任务和白板内容，回到空白状态。确定吗？",
      "清空本地数据",
      { type: "warning", confirmButtonText: "清空", cancelButtonText: "取消" }
    );
  } catch {
    return;
  }
  clearMockState();
  location.reload();
}

/** 把输入框填成系统默认位置（想搬回去时省得手打路径） */
function useDefault() {
  if (overview.value?.default_path) target.value = overview.value.default_path;
}

async function doMigrate() {
  const to = target.value.trim();
  if (!to) {
    ElMessage.warning("先选一个文件夹，或者把路径填进来");
    return;
  }
  busy.value = true;
  try {
    const r = await api.changeDataDir(to);
    step.value = "view";
    target.value = "";
    await load();
    ElMessage.success(
      `已搬到 ${r.to}（${r.folders} 个项目文件夹 · 数据 ${fmtSize(r.db_bytes)}）`
    );
  } catch (e) {
    reportError("更换数据位置", e);
    ElMessage.error(String(e));
  } finally {
    busy.value = false;
  }
}

/** 路径太长时只显示尾部的项目文件夹名 */
const folderTail = computed(() => {
  const p = overview.value?.path || "";
  if (!p) return "";
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || p;
});
</script>

<template>
  <el-dialog
    v-model="open"
    title="数据存储"
    width="640px"
    class="ds-dialog"
    append-to-body
    :close-on-click-modal="false"
  >
    <!-- 浏览器预览模式 -->
    <div v-if="!isTauri">
      <div class="ds-warn">
        当前是浏览器预览模式：数据只存在这个浏览器里，没有可切换的文件夹。
        换成桌面版之后，所有内容都会自动落成文件，可以自己指定放在哪个盘。
      </div>
      <el-button size="small" @click="clearLocal">
        <AppIcon name="trash" :size="13" />
        <span>清空本地数据</span>
      </el-button>
    </div>

    <div class="ds-body">
      <!-- 上次的位置失效 -->
      <div v-if="overview?.pending" class="ds-warn">
        上次指定的位置 <b>{{ overview.pending }}</b> 现在打不开了（U 盘没插 / 文件夹被挪走），
        先临时用默认位置。把它接回来之后，点「更换位置」指回原处就能看到原来的数据。
      </div>

      <div v-if="failMsg" class="ds-warn">{{ failMsg }}</div>

      <!-- 当前位置 -->
      <div v-if="isTauri" class="ds-card">
        <div class="ds-card-head">
          <span class="ds-label">现在存在这里</span>
          <span class="ds-badge" :class="{ 'is-custom': overview && !overview.is_default }">
            {{ overview?.is_default ? "默认位置" : "自定义位置" }}
          </span>
        </div>
        <div class="ds-path" :title="overview?.path">{{ overview?.path || "读取中…" }}</div>
        <div class="ds-meta">
          <span><b>{{ dbName }}</b> 只放项目清单</span>
          <span class="ds-dot">·</span>
          <span>共 {{ fmtSize(overview?.total_bytes) }}（含各项目文件夹）</span>
        </div>
        <div class="ds-actions">
          <el-button size="small" @click="reveal">
            <AppIcon name="folder" :size="13" />
            <span>打开文件夹</span>
          </el-button>
          <el-button size="small" @click="copyPath">
            <AppIcon name="copy" :size="13" />
            <span>复制路径</span>
          </el-button>
          <el-button size="small" type="primary" @click="step = 'pick'">
            更换位置…
          </el-button>
        </div>
      </div>

      <!-- 更换位置 -->
      <div v-if="isTauri && step === 'pick'" class="ds-migrate">
        <div class="ds-label">把数据存到哪儿</div>
        <div class="ds-pick">
          <el-input
            v-model="target"
            size="small"
            placeholder="例如 D:/看板数据 —— 可以手填，也可以点右边选择"
          />
          <el-button size="small" @click="pick">选择…</el-button>
        </div>
        <div v-if="overview && !overview.is_default" class="ds-default">
          <span class="ds-default-label">默认位置</span>
          <span class="ds-mono" :title="overview.default_path">{{ overview.default_path }}</span>
          <button class="ds-mini" @click="useDefault">换回默认</button>
        </div>
        <div class="ds-migrate-tip">
          确认后会把 <b>{{ overview?.projects.length || 0 }} 个项目</b>的看板、白板、文档和附件
          <b>整体搬过去</b>，搬完自动改用新位置，下次打开直接用新的。
          原来的文件夹会留一份备着，确认没问题再自己删。
        </div>
        <div class="ds-actions">
          <el-button size="small" type="primary" :loading="busy" @click="doMigrate">
            开始迁移
          </el-button>
          <el-button size="small" :disabled="busy" @click="step = 'view'">取消</el-button>
        </div>
      </div>

      <!-- 目录结构说明 -->
      <div v-if="isTauri" class="ds-struct">
        <div class="ds-label">文件夹里是什么</div>
        <div class="ds-tree">
          <div class="t-row t-root">
            <AppIcon name="folder" :size="13" />
            <b>{{ folderTail || "数据文件夹" }}</b>
          </div>
          <div class="t-row t-1">
            <span class="t-file">项目列表.db</span>
            <span class="t-note">只有项目清单，很小一份</span>
          </div>
          <div class="t-row t-1">
            <AppIcon name="folder" :size="13" />
            <span>项目名\</span>
            <span class="t-note">每个项目一个文件夹</span>
          </div>
          <div class="t-row t-2">
            <span class="t-file">看板与白板.db</span>
            <span class="t-note">这个项目的任务 + 白板节点/连线</span>
          </div>
          <div class="t-row t-2">
            <AppIcon name="folder" :size="13" />
            <span>附件\</span>
            <span class="t-note">上传的资料原件，保留原文件名</span>
          </div>
          <div class="t-row t-2">
            <AppIcon name="folder" :size="13" />
            <span>文档\</span>
            <span class="t-note">写作正文，一篇一个 .md，Typora / VS Code 都能开</span>
          </div>
        </div>
        <div class="ds-legend">
          一个项目 = 一个文件夹。要备份或发给别人，拷走那个文件夹，这个项目就完整带走了
          （看板、白板、附件、文稿全在里面）。
        </div>
      </div>

      <!-- 各项目占用 -->
      <div class="ds-list">
        <div class="ds-label">
          各项目占用
          <span v-if="loading" class="ds-dim">读取中…</span>
        </div>
        <table class="ds-table">
          <thead>
            <tr>
              <th>项目</th>
              <th>看板</th>
              <th>白板</th>
              <th>文档</th>
              <th>附件</th>
              <th>占用</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in overview?.projects || []" :key="p.id">
              <td class="ds-name" :title="p.folder">{{ p.name }}</td>
              <td>{{ p.tasks }}<span class="ds-dim"> / 完成 {{ p.done }}</span></td>
              <td>{{ p.notes }}</td>
              <td>{{ p.docs }}</td>
              <td>{{ p.files }}</td>
              <td>{{ p.bytes ? fmtSize(p.bytes) : "—" }}</td>
              <td class="ds-td-act">
                <button class="ds-mini" @click="openProject(p)">打开</button>
              </td>
            </tr>
            <tr v-if="!(overview?.projects || []).length && !loading">
              <td colspan="7" class="ds-empty">还没有项目</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="isTauri" class="ds-foot-note">
        <b>备份：</b>整个文件夹一起拷走最稳；只想给谁某个项目，单拷那个项目文件夹也够，
        里面已经有它的看板、白板、附件和文稿。
      </div>
    </div>

    <template #footer>
      <span class="ds-foot">
        <template v-if="overview">
          {{ overview.projects.length }} 个项目 · 共 {{ fmtSize(overview.total_bytes) }}
        </template>
      </span>
      <el-button @click="open = false">关闭</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
/* 项目多了就自己滚，别把弹窗顶出屏幕 */
.ds-body {
  max-height: calc(100vh - 300px);
  overflow-y: auto;
  padding-right: 2px;
}

.ds-warn {
  margin-bottom: 12px;
  padding: 10px 12px;
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--warn) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--warn) 32%, transparent);
  color: var(--text);
  font-size: 12.5px;
  line-height: 1.65;
}

.ds-label {
  font-size: 11.5px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-faint);
  font-weight: 600;
}

.ds-card {
  padding: 12px 14px 13px;
  border-radius: var(--radius-lg);
  background: var(--bg-soft);
  border: 1px solid var(--hairline);
  box-shadow: var(--inner-light);
}

.ds-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
}

.ds-badge {
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 11px;
  line-height: 18px;
  color: var(--text-subtle);
  background: var(--bg-inset);
  border: 1px solid var(--hairline);
}

.ds-badge.is-custom {
  color: var(--accent);
  background: var(--accent-faint);
  border-color: var(--accent-soft);
}

.ds-path {
  font-family: var(--font-mono);
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--text);
  word-break: break-all;
  user-select: all;
}

.ds-meta {
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-subtle);
}

.ds-dot {
  margin: 0 6px;
  color: var(--text-faint);
}

.ds-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 11px;
}

.ds-migrate {
  margin-top: 12px;
  padding: 12px 14px;
  border-radius: var(--radius-lg);
  border: 1px dashed var(--accent-soft);
  background: var(--accent-faint);
}

.ds-pick {
  display: flex;
  gap: 8px;
  margin: 8px 0 9px;
}

.ds-pick :deep(.el-input) {
  flex: 1;
}

.ds-default {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: -2px 0 9px;
  font-size: 11.5px;
  color: var(--text-faint);
}

.ds-mono {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: 11.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ds-default .ds-mini {
  flex: none;
}

.ds-default-label {
  flex: none;
  color: var(--text-faint);
}

.ds-migrate-tip {
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-subtle);
}

.ds-struct {
  margin-top: 16px;
}

.ds-tree {
  margin-top: 8px;
  padding: 10px 12px;
  border-radius: var(--radius-md);
  background: var(--bg-inset);
  border: 1px solid var(--hairline);
  font-size: 12.5px;
  line-height: 1.9;
  color: var(--text);
}

.t-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.t-root {
  color: var(--text);
}

.t-1 {
  padding-left: 16px;
}

.t-2 {
  padding-left: 34px;
}

.t-file {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--accent);
  padding: 0 5px;
  border-radius: 4px;
  background: var(--accent-faint);
}

.t-note {
  color: var(--text-faint);
  font-size: 11.5px;
}

.ds-legend {
  margin-top: 8px;
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--text-faint);
}

.ds-list {
  margin-top: 16px;
}

.ds-table {
  width: 100%;
  margin-top: 8px;
  border-collapse: collapse;
  font-size: 12.5px;
}

.ds-table th {
  text-align: left;
  font-weight: 600;
  font-size: 11px;
  letter-spacing: 0.04em;
  color: var(--text-faint);
  padding: 0 8px 6px;
  border-bottom: 1px solid var(--hairline);
  white-space: nowrap;
}

.ds-table td {
  padding: 7px 8px;
  border-bottom: 1px solid var(--hairline);
  color: var(--text-subtle);
  white-space: nowrap;
}

.ds-table tr:last-child td {
  border-bottom: none;
}

.ds-name {
  color: var(--text);
  max-width: 190px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ds-dim {
  color: var(--text-faint);
  font-size: 11.5px;
}

.ds-td-act {
  text-align: right;
}

.ds-mini {
  font-size: 11.5px;
  color: var(--accent);
  background: none;
  border: none;
  padding: 2px 4px;
  cursor: pointer;
  border-radius: 4px;
}

.ds-mini:hover {
  background: var(--accent-faint);
}

.ds-empty {
  text-align: center;
  color: var(--text-faint);
  padding: 16px 0 !important;
}

.ds-foot-note {
  margin-top: 14px;
  padding-top: 10px;
  border-top: 1px solid var(--hairline);
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--text-faint);
}

.ds-foot {
  float: left;
  line-height: 32px;
  font-size: 12px;
  color: var(--text-faint);
}
</style>
