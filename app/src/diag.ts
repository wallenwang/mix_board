import { ElMessage } from "element-plus";
import { api } from "./api";

// Report an error both to the user (visible toast) and to diag.log on disk.
// This replaces the old "swallow and pretend nothing happened" behavior.
export function reportError(context: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[${context}]`, err);
  ElMessage.error(`${context}失败：${msg}`);
  if (api.diagLog) {
    api.diagLog(`${context} -> ${msg}`).catch(() => {});
  }
}

// 1x1 透明 PNG，用来验证「上传资料」这条链路
const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

// Run once at startup: exercise the REAL create→read→delete path so we can
// see, in diag.log, exactly where the JS→Rust→SQLite chain breaks.
export async function runSelfTest(): Promise<void> {
  const steps: string[] = [];
  const log = (m: string) => {
    steps.push(m);
    console.log("[selftest]", m);
    api.diagLog?.(`SELFTEST ${m}`).catch(() => {});
  };
  try {
    // 先把运行环境记下来：排查"界面显示不全 / 挤在一起"时，第一眼看这行就知道
    // 窗口的逻辑视口有多大、系统缩放是多少（150% 缩放时 innerWidth 只有物理宽的 2/3）。
    log(
      `env viewport=${window.innerWidth}x${window.innerHeight}` +
        ` dpr=${window.devicePixelRatio}` +
        ` screen=${window.screen.width}x${window.screen.height}` +
        ` avail=${window.screen.availWidth}x${window.screen.availHeight}` +
        ` host=${"__TAURI_INTERNALS__" in window ? "tauri" : "browser"}`
    );
    log("start");
    const id = await api.createProject("__自检__", "#409EFF", "🧪");
    log(`createProject id=${id}`);
    const projects = await api.listProjects();
    log(`listProjects count=${projects.length} hasSelf=${projects.some((p) => p.id === id)}`);
    const cols = await api.listColumns(id);
    log(`listColumns count=${cols.length}`);
    if (cols.length > 0) {
      const tid = await api.createTask({
        project_id: id,
        column_id: cols[0].id,
        title: "__自检任务__",
      });
      log(`createTask id=${tid}`);
      const tasks = await api.listTasks(id);
      log(`listTasks count=${tasks.length}`);

      // whiteboard: position, note, edge
      await api.setTaskPos(tid, 123, 456);
      const t2 = (await api.listTasks(id)).find((t) => t.id === tid);
      log(`setTaskPos -> wx=${t2?.wx} wy=${t2?.wy}`);

      const noteId = await api.createNote({
        project_id: id,
        x: 10,
        y: 20,
        text: "自检便签",
        color: "#FFF9C4",
        kind: "note",
        w: 176,
        h: 132,
      });
      const notes = await api.listNotes(id);
      log(`note id=${noteId} listNotes=${notes.length} kind=${notes[0]?.kind}`);

      const mindId = await api.createNote({
        project_id: id,
        x: 320,
        y: 20,
        text: "自检导图",
        color: "#409EFF",
        kind: "mind",
        w: 190,
        h: 46,
      });
      await api.createEdge(id, "note", mindId, "note", noteId);
      log(`mind node id=${mindId} + edge ok`);

      const edgeId = await api.createEdge(id, "task", tid, "note", noteId);
      const edges = await api.listEdges(id);
      log(`edge id=${edgeId} listEdges=${edges.length}`);

      // ---- 资料上传往返（文件落盘 → 读回 → 删除）----
      const file = await api.importAsset(id, "__自检__.png", "image/png", TINY_PNG);
      log(`importAsset id=${file.id} size=${file.size} ext=${file.ext} path=${file.path}`);
      const back = await api.readAssetDataUrl(file.id);
      log(`readAssetDataUrl len=${back.length} head=${back.slice(0, 22)}`);
      const assets = await api.listAssets(id);
      log(`listAssets count=${assets.length}`);
      const fileNoteId = await api.createNote({
        project_id: id,
        x: 10,
        y: 220,
        text: file.name,
        color: "#FFFFFF",
        kind: "file",
        w: 240,
        h: 96,
        file_id: file.id,
      });
      log(`file node id=${fileNoteId} file_id=${file.id}`);
      await api.deleteNote(fileNoteId);
      log("file node deleted (asset file dropped from disk)");

      await api.deleteEdge(edgeId);
      await api.deleteNote(noteId);
      await api.deleteNote(mindId);
      log("cleaned notes+edges");

      await api.deleteTask(tid);
      log("deleteTask ok");
    }
    await api.deleteProject(id);
    log("deleteProject ok — SELFTEST PASSED");
  } catch (e) {
    log(`SELFTEST FAILED at last step: ${e instanceof Error ? e.message : String(e)}`);
    console.error("[selftest] failed", e);
  }
}
