<script setup lang="ts">
/**
 * 浮动网页面板：地址栏 + 前进/后退/刷新 + 缩放。
 *
 * 为什么做成「通用浏览器」而不是预置 AI 站点入口：
 * 预置第三方站点快捷入口，本质上是在给它们做套壳客户端，容易踩对方的服务条款；
 * 通用地址栏则是「输什么开什么」，责任在使用者，也和任何一家都不构成关联。
 *
 * ⚠️ 2026-10-20 起内容区不再是 iframe，而是**真正的子 webview**（WebView2 内核）。
 * 原因（用户实测反馈）：
 *   1. 豆包、Bing 结果页等站点用 CSP frame-ancestors / X-Frame-Options 禁止被 iframe 嵌入；
 *   2. iframe 里点结果如果是 target=_blank，新窗口请求被拦下后**什么都不发生**，
 *      表现就是"点了没反应、进不去网站"。
 * 子 webview 是独立的内核视图，以上两条都不存在；`on_new_window` 里还会把新窗口请求
 * 改成"在当前浮动网页里打开"，这样点搜索结果就能正常跳转。
 *
 * 兜底：如果原生 webview 创建失败（老版本 / 非 Tauri 环境），自动退回 iframe 方案。
 */
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from "vue";
import { api } from "../api";
import { reportError } from "../diag";

const props = withDefaults(defineProps<{ compact?: boolean; active?: boolean }>(), {
  compact: false,
  active: true,
});

const ZOOM_STEPS = [0.8, 0.9, 1, 1.15, 1.3, 1.5];
const STORE_KEY = "kanban.webpane";
/** 输入的不是网址时走哪个搜索：Bing 国内版，不需要额外授权 */
const SEARCH_URL = "https://cn.bing.com/search?q=";
const MAX_HISTORY = 50;

const urlInput = ref("");
const frameSrc = ref("");
const frameKey = ref(0);
const zoomIdx = ref(2);
const zoom = computed(() => ZOOM_STEPS[zoomIdx.value]);
const zoomText = computed(() => `${Math.round(zoom.value * 100)}%`);

/** 内容区占位（真正的网页视图由 Rust 侧按这块的坐标贴上去） */
const boxRef = ref<HTMLDivElement | null>(null);
/** 原生 webview 是否可用（失败就退回 iframe） */
const nativeOk = ref(true);
/** 原生 webview 是全局单例，用模块级变量记着它建过没有 */
let nativeCreated = false;

/** 自己维护一条历史：跨域拿不到 webview 的历史，只能记「地址栏去过的页」 */
const stack = ref<string[]>([]);
const idx = ref(-1);
const canBack = computed(() => idx.value > 0);
const canForward = computed(() => idx.value >= 0 && idx.value < stack.value.length - 1);

onMounted(() => {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    if (Array.isArray(saved.stack) && saved.stack.length) {
      stack.value = saved.stack.filter((u: unknown) => typeof u === "string" && u);
      const i = Number(saved.idx);
      idx.value = Number.isInteger(i) && i >= 0 && i < stack.value.length ? i : stack.value.length - 1;
      frameSrc.value = stack.value[idx.value] ?? "";
      urlInput.value = frameSrc.value;
    } else if (typeof saved.url === "string" && saved.url) {
      // 老数据（只存了一个 url）顺手搬过来
      stack.value = [saved.url];
      idx.value = 0;
      frameSrc.value = saved.url;
      urlInput.value = saved.url;
    }
    const zi = Number(saved.zoomIdx);
    if (Number.isInteger(zi) && zi >= 0 && zi < ZOOM_STEPS.length) zoomIdx.value = zi;
  } catch {
    /* 忽略损坏的本地数据 */
  }
  window.addEventListener("resize", onResize);
  ro = new ResizeObserver(() => scheduleSync());
  if (boxRef.value) ro.observe(boxRef.value);
  // 首帧布局稳定后再把网页视图摆上去
  void nextTick(() => {
    if (props.active && frameSrc.value) void showNative(frameSrc.value, true);
    else void syncBounds();
  });
});

onBeforeUnmount(() => {
  window.removeEventListener("resize", onResize);
  ro?.disconnect();
  window.clearTimeout(boundsTimer);
  // 不在这里关原生视图：浮动窗收起后还要能原样回来（关闭在 FloatWindow 里做）
});

let ro: ResizeObserver | null = null;
let boundsTimer = 0;

function onResize() {
  scheduleSync();
}

/** 拖动/缩放时每帧都在变，节流到 80ms，别把 IPC 打爆 */
function scheduleSync() {
  window.clearTimeout(boundsTimer);
  boundsTimer = window.setTimeout(() => void syncBounds(), 80);
}

