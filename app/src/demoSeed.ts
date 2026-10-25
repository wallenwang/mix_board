/**
 * 桌面版（真实数据库）的演示项目。
 *
 * 浏览器预览有 mock 那一套"直接塞内存数组"，桌面版没有这条路：
 * 项目 / 列 / 任务 / 白板节点 / 连线 / 依据都得走真实的 SQL 命令写进去。
 * 所以这里把 seedDemo 里的那份数据**重放**一遍：
 *  - 种子里的 id 只是占位，真实写入时按顺序建，再建一张「旧 id → 新 id」映射
 *  - 文件类资料现场生成几个小样例（真 PDF / 真 PNG / CSV），保证点开能预览
 *  - 只跑一次：localStorage 里记个标记，用户之后删掉演示项目不会再冒出来
 */
import { api } from "./api";
import { reportError } from "./diag";
import { parseDocRef, withDocRef } from "./types";
import {
  DEMO_PROJECT_NAME,
  seedAssets,
  seedColumns,
  seedDocs,
  seedEdges,
  seedNotes,
  seedProject,
  seedTaskRefs,
  seedTasks,
} from "./seedDemo";

const FLAG_KEY = "kanban.demoSeeded.v2";

const isDesktop = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in (window as any);

/** btoa 只吃 Latin1：中文一律替换掉，否则整个注入会在这里炸掉 */
const b64ascii = (s: string) => btoa(s.replace(/[^\x00-\xFF]/g, "?"));

