<script setup lang="ts">
/**
 * 给 AI 的指令：预览 + 交付格式 + 复制 / 直接发送。
 *
 * 放在 App 里只挂一次，白板任务卡和看板卡片都调 openPrompt(store, taskId) 打开它
 * —— 两边生成的是同一份内容，不会出现"白板里写的和看板里写的不一样"。
 *
 * 弹窗可拖动：生成指令时往往还要对照白板上节点的分布，挡住就看不到了。
 *
 * 「发送到 AI」不是把一大段文字塞进命令行：先把指令写成工作目录里的 brief.md、
 * 参考材料拷进 refs/，再通过 ACP 交给本机装的 agent CLI（OpenCode / DeepSeek
 * Harness / Trae CLI 等）；产物从 out/ 回收，最后在白板上打成一个组。
 */
import { computed, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { api } from "../api";
import {
  aiPromptOpen,
  aiPromptText,
  aiPromptTitle,
  aiPromptTaskId,
  DELIVER_OPTIONS,
  buildTaskPrompt,
  copyText,
  loadPersona,
  projectPersona,
  savePersona,
} from "../aiPrompt";
import {
  AI_OUT_MIME,
  aiBackends,
  aiError,
  aiLastAt,
  aiLog,
  aiModels,
  aiOutputs,
  aiPhase,
  aiText,
  aiWorkDir,
  cancelRun,
  detectBackends,
  loadModels,
  openRunFor,
  placeOutputsOnBoard,
  resetRun,
  saveBackend,
  saveModel,
  savedBackendExe,
  savedModel,
  sendToAi,
} from "../aiAgent";
import { useBoardStore } from "../store";
import { viewing } from "../aiRuns";

const store = useBoardStore();
const savingFmt = ref(false);
const model = ref(savedModel());
const backendExe = ref(savedBackendExe());
const placing = ref(false);
const streamBox = ref<HTMLTextAreaElement | null>(null);

const currentFmt = computed(() => {
  const t = store.allTasks.find((x) => x.id === aiPromptTaskId.value);
  return (t?.deliver_fmt || "").toLowerCase();
});

/* ---- 角色卡：项目级，填一次所有任务通用 ---- */
const personaOpen = ref(false);
const personaDraft = ref("");

function refreshPrompt() {
  const id = aiPromptTaskId.value;
  if (id != null) aiPromptText.value = buildTaskPrompt(store, id);
}

function togglePersona() {
  personaOpen.value = !personaOpen.value;
  if (personaOpen.value) personaDraft.value = projectPersona.value;
}

async function savePersonaNow() {
  await savePersona(store.currentProjectId ?? null, personaDraft.value.trim());
  refreshPrompt();
  ElMessage.success("角色卡已保存，这个项目里所有任务的指令都会带上它");
}

/** 分组框的署名：任务编号 + 标题，事后一眼认得出是哪次产出 */
const taskLabel = computed(() => {
  const id = aiPromptTaskId.value;
  if (id == null) return "未指定任务";
  const t = store.allTasks.find((x) => x.id === id);
  if (!t) return "未指定任务";
  return `T${store.numberOf(id)} ${t.title}`;
});

/** 模型下拉：付费（配了 key）的排前面，免费额度的单独一组 —— 免费的有次数上限 */
const paidModels = computed(() => aiModels.value.filter((m) => !m.free));
const freeModels = computed(() => aiModels.value.filter((m) => m.free));

const running = computed(() => aiPhase.value === "preparing" || aiPhase.value === "running");
const statusText = computed(() => {
  switch (aiPhase.value) {
    case "preparing":
      return "正在准备工作目录（写指令、拷材料）…";
    case "running":
      return "AI 正在处理，可以先把它放在一边";
    case "done":
      return aiLastAt.value ? `上次跑于 ${aiLastAt.value}，产物在下面` : "跑完了";
    case "error":
      return `出问题了：${aiError.value}`;
    default:
      return "";
  }
});

watch(aiPromptOpen, (v) => {
  if (!v) {
    // 关窗≠停任务：只是不再"看着"它，AI 还在后台跑；
    // 下次点同一个任务的 AI 按钮会原样接回来（见 openRunFor 的注释）
    viewing.value = "";
    return;
  }
  // 池里已经跑过/正在跑就接着看，没有才去找上一轮快照
  void openRunFor(aiPromptTaskId.value);
  // 角色卡读完再刷一遍指令，不然第一次打开会少了「你的角色」那两段
  void loadPersona(store.currentProjectId ?? null).then(() => {
    personaDraft.value = projectPersona.value;
    refreshPrompt();
  });
  void detectBackends().then(() => {
    if (!backendExe.value && aiBackends.value.length) {
      backendExe.value = aiBackends.value[0].exe;
    }
    void loadModels().catch(() => {});
  });
});

// 换后端就重新问一遍它能用哪些模型（不同家的模型 id 完全不通用）
watch(backendExe, (v) => {
  if (!v || !aiPromptOpen.value) return;
  saveBackend(v);
  void loadModels().catch(() => {});
});

watch(aiText, () => {
  const el = streamBox.value;
  if (el) el.scrollTop = el.scrollHeight;
});

async function pickFmt(key: string) {
  const id = aiPromptTaskId.value;
  if (id == null) return;
  // 再点一次已选中的 = 取消指定
  const next = currentFmt.value === key ? "" : key;
  savingFmt.value = true;
  try {
    await store.setDeliverFmt(id, next);
    // 重新生成：输出要求那一段会跟着格式变
    aiPromptText.value = buildTaskPrompt(store, id);
  } finally {
    savingFmt.value = false;
  }
}

async function doCopy() {
  const ok = await copyText(aiPromptText.value);
  if (ok) {
    ElMessage.success("已复制。粘到对话框后，把清单里的文件一并拖过去");
    aiPromptOpen.value = false;
  } else {
    ElMessage.warning("复制未成功，请在上方文本框中手动全选复制");
  }
}

async function doSend() {
  const id = aiPromptTaskId.value;
  if (id == null) return;
  if (!aiBackends.value.length) {
    ElMessage.warning("没检测到可用的 AI 命令行。先装 OpenCode 桌面版（自带 CLI）再试。");
    return;
  }
  saveModel(model.value.trim());
  saveBackend(backendExe.value);
  const r = await sendToAi(aiPromptText.value, taskLabel.value, id);
  if (!r.ok) {
    ElMessage.warning(r.error || "发送失败");
    return;
  }
  // 已经发出去了，不等它跑完：可以立刻关窗去发别的任务
  ElMessage.success("已发给 AI。现在可以关掉这个窗口去发别的任务，右下角「AI」里能看到全部进度。");
}

async function doPlace() {
  placing.value = true;
  try {
    const n = await placeOutputsOnBoard(taskLabel.value, aiPromptTaskId.value);
    if (n > 0) {
      ElMessage.success(`已把 ${n} 份产物打成一个组放到白板`);
      aiPromptOpen.value = false;
    } else {
      ElMessage.warning(aiError.value || "没有可放的产物");
    }
  } finally {
    placing.value = false;
  }
}

function openWorkDir() {
  if (!aiWorkDir.value) return;
  void api.aiOpenDir(aiWorkDir.value).catch(() => {});
}

/** 按住产物拖到白板：只传「目录 + 文件名」，不把文件内容塞进拖拽数据 */
function dragOut(e: DragEvent, name: string) {
  const dt = e.dataTransfer;
  if (!dt || !aiWorkDir.value) return;
  dt.effectAllowed = "copy";
  dt.setData(AI_OUT_MIME, JSON.stringify({ workDir: aiWorkDir.value, name }));
  dt.setData("text/plain", name);
}

function fmtSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
</script>

<template>
  <el-dialog
    v-model="aiPromptOpen"
    :title="aiPromptTitle"
    width="680px"
    append-to-body
    draggable
    overflow
    :modal="false"
    :close-on-click-modal="false"
    :close-on-press-escape="false"
    :lock-scroll="false"
    class="ai-dialog"
  >
    <div class="ai-tip">
      下方就是发给 AI 的完整指令。可以复制走自己粘贴，也可以直接点「发送到 AI」，
      让本机装的 AI 命令行在后台跑完。
    </div>

    <!-- 角色卡：项目级，写一次所有任务通用。默认收起，不占地方 -->
    <div class="ai-persona">
      <button class="ai-persona-toggle" type="button" @click="togglePersona">
        <span class="ai-persona-dot" :class="{ on: projectPersona.trim() }"></span>
        角色卡
        <span class="ai-persona-state">{{
          projectPersona.trim() ? "已填写，本项目所有指令都带着它" : "未填写 —— 写两句，AI 的专业口径会稳很多"
        }}</span>
        <span class="ai-persona-caret" :class="{ open: personaOpen }">▾</span>
      </button>
      <div v-if="personaOpen" class="ai-persona-body">
        <textarea
          v-model="personaDraft"
          class="ai-persona-text"
          rows="3"
          placeholder="例：你是品牌视觉设计总监，服务客户是「山茶间」中式茶饮；产出要能直接进教材当示例，风格克制、不用网络热词，中文标点用全角。"
        ></textarea>
        <div class="ai-persona-foot">
          <span>这个项目里每个任务的指令都会带上一段，不用每个任务重复写</span>
          <button class="ai-persona-save" type="button" @click="savePersonaNow">保存</button>
        </div>
      </div>
    </div>

    <div class="ai-fmt">
      <span class="ai-fmt-label">交付格式</span>
      <button
        v-for="o in DELIVER_OPTIONS"
        :key="o.key"
        class="ai-fmt-btn"
        :class="{ on: currentFmt === o.key }"
        :title="o.desc"
        :disabled="savingFmt"
        @click="pickFmt(o.key)"
      >
        {{ o.label }}
      </button>
      <span class="ai-fmt-hint">
        {{ currentFmt ? "再次点击可取消指定" : "未指定：AI 自行判断产出形态" }}
      </span>
    </div>

    <textarea class="ai-text" readonly :value="aiPromptText"></textarea>

    <div class="ai-backend">
      <span class="ai-fmt-label">AI 后端</span>
      <select v-model="backendExe" class="ai-sel">
        <option v-if="!aiBackends.length" value="">（没检测到，请先安装）</option>
        <option v-for="b in aiBackends" :key="b.exe" :value="b.exe">
          {{ b.name }} · {{ b.version }}
        </option>
      </select>
      <select v-model="model" class="ai-model" title="模型：留空=自动挑一个你配了 key 的">
        <option value="">自动（挑一个你配了 key 的）</option>
        <option v-if="model && !aiModels.some((m) => m.value === model)" :value="model">
          {{ model }}（不在当前列表里）
        </option>
        <optgroup v-if="paidModels.length" label="你配了 key 的模型">
          <option v-for="m in paidModels" :key="m.value" :value="m.value">{{ m.name }}</option>
        </optgroup>
        <optgroup v-if="freeModels.length" label="免费额度（有次数上限）">
          <option v-for="m in freeModels" :key="m.value" :value="m.value">{{ m.name }}</option>
        </optgroup>
      </select>
      <button class="ai-mini" title="重新检测本机装了哪些 AI 命令行" @click="detectBackends()">
        重新检测
      </button>
    </div>

    <div v-if="aiPhase !== 'idle'" class="ai-run">
      <div class="ai-run-head">
        <span class="ai-dot" :class="aiPhase"></span>
        <span class="ai-status">{{ statusText }}</span>
        <button v-if="running" class="ai-mini danger" @click="cancelRun">中止</button>
        <button v-if="aiWorkDir" class="ai-mini" @click="openWorkDir">打开工作目录</button>
      </div>
      <textarea
        ref="streamBox"
        class="ai-stream"
        readonly
        :value="aiText"
        placeholder="AI 的回复会实时出现在这里"
      ></textarea>
      <details v-if="aiLog.length" class="ai-logs">
        <summary>过程日志（{{ aiLog.length }} 行，展开后在这里滚动）</summary>
        <div class="ai-log-box">
          <div v-for="(l, i) in aiLog" :key="i" class="ai-log-line">{{ l }}</div>
        </div>
      </details>

      <div v-if="aiPhase === 'done'" class="ai-outs">
        <div class="ai-outs-head">
          out 目录里收到 {{ aiOutputs.length }} 份产物
          <span class="ai-outs-hint">按住任一份拖到白板，只放你要的那几张</span>
        </div>
        <div v-if="aiOutputs.length" class="ai-outs-list">
          <div
            v-for="o in aiOutputs"
            :key="o.path"
            class="ai-out-item"
            draggable="true"
            title="按住左键拖到白板上，就在落点生成一张资料卡"
            @dragstart="dragOut($event, o.name)"
          >
            <span class="ai-out-grip">⠿</span>
            <span class="ai-out-name">{{ o.name }}</span>
            <span class="ai-out-size">{{ fmtSize(o.size) }}</span>
          </div>
        </div>
        <div v-else class="ai-outs-empty">
          还没有文件。AI 可能只回了文字 —— 可以让它把成果写成文件再跑一次。
        </div>
      </div>
    </div>

    <div class="ai-foot">
      <span>内容取自本任务的任务说明、参考材料、关注重点、任务关系与交付物</span>
    </div>

    <template #footer>
      <el-button @click="aiPromptOpen = false">关闭</el-button>
      <el-button @click="doCopy">复制指令</el-button>
      <el-button
        v-if="aiPhase === 'done' && aiOutputs.length"
        :loading="placing"
        @click="doPlace"
      >
        把产物打成组放到白板
      </el-button>
      <el-button
        type="primary"
        :loading="running"
        :disabled="!aiBackends.length"
        :title="aiBackends.length ? '' : '没检测到 AI 命令行'"
        @click="doSend"
      >
        {{ running ? "处理中…" : "发送到 AI" }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.ai-tip {
  margin-bottom: 10px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-subtle);
}
.ai-fmt {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 10px;
}
.ai-fmt-label {
  flex: none;
  margin-right: 2px;
  font-size: 12px;
  color: var(--text-subtle);
}
.ai-fmt-btn {
  flex: none;
  padding: 4px 12px;
  border: 1px solid var(--hairline-strong);
  border-radius: 5px;
  background: var(--bg);
  color: var(--text-subtle);
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}
.ai-fmt-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.ai-fmt-btn.on {
  border-color: var(--accent);
  background: var(--accent);
  color: #fff;
}
.ai-fmt-hint {
  margin-left: 4px;
  font-size: 11px;
  color: var(--text-faint);
}

/* ---------- 角色卡（项目级，可折叠） ---------- */
.ai-persona {
  margin-bottom: 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-soft);
  overflow: hidden;
}
.ai-persona-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 7px 10px;
  border: 0;
  background: transparent;
  color: var(--text);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.ai-persona-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-faint);
}
.ai-persona-dot.on {
  background: var(--brand-2);
}
.ai-persona-state {
  flex: 1;
  color: var(--text-subtle);
  font-size: 11px;
}
.ai-persona-caret {
  transition: transform 0.16s var(--ease);
}
.ai-persona-caret.open {
  transform: rotate(180deg);
}
.ai-persona-body {
  padding: 0 10px 9px;
}
.ai-persona-text {
  box-sizing: border-box;
  width: 100%;
  padding: 8px 9px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  color: var(--text);
  font-family: inherit;
  font-size: 12px;
  line-height: 1.7;
  resize: vertical;
}
.ai-persona-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 6px;
  color: var(--text-faint);
  font-size: 11px;
}
.ai-persona-save {
  flex: none;
  padding: 3px 12px;
  border: 1px solid var(--accent);
  border-radius: 999px;
  background: var(--accent);
  color: var(--accent-fg);
  font-size: 11px;
  cursor: pointer;
}
.ai-persona-save:hover {
  background: var(--accent-hover);
}

