<script setup lang="ts">
import { computed } from "vue";
import { ICONS, type IconName } from "../icons";

/**
 * 统一图标组件：24×24 网格、只描边不填充、圆头圆角。
 * 尺寸通过 size 控制（默认 16），描边默认 1.7 —— 这正是参考稿那套规范。
 */
const props = withDefaults(
  defineProps<{ name: IconName; size?: number; stroke?: number }>(),
  { size: 16, stroke: 1.7 }
);

const d = computed(() => ICONS[props.name] ?? "");
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    :stroke-width="stroke"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    class="app-icon"
  >
    <path :d="d" />
  </svg>
</template>

<style scoped>
.app-icon {
  flex: none;
  display: block;
}
</style>
