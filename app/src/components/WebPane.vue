<script setup lang="ts">
/**
 * 浮动浏览器面板：地址栏 + 前进/后退/刷新 + 缩放。
 *
 * 为什么做成「通用浏览器」而不是预置 AI 站点入口：
 * 预置第三方站点快捷入口，本质上是在给它们做套壳客户端，容易踩对方的服务条款；
 * 通用地址栏则是「输什么开什么」，责任在使用者，也和任何一家都不构成关联。
 *
 * iframe 方案自身的天花板（写在这，免得以后当 bug 查）：
 * 1. 站点可以用 X-Frame-Options / CSP frame-ancestors 拒绝被嵌入 → 白屏，用「↗」开系统浏览器；
 * 2. 跨域拿不到 iframe 内部的历史记录 → 前进/后退只能在「地址栏跳过的页面」之间走；
 * 3. 第三方 Cookie 受限，有的站登录态进不去，同样用「↗」。
 */
import { ref, computed, onMounted } from "vue";

const props = withDefaults(defineProps<{ compact?: boolean }>(), { compact: false });

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

/** 自己维护一条历史：跨域拿不到 iframe 的 history，只能记「地址栏去过的页」 */
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
});

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

/** 输入的是网址还是搜索词：有协议头 / 像个域名 → 网址，其余一律当搜索 */
function toTarget(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  if (/^https?:\/\//i.test(t)) {
    try {
      const u = new URL(t);
      if (u.hostname.includes(".") || u.hostname === "localhost") return u.toString();
    } catch {
      /* 落下去当搜索词 */
    }
    return SEARCH_URL + encodeURIComponent(t);
  }
  const noSpace = !/\s/.test(t);
  const looksHost =
    /^[\w-]+(\.[\w-]+)+(:\d+)?(\/[^\s]*)?$/.test(t) ||
    /^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/[^\s]*)?$/i.test(t);
  if (noSpace && looksHost) {
    try {
      const u = new URL(`https://${t}`);
      return u.toString();
    } catch {
      /* 落下去当搜索词 */
    }
  }
  return SEARCH_URL + encodeURIComponent(t);
}

function load(u: string) {
  frameSrc.value = u;
  urlInput.value = u;
  frameKey.value++;
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
  if (frameSrc.value) frameKey.value++;
}

function openExternal() {
  const u = toTarget(urlInput.value) || frameSrc.value;
  if (u) window.open(u, "_blank", "noopener");
}

function zoomIn() {
  zoomIdx.value = Math.min(ZOOM_STEPS.length - 1, zoomIdx.value + 1);
  persist();
}
function zoomOut() {
  zoomIdx.value = Math.max(0, zoomIdx.value - 1);
  persist();
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
        <button class="wp-btn" title="用系统浏览器打开（嵌入白屏或登录不上时用）" @click="openExternal">
          ↗
        </button>
        <span class="wp-sep"></span>
        <button class="wp-btn" title="缩小" @click="zoomOut">－</button>
        <span class="wp-zoom">{{ zoomText }}</span>
        <button class="wp-btn" title="放大" @click="zoomIn">＋</button>
      </div>
    </div>

    <div class="wp-frame-wrap">
      <iframe
        v-if="frameSrc"
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
          有些站点禁止被第三方嵌入（会白屏），点 <b>↗</b> 用系统浏览器打开。
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
</style>
