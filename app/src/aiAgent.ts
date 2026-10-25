/**
 * 「发送到 AI」的全过程：准备工作目录 → 交给本地 agent CLI → 收产物 → 打组放到白板。
 *
 * 传送方式说明（这也是为什么不再让用户复制粘贴）：
 *  · 先把指令写成 <项目>/AI产出/<任务>/brief.md，参考材料拷进 refs/；
 *  · 命令行上只出现「路径」，中文正文一个字都不经过 shell；
 *  · 通过 ACP（stdin/stdout 的 nd-JSON，规范强制 UTF-8）把指令发出去；
 *  · AI 把产物写进 out/，我们扫目录回收 —— 比从 stdout 里抠 Markdown 稳得多。
 *
 * ⚠️ 进度用**两条路**读：正常走 ai-event 事件；如果事件订阅失败（Tauri 2 里
 *    core:event 权限没给到，listen 会直接 reject），自动退化成轮询 ai_status。
 *    早先只依赖事件，一旦权限缺失就是「点了发送、界面一直转圈」，还看不出原因。
 */
import { ref } from "vue";
import { ElMessage } from "element-plus";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api, isTauri } from "./api";
import type { AiBackend, AiImported, AiModel, AiOutput } from "./types";
import { useBoardStore } from "./store";
import { focusOnBoard } from "./uiBus";

const LS_BACKEND = "ai.backend";
const LS_MODEL = "ai.model";
/** 上一轮跑完的结果，按「项目:任务」各存一份 */
const LS_RUN = "ai.lastRun";
/** 产物列表拖到白板用的自定义 MIME（白板那边认这个类型） */
export const AI_OUT_MIME = "application/x-ai-output";

/** 探测到的 agent 命令行 */
export const aiBackends = ref<AiBackend[]>([]);
/** idle 空闲 / preparing 准备目录 / running 跑着 / done 完成 / error 出错 */
export const aiPhase = ref<"idle" | "preparing" | "running" | "done" | "error">("idle");
export const aiText = ref("");
export const aiLog = ref<string[]>([]);
export const aiOutputs = ref<AiOutput[]>([]);
export const aiWorkDir = ref("");
export const aiError = ref("");
/** 恢复出来的是哪一轮的结果（"10-25 00:12"），空=这一轮是刚跑的 */
export const aiLastAt = ref("");

let runId = "";
let stop: UnlistenFn | null = null;
let pollTimer: number | null = null;

function pushLog(s: string) {
  const line = s.trim();
  if (!line) return;
  aiLog.value.push(line.length > 160 ? line.slice(0, 160) + "…" : line);
  if (aiLog.value.length > 200) aiLog.value.splice(0, aiLog.value.length - 200);
}

/** 同时写一份到 diag.log：用户说"点了没反应"时，一行就能看出断在哪一步 */
function dlog(m: string) {
  pushLog(`· ${m}`);
  api.diagLog?.(`AI ${m}`).catch(() => {});
}

