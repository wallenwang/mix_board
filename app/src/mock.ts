// Browser-only fallback so the UI can be tested in a plain browser (no Tauri).
// In the real desktop app, Tauri IS present and this file is never used.
import type {
  Project,
  Column,
  Task,
  Tag,
  TrashItem,
  BoardNote,
  BoardEdge,
  EdgeKind,
  TaskRef,
  Doc,
} from "./types";

const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in (window as any);

if (!isTauri) {
  console.warn(
    "[dev] 未检测到 Tauri 后端 —— 使用浏览器本地存储模式，数据保存在这个浏览器里。"
  );
}

// ---- tiny in-memory DB ----
let pid = 1;
let cid = 1;
let tid = 1;
let gid = 1;
let nid = 1;
let eid = 1;
let did = 1;
let rid = 1;
const projects: Project[] = [];
const columns: Column[] = [];
const tasks: Task[] = [];
const tags: Tag[] = [];
const trash: TrashItem[] = [];
const notes: BoardNote[] = [];
const edges: BoardEdge[] = [];
const taskRefs: TaskRef[] = [];
const docs: Doc[] = [];
const settings: Record<string, string> = { theme: "light" };

function log(cmd: string, args?: any) {
  (window as any).__mockLog = (window as any).__mockLog || [];
  (window as any).__mockLog.push({ cmd, args });
  console.log("[mock]", cmd, args ?? "");
}

