/**
 * 「发送到 AI」的全过程：准备工作目录 → 交给本地 agent CLI → 收产物 → 打组放到白板。
 *
 * 传送方式说明（这也是为什么不再让用户复制粘贴）：
 *  · 先把指令写成 <项目>/AI产出/<任务>/brief.md，参考材料拷进 refs/；
 *  · 命令行上只出现「路径」，中文正文一个字都不经过 shell；
 *  · 通过 ACP（stdin/stdout 的 nd-JSON，规范强制 UTF-8）把指令发出去；
 *  · AI 把产物写进 out/，我们扫目录回收 —— 比从 stdout 里抠 Markdown 稳得多。
 *
 * ⚠️ 状态**不再住在这里**：全部搬进 aiRuns.ts 的运行池，一个任务一个 run。
 *    这个文件里的 aiPhase / aiText / … 只是「当前弹窗里那个任务」的**只读视图**，
 *    关掉弹窗不影响 run，发下一个任务也不会清空上一个。
 *
 * ⚠️ 进度用**两条路**读：正常走 ai-event 事件；订阅失败（core:event 权限没给到）
 *    自动退化成轮询 ai_status。早先只依赖事件，一旦权限缺失就是「点了发送、
 *    界面一直转圈」，还看不出原因。
 */
import { computed, shallowRef } from "vue";
import { ElMessage } from "element-plus";
import { api, isTauri } from "./api";
import type { AiBackend, AiImported, AiModel, AiOutput } from "./types";
import { useBoardStore } from "./store";
import { focusOnBoard } from "./uiBus";
import { aiPromptTaskId } from "./aiPrompt";
import {
  ensureBridge,
  ensureRun,
  finishRun,
  forgetRun,
  isBusy,
  notifyDone,
  pushRunLog,
  runOf,
  stamp,
  startTicker,
  viewing,
  type AiRun,
} from "./aiRuns";

const LS_BACKEND = "ai.backend";
const LS_MODEL = "ai.model";
/** 上一轮跑完的结果，按「项目:任务」各存一份 */
const LS_RUN = "ai.lastRun";
/** 产物列表拖到白板用的自定义 MIME（白板那边认这个类型） */
export const AI_OUT_MIME = "application/x-ai-output";

/** 探测到的 agent 命令行 */
export const aiBackends = shallowRef<AiBackend[]>([]);

/** 当前后端能选的模型（来自 agent 会话的 configOptions） */
export const aiModels = shallowRef<AiModel[]>([]);

// ------------------------------------------------------------ 当前弹窗任务的可读视图

/** 弹窗正在看哪个任务 */
export const currentRun = computed<AiRun | null>(() => {
  const pid = useBoardStore().currentProjectId;
  return runOf(pid, aiPromptTaskId.value);
});

/**
 * idle 空闲 / preparing 准备目录 / running 跑着 / done 完成 / error 出错
 * 只反映「当前看的这个任务」，别的任务跑它的，互不影响。
 */
export const aiPhase = computed<"idle" | "preparing" | "running" | "done" | "error">(
  () => currentRun.value?.phase ?? "idle"
);
export const aiText = computed(() => currentRun.value?.text ?? "");
export const aiLog = computed(() => currentRun.value?.log ?? []);
export const aiOutputs = computed(() => currentRun.value?.outputs ?? []);
export const aiWorkDir = computed(() => currentRun.value?.workDir ?? "");
export const aiError = computed(() => currentRun.value?.error ?? "");
/** 恢复出来的是哪一轮的结果（"10-25 00:12"），空=这一轮是刚跑的 */
export const aiLastAt = computed(() => currentRun.value?.at ?? "");

/** 同时写一份到 diag.log：用户说"点了没反应"时，一行就能看出断在哪一步 */
function dlog(m: string) {
  const r = currentRun.value;
  if (r) pushRunLog(r, `· ${m}`);
  api.diagLog?.(`AI ${m}`).catch(() => {});
}

/** 清理当前任务的运行记录（只清不跑的；正在跑的必须先中止） */
export function resetRun() {
  const store = useBoardStore();
  forgetRun(store.currentProjectId, aiPromptTaskId.value);
}

// ------------------------------------------------------------ 上一轮结果快照

/** 一次跑完的结果快照 */
interface RunSnap {
  workDir: string;
  at: string;
  model: string;
  text: string;
  outputs: AiOutput[];
}

function readSnaps(): Record<string, RunSnap> {
  try {
    return JSON.parse(localStorage.getItem(LS_RUN) || "{}") as Record<string, RunSnap>;
  } catch {
    return {};
  }
}

