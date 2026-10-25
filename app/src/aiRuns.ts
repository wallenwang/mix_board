/**
 * AI 运行池：**一个任务一个 run**，可以同时跑好几个，关掉窗口也不停。
 *
 * 背景（为什么要单独抽这一层）：
 *  · 早先 aiAgent.ts 里是一整套全局单例（aiPhase / aiText / aiLog…），
 *    点第二个任务的「AI」时先 resetRun() —— 第一个任务的进度就被抹掉了；
 *    而 Rust 那边其实一直是按 run_id 分开跑的，进程根本没停，只是前端"忘了"。
 *  · 现在把状态搬到以「项目:任务」为键的池子里，谁跑谁的，互不干扰。
 *    弹窗只是这个池子的一个**视图**，关掉它不影响任何 run。
 *
 * 两条通道读到的东西是同一份：事件（快）+ 轮询（一定到）。
 * 事件只订阅一次、按 run_id 分发；轮询也只有一个定时器，只看还在跑的。
 */
import { computed, reactive, ref } from "vue";
import { ElNotification } from "element-plus";
import { listen } from "@tauri-apps/api/event";
import { api, isTauri } from "./api";
import type { AiOutput } from "./types";

export type AiRunPhase = "preparing" | "running" | "done" | "error";

export interface AiRun {
  /** `${项目id}:${任务id}` —— 池子里的键，也是"同一个任务的对话"的唯一标识 */
  key: string;
  pid: number;
  taskId: number | null;
  /** 显示名，一般是 T1.1.1 那种任务号 + 标题 */
  title: string;
  /** Rust 侧的 run_id */
  runId: string;
  phase: AiRunPhase;
  text: string;
  log: string[];
  outputs: AiOutput[];
  workDir: string;
  error: string;
  /** 完成时间（"10-25 20:41"）；还在跑的时候是空 */
  at: string;
  startedAt: number;
  endedAt: number;
  /** 跑完了但用户还没打开看过：小按钮上冒红点、列表里标「新」 */
  unread: boolean;
  /** 从 localStorage 快照恢复出来的历史轮次（不是这一会儿真跑的） */
  restored?: boolean;
}

export function runKey(pid: number, taskId: number | null): string {
  return `${pid}:${taskId ?? 0}`;
}

export function stamp(at: number = Date.now()): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 把 agent 的原始报错翻译成「下一步该点哪里」 */
export function humanize(raw: string): string {
  const t = (raw || "").trim();
  if (/free usage limit|usage limit reached/i.test(t)) {
    return (
      "这个模型的免费额度用完了（opencode 自带的免费模型有次数上限）。\n" +
      "两种解法：① 在「模型」下拉里选一个自己配了 key 的模型；" +
      "② 去 opencode 桌面版里 Connect provider 或订阅 Go 套餐。\n" +
      "原始报错：" + t
    );
  }
  if (/no api key|invalid api key|unauthorized|401/i.test(t)) {
    return "这个模型没有可用的 key：先在 opencode 桌面版里连上 provider，再换模型。\n原始报错：" + t;
  }
  return t;
}

// ------------------------------------------------------------ 池子

export const runs = reactive<Record<string, AiRun>>({});

/** 正在看哪个 run（弹窗打开的任务 / 面板展开的那条）—— 只有它不弹完成通知 */
export const viewing = ref<string>("");

export const runList = computed(() =>
  Object.values(runs).sort((a, b) => b.startedAt - a.startedAt)
);

export function isBusy(r: AiRun | null | undefined): boolean {
  return !!r && (r.phase === "preparing" || r.phase === "running");
}

export const busyRuns = computed(() => runList.value.filter((r) => isBusy(r)));
export const liveCount = computed(() => busyRuns.value.length);
export const unreadCount = computed(() => runList.value.filter((r) => r.unread).length);
export const hasAny = computed(() => runList.value.length > 0);

export function runOf(pid: number | null, taskId: number | null): AiRun | null {
  if (pid == null) return null;
  return runs[runKey(pid, taskId)] ?? null;
}

/** 拿一个 run；没有就建一个空的（同一个任务反复调用拿到的是同一个对象） */
export function ensureRun(pid: number, taskId: number | null, title: string): AiRun {
  const key = runKey(pid, taskId);
  let r = runs[key];
  if (!r) {
    // 先建成普通对象塞进 reactive 容器：容器会把它代理掉，
    // 之后对 r.text 的追加才会触发重渲染
    const item: AiRun = {
      key,
      pid,
      taskId,
      title,
      runId: "",
      phase: "preparing",
      text: "",
      log: [],
      outputs: [],
      workDir: "",
      error: "",
      at: "",
      startedAt: Date.now(),
      endedAt: 0,
      unread: false,
    };
    runs[key] = item;
    r = runs[key];
  } else if (title) {
    r.title = title;
  }
  return r;
}

