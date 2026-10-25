<script setup lang="ts">
import { ref } from "vue";
import { useBoardStore } from "../store";
import { api } from "../api";
import { ElMessageBox, ElMessage } from "element-plus";
import { reportError } from "../diag";
import AppIcon from "./AppIcon.vue";
import DataStoreDialog from "./DataStoreDialog.vue";

const emit = defineEmits<{ (e: "open-trash"): void }>();
const store = useBoardStore();

// ---- 数据存储（位置 / 迁移 / 各项目占用，都收在弹窗里）----
const dataDirOpen = ref(false);

function openDataPanel() {
  dataDirOpen.value = true;
}

async function addProject() {
  let value: string;
  try {
    ({ value } = await ElMessageBox.prompt("项目名称", "新建项目", {
      confirmButtonText: "创建",
      cancelButtonText: "取消",
      inputValidator: (v: string) => (v.trim() ? true : "名称不能为空"),
    }));
  } catch {
    return; // user cancelled the dialog
  }
  try {
    const id = await api.createProject(value.trim());
    await store.refreshProjects();
    await store.loadProject(id);
    ElMessage.success(`已新建项目「${value.trim()}」`);
  } catch (e) {
    reportError("新建项目", e);
    const msg = String((e as Error)?.message ?? e);
    ElMessage.error(`新建项目失败：${msg.slice(0, 80)}`);
  }
}

async function renameProject(id: number, old: string) {
  let value: string;
  try {
    ({ value } = await ElMessageBox.prompt("新的名称", "重命名", {
      inputValue: old,
      confirmButtonText: "保存",
      cancelButtonText: "取消",
      inputValidator: (v: string) => (v.trim() ? true : "名称不能为空"),
    }));
  } catch {
    return; // cancelled
  }
  try {
    await api.updateProject(id, { name: value.trim() });
    await store.refreshProjects();
  } catch (e) {
    reportError("重命名项目", e);
  }
}

async function removeProject(id: number, name: string) {
  try {
    await ElMessageBox.confirm(`删除项目「${name}」及其所有任务？此操作不可恢复。`, "删除项目", {
      type: "warning",
      confirmButtonText: "删除",
      cancelButtonText: "取消",
    });
  } catch {
    return; // cancelled
  }
  try {
    await api.deleteProject(id);
    await store.refreshProjects();
    if (store.currentProjectId === id) {
      const first = store.projects[0];
      if (first) await store.loadProject(first.id);
      else {
        store.currentProjectId = null;
        store.columns = [];
        store.tasksByCol = {};
        store.notes = [];
        store.edges = [];
      }
    }
  } catch (e) {
    reportError("删除项目", e);
  }
}

function toggleTheme() {
  store.setTheme(store.theme === "dark" ? "light" : "dark");
}
</script>

<template>
  <aside class="sidebar">
    <!-- 品牌区：建筑制图意象的标识 + 专业定位 -->
    <div class="sidebar-header">
      <span class="brand-mark">
        <AppIcon name="logo" :size="21" :stroke="1.55" />
      </span>
      <div class="brand-text">
        <div class="brand-name">工作看板</div>
        <div class="brand-sub">建筑室内设计 · 专业工作台</div>
      </div>
    </div>

    <div class="project-list">
      <div
        v-for="p in store.projects"
        :key="p.id"
        class="project-item"
        :class="{ active: p.id === store.currentProjectId }"
        @click="store.switchProject(p.id)"
      >
        <span class="dot" :style="{ background: p.color }"></span>
        <span class="name">{{ p.name }}</span>
        <span class="ops">
          <el-button link size="small" title="重命名" @click.stop="renameProject(p.id, p.name)">
            <svg
              viewBox="0 0 24 24"
              width="13"
              height="13"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
            </svg>
          </el-button>
          <el-button link size="small" title="删除" @click.stop="removeProject(p.id, p.name)">
            <svg
              viewBox="0 0 24 24"
              width="13"
              height="13"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M3 6h18" />
              <path d="M8 6V4h8v2" />
              <path d="M19 6l-1 14H6L5 6" />
            </svg>
          </el-button>
        </span>
      </div>
      <div v-if="!store.projects.length" class="project-empty">还没有项目</div>
    </div>

    <div class="sidebar-new">
      <el-button @click="addProject">
        <svg
          viewBox="0 0 24 24"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
        >
          <path d="M12 5v14M5 12h14" />
        </svg>
        <span style="margin-left: 6px">新建项目</span>
      </el-button>
    </div>

    <div class="sidebar-footer">
      <button class="footer-btn fb-trash" @click="emit('open-trash')">
        <AppIcon name="trash" :size="15" />
        回收站
      </button>
      <button class="footer-btn fb-theme" @click="toggleTheme">
        <AppIcon :name="store.theme === 'dark' ? 'sun' : 'moon'" :size="15" />
        {{ store.theme === "dark" ? "浅色模式" : "深色模式" }}
      </button>
      <button class="footer-btn fb-store" @click="openDataPanel">
        <AppIcon name="folder" :size="15" />
        数据存储
      </button>
    </div>

    <!-- 开发者署名 -->
    <div class="brand-sign">
      <div class="sign-row">
        <span class="sign-rule"></span>
        <span>由 <b>wallenwang</b> 开发</span>
      </div>
    </div>

    <DataStoreDialog v-model="dataDirOpen" />
  </aside>
</template>

<style scoped>
.project-empty {
  padding: 16px 10px;
  text-align: center;
  font-size: 12.5px;
  color: var(--side-subtle);
}
.sidebar-new {
  padding: 4px 10px 12px;
}
.sidebar-new .el-button {
  width: 100%;
  border-radius: 8px;
}
</style>