/** 某个任务上一次跑完的快照（没有就 null） */
export function lastRunOf(pid: number, taskId: number | null): RunSnap | null {
  const s = readSnaps()[`${pid}:${taskId ?? 0}`];
  return s && s.workDir ? s : null;
}

function rememberRun(run: AiRun) {
  if (!run.workDir) return;
  const all = readSnaps();
  all[run.key] = {
    workDir: run.workDir,
    at: run.at || stamp(),
    model: savedModel(),
    text: run.text.slice(0, 4000),
    outputs: run.outputs,
  };
  // 只留最近 30 条，别把 localStorage 撑爆
  const keys = Object.keys(all);
  if (keys.length > 30) keys.slice(0, keys.length - 30).forEach((k) => delete all[k]);
  try {
    localStorage.setItem(LS_RUN, JSON.stringify(all));
  } catch {
    /* 存不下不影响当前这一轮 */
  }
}

/**
 * 打开弹窗时调用。
 *
 * 三种情况，顺序很重要：
 *  ① 池里已经有这个任务的 run（在跑 / 刚跑完）→ **原样接着看**，一个字都不清；
 *  ② 池里没有，但有上一轮快照 → 恢复成一条 done 的 run（重扫 workDir，文件没了就如实说）；
 *  ③ 都没有 → 什么都不做，等用户点发送。
 */
export async function openRunFor(taskId: number | null): Promise<void> {
  const pid = useBoardStore().currentProjectId;
  if (pid == null || taskId == null) return;

  const live = runOf(pid, taskId);
  if (live) {
    viewing.value = live.key;
    live.unread = false;
    if (live.workDir && !live.outputs.length) await refreshOutputs(live);
    if (isBusy(live)) dlog("接着看正在跑的这一轮");
    return;
  }

  const snap = lastRunOf(pid, taskId);
  if (!snap) return;
  const title =
    useBoardStore().allTasks.find((t) => t.id === taskId)?.title ?? `任务 ${taskId}`;
  const r = ensureRun(pid, taskId, title);
  r.workDir = snap.workDir;
  r.text = snap.text || "";
  r.outputs = snap.outputs ?? [];
  r.phase = "done";
  r.at = snap.at || "";
  r.restored = true;
  r.startedAt = Date.now() - 1000;
  r.endedAt = Date.now();
  viewing.value = r.key;
  await refreshOutputs(r);
  if (!r.outputs.length) {
    r.error = "上次的工作目录已经不在了（可能被删，或换过数据目录）";
    dlog("恢复上次结果失败：工作目录不在了");
  } else {
    dlog(`已恢复上次结果（${snap.at}）：${r.outputs.length} 份产物`);
  }
}

// ------------------------------------------------------------ 后端探测 / 偏好

/** 探测本机装了哪些 agent CLI */
export async function detectBackends(): Promise<AiBackend[]> {
  try {
    const list = await api.aiDetectBackends();
    aiBackends.value = list ?? [];
    dlog(
      `探测到 ${aiBackends.value.length} 个 CLI：${aiBackends.value.map((b) => b.name).join("、") || "无"}`
    );
  } catch (e) {
    aiBackends.value = [];
    dlog(`探测失败：${String(e)}`);
  }
  return aiBackends.value;
}

export function savedBackendExe(): string {
  return localStorage.getItem(LS_BACKEND) || "";
}
export function saveBackend(exe: string) {
  localStorage.setItem(LS_BACKEND, exe);
}
export function savedModel(): string {
  return localStorage.getItem(LS_MODEL) || "";
}
export function saveModel(m: string) {
  localStorage.setItem(LS_MODEL, m);
}

/**
 * 拉一次模型列表。
 * ⚠️ 只是为了给用户一个正确的下拉；就算拉失败也不影响发送 ——
 *    后端在 session/new 里自己也会拿到同一份列表，会自动挑一个付费模型。
 */
export async function loadModels(): Promise<void> {
  const b = pickBackend();
  // ⚠️ isTauri 是布尔常量（api.ts: export const isTauri = hasTauri），不是函数
  if (!b || !isTauri) {
    aiModels.value = [];
    return;
  }
  try {
    aiModels.value = await api.aiListModels(b.exe, b.args);
  } catch {
    aiModels.value = [];
  }
}

function pickBackend(): AiBackend | null {
  const list = aiBackends.value;
  if (!list.length) return null;
  const saved = savedBackendExe();
  return list.find((b) => b.exe === saved) ?? list[0];
}