const apiImpl = {
  async bootstrap() {
    log("bootstrap");
    return {
      projects: [...projects],
      settings: { theme: settings.theme || "light" },
      current_project_id: projects[0]?.id ?? null,
    };
  },

  async listProjects() {
    log("list_projects");
    return [...projects];
  },
  async createProject(name: string, color?: string, icon?: string) {
    log("create_project", { name, color, icon });
    const p: Project = {
      id: pid++,
      name,
      color: color ?? "#409EFF",
      icon: icon ?? "📁",
      sort_order: projects.length * 1000 + 1000,
    };
    projects.push(p);
    const defs: [string, string][] = [
      ["待办", "#909399"],
      ["进行中", "#409EFF"],
      ["待评审", "#E6A23C"],
      ["已完成", "#67C23A"],
    ];
    defs.forEach(([n, c], i) =>
      columns.push({
        id: cid++,
        project_id: p.id,
        name: n,
        color: c,
        wip_limit: null,
        sort_order: (i + 1) * 1000,
        collapsed: false,
      })
    );
    return p.id;
  },
  async updateProject(id: number, patch: any) {
    log("update_project", { id, ...patch });
    const p = projects.find((x) => x.id === id);
    if (p) Object.assign(p, patch);
  },
  async deleteProject(id: number) {
    log("delete_project", { id });
    const i = projects.findIndex((x) => x.id === id);
    if (i >= 0) projects.splice(i, 1);
  },
  async reorderProjects(ids: number[]) {
    log("reorder_projects", ids);
    ids.forEach((id, i) => {
      const p = projects.find((x) => x.id === id);
      if (p) p.sort_order = (i + 1) * 1000;
    });
  },

  async listColumns(projectId: number) {
    log("list_columns", projectId);
    return columns.filter((c) => c.project_id === projectId);
  },
  async createColumn(projectId: number, name: string, color?: string) {
    log("create_column", { projectId, name, color });
    const c: Column = {
      id: cid++,
      project_id: projectId,
      name,
      color: color ?? "#909399",
      wip_limit: null,
      sort_order: columns.filter((x) => x.project_id === projectId).length * 1000 + 1000,
      collapsed: false,
    };
    columns.push(c);
    return c.id;
  },
  async updateColumn(id: number, patch: any) {
    log("update_column", { id, ...patch });
    const c = columns.find((x) => x.id === id);
    if (c) {
      if ("name" in patch) c.name = patch.name;
      if ("color" in patch) c.color = patch.color;
      if ("wipLimit" in patch) c.wip_limit = patch.wipLimit;
      if ("collapsed" in patch) c.collapsed = patch.collapsed;
    }
  },
  async deleteColumn(id: number) {
    log("delete_column", { id });
    const i = columns.findIndex((x) => x.id === id);
    if (i >= 0) columns.splice(i, 1);
    for (let j = tasks.length - 1; j >= 0; j--) if (tasks[j].column_id === id) tasks.splice(j, 1);
  },
  async reorderColumns(projectId: number, ids: number[]) {
    log("reorder_columns", { projectId, ids });
    ids.forEach((id, i) => {
      const c = columns.find((x) => x.id === id);
      if (c) c.sort_order = (i + 1) * 1000;
    });
  },

  async listTasks(projectId: number) {
    log("list_tasks", projectId);
    return tasks.filter((t) => t.project_id === projectId);
  },
  async createTask(t: any) {
    log("create_task", t);
    const task: Task = {
      id: tid++,
      project_id: t.project_id,
      column_id: t.column_id,
      title: t.title,
      description: t.description ?? "",
      priority: t.priority ?? 2,
      due_date: t.due_date ?? null,
      start_date: t.start_date ?? null,
      progress: t.progress ?? null,
      bar_color: t.bar_color ?? null,
      sort_order: tasks.filter((x) => x.column_id === t.column_id).length * 1000 + 1000,
      created_at: "",
      updated_at: "",
      completed_at: null,
      tags: t.tags ?? [],
      wx: t.wx ?? null,
      wy: t.wy ?? null,
      deliver_fmt: t.deliver_fmt ?? "",
      // 项目内编号，删掉的号不回收 —— 与桌面版一致
      seq:
        tasks
          .filter((x) => x.project_id === t.project_id)
          .reduce((m, x) => Math.max(m, x.seq || 0), 0) + 1,
    };
    tasks.push(task);
    return task.id;
  },
  async updateTask(id: number, patch: any) {
    log("update_task", { id, ...patch });
    const t = tasks.find((x) => x.id === id);
    if (t) {
      if ("title" in patch) t.title = patch.title;
      if ("description" in patch) t.description = patch.description;
      if ("priority" in patch) t.priority = patch.priority;
      if ("due_date" in patch) t.due_date = patch.due_date;
      if ("start_date" in patch) t.start_date = patch.start_date;
      if ("progress" in patch) t.progress = patch.progress;
      if ("bar_color" in patch) t.bar_color = patch.bar_color;
      if ("deliver_fmt" in patch) t.deliver_fmt = patch.deliver_fmt;
      // 勾「完成」= 盖一个完成时间戳（跟桌面版 Rust 侧语义一致）
      if ("completed" in patch) {
        t.completed_at = patch.completed ? new Date().toLocaleString("sv-SE") : null;
      }
      if ("tags" in patch) t.tags = patch.tags;
    }
  },
  async moveTask(id: number, columnId: number, sortOrder: number) {
    log("move_task", { id, columnId, sortOrder });
    const t = tasks.find((x) => x.id === id);
    if (t) {
      t.column_id = columnId;
      t.sort_order = sortOrder;
    }
  },
  async deleteTask(id: number) {
    log("delete_task", id);
    const t = tasks.find((x) => x.id === id);
    if (t) {
      trash.unshift({
        id: t.id,
        title: t.title,
        column_name: columns.find((c) => c.id === t.column_id)?.name ?? null,
        project_name: projects.find((p) => p.id === t.project_id)?.name ?? null,
        deleted_at: new Date().toLocaleString("sv-SE"),
      });
    }
    const i = tasks.findIndex((x) => x.id === id);
    if (i >= 0) tasks.splice(i, 1);
  },
  async restoreTask(id: number) {
    log("restore_task", id);
    const i = trash.findIndex((x) => x.id === id);
    if (i >= 0) trash.splice(i, 1);
  },
  async purgeTask(id: number) {
    log("purge_task", id);
    const i = trash.findIndex((x) => x.id === id);
    if (i >= 0) trash.splice(i, 1);
  },

  async listTrash() {
    log("list_trash");
    return [...trash];
  },
  async emptyTrash() {
    log("empty_trash");
    trash.length = 0;
  },

  async listTags(projectId: number) {
    log("list_tags", projectId);
    return tags.filter((t) => t.project_id === projectId);
  },
  async createTag(projectId: number, name: string, color?: string) {
    log("create_tag", { projectId, name, color });
    const t: Tag = { id: gid++, project_id: projectId, name, color: color ?? "#409EFF" };
    tags.push(t);
    return t.id;
  },
  async deleteTag(id: number) {
    log("delete_tag", id);
    const i = tags.findIndex((x) => x.id === id);
    if (i >= 0) tags.splice(i, 1);
  },

  async setTaskPos(id: number, wx: number, wy: number) {
    log("set_task_pos", { id, wx, wy });
    const t = tasks.find((x) => x.id === id);
    if (t) {
      t.wx = wx;
      t.wy = wy;
    }
  },

  async listNotes(projectId: number) {
    log("list_notes", projectId);
    return notes.filter((n) => n.project_id === projectId);
  },
  async createNote(note: any) {
    log("create_note", note);
    const n: BoardNote = {
      id: nid++,
      project_id: note.project_id,
      x: note.x,
      y: note.y,
      text: note.text ?? "",
      color: note.color ?? "#FFF9C4",
      kind: note.kind ?? "note",
      w: note.w ?? null,
      h: note.h ?? null,
      file_id: note.file_id ?? null,
      meta: note.meta ?? "",
      role: note.role ?? "",
      group_kind: note.group_kind ?? "",
    };
    notes.push(n);
    return n.id;
  },
  async updateNote(id: number, patch: any) {
    log("update_note", { id, ...patch });
    const n = notes.find((x) => x.id === id);
    if (n) Object.assign(n, patch);
  },
  async deleteNote(id: number) {
    log("delete_note", id);
    const i = notes.findIndex((x) => x.id === id);
    if (i >= 0) notes.splice(i, 1);
    for (let j = taskRefs.length - 1; j >= 0; j--) {
      if (taskRefs[j].note_id === id) taskRefs.splice(j, 1);
    }
    for (let j = edges.length - 1; j >= 0; j--) {
      const e = edges[j];
      if ((e.from_kind === "note" && e.from_id === id) || (e.to_kind === "note" && e.to_id === id))
        edges.splice(j, 1);
    }
  },

  // ---- 白板资料（浏览器 mock：内容以 data URL 存在内存里） ----
  async listAssets(projectId: number) {
    log("list_assets", projectId);
    const all: any[] = (window as any).__mockAssets || [];
    return all.filter((f) => f.project_id === projectId);
  },
  async importAsset(
    projectId: number,
    name: string,
    mime: string,
    dataB64: string,
    sha256?: string
  ) {
    const all: any[] = ((window as any).__mockAssets ||= []);
    const blobs: Record<number, string> = ((window as any).__mockBlobs ||= {});
    const id = all.reduce((m, f) => Math.max(m, f.id), 0) + 1;
    const dot = name.lastIndexOf(".");
    const ext = (dot >= 0 ? name.slice(dot + 1) : "").toLowerCase();
    const payload = dataB64.includes(",") ? dataB64.slice(dataB64.indexOf(",") + 1) : dataB64;
    const type = mime || "application/octet-stream";
    blobs[id] = `data:${type};base64,${payload}`;
    const rec = {
      id,
      project_id: projectId,
      name,
      ext,
      mime: type,
      size: Math.round(payload.length * 0.75),
      path: `mock://assets/${id}.${ext}`,
      created_at: new Date().toLocaleString("sv-SE"),
      sha256: sha256 || "",
    };
    all.push(rec);
    log("import_asset", { id, name, size: rec.size, reused: false });
    return rec;
  },
  /** 按内容指纹找同款资料（复用，不重复存） */
  async findAssetByHash(projectId: number, sha256: string) {
    const all: any[] = (window as any).__mockAssets || [];
    if (!sha256) return null;
    return (
      all.find((f) => f.project_id === projectId && f.sha256 === sha256) ?? null
    );
  },
  async deleteAsset(id: number) {
    log("delete_asset", id);
    const all: any[] = ((window as any).__mockAssets ||= []);
    const i = all.findIndex((f) => f.id === id);
    if (i >= 0) all.splice(i, 1);
    const blobs: Record<number, string> = ((window as any).__mockBlobs ||= {});
    delete blobs[id];
    for (let j = notes.length - 1; j >= 0; j--) if (notes[j].file_id === id) notes.splice(j, 1);
  },
  async openAsset(id: number) {
    log("open_asset", id);
    const blobs: Record<number, string> = ((window as any).__mockBlobs ||= {});
    if (blobs[id]) window.open(blobs[id], "_blank");
  },
  async revealAsset(id: number) {
    log("reveal_asset", id);
  },
  async readAssetDataUrl(id: number) {
    const blobs: Record<number, string> = ((window as any).__mockBlobs ||= {});
    return blobs[id] ?? "";
  },
  async getDataDir() {
    log("get_data_dir");
    return "（浏览器预览模式 · 数据只在内存中，刷新即清空）";
  },
  async openDataDir() {
    log("open_data_dir");
    throw new Error("浏览器预览模式没有本地数据目录，请用桌面版");
  },
  async dataOverview() {
    log("data_overview");
    const assets: any[] = (window as any).__mockAssets || [];
    let dbBytes = 0;
    try {
      dbBytes = (localStorage.getItem(LS_KEY) || "").length;
    } catch {
      dbBytes = 0;
    }
    const stats = projects.map((p) => ({
      id: p.id,
      name: p.name,
      folder: p.name,
      tasks: tasks.filter((t) => t.project_id === p.id).length,
      done: tasks.filter((t) => t.project_id === p.id && (t as any).completed_at).length,
      notes: notes.filter((n) => n.project_id === p.id).length,
      docs: docs.filter((d) => d.project_id === p.id).length,
      files: assets.filter((a) => a.project_id === p.id).length,
      bytes: 0,
    }));
    return {
      path: "（浏览器预览模式 · 数据存在这个浏览器里）",
      db_file: `localStorage://${LS_KEY}`,
      db_bytes: dbBytes,
      is_default: true,
      default_path: "（浏览器预览模式）",
      pending: null,
      projects: stats,
      total_bytes: dbBytes,
    };
  },
  async pickFolder() {
    log("pick_folder");
    return null;
  },
  async changeDataDir() {
    log("change_data_dir");
    throw new Error("浏览器预览模式改不了数据位置，请用桌面版");
  },
  async openProjectDir(projectId: number) {
    log("open_project_dir", projectId);
    throw new Error("浏览器预览模式没有本地文件夹，请用桌面版");
  },
  async openProjectDb(projectId: number) {
    log("open_project_db", projectId);
    return; // 浏览器里所有项目共用一份内存数据，切项目不需要真的开库
  },

  async listEdges(projectId: number) {
    log("list_edges", projectId);
    return edges.filter((e) => e.project_id === projectId);
  },
  async createEdge(
    projectId: number,
    fromKind: "task" | "note",
    fromId: number,
    toKind: "task" | "note",
    toId: number,
    kind?: EdgeKind
  ) {
    log("create_edge", { projectId, fromKind, fromId, toKind, toId, kind });
    if (fromKind === toKind && fromId === toId) throw new Error("不能连接到自身");
    const dup = edges.find(
      (e) =>
        e.project_id === projectId &&
        e.from_kind === fromKind &&
        e.from_id === fromId &&
        e.to_kind === toKind &&
        e.to_id === toId
    );
    if (dup) return dup.id;
    const k: EdgeKind = kind ?? "decompose";
    const e: BoardEdge = {
      id: eid++,
      project_id: projectId,
      from_kind: fromKind,
      from_id: fromId,
      to_kind: toKind,
      to_id: toId,
      kind: k,
      strength: k === "evidence" ? 1 : 0,
    };
    edges.push(e);
    return e.id;
  },
  async updateEdge(id: number, patch: { kind?: EdgeKind; strength?: number }) {
    log("update_edge", { id, ...patch });
    const e = edges.find((x) => x.id === id);
    if (!e) return;
    if (patch.kind !== undefined) e.kind = patch.kind;
    if (patch.strength !== undefined) e.strength = patch.strength;
  },
  async deleteEdge(id: number) {
    log("delete_edge", id);
    const i = edges.findIndex((x) => x.id === id);
    if (i >= 0) edges.splice(i, 1);
  },

  // ---- 任务用到的资料与等级 ----
  async listTaskRefs(projectId: number) {
    log("list_task_refs", projectId);
    const taskIds = new Set(tasks.filter((t) => t.project_id === projectId).map((t) => t.id));
    return taskRefs
      .filter((r) => taskIds.has(r.task_id))
      .sort((a, b) => a.task_id - b.task_id || a.ord - b.ord || a.id - b.id);
  },
  async setTaskRef(
    projectId: number,
    taskId: number,
    noteId: number,
    level?: number,
    ord?: number,
    point?: string
  ) {
    log("set_task_ref", { projectId, taskId, noteId, level, ord, point });
    const lv = level ?? 1;
    const pt = (point ?? "").trim().slice(0, 2000);
    const old = taskRefs.find((r) => r.task_id === taskId && r.note_id === noteId);
    if (old) {
      old.level = lv as any;
      if (ord !== undefined) old.ord = ord;
      // 传了才覆盖：跟后端一致，换档不该清掉要点
      if (point !== undefined) old.point = pt;
      return old.id;
    }
    const nextOrd =
      ord ??
      taskRefs.filter((r) => r.task_id === taskId).reduce((m, r) => Math.max(m, r.ord), -1) + 1;
    const ref: TaskRef = {
      id: rid++,
      task_id: taskId,
      note_id: noteId,
      level: lv as any,
      ord: nextOrd,
      point: pt,
    };
    taskRefs.push(ref);
    return ref.id;
  },
  async deleteTaskRef(taskId: number, noteId: number) {
    log("delete_task_ref", { taskId, noteId });
    const i = taskRefs.findIndex((r) => r.task_id === taskId && r.note_id === noteId);
    if (i >= 0) taskRefs.splice(i, 1);
  },

  // ---- 写作模块：Markdown 文档 ----
  async listDocs(projectId: number) {
    log("list_docs", projectId);
    return docs
      .filter((d) => d.project_id === projectId)
      .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
  },
  async createDoc(projectId: number, title?: string, body?: string) {
    log("create_doc", { projectId, title });
    const now = new Date().toLocaleString("sv-SE");
    const maxOrder = docs
      .filter((d) => d.project_id === projectId)
      .reduce((m, d) => Math.max(m, d.sort_order), 0);
    const d: Doc = {
      id: did++,
      project_id: projectId,
      title: title || "未命名文档",
      body: body || "",
      sort_order: maxOrder + 1000,
      created_at: now,
      updated_at: now,
    };
    docs.push(d);
    return d.id;
  },
  async updateDoc(id: number, patch: any) {
    log("update_doc", { id, ...patch });
    const d = docs.find((x) => x.id === id);
    if (!d) return;
    if (patch.title !== undefined) d.title = patch.title;
    if (patch.body !== undefined) d.body = patch.body;
    if (patch.sort_order !== undefined) d.sort_order = patch.sort_order;
    d.updated_at = new Date().toLocaleString("sv-SE");
  },
  async deleteDoc(id: number) {
    log("delete_doc", id);
    const i = docs.findIndex((x) => x.id === id);
    if (i >= 0) docs.splice(i, 1);
  },

  async getSettings() {
    log("get_settings");
    return { theme: settings.theme || "light" };
  },
  async setSetting(key: string, value: string) {
    log("set_setting", { key, value });
    settings[key] = value;
  },

  async diagLog(message: string) {
    console.log("[diag]", message);
  },
  async diagDb() {
    log("diag_db");
    return "mock db OK";
  },

  /** 浏览器里没有"窗口"这个概念，空操作即可 */
  async showWindow() {
    /* 空操作 */
  },

  /** 启动性能探针：浏览器里直接打控制台 */
  async perfProbe(line: string) {
    console.log("[perf]", line);
  },

  /**
   * 浮动网页：浏览器预览里没有子 webview，直接抛错让 WebPane 退回 iframe 模式。
   * （抛错是故意的 —— WebPane 收到异常会自动切到 iframe，界面照样能用）
   */
  async floatWebOpen() {
    throw new Error("浏览器预览模式没有原生网页视图");
  },
  async floatWebBounds() {
    /* 空操作 */
  },
  async floatWebNavigate() {
    /* 空操作 */
  },
  async floatWebVisible() {
    /* 空操作 */
  },
  async floatWebClose() {
    /* 空操作 */
  },
  async floatWebZoom() {
    /* 空操作 */
  },
};