function rectOf(): { x: number; y: number; w: number; h: number } | null {
  const el = boxRef.value;
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 8 || r.height < 8) return null;
  return {
    x: Math.round(r.left),
    y: Math.round(r.top),
    w: Math.round(r.width),
    h: Math.round(r.height),
  };
}

async function syncBounds() {
  if (!nativeOk.value || !nativeCreated) return;
  const r = rectOf();
  if (!r) return;
  try {
    await api.floatWebBounds(r.x, r.y, r.w, r.h);
  } catch (e) {
    reportError("浮动网页定位", e);
  }
}

/** 创建（或复用）原生网页视图，并导航到 url */
async function showNative(u: string, keepScroll = false) {
  const r = rectOf();
  if (!r) return false;
  try {
    if (!nativeCreated) {
      await api.floatWebOpen(u, r.x, r.y, r.w, r.h);
      nativeCreated = true;
    } else {
      await api.floatWebBounds(r.x, r.y, r.w, r.h);
      if (!keepScroll) await api.floatWebNavigate(u);
    }
    await api.floatWebZoom(zoom.value);
    await api.floatWebVisible(props.active !== false);
    return true;
  } catch (e) {
    // 原生不可用 → 退回 iframe，至少还能显示能嵌的站点
    nativeOk.value = false;
    reportError("浮动网页（改用内嵌模式）", e);
    return false;
  }
}

/** 输入的是网址还是搜索词：有空格当搜索；没空格且能解析成域名就当网址 */
function toTarget(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  if (/\s/.test(t)) return SEARCH_URL + encodeURIComponent(t);
  try {
    // 中文域名也能解析（URL 会自动转成 punycode），所以「豆包.com」能直接打开
    const u = new URL(t.includes("://") ? t : `https://${t}`);
    const h = u.hostname;
    if (h.includes(".") || h === "localhost" || /^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
      return u.toString();
    }
  } catch {
    /* 不是网址 */
  }
  return SEARCH_URL + encodeURIComponent(t);
}

function load(u: string) {
  frameSrc.value = u;
  urlInput.value = u;
  frameKey.value++;
  if (nativeOk.value) void showNative(u);
}

function go(raw?: string, push = true) {
  const u = toTarget(raw ?? urlInput.value);
  if (!u) return;
  load(u);
  if (push) {
    stack.value = stack.value.slice(0, idx.value + 1);
    stack.value.push(u);
    if (stack.value.length > MAX_HISTORY) stack.value.shift();
    idx.value = stack.value.length - 1;
  }
  persist();
}

function back() {
  if (!canBack.value) return;
  idx.value--;
  load(stack.value[idx.value]);
  persist();
}

function forward() {
  if (!canForward.value) return;
  idx.value++;
  load(stack.value[idx.value]);
  persist();
}

function reload() {
  if (!frameSrc.value) return;
  if (nativeOk.value) void showNative(frameSrc.value, false);
  else frameKey.value++;
}

function openExternal() {
  const u = toTarget(urlInput.value) || frameSrc.value;
  if (u) window.open(u, "_blank", "noopener");
}

function zoomIn() {
  zoomIdx.value = Math.min(ZOOM_STEPS.length - 1, zoomIdx.value + 1);
  applyZoom();
}
function zoomOut() {
  zoomIdx.value = Math.max(0, zoomIdx.value - 1);
  applyZoom();
}
function applyZoom() {
  persist();
  if (nativeOk.value && nativeCreated) void api.floatWebZoom(zoom.value);
}

/** 浮动窗收起/展开时同步可见性（原生视图不会跟着 v-show 消失） */
watch(
  () => props.active,
  (on) => {
    if (!nativeOk.value || !nativeCreated) return;
    void (async () => {
      if (on) {
        await syncBounds();
        void api.floatWebVisible(true);
      } else {
        void api.floatWebVisible(false);
      }
    })();
  }
);

watch(zoomIdx, () => applyZoom());

function persist() {
  try {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({
        stack: stack.value.slice(-MAX_HISTORY),
        idx: idx.value,
        zoomIdx: zoomIdx.value,
      })
    );
  } catch {
    /* 存不下就算了 */
  }
}

const frameStyle = computed(() => ({
  width: `${100 / zoom.value}%`,
  height: `${100 / zoom.value}%`,
  transform: `scale(${zoom.value})`,
  transformOrigin: "top left",
}));

defineExpose({ go, openExternal });
</script>

