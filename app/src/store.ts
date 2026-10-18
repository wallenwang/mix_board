import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { api } from "./api";
import { daysLeft } from "./due";
import { reportError } from "./diag";
import type { Project, Column, Task, Tag, BoardNote, BoardEdge, WbFile, Doc } from "./types";

export const useBoardStore = defineStore("board", () => {
  const projects = ref<Project[]>([]);
  const columns = ref<Column[]>([]);
  const tasksByCol = ref<Record<number, Task[]>>({});
  const tags = ref<Tag[]>([]);
  const notes = ref<BoardNote[]>([]);
  const edges = ref<BoardEdge[]>([]);
  const assets = ref<WbFile[]>([]);
  const docs = ref<Doc[]>([]);
  const currentProjectId = ref<number | null>(null);
  const theme = ref<"light" | "dark">("light");
  const loaded = ref(false);
  /** 分屏比例：左侧看板占多少（0.15 ~ 0.85） */
  const splitRatio = ref(0.5);

  // filters
  const filterSearch = ref("");
  const filterPriority = ref<number | null>(null);
  const filterTags = ref<number[]>([]);

  const currentProject = computed(
    () => projects.value.find((p) => p.id === currentProjectId.value) ?? null
  );

  const hasFilter = computed(
    () =>
      filterSearch.value.trim() !== "" ||
      filterPriority.value !== null ||
      filterTags.value.length > 0
  );

  function matchFilter(t: Task): boolean {
    const q = filterSearch.value.trim().toLowerCase();
    if (q && !t.title.toLowerCase().includes(q) && !t.description.toLowerCase().includes(q))
      return false;
    if (filterPriority.value !== null && t.priority !== filterPriority.value) return false;
    if (filterTags.value.length && !filterTags.value.every((tag) => t.tags.includes(tag)))
      return false;
    return true;
  }

  const totalTaskCount = computed(() =>
    Object.values(tasksByCol.value).reduce((n, l) => n + l.length, 0)
  );

  // flat task list (whiteboard uses this to place nodes)
  const allTasks = computed<Task[]>(() =>
    Object.values(tasksByCol.value).flat()
  );

  function tagOf(id: number): Tag | undefined {
    return tags.value.find((t) => t.id === id);
  }

  // full list for a column (drag source of truth). Returns the live array so
  // vue-draggable can mutate it in place; it's sorted once in rebuildByCol.
  function sortedCol(colId: number): Task[] {
    return tasksByCol.value[colId] ?? [];
  }

  // count of tasks in a column that pass the current filter
  function visibleCount(colId: number): number {
    return sortedCol(colId).filter(matchFilter).length;
  }

  function fileById(id: number | null | undefined): WbFile | undefined {
    if (id == null) return undefined;
    return assets.value.find((f) => f.id === id);
  }

  async function loadBootstrap() {
    const data = await api.bootstrap();
    projects.value = data.projects;
    theme.value = data.settings.theme === "dark" ? "dark" : "light";
    currentProjectId.value = data.current_project_id ?? data.projects[0]?.id ?? null;
    if (currentProjectId.value != null) await loadProject(currentProjectId.value);
    loaded.value = true;
  }

  async function loadProject(id: number) {
    // 一个项目一份库：先让后端把这个项目的库打开，再读数据
    await api.openProjectDb(id);
    currentProjectId.value = id;
    const [cols, tsk, tg, nts, eds, fls, dcs] = await Promise.all([
      api.listColumns(id),
      api.listTasks(id),
      api.listTags(id),
      api.listNotes(id),
      api.listEdges(id),
      api.listAssets(id),
      api.listDocs(id),
    ]);
    columns.value = cols;
    tags.value = tg;
    notes.value = nts;
    edges.value = eds;
    assets.value = fls;
    docs.value = dcs;
    rebuildByCol(tsk);
    api.setSetting("current_project_id", String(id)).catch(() => {});
  }

  function rebuildByCol(tsk: Task[]) {
    const map: Record<number, Task[]> = {};
    for (const t of tsk) {
      // 浅拷贝一份：让引用每次都变。
      // 直接沿用后端返回的同一个对象时，就地改字段（标题/备注等）不会触发
      // 看板卡片的重新渲染 —— 表现就是"白板改了，看板还是旧的"。
      (map[t.column_id] ??= []).push({ ...t });
    }
    // sort each column once by persisted order
    for (const k of Object.keys(map)) {
      map[Number(k)].sort((a, b) => a.sort_order - b.sort_order);
    }
    tasksByCol.value = map;
  }

  async function refreshTasks() {
    if (currentProjectId.value == null) return;
    const tsk = await api.listTasks(currentProjectId.value);
    rebuildByCol(tsk);
  }

  async function refreshColumns() {
    if (currentProjectId.value == null) return;
    columns.value = await api.listColumns(currentProjectId.value);
  }

  async function refreshBoard() {
    if (currentProjectId.value == null) return;
    const [nts, eds, fls] = await Promise.all([
      api.listNotes(currentProjectId.value),
      api.listEdges(currentProjectId.value),
      api.listAssets(currentProjectId.value),
    ]);
    notes.value = nts;
    edges.value = eds;
    assets.value = fls;
  }

  async function refreshProjects() {
    projects.value = await api.listProjects();
  }

  async function refreshDocs() {
    if (currentProjectId.value == null) return;
    docs.value = await api.listDocs(currentProjectId.value);
  }

  /**
   * 白板点文档卡片的「↗ 去写作」用：App.vue 监听它把写作栏打开，
   * WriteView 再监听它切到对应文档。带 seq 是为了同一篇反复点也能触发。
   */
  const docFocus = ref<{ id: number; seq: number } | null>(null);
  function focusDoc(id: number) {
    docFocus.value = { id, seq: (docFocus.value?.seq ?? 0) + 1 };
  }

  /**
   * 写作栏（现在叫「文档」栏）当前打开的是哪一篇。
   * 白板上右键图片「发送到文档」时要知道插到哪一篇里。
   */
  const activeDocId = ref<number | null>(null);
  function setActiveDoc(id: number | null) {
    activeDocId.value = id;
  }

  /**
   * 「把这段 Markdown 插到文档光标处」的信号。
   * 白板右键图片 → 这里发一条，App.vue 负责把文档栏打开，
   * WriteView 负责真正插进编辑器（它才知道光标在哪）。
   */
  const docInsert = ref<{ md: string; docId: number | null; seq: number } | null>(null);
  function insertIntoDoc(md: string) {
    if (!md) return;
    docInsert.value = {
      md,
      docId: activeDocId.value,
      seq: (docInsert.value?.seq ?? 0) + 1,
    };
  }
  /**
   * 取走这条插入请求（取完就清空）。
   * 文档栏是"打开才挂载"的：请求可能先到、组件后到，
   * 所以组件挂载时要能把它捞出来，而且只能被处理一次。
   */
  function takeDocInsert() {
    const v = docInsert.value;
    docInsert.value = null;
    return v;
  }

  /**
   * 文档被「外部」改动的信号（目前只有白板上的文档卡片就地编辑这一条路）。
   * 写作栏自己也持有 body 的本地副本，不看这个信号的话，
   * 白板里改了字、写作栏还显示旧的 —— 两边看着不是同一篇。
   */
  const docTouched = ref<{ id: number; seq: number } | null>(null);
  function touchDoc(id: number) {
    docTouched.value = { id, seq: (docTouched.value?.seq ?? 0) + 1 };
  }

  /** 按 id 找文档（白板渲染文档节点摘要用） */
  function docById(id: number | null | undefined): Doc | undefined {
    if (id == null) return undefined;
    return docs.value.find((d) => d.id === id);
  }

  async function setTheme(t: "light" | "dark") {
    theme.value = t;
    document.documentElement.classList.toggle("dark", t === "dark");
    api.setSetting("theme", t).catch(() => {});
  }

  function applyTheme() {
    document.documentElement.classList.toggle("dark", theme.value === "dark");
  }

  async function switchProject(id: number) {
    if (id === currentProjectId.value) return;
    await loadProject(id);
  }

  /** 拖分割条时实时改；松手时落库 */
  function setSplitRatio(v: number, persist = false) {
    const clamped = Math.min(0.85, Math.max(0.15, v));
    splitRatio.value = clamped;
    if (persist) api.setSetting("split_ratio", String(clamped)).catch(() => {});
  }

  /** task → task 的父子关系（来自白板连线：from = 父，to = 子） */
  const taskParentOf = computed(() => {
    const m = new Map<number, number>();
    for (const e of edges.value) {
      if (e.from_kind !== "task" || e.to_kind !== "task") continue;
      if (e.from_id === e.to_id) continue;
      m.set(e.to_id, e.from_id);
    }
    return m;
  });

  /** 任务的层级深度（根 = 0）；遇环也不会死循环 */
  function taskDepth(id: number): number {
    const parentOf = taskParentOf.value;
    const seen = new Set<number>([id]);
    let cur = id;
    let d = 0;
    while (d < 30) {
      const p = parentOf.get(cur);
      if (p == null || seen.has(p)) break;
      seen.add(p);
      cur = p;
      d++;
    }
    return d;
  }

  /** 某任务的全部后代（层序：父在前、子在后），用于「拖父任务时下级跟着走」 */
  function taskDescendants(id: number): number[] {
    const kidsOf = new Map<number, number[]>();
    for (const e of edges.value) {
      if (e.from_kind !== "task" || e.to_kind !== "task") continue;
      const arr = kidsOf.get(e.from_id);
      if (arr) arr.push(e.to_id);
      else kidsOf.set(e.from_id, [e.to_id]);
    }
    const out: number[] = [];
    const seen = new Set<number>([id]);
    const queue: number[] = [id];
    while (queue.length) {
      const cur = queue.shift() as number;
      for (const k of kidsOf.get(cur) ?? []) {
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(k);
        queue.push(k);
      }
    }
    return out;
  }

  /** 直接子任务数量（看板卡片上做标记用） */
  function taskChildCount(id: number): number {
    return edges.value.filter(
      (e) => e.from_kind === "task" && e.to_kind === "task" && e.from_id === id
    ).length;
  }

  // ---------- 进度 / 截止日期 ----------

  /** 勾「完成」：盖/清 completed_at。卡片立刻变色，事后统一刷库 */
  async function toggleDone(id: number) {
    const t = allTasks.value.find((x) => x.id === id);
    if (!t) return;
    const next = !t.completed_at;
    const copy = { ...t, completed_at: next ? new Date().toLocaleString("sv-SE") : null } as Task;
    rebuildByCol(patchTaskEverywhere(copy));
    try {
      await api.updateTask(id, { completed: next });
      void refreshTasks();
    } catch (e) {
      reportError("标记完成", e);
      void refreshTasks();
    }
  }

  /** 改计划开始/截止日期（甘特图和紧迫度都吃这两个值） */
  async function setDates(
    id: number,
    patch: { start_date?: string | null; due_date?: string | null }
  ) {
    const t = allTasks.value.find((x) => x.id === id);
    if (!t) return;
    rebuildByCol(patchTaskEverywhere({ ...t, ...patch }));
    try {
      await api.updateTask(id, patch);
      void refreshTasks();
    } catch (e) {
      reportError("修改日期", e);
      void refreshTasks();
    }
  }

  /** 手动设进度百分比（甘特图上拖/输入都用它） */
  async function setProgress(id: number, pct: number) {
    const v = Math.max(0, Math.min(100, Math.round(pct)));
    const t = allTasks.value.find((x) => x.id === id);
    if (!t) return;
    rebuildByCol(patchTaskEverywhere({ ...t, progress: v } as Task));
    try {
      await api.updateTask(id, { progress: v });
    } catch (e) {
      reportError("修改进度", e);
    }
  }

  /** 手动指定甘特条颜色（null = 恢复按截止日期紧迫度自动配色） */
  async function setBarColor(id: number, color: string | null) {
    const t = allTasks.value.find((x) => x.id === id);
    if (!t) return;
    rebuildByCol(patchTaskEverywhere({ ...t, bar_color: color } as Task));
    try {
      await api.updateTask(id, { bar_color: color });
    } catch (e) {
      reportError("设置甘特条颜色", e);
    }
  }

  /** 用一份新对象替换 tasksByCol 里的旧对象（Vue 才认这是变化，UI 才会重绘） */
  function patchTaskEverywhere(next: Task): Task[] {
    const out: Task[] = [];
    for (const list of Object.values(tasksByCol.value)) {
      for (const x of list) out.push(x.id === next.id ? next : x);
    }
    return out;
  }

  /** 某一列的完成进度 */
  function colProgress(columnId: number): { done: number; total: number; pct: number } {
    const list = tasksByCol.value[columnId] ?? [];
    const total = list.length;
    const done = list.filter((t) => t.completed_at).length;
    return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
  }

  /** 整个项目的完成进度 */
  const projectProgress = computed(() => {
    const list = allTasks.value;
    const total = list.length;
    const done = list.filter((t) => t.completed_at).length;
    return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
  });

  /** 有截止日期且已经逾期的任务（侧栏「⚠️ 逾期」用） */
  const overdueTasks = computed(() =>
    allTasks.value.filter(
      (t) => t.due_date && !t.completed_at && (daysLeft(t.due_date) ?? 0) < 0
    )
  );

  return {
    projects, columns, tasksByCol, tags, notes, edges, assets, docs, currentProjectId, currentProject,
    theme, loaded, splitRatio,
    filterSearch, filterPriority, filterTags, hasFilter, matchFilter, totalTaskCount,
    allTasks, tagOf, fileById, sortedCol, visibleCount,
    taskParentOf, taskDepth, taskDescendants, taskChildCount,
    toggleDone, setDates, setProgress, setBarColor, colProgress, projectProgress, overdueTasks,
    loadBootstrap, loadProject, refreshTasks, refreshColumns, refreshProjects, refreshBoard,
    refreshDocs, docFocus, focusDoc, docTouched, touchDoc, docById,
    activeDocId, setActiveDoc, docInsert, insertIntoDoc, takeDocInsert,
    setTheme, applyTheme, switchProject, rebuildByCol, setSplitRatio,
  };
});