// ---------------------------------------------------------------
// 持久化：把这份 mock 数据写进 localStorage
//
// 浏览器预览模式没有后端，原本刷新就清空、每次打开都要重建项目。
// 现在每次「写操作」之后自动落盘，刷新 / 关掉标签页再打开都还在。
// 注意：数据存在这个浏览器里，换浏览器或清缓存会丢；要长期保存请用桌面版。
// ---------------------------------------------------------------

const LS_KEY = "kanban-mock-state-v1";

/** 不改变数据的方法，调用后不需要落盘 */
const READ_ONLY = new Set([
  "bootstrap", "listProjects", "listColumns", "listTasks", "listTags", "listTrash",
  "listNotes", "listEdges", "listTaskRefs", "listAssets", "getSettings", "diagLog", "diagDb",
  "readAssetDataUrl", "getDataDir", "openAsset", "revealAsset", "openDataDir",
  "findAssetByHash", "listDocs", "dataOverview", "pickFolder", "openProjectDb",
]);

function snapshot(withBlobs: boolean) {
  return {
    v: 1,
    pid, cid, tid, gid, nid, eid, did, rid,
    projects: [...projects],
    columns: [...columns],
    tasks: [...tasks],
    tags: [...tags],
    trash: [...trash],
    notes: [...notes],
    edges: [...edges],
    taskRefs: [...taskRefs],
    docs: [...docs],
    settings: { ...settings },
    assets: (window as any).__mockAssets || [],
    blobs: withBlobs ? (window as any).__mockBlobs || {} : {},
  };
}