/** 在 brief 后面补一段"怎么交活"的说明 —— 写进文件比贴在回复里可靠 */
function withDeliveryRules(brief: string, dir: string): string {
  const back = dir.replace(/\\/g, "/");
  return [
    brief,
    "",
    "---",
    "",
    "## 交付方式（必读）",
    "",
    `本次任务的工作目录是：\`${back}\``,
    "",
    "1. 参考材料在该目录的 `refs/` 下，请自行读取（PDF、图片都能直接看）。",
    "2. **所有产出文件请写入该目录的 `out/` 目录**，不要只把内容贴在回复里。",
    "   例如报告写 `out/报告.md`，配图写 `out/图1.png`，需要就多写几个文件。",
    "3. ⚠️ 写文件**请用你自己的写文件工具**，不要用 shell 重定向（如 `echo ... > 文件`）。",
    "   Windows 命令行对中文会乱码，实测这样写出来的文件是空的或坏的。",
    "4. 目录不存在就自己创建。文件名用中文即可，不要带斜杠等特殊符号。",
    "5. 回复里用几句话说明你产出了什么、有什么取舍。",
  ].join("\n");
}

export interface SendResult {
  ok: boolean;
  error?: string;
}

/**
 * 把这份指令发出去。**发出去就返回**，不等它跑完 ——
 * 所以用户可以连着发好几个任务，也可以立刻关掉窗口去干别的。
 * 跑完会由运行池发一条右下角通知，产物随时能在「AI 任务」面板里看。
 */