/** 1×1 透明 PNG：够当图片预览，不占空间 */
const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** 生成一页最小可用 PDF（内容全 ASCII，方便 btoa）：点开能预览，不是坏文件 */
function makePdf(rawTitle: string): string {
  // PDF 这一段用的是 Helvetica + 纯 ASCII 字符串：中文文件名先滤掉，否则 btoa 会抛
  const cleaned = rawTitle.replace(/[^\x20-\x7E]/g, " ").replace(/\s+/g, " ").trim();
  const title = cleaned || "Sample Document";
  const esc = title.replace(/[()\\]/g, " ");
  const stream = `BT /F1 20 Tf 56 760 Td (${esc}) Tj ET`;
  const objs = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>",
    `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`,
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
  ];
  let out = "%PDF-1.4\n";
  const offs: number[] = [];
  objs.forEach((o, i) => {
    offs.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offs) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`;
  return out;
}

function sampleFile(name: string): { mime: string; b64: string } {
  const ext = (name.split(".").pop() ?? "").toLowerCase();
  if (ext === "png") return { mime: "image/png", b64: PNG_1PX };
  if (ext === "csv") {
    return {
      mime: "text/csv",
      b64: b64ascii("name,note\nCamellia,brand reference\nvisual,low saturation\n"),
    };
  }
  return { mime: "application/pdf", b64: b64ascii(makePdf(name.replace(/\.[a-z]+$/i, ""))) };
}

/** 文档卡片的关联信息（note id 是种子里的旧 id） */
const DOC_OF_NOTE = new Map<number, number>([
  [2031, 6001], // 调性说明
  [2032, 6002], // 版式规范
]);

async function buildDemo(): Promise<number> {
  const pid = await api.createProject(DEMO_PROJECT_NAME, seedProject.color, seedProject.icon);
  // ⚠️ 必须先把新项目的库打开：后面的 create_column / create_task / import_asset
  // 都写"当前打开的库"，不切过去就会把演示数据写进上一个项目里。
  await api.openProjectDb(pid);

  // ---- 列 ----
  const colIds = new Map<number, number>();
  for (const c of seedColumns) {
    colIds.set(c.id, await api.createColumn(pid, c.name, c.color));
  }

  // ---- 文档（文档卡片要引用真实 id，先建） ----
  const docIds = new Map<number, number>();
  for (const d of seedDocs) {
    docIds.set(d.id, await api.createDoc(pid, d.title, d.body));
  }

  // ---- 资料（现场生成小样例，保证能打开） ----
  const assetIds = new Map<number, number>();
  for (const f of seedAssets) {
    const s = sampleFile(f.name);
    const wf = await api.importAsset(pid, f.name, s.mime, s.b64);
    assetIds.set(f.id, wf.id);
  }

  // ---- 任务 ----
  const taskIds = new Map<number, number>();
  for (const t of seedTasks) {
    const nid = await api.createTask({
      project_id: pid,
      column_id: colIds.get(t.column_id) ?? [...colIds.values()][0],
      title: t.title,
      description: t.description,
      priority: t.priority,
    });
    taskIds.set(t.id, nid);
    await api.updateTask(nid, {
      start_date: t.start_date,
      due_date: t.due_date,
      progress: t.progress,
      deliver_fmt: t.deliver_fmt || "",
      ...(t.completed_at ? { completed: true } : {}),
    });
    await api.setTaskPos(nid, t.wx, t.wy);
  }

  // ---- 白板节点 ----
  const noteIds = new Map<number, number>();
  for (const n of seedNotes) {
    let meta = n.meta;
    const docOld = DOC_OF_NOTE.get(n.id);
    if (docOld != null) {
      const realDoc = docIds.get(docOld);
      if (realDoc != null) {
        const d = seedDocs.find((x) => x.id === docOld);
        const base = parseDocRef(meta) ? meta : "";
        meta = withDocRef(base, { doc_id: realDoc, title: d?.title ?? n.text });
      }
    }
    const id = await api.createNote({
      project_id: pid,
      x: n.x,
      y: n.y,
      text: n.text,
      color: n.color,
      kind: n.kind,
      w: n.w,
      h: n.h,
      file_id: n.file_id != null ? assetIds.get(n.file_id) ?? null : null,
      meta,
    });
    noteIds.set(n.id, id);
  }

  // ---- 连线 ----
  for (const e of seedEdges) {
    const fid = e.from_kind === "task" ? taskIds.get(e.from_id) : noteIds.get(e.from_id);
    const tid = e.to_kind === "task" ? taskIds.get(e.to_id) : noteIds.get(e.to_id);
    if (fid == null || tid == null) continue;
    await api.createEdge(
      pid,
      e.from_kind as "task" | "note",
      fid,
      e.to_kind as "task" | "note",
      tid,
      e.kind
    );
  }

  // ---- 依据等级（挂在关系上） ----
  for (const r of seedTaskRefs) {
    const t = taskIds.get(r.task_id);
    const n = noteIds.get(r.note_id);
    if (t == null || n == null) continue;
    await api.setTaskRef(pid, t, n, r.level, r.ord, r.point);
  }

  return pid;
}

/**
 * 第一次打开桌面版时把演示项目建出来，返回新项目 id（建过 / 不需要就返回 null）。
 * 浏览器预览不做：mock 自带一份，否则会出现两个同名项目。
 */
export async function ensureDemoProject(): Promise<number | null> {
  try {
    if (localStorage.getItem(FLAG_KEY)) return null;
  } catch {
    /* 隐私模式读不到就每次都试，反正查重有名字兜底 */
  }
  if (!isDesktop()) {
    try {
      localStorage.setItem(FLAG_KEY, "1");
    } catch {
      /* 忽略 */
    }
    return null;
  }
  try {
    const projects = await api.listProjects();
    const found = projects.find((p) => p.name === DEMO_PROJECT_NAME);
    if (found) {
      // 上一次可能建到一半就断了（资料编码失败那种），留下一个空壳项目。
      // 空壳就删掉重建，别让用户点进去看到一片空白。
      let taskCount = 0;
      try {
        await api.openProjectDb(found.id);
        taskCount = (await api.listTasks(found.id)).length;
      } catch {
        taskCount = 0;
      }
      if (taskCount > 0) {
        localStorage.setItem(FLAG_KEY, "1");
        return null;
      }
      // 先把库切到别的项目：Windows 上删不掉正在被打开的那个 db 文件
      const other = projects.find((p) => p.id !== found.id);
      if (other) await api.openProjectDb(other.id);
      await api.deleteProject(found.id);
    }
    const id = await buildDemo();
    localStorage.setItem(FLAG_KEY, "1");
    return id;
  } catch (e) {
    reportError("创建演示项目", e);
    return null;
  }
}