function stopPoll() {
  if (pollTimer != null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

export function resetRun() {
  stopPoll();
  aiPhase.value = "idle";
  aiText.value = "";
  aiLog.value = [];
  aiOutputs.value = [];
  aiError.value = "";
  aiWorkDir.value = "";
  aiLastAt.value = "";
  runId = "";
}

/** 一次跑完的结果快照 */
interface RunSnap {
  workDir: string;
  at: string;
  model: string;
  text: string;
  outputs: AiOutput[];
}

function runKey(pid: number, taskId: number | null): string {
  return `${pid}:${taskId ?? 0}`;
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
  const s = readSnaps()[runKey(pid, taskId)];
  return s && s.workDir ? s : null;
}

function rememberRun(pid: number, taskId: number | null, text: string) {
  if (!aiWorkDir.value) return;
  const all = readSnaps();
  all[runKey(pid, taskId)] = {
    workDir: aiWorkDir.value,
    at: stamp(),
    model: savedModel(),
    text: text.slice(0, 4000),
    outputs: aiOutputs.value,
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
 * 打开弹窗时调用：把同一个任务**上一轮跑完**的结果恢复出来。
 * 常见诉求是"我点进去想再看看上一轮的产物" —— 重跑一遍又慢又费钱。
 * 恢复后仍会重扫一遍 workDir：文件被删了就如实说没有，不假装还在。
 */
export async function openRunFor(taskId: number | null): Promise<void> {
  resetRun();
  const pid = useBoardStore().currentProjectId;
  if (pid == null || taskId == null) return;
  const snap = lastRunOf(pid, taskId);
  if (!snap) return;
  aiWorkDir.value = snap.workDir;
  aiText.value = snap.text || "";
  aiOutputs.value = snap.outputs ?? [];
  aiLastAt.value = snap.at || "";
  aiPhase.value = "done";
  await refreshOutputs();
  if (!aiOutputs.value.length) {
    aiError.value = "上次的工作目录已经不在了（可能被删，或换过数据目录）";
    dlog("恢复上次结果失败：工作目录不在了");
  } else {
    dlog(`已恢复上次结果（${snap.at}）：${aiOutputs.value.length} 份产物`);
  }
}

/** 探测本机装了哪些 agent CLI */
export async function detectBackends(): Promise<AiBackend[]> {
  try {
    const list = await api.aiDetectBackends();
    aiBackends.value = list ?? [];
    dlog(`探测到 ${aiBackends.value.length} 个 CLI：${aiBackends.value.map((b) => b.name).join("、") || "无"}`);
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

/** 当前后端能选的模型（来自 agent 会话的 configOptions） */
export const aiModels = ref<AiModel[]>([]);

/**
 * 拉一次模型列表。
 * ⚠️ 只是为了给用户一个正确的下拉；就算拉失败也不影响发送 ——
 *    后端在 session/new 里自己也会拿到同一份列表，会自动挑一个付费模型。
 */
export async function loadModels(): Promise<void> {
  const b = pickBackend();
  // ⚠️ isTauri 是布尔常量（api.ts: export const isTauri = hasTauri），不是函数，
  //    写成 isTauri() 会抛 "is not a function" —— 打开弹窗时就炸。
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

/** 把 agent 的原始报错翻译成「下一步该点哪里」 */
function humanize(raw: string): string {
  const t = (raw || "").trim();
  if (/free usage limit|usage limit reached/i.test(t)) {
    return (
      "这个模型的免费额度用完了（opencode 自带的免费模型有次数上限）。\n" +
      "两种解法：① 在上面的「模型」下拉里选一个你自己配了 key 的模型（如 deepseek/DeepSeek V4.1 Flash）；" +
      "② 去 opencode 桌面版里 Connect provider 或订阅 Go 套餐。\n" +
      "原始报错：" + t
    );
  }
  if (/no api key|invalid api key|unauthorized|401/i.test(t)) {
    return "这个模型没有可用的 key：先在 opencode 桌面版里连上 provider，再换模型。\n原始报错：" + t;
  }
  return t;
}

export interface SendResult {
  ok: boolean;
  error?: string;
}

/** 把当前这份指令发出去，等它跑完。过程会实时写进 aiText / aiLog */
export async function sendToAi(brief: string, title: string, taskId: number | null): Promise<SendResult> {
  const store = useBoardStore();
  const pid = store.currentProjectId;
  if (pid == null) return { ok: false, error: "还没选项目" };

  const backend = pickBackend();
  if (!backend) {
    dlog("发送中止：没有可用的后端");
    return {
      ok: false,
      error: "没找到可用的 AI 命令行。先装 OpenCode 桌面版（自带 CLI），或在设置里指定路径。",
    };
  }

  resetRun();
  try {
    // 1) 准备工作目录：把指令和参考材料摆好
    aiPhase.value = "preparing";
    dlog(`开始：${backend.name} ${backend.version} → ${backend.exe}`);
    const assetIds: number[] = [];
    if (taskId != null) {
      for (const r of store.refsOfTask(taskId)) {
        const n = store.notes.find((x) => x.id === r.note_id);
        if (n?.file_id != null && !assetIds.includes(n.file_id)) assetIds.push(n.file_id);
      }
    }
    const prep = await api.aiPrepare(pid, title, brief, assetIds);
    aiWorkDir.value = prep.dir;
    dlog(`工作目录就绪：${prep.dir}（参考材料 ${assetIds.length} 份）`);

    // 2) run_id 由前端生成：这样 listen 的时候就知道自己是哪个 run，
    //    不会漏掉刚起跑那几十毫秒里发出的事件
    const rid = `ai${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    runId = rid;

    // 3) 监听事件（失败不致命，下面会退化成轮询）
    if (isTauri) {
      stop?.();
      stop = null;
      try {
        stop = await listen<{ run_id: string; kind: string; text: string }>("ai-event", (ev) => {
          const p = ev.payload;
          if (p.run_id !== runId) return;
          if (p.kind === "chunk") aiText.value += p.text;
          else if (p.kind === "log") pushLog(p.text);
          else if (p.kind === "done") {
            aiText.value = p.text || aiText.value;
            if (aiPhase.value !== "error") aiPhase.value = "done";
            dlog("收到 done 事件");
            finish();
          } else if (p.kind === "error") {
            aiError.value = humanize(p.text);
            aiPhase.value = "error";
            dlog(`收到 error 事件：${p.text}`);
            finish();
          }
        });
        dlog("事件通道已订阅");
      } catch (e) {
        dlog(`事件订阅失败，改用轮询：${String(e)}`);
      }
    }

    // 4) 起跑
    aiPhase.value = "running";
    await api.aiStart({
      run_id: rid,
      exe: backend.exe,
      args: backend.args,
      cwd: prep.dir,
      prompt: withDeliveryRules(brief, prep.dir),
      model: savedModel(),
      title,
    });
    dlog("已下发，等 AI 干活");

    // 5) 无论事件通道有没有订阅上，都开一条慢轮询兜底：
    //    事件是"立刻知道"的快路，轮询是"一定知道"的保险。两边写的是同一份状态，
    //    重复应用不会出错（只是把同一段文字再赋一次值）。
    pollTimer = window.setInterval(() => void pullStatus(), 1500);
    void pullStatus();

    // 等结果：done / error 会把 phase 改掉
    await waitPhase();
    finish();
    dlog(`结束：${aiPhase.value}${aiError.value ? " / " + aiError.value : ""}`);

    // 兜底：模型只回文字不肯写文件时，把回复存成 out/AI 回复.md，组里至少有一张卡。
    // （只在 out/ 是空的时候写，否则每次都会多出一张重复的"AI 回复"卡）
    await refreshOutputs();
    // ⚠️ 取一份副本再判断：TS 会把上面 `aiPhase.value = "running"` 的窄化一路带下来，
    //    直接比较 "done"/"error" 会被判成"两个类型没有交集"，把这段兜底当成死代码。
    const finalPhase: string = aiPhase.value;
    if (finalPhase === "done" && !aiOutputs.value.length && aiWorkDir.value && aiText.value.trim()) {
      await api.aiSaveReply(aiWorkDir.value, aiText.value).catch(() => "");
      await refreshOutputs();
    }
    dlog(`收到 ${aiOutputs.value.length} 份产物`);
    // 记一份，下次点同一个任务的 AI 时能直接看到这些产物
    if (aiWorkDir.value) rememberRun(pid, taskId, aiText.value);

    return finalPhase === "error" ? { ok: false, error: aiError.value } : { ok: true };
  } catch (e) {
    aiPhase.value = "error";
    aiError.value = humanize(String(e));
    dlog(`异常：${String(e)}`);
    finish();
    return { ok: false, error: String(e) };
  }
}

/** 从后端拉一次状态（事件通道的备份） */
async function pullStatus() {
  if (!runId) return;
  try {
    const st = await api.aiStatus(runId);
    // 事件通道可能已经把更新的字推过来了，别用稍旧的快照把它盖回去（会闪、会回退）
    if (st.text && st.text.length > aiText.value.length) aiText.value = st.text;
    if (st.phase === "done") {
      if (aiPhase.value !== "error") aiPhase.value = "done";
      finish();
    } else if (st.phase === "error") {
      aiError.value = humanize(st.error || "AI 那边出错了");
      aiPhase.value = "error";
      finish();
    }
  } catch {
    /* 单次查询失败不算错，下一轮再试 */
  }
}

function waitPhase(): Promise<void> {
  return new Promise((res) => {
    const t = setInterval(() => {
      if (aiPhase.value === "done" || aiPhase.value === "error") {
        clearInterval(t);
        res();
      }
    }, 120);
    // 兜底：最多等 30 分钟
    setTimeout(() => {
      clearInterval(t);
      res();
    }, 30 * 60 * 1000);
  });
}

function finish() {
  stop?.();
  stop = null;
  stopPoll();
  if (aiPhase.value === "running" || aiPhase.value === "preparing") aiPhase.value = "done";
}

/** 扫一遍 out/ 目录，把产物列出来 */
async function refreshOutputs() {
  if (!aiWorkDir.value) return;
  try {
    aiOutputs.value = (await api.aiCollectOutputs(aiWorkDir.value)) ?? [];
  } catch {
    aiOutputs.value = [];
  }
}

export function cancelRun() {
  if (runId) void api.aiCancel(runId).catch(() => {});
  aiPhase.value = "error";
  aiError.value = "已中止";
  dlog("用户中止");
  finish();
}

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

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
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
  if (pid == null || !aiWorkDir.value) return 0;

  const imported: AiImported[] = await api.aiImportOutputs(pid, aiWorkDir.value);
  if (!imported.length) {
    aiError.value = "out 目录里还没有文件。可以让 AI 再跑一次，或自己打开目录看看。";
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
    meta: JSON.stringify({ role: "output", task_id: taskId, at: stamp() }),
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
  if (taskId != null && boxId) {
    try {
      await api.createEdge(pid, "note", boxId, "task", taskId, "produce");
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