function saveState() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(snapshot(true)));
  } catch {
    // 多半是 localStorage 配额爆了（上传的文件太大）—— 先丢掉文件内容，保住项目/任务
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(snapshot(false)));
    } catch {
      /* 还是存不下就放弃，不影响当前会话继续用 */
    }
  }
}

function loadState() {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(LS_KEY);
  } catch {
    return;
  }
  if (!raw) return;
  try {
    const d = JSON.parse(raw);
    if (!d || d.v !== 1) return;
    pid = d.pid ?? pid;
    cid = d.cid ?? cid;
    tid = d.tid ?? tid;
    gid = d.gid ?? gid;
    nid = d.nid ?? nid;
    eid = d.eid ?? eid;
    did = d.did ?? did;
    rid = d.rid ?? rid;
    const put = (arr: any[], src: any) => {
      arr.length = 0;
      if (Array.isArray(src)) arr.push(...src);
    };
    put(projects, d.projects);
    put(columns, d.columns);
    put(tasks, d.tasks);
    put(tags, d.tags);
    put(trash, d.trash);
    put(notes, d.notes);
    put(edges, d.edges);
    put(taskRefs, (d as any).taskRefs);
    put(docs, d.docs);
    if (d.settings) Object.assign(settings, d.settings);
    (window as any).__mockAssets = d.assets || [];
    (window as any).__mockBlobs = d.blobs || {};
  } catch {
    /* 数据损坏就当没存过 */
  }
}