export async function sendToAi(
  brief: string,
  title: string,
  taskId: number | null
): Promise<SendResult> {
  const store = useBoardStore();
  const pid = store.currentProjectId;
  if (pid == null) return { ok: false, error: "还没选项目" };

  const backend = pickBackend();
  if (!backend) {
    return {
      ok: false,
      error: "没找到可用的 AI 命令行。先装 OpenCode 桌面版（自带 CLI），或在设置里指定路径。",
    };
  }

  const run = ensureRun(pid, taskId, title);

  // 同一个任务重复发：先把上一轮掐掉，否则两个进程抢同一个 out/ 目录
  if (isBusy(run) && run.runId) {
    await api.aiCancel(run.runId).catch(() => {});
  }

  // 清成新的一轮（只清自己这条，别人的 run 一根头发都不动）
  run.runId = "";
  run.text = "";
  run.log = [];
  run.outputs = [];
  run.error = "";
  run.phase = "preparing";
  run.startedAt = Date.now();
  run.endedAt = 0;
  run.at = "";
  run.unread = false;
  run.restored = false;
  viewing.value = run.key;

  try {
    // 1) 准备工作目录：把指令和参考材料摆好
    pushRunLog(run, `开始：${backend.name} ${backend.version} → ${backend.exe}`);
    const assetIds: number[] = [];
    if (taskId != null) {
      for (const r of store.refsOfTask(taskId)) {
        const n = store.notes.find((x) => x.id === r.note_id);
        if (n?.file_id != null && !assetIds.includes(n.file_id)) assetIds.push(n.file_id);
      }
    }
    const prep = await api.aiPrepare(pid, title, brief, assetIds);
    run.workDir = prep.dir;
    pushRunLog(run, `工作目录就绪：${prep.dir}（参考材料 ${assetIds.length} 份）`);

    // 2) run_id 由前端生成：这样订阅的时候就知道自己是哪个 run，
    //    不会漏掉刚起跑那几十毫秒里发出的事件
    const rid = `ai${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    run.runId = rid;

    // 3) 事件通道（全局只订阅一次，按 run_id 分发到各自的 run）
    const gotEvents = await ensureBridge();
    pushRunLog(run, gotEvents ? "事件通道已订阅" : "事件订阅不上，改用轮询兜底");
    startTicker();

    // 4) 起跑
    run.phase = "running";
    await api.aiStart({
      run_id: rid,
      exe: backend.exe,
      args: backend.args,
      cwd: prep.dir,
      prompt: withDeliveryRules(brief, prep.dir),
      model: savedModel(),
      title,
    });
    pushRunLog(run, "已下发，等 AI 干活（关掉这个窗口也不会停）");

    // 5) 收尾放在后台：不挡用户去发下一个
    void follow(run);

    return { ok: true };
  } catch (e) {
    pushRunLog(run, `异常：${String(e)}`);
    finishRun(run, "error", String(e));
    return { ok: false, error: String(e) };
  }
}

/** 起跑之后的收尾：等结束 → 扫产物 → 兜底存回复 → 记快照 → 通知 */
async function follow(run: AiRun) {
  await waitRunDone(run);

  await refreshOutputs(run);
  // 兜底：模型只回文字不肯写文件时，把回复存成 out/AI 回复.md，组里至少有一张卡。
  // （只在 out/ 是空的时候写，否则每次都会多出一张重复的"AI 回复"卡）
  const phase: string = run.phase;
  if (phase === "done" && !run.outputs.length && run.workDir && run.text.trim()) {
    await api.aiSaveReply(run.workDir, run.text).catch(() => "");
    await refreshOutputs(run);
  }
  pushRunLog(run, `收到 ${run.outputs.length} 份产物`);
  rememberRun(run);
  notifyDone(run);
}

/** 等这个 run 收工（最多 30 分钟） */
function waitRunDone(run: AiRun): Promise<void> {
  return new Promise((res) => {
    if (!isBusy(run)) return res();
    const t = setInterval(() => {
      if (!isBusy(run)) {
        clearInterval(t);
        res();
      }
    }, 150);
    setTimeout(() => {
      clearInterval(t);
      res();
    }, 30 * 60 * 1000);
  });
}

/** 扫一遍 out/ 目录，把产物列出来 */
async function refreshOutputs(run: AiRun | null) {
  if (!run?.workDir) return;
  try {
    run.outputs = (await api.aiCollectOutputs(run.workDir)) ?? [];
  } catch {
    run.outputs = [];
  }
}

/** 中止某个任务（不传就是当前弹窗那个） */
export function cancelRun(taskId?: number | null) {
  const store = useBoardStore();
  const tid = taskId === undefined ? aiPromptTaskId.value : taskId;
  const run = runOf(store.currentProjectId, tid);
  if (!run) return;
  if (run.runId) void api.aiCancel(run.runId).catch(() => {});
  pushRunLog(run, "用户中止");
  finishRun(run, "error", "已中止");
}

/** 给「AI 任务」面板用：重新扫某个 run 的产物 */
export async function refreshRunOutputs(taskId: number | null) {
  const store = useBoardStore();
  const run = runOf(store.currentProjectId, taskId);
  if (run) await refreshOutputs(run);
}

export { isBusy };

// ------------------------------------------------------------ 产物上白板

/**
 * 把 out/ 里的**某一份**产物拖到白板上：落在哪就在哪生成一张资料卡。
 * 只放一张、不连线 —— 用户自己决定它该挂给谁（组是"这一轮全部"，拖拽是"我只要这个"）。
 */
export async function dropOutputOnBoard(
  workDir: string,
  name: string,
  x: number,
  y: number
): Promise<number | null> {
  const store = useBoardStore();
  const pid = store.currentProjectId;
  if (pid == null) return null;

  let it: AiImported | null = null;
  try {
    it = await api.aiImportOutput(pid, workDir, name);
  } catch (e) {
    dlog(`拖放导入失败：${String(e)}`);
  }
  if (!it) {
    ElMessage.warning(`「${name}」已经不在 out 目录里了`);
    return null;
  }

  const CW = 200;
  let h = 92;
  if ((it.mime || "").startsWith("image/")) {
    try {
      const d = await imageSize(await api.readAssetDataUrl(it.id));
      if (d && d.w > 0) h = Math.round(Math.min(170, Math.max(84, (d.h * CW) / d.w)));
    } catch {
      /* 读不出来就用默认高度 */
    }
  }

  // 以落点为中心摆，不然鼠标指着的位置是卡的左上角，手感很怪
  const id = await api.createNote({
    project_id: pid,
    x: Math.round(x - CW / 2),
    y: Math.round(y - h / 2),
    text: it.name,
    color: "#FFFFFF",
    kind: "file",
    w: CW,
    h,
    file_id: it.id,
    meta: "",
  });
  await store.refreshBoard();
  dlog(`产物「${it.name}」已拖到白板 (${Math.round(x)}, ${Math.round(y)})`);
  return id;
}

function imageSize(url: string): Promise<{ w: number; h: number } | null> {
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => res({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => res(null);
    img.src = url;
  });
}

/**
 * 把 out/ 里的产物收进资料库，在白板上用一个**分组框**装起来。
 * 组不跟任务连线（它就是一份成果集），名字里带上任务和时间，方便事后找。
 */
export async function placeOutputsOnBoard(
  label: string,
  taskId: number | null = null
): Promise<number> {
  const store = useBoardStore();
  const pid = store.currentProjectId;
  const tid = taskId ?? aiPromptTaskId.value;
  const run = runOf(pid, tid);
  const workDir = run?.workDir ?? aiWorkDir.value;
  if (pid == null || !workDir) return 0;

  const imported: AiImported[] = await api.aiImportOutputs(pid, workDir);
  if (!imported.length) {
    if (run) run.error = "out 目录里还没有文件。可以让 AI 再跑一次，或自己打开目录看看。";
    dlog("打组失败：out 里没有文件");
    return 0;
  }
  dlog(`把 ${imported.length} 份产物收进资料库`);

  // 卡片尺寸：图片按真实比例给高度，其它统一扁卡
  const CW = 200;
  const GAP = 22;
  const cards: { id: number; name: string; w: number; h: number }[] = [];
  for (const it of imported) {
    let h = 92;
    if ((it.mime || "").startsWith("image/")) {
      try {
        const url = await api.readAssetDataUrl(it.id);
        const d = await imageSize(url);
        if (d && d.w > 0) {
          h = Math.round(Math.min(170, Math.max(84, (d.h * CW) / d.w)));
        }
      } catch {
        /* 读不出来就用默认高度 */
      }
    }
    cards.push({ id: it.id, name: it.name, w: CW, h });
  }

  // 3 张一行，算好每组行高，框再把它们全包住
  const perRow = Math.min(3, Math.max(1, cards.length));
  const rows: (typeof cards)[] = [];
  for (let i = 0; i < cards.length; i += perRow) rows.push(cards.slice(i, i + perRow));
  const rowTops: number[] = [];
  let innerH = 0;
  for (const r of rows) {
    rowTops.push(innerH);
    innerH += Math.max(...r.map((c) => c.h)) + GAP;
  }
  innerH -= GAP;

  const perRowW = perRow * CW + (perRow - 1) * GAP;
  const boxW = perRowW + 64;
  const boxH = innerH + 96;

  // 落位：贴着现有内容的右侧放，别压住东西。
  // ⚠️ 白板上的内容是「任务卡 + 各种卡片」，只按 notes 算会压到最右列的任务卡。
  const boxes = [
    ...store.notes.map((n) => ({ x: n.x, y: n.y, w: n.w || 200, h: n.h || 120 })),
    ...store.allTasks
      .filter((t) => t.wx != null && t.wy != null)
      .map((t) => ({ x: t.wx as number, y: t.wy as number, w: 220, h: 110 })),
  ];
  const x0 = boxes.length ? Math.max(...boxes.map((b) => b.x + b.w)) + 90 : 220;
  const y0 = boxes.length ? Math.min(...boxes.map((b) => b.y)) : 220;

  // ⚠️ 必须一张一张 await：之前用 void 并发，refreshBoard 跑在 createNote 之前，
  //    白板上经常只剩半个组（框在、卡没了）。
  const boxId = await api.createNote({
    project_id: pid,
    x: Math.round(x0),
    y: Math.round(y0),
    text: `AI 产物 · ${label} · ${stamp()}`,
    color: "#2f9e6a",
    kind: "box",
    w: Math.round(boxW),
    h: Math.round(boxH),
    file_id: null,
    // role=output 让白板把框头换成绿标「产物」，也不再显示强度档位
    meta: JSON.stringify({ role: "output", task_id: tid, at: stamp() }),
  });

  for (let ri = 0; ri < rows.length; ri++) {
    let cx = x0 + 32;
    const cy = y0 + 66 + rowTops[ri];
    for (const c of rows[ri]) {
      await api.createNote({
        project_id: pid,
        x: Math.round(cx),
        y: Math.round(cy),
        text: c.name,
        color: "#FFFFFF",
        kind: "file",
        w: c.w,
        h: c.h,
        file_id: c.id,
        meta: "",
      });
      cx += c.w + GAP;
    }
  }

  // 组连回任务：这是「产物」关系（绿线），箭头指向任务。
  // ⚠️ 绝不能写成 decompose —— 产物不会让任务变成它的下级。
  if (tid != null && boxId) {
    try {
      await api.createEdge(pid, "note", boxId, "task", tid, "produce");
    } catch {
      /* 已经连过就算了 */
    }
  }

  await store.refreshBoard();
  // 放好了得让用户看见：把白板视口挪到这组上
  focusOnBoard(x0 - 40, y0 - 60, boxW + 80, boxH + 120);
  dlog(`组已放到白板 (${Math.round(x0)}, ${Math.round(y0)}) size=${Math.round(boxW)}x${Math.round(boxH)}`);
  return cards.length;
}