/** 丢掉一个任务的 run（只用于"重新开始"，正在跑的要先 cancel） */
export function forgetRun(pid: number | null, taskId: number | null) {
  if (pid == null) return;
  const key = runKey(pid, taskId);
  if (runs[key] && !isBusy(runs[key])) delete runs[key];
}

/** 清掉所有已完成的（在跑的留着） */
export function forgetFinished(): number {
  let n = 0;
  for (const k of Object.keys(runs)) {
    if (!isBusy(runs[k])) {
      delete runs[k];
      n++;
    }
  }
  return n;
}

export function pushRunLog(r: AiRun, s: string) {
  const line = s.trim();
  if (!line) return;
  r.log.push(line.length > 160 ? line.slice(0, 160) + "…" : line);
  if (r.log.length > 200) r.log.splice(0, r.log.length - 200);
}

/** 收工：改状态 + 标"没看过" + 不在看的时候弹一条右下角提醒 */
export function finishRun(r: AiRun, phase: "done" | "error", err = "") {
  if (r.phase === "done" || r.phase === "error") return;
  r.phase = phase;
  r.endedAt = Date.now();
  r.at = stamp(r.endedAt);
  if (err) r.error = humanize(err);
  // 只在"没人看着"的时候标成未读；看过了由面板/弹窗自己清掉
  r.unread = viewing.value !== r.key;
}

/**
 * 右下角提示。**由收尾流程在扫完产物之后调用**，不要塞进 finishRun ——
 * 那一刻 out/ 还没扫，通知里会永远显示"没有产物"。
 */
export function notifyDone(r: AiRun) {
  if (viewing.value === r.key) return;
  const mins = Math.max(1, Math.round((r.endedAt - r.startedAt) / 60000));
  ElNotification({
    title: r.phase === "error" ? `AI 任务出错 · ${r.title}` : `AI 任务完成 · ${r.title}`,
    message:
      r.phase === "error"
        ? r.error.split("\n")[0].slice(0, 90)
        : `${r.outputs.length ? `收回 ${r.outputs.length} 份产物` : "没有产物，看看回复"} · 用了约 ${mins} 分钟`,
    type: r.phase === "error" ? "error" : "success",
    duration: 5000,
    position: "bottom-right",
  });
}

// ------------------------------------------------------------ 事件桥（只订阅一次）

let bridged = false;

export async function ensureBridge(): Promise<boolean> {
  if (!isTauri) return false;
  if (bridged) return true;
  bridged = true;
  try {
    await listen<{ run_id: string; kind: string; text: string }>("ai-event", (ev) => {
      const p = ev.payload;
      const r = findByRunId(p.run_id);
      if (!r) return;
      applyEvent(r, p.kind, p.text);
    });
    return true;
  } catch {
    // 订阅不上就完全靠轮询：慢一点，但一样能读到结果
    bridged = false;
    return false;
  }
}

function findByRunId(runId: string): AiRun | null {
  if (!runId) return null;
  for (const k of Object.keys(runs)) {
    if (runs[k].runId === runId) return runs[k];
  }
  return null;
}

function applyEvent(r: AiRun, kind: string, text: string) {
  if (kind === "chunk") {
    r.text += text;
  } else if (kind === "log") {
    pushRunLog(r, text);
  } else if (kind === "done") {
    if (text.trim()) r.text = text;
    finishRun(r, "done");
  } else if (kind === "error") {
    finishRun(r, "error", text);
  }
}

// ------------------------------------------------------------ 轮询兜底（一个定时器管所有）

let ticker: number | null = null;

export function startTicker() {
  if (ticker != null) return;
  ticker = window.setInterval(() => void tick(), 1500);
}

async function tick() {
  const list = busyRuns.value.filter((r) => r.runId);
  for (const r of list) {
    try {
      const st = await api.aiStatus(r.runId);
      // 事件通道可能已经把更新的字推过来了，别用稍旧的快照盖回去（会闪、会回退）
      if (st.text && st.text.length > r.text.length) r.text = st.text;
      if (st.phase === "done") finishRun(r, "done");
      else if (st.phase === "error") finishRun(r, "error", st.error || "AI 那边出错了");
    } catch {
      /* 单次查询失败不算错，下一轮再试 */
    }
  }
}
