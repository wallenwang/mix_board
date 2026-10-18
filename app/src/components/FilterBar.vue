<script setup lang="ts">
import { useBoardStore } from "../store";
import { PRIORITIES } from "../types";

const store = useBoardStore();

/** 竖排（放进「筛选」气泡里时用），默认是横向平铺 */
defineProps<{ stacked?: boolean }>();

function clearFilters() {
  store.filterSearch = "";
  store.filterPriority = null;
  store.filterTags = [];
}
</script>

<template>
  <!-- 宽度都用弹性值：看板栏被拖窄时这里会自己收窄 / 换行，不会把「新建任务」挤出去 -->
  <div class="filter-bar" :class="{ stacked }">
    <el-input
      v-model="store.filterSearch"
      placeholder="搜索任务…"
      clearable
      size="small"
      class="fb-search"
    />

    <el-select
      v-model="store.filterPriority"
      placeholder="优先级"
      clearable
      size="small"
      class="fb-prio"
    >
      <el-option v-for="p in PRIORITIES" :key="p.value" :label="p.label" :value="p.value" />
    </el-select>

    <el-select
      v-model="store.filterTags"
      placeholder="标签"
      clearable
      multiple
      collapse-tags
      size="small"
      class="fb-tags"
    >
      <el-option v-for="t in store.tags" :key="t.id" :label="t.name" :value="t.id" />
    </el-select>

    <el-button v-if="store.hasFilter" link size="small" @click="clearFilters">清除筛选</el-button>
  </div>
</template>

<style scoped>
.filter-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
  flex: 1 1 auto;
}
.fb-search {
  flex: 1 1 130px;
  width: auto;
  min-width: 108px;
  max-width: 230px;
}
.fb-prio {
  flex: 0 1 112px;
  width: auto;
  min-width: 96px;
  max-width: 130px;
}
.fb-tags {
  flex: 0 1 158px;
  width: auto;
  min-width: 104px;
  max-width: 200px;
}

/* 竖排（气泡里） */
.filter-bar.stacked {
  flex-direction: column;
  align-items: stretch;
}
.filter-bar.stacked .fb-search,
.filter-bar.stacked .fb-prio,
.filter-bar.stacked .fb-tags {
  flex: none;
  width: 100%;
  min-width: 0;
  max-width: none;
}
.filter-bar.stacked .el-button {
  align-self: flex-start;
}
</style>
