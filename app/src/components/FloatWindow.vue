<script setup lang="ts">
/**
 * 可拖动、可缩放的悬浮窗（装一个通用网页浏览器）。
 *
 * 为什么需要它：内嵌分栏里的面板宽度被布局绑死，而网页对宽度很敏感；
 * 悬浮窗可以盖在看板/白板上面任意位置，位置尺寸都记住，用完收起来。
 *
 * 定位是「浏览器」而不是「AI 客户端」：不预置任何第三方站点入口，
 * 打开什么由用户在地址栏决定，避免给别家做套壳客户端带来的条款风险。
 */
import { ref, onMounted, onBeforeUnmount, watch, computed } from "vue";
import WebPane from "./WebPane.vue";

const open = defineModel<boolean>({ default: false });

const KEY = "kanban.aiFloat";
const MIN_W = 320;
const MIN_H = 260;

const x = ref(0);
const y = ref(0);
const w = ref(430);
const h = ref(620);
const maxed = ref(false);
let saveTimer = 0;

const WIDTHS: { label: string; w: number; title: string }[] = [
  { label: "📱", w: 400, title: "手机宽度（网站自动切手机版，字更大）" },
  { label: "▭", w: 620, title: "平板宽度" },
  { label: "▬", w: 900, title: "宽屏" },
];

function clampX(v: number) {
  return Math.min(Math.max(0, window.innerWidth - 60), Math.max(0, v));
}
function clampY(v: number) {
  return Math.min(Math.max(0, window.innerHeight - 40), Math.max(0, v));
}

onMounted(() => {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "{}");
    if (Number.isFinite(s.x)) x.value = Number(s.x);
    if (Number.isFinite(s.y)) y.value = Number(s.y);
    if (Number(s.w) >= MIN_W) w.value = Number(s.w);
    if (Number(s.h) >= MIN_H) h.value = Number(s.h);
    if (s.maxed === true) maxed.value = true;
  } catch {
    /* 忽略 */
  }
  // 没有历史位置 → 默认贴在右侧偏上（正好压在看板上，看板本来也不常看）
  if (!Number.isFinite(JSON.parse(localStorage.getItem(KEY) || "{}").x)) {
    x.value = Math.max(20, window.innerWidth - w.value - 28);
    y.value = 96;
  }
  x.value = clampX(x.value);
  y.value = clampY(y.value);
  window.addEventListener("resize", onWinResize);
});

onBeforeUnmount(() => {
  window.removeEventListener("resize", onWinResize);
  window.clearTimeout(saveTimer);
});

function onWinResize() {
  x.value = clampX(x.value);
  y.value = clampY(y.value);
}

/** 位置/尺寸变化攒 300ms 再落盘，拖动过程中不狂写 localStorage */
watch([x, y, w, h, maxed], () => {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(
        KEY,
        JSON.stringify({ x: x.value, y: y.value, w: w.value, h: h.value, maxed: maxed.value })
      );
    } catch {
      /* 忽略 */
    }
  }, 300);
});

/**
 * 拖动/缩放的通用壳子。
 *
 * ⚠️ pointermove 一帧可能触发多次，直接改坐标会让 Vue 反复 diff + 重排，
 * 拖起来发涩；这里攒到**每帧只应用一次**（rAF 节流），
 * 同时让里面的原生网页视图（按帧读位置）能和窗口严丝合缝地一起走。
 */
function dragBar(cursor: string, onMove: (ev: PointerEvent) => void) {
  const prevCursor = document.body.style.cursor;
  const prevSelect = document.body.style.userSelect;
  document.body.style.cursor = cursor;
  document.body.style.userSelect = "none";

  let pending: PointerEvent | null = null;
  let raf = 0;
  const tick = () => {
    raf = 0;
    if (pending) {
      const ev = pending;
      pending = null;
      onMove(ev);
    }
  };
  const move = (ev: PointerEvent) => {
    pending = ev;
    if (!raf) raf = requestAnimationFrame(tick);
  };
  const up = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    pending = null;
    document.body.style.cursor = prevCursor;
    document.body.style.userSelect = prevSelect;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}

/** 拖标题栏移动 */
function startDrag(e: PointerEvent) {
  if (e.button !== 0 || maxed.value) return;
  e.preventDefault();
  const sx = e.clientX;
  const sy = e.clientY;
  const ox = x.value;
  const oy = y.value;
  dragBar("move", (ev) => {
    x.value = clampX(ox + ev.clientX - sx);
    y.value = clampY(oy + ev.clientY - sy);
  });
}

