import { invoke } from "@tauri-apps/api/core";
import type {
  Project,
  Column,
  Task,
  Tag,
  TrashItem,
  BoardNote,
  BoardEdge,
  WbFile,
  Doc,
} from "./types";
import { mockApi } from "./mock";

/** 单个项目在数据文件夹里占了多少、里面有什么 */
export interface ProjectStat {
  id: number;
  name: string;
  folder: string;
  tasks: number;
  done: number;
  notes: number;
  docs: number;
  files: number;
  bytes: number;
}

/** 数据存储总览 */
export interface DataOverview {
  path: string;
  db_file: string;
  db_bytes: number;
  is_default: boolean;
  default_path: string;
  /** 上次指定的位置打不开了，这里是被记下来的那个路径 */
  pending: string | null;
  projects: ProjectStat[];
  total_bytes: number;
}

export interface MigrateReport {
  from: string;
  to: string;
  db_bytes: number;
  folder_bytes: number;
  folders: number;
  leftover: string;
}

// When running in a plain browser (no Tauri backend), fall back to an
// in-memory mock so the UI can be developed/tested. The desktop app always
// has Tauri, so it uses the real commands below.
const hasTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in (window as any);

const real = {
  bootstrap: () =>
    invoke<{ projects: Project[]; settings: { theme: string }; current_project_id: number | null }>("bootstrap"),

  // projects
  listProjects: () => invoke<Project[]>("list_projects"),
  createProject: (name: string, color?: string, icon?: string) =>
    invoke<number>("create_project", { name, color, icon }),
  updateProject: (id: number, patch: { name?: string; color?: string; icon?: string }) =>
    invoke<void>("update_project", { id, ...patch }),
  deleteProject: (id: number) => invoke<void>("delete_project", { id }),
  reorderProjects: (orderedIds: number[]) => invoke<void>("reorder_projects", { orderedIds }),

  // columns
  listColumns: (projectId: number) => invoke<Column[]>("list_columns", { projectId }),
  createColumn: (projectId: number, name: string, color?: string) =>
    invoke<number>("create_column", { projectId, name, color }),
  updateColumn: (
    id: number,
    patch: { name?: string; color?: string; wipLimit?: number | null; collapsed?: boolean }
  ) => invoke<void>("update_column", { id, ...patch }),
  deleteColumn: (id: number) => invoke<void>("delete_column", { id }),
  reorderColumns: (projectId: number, orderedIds: number[]) =>
    invoke<void>("reorder_columns", { projectId, orderedIds }),

  // tasks
  listTasks: (projectId: number) => invoke<Task[]>("list_tasks", { projectId }),
  createTask: (task: {
    project_id: number;
    column_id: number;
    title: string;
    description?: string;
    priority?: number;
    due_date?: string | null;
    start_date?: string | null;
    tags?: number[];
  }) => invoke<number>("create_task", { task }),
  updateTask: (
    id: number,
    patch: {
      title?: string;
      description?: string;
      priority?: number;
      due_date?: string | null;
      start_date?: string | null;
      progress?: number | null;
      completed?: boolean;
      tags?: number[];
    }
  ) => invoke<void>("update_task", { id, patch }),
  moveTask: (id: number, columnId: number, sortOrder: number) =>
    invoke<void>("move_task", { id, columnId, sortOrder }),
  deleteTask: (id: number) => invoke<void>("delete_task", { id }),
  restoreTask: (id: number) => invoke<void>("restore_task", { id }),
  purgeTask: (id: number) => invoke<void>("purge_task", { id }),
  setTaskPos: (id: number, wx: number, wy: number) =>
    invoke<void>("set_task_pos", { id, wx, wy }),

  // whiteboard notes / nodes
  listNotes: (projectId: number) => invoke<BoardNote[]>("list_notes", { projectId }),
  createNote: (note: {
    project_id: number;
    x: number;
    y: number;
    text?: string;
    color?: string;
    kind?: string;
    w?: number | null;
    h?: number | null;
    file_id?: number | null;
    meta?: string;
  }) =>
    invoke<number>("create_note", {
      projectId: note.project_id,
      x: note.x,
      y: note.y,
      text: note.text ?? "",
      color: note.color ?? "#FFF9C4",
      kind: note.kind ?? "note",
      w: note.w ?? null,
      h: note.h ?? null,
      fileId: note.file_id ?? null,
      meta: note.meta ?? "",
    }),
  updateNote: (
    id: number,
    patch: {
      x?: number;
      y?: number;
      text?: string;
      color?: string;
      kind?: string;
      w?: number | null;
      h?: number | null;
      file_id?: number | null;
      meta?: string;
    }
  ) => invoke<void>("update_note", { id, patch }),
  deleteNote: (id: number) => invoke<void>("delete_note", { id }),

  // whiteboard edges (connections between nodes)
  listEdges: (projectId: number) => invoke<BoardEdge[]>("list_edges", { projectId }),
  createEdge: (
    projectId: number,
    fromKind: "task" | "note",
    fromId: number,
    toKind: "task" | "note",
    toId: number
  ) =>
    invoke<number>("create_edge", {
      projectId,
      fromKind,
      fromId,
      toKind,
      toId,
    }),
  deleteEdge: (id: number) => invoke<void>("delete_edge", { id }),

  // whiteboard assets (uploaded files / images, stored under <app_data>/assets)
  listAssets: (projectId: number) => invoke<WbFile[]>("list_assets", { projectId }),
  importAsset: (projectId: number, name: string, mime: string, dataB64: string, sha256?: string) =>
    invoke<WbFile>("import_asset", { projectId, name, mime, dataB64, sha256: sha256 ?? "" }),
  deleteAsset: (id: number) => invoke<void>("delete_asset", { id }),
  openAsset: (id: number) => invoke<void>("open_asset", { id }),
  revealAsset: (id: number) => invoke<void>("reveal_asset", { id }),
  readAssetDataUrl: (id: number) => invoke<string>("read_asset_data_url", { id }),
  /** 按内容指纹查已存在的同款资料（复用，不重复存） */
  findAssetByHash: (projectId: number, sha256: string) =>
    invoke<WbFile | null>("find_asset_by_hash", { projectId, sha256 }),

  // 写作模块：Markdown 文档
  listDocs: (projectId: number) => invoke<Doc[]>("list_docs", { projectId }),
  createDoc: (projectId: number, title?: string, body?: string) =>
    invoke<number>("create_doc", { projectId, title, body }),
  updateDoc: (id: number, patch: { title?: string; body?: string; sort_order?: number }) =>
    invoke<void>("update_doc", { id, patch }),
  deleteDoc: (id: number) => invoke<void>("delete_doc", { id }),

  // 数据目录（设置面板里展示 / 打开，方便用户自己备份）
  getDataDir: () => invoke<string>("get_data_dir"),
  openDataDir: () => invoke<void>("open_data_dir"),
  /** 数据存储总览：位置、每个项目占多少、有哪些附件 */
  dataOverview: () => invoke<DataOverview>("data_overview"),
  /** 弹系统文件夹选择框，取消返回 null */
  pickFolder: () => invoke<string | null>("pick_folder"),
  /** 换一个文件夹保存：整体迁移后立即切过去用 */
  changeDataDir: (newRoot: string) =>
    invoke<MigrateReport>("change_data_dir", { newRoot }),
  /** 打开某个项目自己的数据文件夹 */
  openProjectDir: (projectId: number) =>
    invoke<void>("open_project_dir", { projectId }),
  /** 切到某个项目：后端打开它的库（一个项目一份库） */
  openProjectDb: (projectId: number) =>
    invoke<void>("open_project_db", { projectId }),

  // trash
  listTrash: () => invoke<TrashItem[]>("list_trash"),
  emptyTrash: () => invoke<void>("empty_trash"),

  // tags
  listTags: (projectId: number) => invoke<Tag[]>("list_tags", { projectId }),
  createTag: (projectId: number, name: string, color?: string) =>
    invoke<number>("create_tag", { projectId, name, color }),
  deleteTag: (id: number) => invoke<void>("delete_tag", { id }),

  // settings
  getSettings: () => invoke<{ theme: string }>("get_settings"),
  setSetting: (key: string, value: string) => invoke<void>("set_setting_kv", { key, value }),

  // diagnostics
  diagLog: (message: string) => invoke<void>("diag_log", { message }),
  diagDb: () => invoke<string>("diag_db"),

  // 窗口
  /** 首帧渲染完成后调用：把隐藏的主窗口亮出来（浏览器预览模式下是空操作） */
  showWindow: () => (hasTauri ? invoke<void>("show_main_window") : Promise.resolve()),

  /** 启动性能探针：写进 <数据目录>/perf.log（排查卡顿用，不影响功能） */
  perfProbe: (line: string) =>
    hasTauri ? invoke<void>("perf_probe", { line }) : Promise.resolve(),

  // 浮动网页：用**子 webview**（真内核），不是 iframe
  floatWebOpen: (url: string, x: number, y: number, w: number, h: number) =>
    invoke<void>("float_web_open", { url, x, y, w, h }),
  floatWebBounds: (x: number, y: number, w: number, h: number) =>
    invoke<void>("float_web_bounds", { x, y, w, h }),
  floatWebNavigate: (url: string) => invoke<void>("float_web_navigate", { url }),
  floatWebVisible: (on: boolean) => invoke<void>("float_web_visible", { on }),
  floatWebClose: () => invoke<void>("float_web_close"),
  floatWebZoom: (zoom: number) => invoke<void>("float_web_set_zoom", { zoom }),
};

// In the desktop app, use real Tauri commands; in a plain browser, use the mock.
export const api: typeof real = hasTauri ? real : (mockApi as any);

/** 是否跑在桌面壳里（浏览器预览模式下没有真实文件系统） */
export const isTauri = hasTauri;
