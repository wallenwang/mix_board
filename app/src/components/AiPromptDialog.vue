<script setup lang="ts">
/**
 * 给 AI 的指令：预览 + 交付格式 + 一键复制。
 *
 * 放在 App 里只挂一次，白板任务卡和看板卡片都调 openPrompt(store, taskId) 打开它
 * —— 两边生成的是同一份内容，不会出现"白板里写的和看板里写的不一样"。
 *
 * 弹窗可拖动：生成指令时往往还要对照白板上节点的分布，挡住就看不到了。
 */
import { computed, ref } from "vue";
import { ElMessage } from "element-plus";
import {
  aiPromptOpen,
  aiPromptText,
  aiPromptTitle,
  aiPromptTaskId,
  DELIVER_OPTIONS,
  buildTaskPrompt,
  copyText,
} from "../aiPrompt";
import { useBoardStore } from "../store";

const store = useBoardStore();
const savingFmt = ref(false);

const currentFmt = computed(() => {
  const t = store.allTasks.find((x) => x.id === aiPromptTaskId.value);
  return (t?.deliver_fmt || "").toLowerCase();
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
</script>

<template>
  <el-dialog
    v-model="aiPromptOpen"
    :title="aiPromptTitle"
    width="760px"
    append-to-body
    draggable
    overflow
  >
    <div class="ai-tip">
      将下列指令粘贴给 AI，同时把「参考材料」中列出的文件一并提交。
      材料按约束层级分组，交付格式在下方选定。
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

    <div class="ai-foot">
      <span>内容取自本任务的任务说明、参考材料、关注重点、任务关系与交付物</span>
    </div>

    <template #footer>
      <el-button @click="aiPromptOpen = false">关闭</el-button>
      <el-button type="primary" @click="doCopy">复制指令</el-button>
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
