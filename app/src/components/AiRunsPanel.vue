<script setup lang="ts">
/**
 * 右下角的「AI 任务」浮动入口。
 *
 * 解决的问题：以前发一个任务就得盯着弹窗，关了就看不到；
 * 想同时发三四个任务更是没地方看它们各自跑到哪了。
 *
 * 这里只做展示 + 转手：状态全部来自 aiRuns.ts 的运行池。
 * 点开一条 = 把 viewing 指向它（所以它跑完不会弹通知，也不标"新"）。
 */
import { computed, onMounted, onUnmounted, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { api } from "../api";
import { useBoardStore } from "../store";
import { openPrompt } from "../aiPrompt";
import { cancelRun, placeOutputsOnBoard, refreshRunOutputs } from "../aiAgent";
import {
  busyRuns,
  forgetFinished,
  isBusy,
  liveCount,
  runList,
  unreadCount,
  viewing,
  type AiRun,
} from "../aiRuns";

const store = useBoardStore();

const open = ref(false);
const expanded = ref("");
/** 每秒跳一下，只为了让"跑着 3 分 12 秒"这个数字自己走 */
const now = ref(Date.now());
let timer: number | null = null;

onMounted(() => {
  timer = window.setInterval(() => {
    if (liveCount.value) now.value = Date.now();
  }, 1000);
});
onUnmounted(() => {
  if (timer != null) window.clearInterval(timer);
  viewing.value = "";
});

const doneCount = computed(() => runList.value.filter((r) => !isBusy(r)).length);
const badge = computed(() => (liveCount.value ? liveCount.value : unreadCount.value));
const tip = computed(() =>
  liveCount.value
    ? `${liveCount.value} 个 AI 任务正在跑`
    : unreadCount.value
      ? `${unreadCount.value} 个任务有结果没看`
      : "AI 任务"
);

function toggleAll() {
  open.value = !open.value;
  if (!open.value) {
    expanded.value = "";
    viewing.value = "";
  }
}

function toggle(r: AiRun) {
  if (expanded.value === r.key) {
    expanded.value = "";
    viewing.value = "";
    return;
  }
  expanded.value = r.key;
  viewing.value = r.key;
  r.unread = false;
  if (r.workDir && !r.outputs.length && !isBusy(r)) void refreshRunOutputs(r.taskId);
}

function phaseText(r: AiRun): string {
  if (r.phase === "preparing") return "准备中…";
  if (r.phase === "running") return `跑着 ${dur(r.startedAt, now.value)}`;
  if (r.phase === "error") return "出错";
  const n = r.outputs.length;
  return `${r.at || "完成"}${n ? ` · ${n} 份产物` : ""}`;
}

function dur(a: number, b: number): string {
  const s = Math.max(0, Math.round((b - a) / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${s % 60} 秒`;
  return `${Math.floor(m / 60)} 时 ${m % 60} 分`;
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function stop(r: AiRun) {
  cancelRun(r.taskId);
  ElMessage.info(`已中止「${r.title}」`);
}

/** 打开指令弹窗并直接接回这条 run（弹窗里那个任务就是它） */
function openPromptFor(r: AiRun) {
  if (r.taskId == null) return;
  open.value = false;
  viewing.value = "";
  openPrompt(store, r.taskId);
}

async function place(r: AiRun) {
  const n = await placeOutputsOnBoard(r.title, r.taskId);
  if (n > 0) ElMessage.success(`已把 ${n} 份产物打成一个组放到白板`);
  else ElMessage.warning(r.error || "没有可放的产物");
}

function openDir(r: AiRun) {
  if (!r.workDir) return;
  void api.aiOpenDir(r.workDir).catch(() => {});
}

async function clearDone() {
  try {
    await ElMessageBox.confirm(
      `清掉 ${doneCount.value} 条已结束的任务记录？\n（只是清这个列表，产物文件和白板上的卡片都不动）`,
      "清空已完成",
      { confirmButtonText: "清掉", cancelButtonText: "留着", type: "info" }
    );
  } catch {
    return;
  }
  const n = forgetFinished();
  expanded.value = "";
  viewing.value = "";
  ElMessage.success(`清掉了 ${n} 条记录`);
}
</script>

<template>
  <div class="ai-runs">
    <transition name="runs-pop">
      <section v-if="open" class="runs-panel">
        <header class="runs-head">
          <span class="runs-title">AI 任务</span>
          <span class="runs-sub">
            {{ busyRuns.length ? `${busyRuns.length} 个在跑` : "没有在跑的" }}
          </span>
          <button v-if="doneCount" class="runs-clear" @click="clearDone">清空已完成</button>
          <button class="runs-x" title="收起" @click="toggleAll">×</button>
        </header>

        <div v-if="!runList.length" class="runs-empty">
          还没有 AI 任务。<br />
          点任务卡上的「AI」按钮发一份指令，这里就会出现它 —— 之后关掉弹窗它也会接着跑。
        </div>

        <ul v-else class="runs-list">
          <li
            v-for="r in runList"
            :key="r.key"
            class="run-item"
            :class="{ exp: expanded === r.key }"
          >
            <button class="run-head" @click="toggle(r)">
              <span class="run-dot" :class="'ph-' + r.phase"></span>
              <span class="run-name" :title="r.title">{{ r.title }}</span>
              <span class="run-meta">{{ phaseText(r) }}</span>
              <span v-if="r.unread" class="run-new">新</span>
            </button>

            <div v-if="expanded === r.key" class="run-detail">
              <div v-if="r.workDir" class="run-dir" :title="r.workDir">{{ r.workDir }}</div>

              <pre v-if="r.text.trim()" class="run-text">{{ r.text }}</pre>
              <div v-else-if="isBusy(r)" class="run-wait">
                AI 还在想，第一段文字出来就会显示在这儿…
              </div>

              <div v-if="r.error" class="run-err">{{ r.error }}</div>

              <div v-if="r.outputs.length" class="run-outs">
                <div class="run-outs-t">产物 {{ r.outputs.length }} 份</div>
                <div v-for="o in r.outputs" :key="o.path" class="run-out">
                  <span class="of-name">{{ o.name }}</span>
                  <span class="of-size">{{ fmtSize(o.size) }}</span>
                </div>
              </div>

              <details v-if="r.log.length" class="run-log">
                <summary>过程日志（{{ r.log.length }} 行）</summary>
                <div v-for="(l, i) in r.log" :key="i" class="log-line">{{ l }}</div>
              </details>

              <div class="run-acts">
                <button v-if="isBusy(r)" class="btn danger" @click="stop(r)">中止</button>
                <button class="btn" @click="openPromptFor(r)">看指令 / 接着发</button>
                <button v-if="r.outputs.length" class="btn" @click="place(r)">放到白板</button>
                <button v-if="r.workDir" class="btn ghost" @click="openDir(r)">打开目录</button>
              </div>
            </div>
          </li>
        </ul>
      </section>
    </transition>

    <button class="runs-fab" :class="{ live: liveCount > 0 }" :title="tip" @click="toggleAll">
      <span class="fab-ring" v-if="liveCount > 0"></span>
      <span class="fab-txt">AI</span>
      <span v-if="badge" class="fab-badge" :class="{ dot: !liveCount }">{{ badge }}</span>
    </button>
  </div>
</template>

<style scoped>
.ai-runs {
  position: fixed;
  right: 20px;
  bottom: 26px;
  z-index: 1400;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 12px;
}

/* ---------------------------------------------------------------- 浮动按钮 */

.runs-fab {
  position: relative;
  width: 46px;
  height: 46px;
  border-radius: 50%;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  color: var(--text);
  cursor: pointer;
  font: 600 13px/1 inherit;
  letter-spacing: 0.5px;
  display: grid;
  place-items: center;
  box-shadow: 0 6px 20px rgba(26, 34, 51, 0.14), 0 1px 2px rgba(26, 34, 51, 0.08);
  transition: transform 0.16s ease, box-shadow 0.16s ease, background 0.16s ease;
}
.runs-fab:hover {
  transform: translateY(-2px);
  box-shadow: 0 10px 26px rgba(26, 34, 51, 0.18);
}
.runs-fab.live {
  background: var(--accent);
  border-color: transparent;
  color: var(--accent-fg);
}
.fab-txt {
  position: relative;
  z-index: 1;
}

/* 在跑的时候外面套一圈呼吸光，扫一眼就知道"还有活没干完" */
.fab-ring {
  position: absolute;
  inset: -5px;
  border-radius: 50%;
  border: 2px solid var(--accent);
  opacity: 0.5;
  animation: fabPulse 1.8s ease-out infinite;
  pointer-events: none;
}
@keyframes fabPulse {
  0% {
    transform: scale(0.92);
    opacity: 0.55;
  }
  70% {
    transform: scale(1.16);
    opacity: 0;
  }
  100% {
    opacity: 0;
  }
}

.fab-badge {
  position: absolute;
  top: -4px;
  right: -4px;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: var(--danger);
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  display: grid;
  place-items: center;
  box-shadow: 0 0 0 2px var(--bg-elevated);
}
.fab-badge.dot {
  background: var(--warn);
}

/* ---------------------------------------------------------------- 面板 */

.runs-panel {
  width: 384px;
  max-height: 64vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: 0 18px 48px rgba(26, 34, 51, 0.18), 0 2px 6px rgba(26, 34, 51, 0.06);
  overflow: hidden;
}

.runs-pop-enter-active,
.runs-pop-leave-active {
  transition: opacity 0.16s ease, transform 0.16s ease;
}
.runs-pop-enter-from,
.runs-pop-leave-to {
  opacity: 0;
  transform: translateY(8px) scale(0.98);
}

.runs-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 12px 10px 14px;
  border-bottom: 1px solid var(--hairline);
  background: var(--bg-hover);
}
.runs-title {
  font: 600 13px/1 inherit;
  color: var(--text);
}
.runs-sub {
  font-size: 11.5px;
  color: var(--text-subtle);
  flex: 1;
}
.runs-clear {
  border: none;
  background: none;
  color: var(--text-subtle);
  font-size: 11.5px;
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 5px;
}
.runs-clear:hover {
  background: var(--bg-inset);
  color: var(--text);
}
.runs-x {
  border: none;
  background: none;
  color: var(--text-faint);
  font-size: 17px;
  line-height: 1;
  width: 22px;
  height: 22px;
  border-radius: 6px;
  cursor: pointer;
}
.runs-x:hover {
  background: var(--bg-inset);
  color: var(--text);
}

.runs-empty {
  padding: 26px 20px 30px;
  text-align: center;
  font-size: 12.5px;
  line-height: 1.9;
  color: var(--text-faint);
}

.runs-list {
  list-style: none;
  margin: 0;
  padding: 6px;
  overflow-y: auto;
}

.run-item {
  border-radius: 10px;
  margin-bottom: 2px;
}
.run-item.exp {
  background: var(--bg-hover);
  box-shadow: inset 0 0 0 1px var(--hairline);
}

.run-head {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 9px;
  border: none;
  background: none;
  cursor: pointer;
  text-align: left;
  border-radius: 10px;
  font: inherit;
}
.run-head:hover {
  background: var(--bg-inset);
}
.run-item.exp .run-head:hover {
  background: none;
}

.run-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: none;
  background: var(--text-faint);
}
.ph-preparing {
  background: var(--warn);
  animation: dotBlink 1.2s ease-in-out infinite;
}
.ph-running {
  background: var(--accent);
  animation: dotBlink 1.2s ease-in-out infinite;
}
.ph-done {
  background: var(--ok);
}
.ph-error {
  background: var(--danger);
}
@keyframes dotBlink {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.28;
  }
}

.run-name {
  font: 500 12.5px/1.3 inherit;
  color: var(--text);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.run-meta {
  font-size: 11px;
  color: var(--text-subtle);
  flex: none;
  font-variant-numeric: tabular-nums;
}
.run-new {
  flex: none;
  font-size: 10px;
  font-weight: 700;
  color: #fff;
  background: var(--danger);
  border-radius: 4px;
  padding: 1px 4px;
}

/* ---------------------------------------------------------------- 详情 */

.run-detail {
  padding: 2px 10px 10px;
}

.run-dir {
  font-size: 10.5px;
  color: var(--text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-bottom: 6px;
}

.run-text {
  margin: 0 0 8px;
  padding: 9px 10px;
  max-height: 200px;
  overflow-y: auto;
  background: var(--bg-inset);
  border-radius: 8px;
  font: 400 11.5px/1.7 inherit;
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-word;
}

.run-wait {
  font-size: 11.5px;
  color: var(--text-faint);
  padding: 8px 2px;
}

.run-err {
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--danger);
  background: rgba(220, 83, 70, 0.08);
  border-radius: 8px;
  padding: 8px 10px;
  margin-bottom: 8px;
  white-space: pre-wrap;
}

.run-outs {
  margin-bottom: 8px;
}
.run-outs-t {
  font-size: 11px;
  color: var(--text-subtle);
  margin-bottom: 4px;
}
.run-out {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 3px 8px;
  border-radius: 6px;
  background: var(--bg-elevated);
  box-shadow: inset 0 0 0 1px var(--hairline);
  margin-bottom: 3px;
}
.of-name {
  font-size: 11.5px;
  color: var(--text);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.of-size {
  font-size: 10.5px;
  color: var(--text-faint);
  flex: none;
}

.run-log summary {
  font-size: 11px;
  color: var(--text-subtle);
  cursor: pointer;
  padding: 2px 0;
  user-select: none;
}
.log-line {
  font: 400 10.5px/1.6 ui-monospace, Consolas, monospace;
  color: var(--text-subtle);
  white-space: pre-wrap;
  word-break: break-all;
  padding: 1px 0;
}

.run-acts {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 9px;
}
.btn {
  height: 26px;
  padding: 0 10px;
  border-radius: 7px;
  border: 1px solid var(--border-strong);
  background: var(--bg-elevated);
  color: var(--text);
  font-size: 11.5px;
  cursor: pointer;
  transition: background 0.14s ease, border-color 0.14s ease;
}
.btn:hover {
  background: var(--bg-inset);
}
.btn.ghost {
  border-color: transparent;
  color: var(--text-subtle);
  background: none;
}
.btn.ghost:hover {
  background: var(--bg-inset);
  color: var(--text);
}
.btn.danger {
  border-color: transparent;
  background: rgba(220, 83, 70, 0.1);
  color: var(--danger);
}
.btn.danger:hover {
  background: rgba(220, 83, 70, 0.18);
}
</style>