<template>
  <div class="webpane" :class="{ compact: props.compact }">
    <div class="wp-tools">
      <div class="wp-bar">
        <button class="wp-btn nav" :disabled="!canBack" title="后退" @click="back">‹</button>
        <button class="wp-btn nav" :disabled="!canForward" title="前进" @click="forward">›</button>
        <button class="wp-btn nav" :disabled="!frameSrc" title="刷新" @click="reload">⟳</button>
        <input
          v-model="urlInput"
          class="wp-url"
          placeholder="输入网址；也可以直接输要搜的内容"
          spellcheck="false"
          @keydown.enter.prevent="go()"
        />
        <button class="wp-btn" title="打开" @click="go()">前往</button>
        <button class="wp-btn" title="用系统浏览器打开（登录不上时用）" @click="openExternal">
          ↗
        </button>
        <span class="wp-sep"></span>
        <button class="wp-btn" title="缩小" @click="zoomOut">－</button>
        <span class="wp-zoom">{{ zoomText }}</span>
        <button class="wp-btn" title="放大" @click="zoomIn">＋</button>
      </div>
    </div>

    <div ref="boxRef" class="wp-frame-wrap">
      <!-- 原生模式：真正的网页由子 webview 铺在这块区域上，这里只放空位 -->
      <div v-if="nativeOk && frameSrc" class="wp-native"></div>
      <iframe
        v-else-if="frameSrc"
        :key="frameKey"
        :src="frameSrc"
        :style="frameStyle"
        class="wp-frame"
        allow="clipboard-read; clipboard-write; microphone"
        referrerpolicy="no-referrer"
      ></iframe>
      <div v-else class="wp-empty">
        <div class="wp-empty-ico">🌐</div>
        <div class="wp-empty-title">在这里打开任意网页</div>
        <div class="wp-empty-sub">
          输网址回车就打开；直接输一句话，会按<b>搜索</b>处理。<br />
          豆包、Bing、各类 AI 工具都能直接用，登录也会记住。
        </div>
      </div>
    </div>

    <div class="wp-tip">
      💡 选中内容 <b>Ctrl+C</b> 复制，直接粘到文档或白板；「＋/－」放大页面。
    </div>
  </div>
</template>

<style scoped>
.webpane {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: var(--bg);
}
.wp-tools {
  flex: none;
  border-bottom: 1px solid var(--border);
  background: var(--bg-elevated, var(--bg));
  padding: 6px 10px 8px;
}
.wp-bar {
  display: flex;
  align-items: center;
  gap: 5px;
}
.wp-url {
  flex: 1;
  min-width: 90px;
  font-size: 13px;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--bg);
  color: var(--text);
  outline: none;
}
.wp-url:focus {
  border-color: var(--accent, #0079bf);
}
.wp-btn {
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text);
  font-size: 12px;
  padding: 5px 9px;
  border-radius: 7px;
  cursor: pointer;
  white-space: nowrap;
}
.wp-btn:hover:not(:disabled) {
  border-color: var(--accent, #0079bf);
  color: var(--accent, #0079bf);
}
.wp-btn:disabled {
  opacity: 0.35;
  cursor: default;
}
/* 前进 / 后退 / 刷新：图标按钮，别跟「前往」一样宽 */
.wp-btn.nav {
  padding: 5px 8px;
  font-size: 13px;
  line-height: 1;
}
.wp-sep {
  width: 1px;
  height: 16px;
  background: var(--border);
  margin: 0 2px;
  flex: none;
}
.wp-zoom {
  font-size: 12px;
  color: var(--text-subtle);
  min-width: 40px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.wp-frame-wrap {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  position: relative;
}
.wp-frame {
  border: none;
  background: #fff;
  display: block;
}
.wp-empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  color: var(--text-subtle);
  padding: 0 14px;
}
.wp-empty-ico {
  font-size: 34px;
  margin-bottom: 8px;
}
.wp-empty-title {
  font-weight: 600;
  margin-bottom: 6px;
  color: var(--text);
}
.wp-empty-sub {
  font-size: 13px;
  line-height: 1.9;
}
.wp-tip {
  flex: none;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--text-subtle);
  padding: 5px 12px;
  border-top: 1px solid var(--border);
  background: var(--bg-elevated, var(--bg));
}
/* 窄栏模式：按钮缩小，把宽度让给网页 */
.webpane.compact .wp-btn {
  padding: 4px 7px;
}
.webpane.compact .wp-btn.nav {
  padding: 4px 6px;
}

/* 原生网页视图铺满内容区（真正的页面由 Rust 侧的子 webview 盖上） */
.wp-native {
  position: absolute;
  inset: 0;
}
</style>
