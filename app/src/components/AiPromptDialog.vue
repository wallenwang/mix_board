<script setup lang="ts">
/**
 * 给 AI 的指令：预览 + 一键复制。
 *
 * 放在 App 里只挂一次，白板任务卡和看板卡片都调 openPrompt(store, taskId) 打开它
 * —— 两边生成的是同一份内容，不会出现"白板里写的和看板里写的不一样"。
 */
import { ElMessage } from "element-plus";
import { aiPromptOpen, aiPromptText, aiPromptTitle, copyText } from "../aiPrompt";

async function doCopy() {
  const ok = await copyText(aiPromptText.value);
  if (ok) {
    ElMessage.success("已复制，直接粘到对话框里");
    aiPromptOpen.value = false;
  } else {
    ElMessage.warning("复制没成功，请在上面框里手动全选复制");
  }
}

/** 重新生成一次：内容都是实时读库的，改了任务或资料等级再点这里就会更新 */
function refreshHint() {
  ElMessage.info("这段是打开时生成的。改了任务或资料等级，关掉重开就是新的");
}
</script>

<template>
  <el-dialog v-model="aiPromptOpen" :title="aiPromptTitle" width="720px" append-to-body>
    <div class="ai-tip">
      把下面这段直接粘给 AI，然后把清单里列的文件一并拖过去（它读不到你硬盘上的文件）。
      材料按「必须遵守 / 可以参考 / 仅作背景」分好了，产出物和上下游也是从白板上读的。
    </div>
    <textarea class="ai-text" readonly :value="aiPromptText"></textarea>
    <div class="ai-foot">
      <span>内容来自这个任务本身：说明、材料等级、重点、上下游、产出物。文件要另外拖给 AI。</span>
      <button class="ai-link" @click="refreshHint">为什么不是固定的？</button>
    </div>
    <template #footer>
      <el-button @click="aiPromptOpen = false">关闭</el-button>
      <el-button type="primary" @click="doCopy">复制这段</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.ai-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-faint);
}
.ai-link {
  flex: none;
  padding: 0;
  border: none;
  background: none;
  color: var(--accent);
  font-size: 12px;
  cursor: pointer;
}
.ai-link:hover {
  text-decoration: underline;
}
</style>