loadState();

// 老存档里没有新字段：读进来时补默认值，避免界面拿到 undefined。
// 任务编号按「项目内顺序」补一次，跟桌面版打开老库时做的事一致。
(function upgradeLoadedState() {
  const byProject = new Map<number, number>();
  for (const t of tasks) {
    if (!t.seq) {
      const cur = byProject.get(t.project_id) ?? 0;
      t.seq = cur + 1;
      byProject.set(t.project_id, t.seq);
    } else {
      byProject.set(t.project_id, Math.max(byProject.get(t.project_id) ?? 0, t.seq));
    }
  }
  for (const e of edges) {
    if (!e.kind) e.kind = "decompose";
    if (e.strength === undefined) e.strength = 0;
  }
  for (const n of notes) {
    if (n.role === undefined) n.role = "";
    if (n.group_kind === undefined) n.group_kind = "";
  }
})();

/** 清空浏览器本地数据（想重置时用） */
export function clearMockState() {
  try {
    localStorage.removeItem(LS_KEY);
  } catch {
    /* ignore */
  }
  (window as any).__mockAssets = [];
  (window as any).__mockBlobs = {};
}

// 所有调用都包一层：写操作完成后落盘。数据量小，开销可以忽略。
export const mockApi = new Proxy(apiImpl, {
  get(target: any, prop: string | symbol) {
    const fn = target[prop];
    if (typeof fn !== "function") return fn;
    return (...args: any[]) => {
      const r = fn.apply(target, args);
      const skip = typeof prop === "string" && READ_ONLY.has(prop);
      if (r && typeof r.then === "function") {
        return skip ? r : r.then((v: any) => { saveState(); return v; });
      }
      if (!skip) saveState();
      return r;
    };
  },
}) as unknown as typeof apiImpl;