/** 拖右下角改大小 */
function startResize(e: PointerEvent) {
  if (e.button !== 0 || maxed.value) return;
  e.preventDefault();
  e.stopPropagation();
  const sx = e.clientX;
  const sy = e.clientY;
  const ow = w.value;
  const oh = h.value;
  dragBar("nwse-resize", (ev) => {
    w.value = Math.max(MIN_W, Math.min(window.innerWidth - 20, ow + ev.clientX - sx));
    h.value = Math.max(MIN_H, Math.min(window.innerHeight - 60, oh + ev.clientY - sy));
  });
}

const boxStyle = computed(() => {
  if (maxed.value) {
    return { left: "24px", top: "24px", width: "calc(100vw - 48px)", height: "calc(100vh - 48px)" };
  }
  return { left: `${x.value}px`, top: `${y.value}px`, width: `${w.value}px`, height: `${h.value}px` };
});

/**
 * 里面那个 iframe 只在**真的打开过**浮动浏览器之后才创建。
 *
 * 以前 WebPane 跟着 v-show 常驻，启动那一刻 iframe 就会把上次访问的网页
 * （可能是豆包/在线文档这类大型 SPA）整个加载一遍 —— 明明没打开浮窗，
 * 启动却在后台跑一个网站：又卡又占内存。这是"启动卡顿"的隐形大头。
 *
 * 收起后延迟 20 秒再卸载：短时间内反复开合不用重新加载，
 * 长期挂着也不会白白占资源。
 */
const paneMounted = ref(false);
let unmountTimer = 0;
watch(
  open,
  (v) => {
    window.clearTimeout(unmountTimer);
    if (v) paneMounted.value = true;
    else
      unmountTimer = window.setTimeout(() => {
        paneMounted.value = false;
      }, 20000);
  },
  { immediate: true }
);
onBeforeUnmount(() => window.clearTimeout(unmountTimer));
</script>

<template>
  <Teleport to="body">
    <div v-show="open" class="floatwin" :style="boxStyle" :class="{ maxed }">
      <div class="fw-head" @pointerdown="startDrag" @dblclick="maxed = !maxed">
        <span class="fw-dot"></span>
        <span class="fw-title">🌐 浏览器</span>
        <div class="fw-tools" @pointerdown.stop>
          <button
            v-for="s in WIDTHS"
            :key="s.w"
            class="fw-btn"
            :title="s.title"
            @click="((w = s.w), (maxed = false))"
          >
            {{ s.label }}
          </button>
          <button class="fw-btn" :title="maxed ? '还原窗口' : '最大化'" @click="maxed = !maxed">
            {{ maxed ? "❐" : "▢" }}
          </button>
          <button class="fw-btn fw-close" title="收起（位置会记住）" @click="open = false">✕</button>
        </div>
      </div>
      <div class="fw-body">
        <!-- 懒加载：没见过浮窗就完全不创建（见 paneMounted 的注释） -->
        <WebPane v-if="paneMounted" :active="open" compact />
        <div v-else class="fw-placeholder">网页会在第一次打开时加载</div>
      </div>
      <div class="fw-grip" title="拖动改变大小" @pointerdown="startResize"></div>
    </div>
  </Teleport>
</template>

<style scoped>
.floatwin {
  position: fixed;
  z-index: 1500;
  display: flex;
  flex-direction: column;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: var(--shadow-lg);
  overflow: hidden;
}
.fw-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 9px 8px 12px;
  background: var(--bg-elevated);
  border-bottom: 1px solid var(--border);
  cursor: move;
  user-select: none;
}
.fw-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
  flex: none;
}
.fw-title {
  font-size: 13px;
  font-weight: 650;
  letter-spacing: 0.01em;
  color: var(--text);
}
.fw-tools {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 3px;
  cursor: default;
}
.fw-btn {
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-subtle);
  font-family: inherit;
  font-size: 12px;
  padding: 3px 7px;
  border-radius: 6px;
  cursor: pointer;
  line-height: 1.3;
  transition: background 0.14s var(--ease), color 0.14s var(--ease);
}
.fw-btn:hover {
  background: var(--bg-sunken);
  color: var(--text);
}
.fw-close:hover {
  background: var(--danger);
  color: #fff;
  border-color: var(--danger);
}
.fw-body {
  flex: 1;
  min-height: 0;
  display: flex;
}
.fw-placeholder {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: var(--text-subtle);
}
.fw-grip {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 18px;
  height: 18px;
  cursor: nwse-resize;
  background: linear-gradient(
    135deg,
    transparent 0 50%,
    var(--border, #dcdfe6) 50% 60%,
    transparent 60% 70%,
    var(--border, #dcdfe6) 70% 80%,
    transparent 80%
  );
}
</style>