.ai-backend {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 8px 0 4px;
}
.ai-sel {
  flex: none;
  max-width: 240px;
  padding: 4px 8px;
  border: 1px solid var(--hairline-strong);
  border-radius: 5px;
  background: var(--bg);
  color: var(--text);
  font-size: 12px;
}
.ai-model {
  flex: 1;
  min-width: 120px;
  padding: 4px 8px;
  border: 1px solid var(--hairline-strong);
  border-radius: 5px;
  background: var(--bg);
  color: var(--text);
  font-size: 12px;
}
.ai-mini {
  flex: none;
  padding: 4px 10px;
  border: 1px solid var(--hairline-strong);
  border-radius: 5px;
  background: var(--bg);
  color: var(--text-subtle);
  font-size: 12px;
  cursor: pointer;
}
.ai-mini:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.ai-mini.danger:hover {
  border-color: #d84338;
  color: #d84338;
}

.ai-run {
  margin-top: 10px;
  padding: 10px;
  border: 1px solid var(--hairline);
  border-radius: 8px;
}
.ai-run-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 12px;
  color: var(--text-subtle);
}
.ai-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #b6bdc9;
}
.ai-dot.running,
.ai-dot.preparing {
  background: #e0842b;
}
.ai-dot.done {
  background: #2f9e6a;
}
.ai-dot.error {
  background: #d84338;
}
.ai-status {
  flex: 1;
  min-width: 0;
}
.ai-stream {
  display: block;
  width: 100%;
  height: 132px;
  padding: 8px;
  border: 1px solid var(--hairline);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text);
  font-family: inherit;
  font-size: 12px;
  line-height: 1.7;
  resize: vertical;
}
.ai-logs {
  margin-top: 6px;
  font-size: 11px;
  color: var(--text-faint);
}
.ai-logs summary {
  cursor: pointer;
}
/* 日志一多就顶到页面最下面 —— 限高，自己在里面滚 */
.ai-log-box {
  max-height: 132px;
  overflow: auto;
  margin-top: 4px;
  padding: 4px 6px;
  border: 1px solid var(--hairline);
  border-radius: 6px;
  background: var(--bg);
}
.ai-log-box::-webkit-scrollbar {
  width: 8px;
}
.ai-log-box::-webkit-scrollbar-thumb {
  background: var(--hairline-strong);
  border-radius: 4px;
}
.ai-log-line {
  padding: 1px 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ai-outs {
  margin-top: 8px;
}
.ai-outs-head {
  margin-bottom: 6px;
  font-size: 12px;
  color: var(--text-subtle);
}
.ai-outs-list {
  max-height: 96px;
  overflow: auto;
}
.ai-out-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 3px 4px;
  border-radius: 4px;
  font-size: 12px;
  color: var(--text);
  cursor: grab;
}
.ai-out-item:hover {
  background: var(--bg-soft, rgba(0, 0, 0, 0.04));
}
.ai-out-item:active {
  cursor: grabbing;
}
.ai-out-grip {
  flex: none;
  color: var(--text-faint);
  letter-spacing: -2px;
}
.ai-outs-hint {
  margin-left: 8px;
  font-size: 11px;
  color: var(--text-faint);
}
.ai-out-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ai-out-size {
  flex: none;
  color: var(--text-faint);
}
.ai-outs-empty {
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-faint);
}

.ai-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-faint);
}
</style>
