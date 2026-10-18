/**
 * 把 store 里的数据翻译成"可导出"的形状。
 *
 * 看板导出 Markdown/Word、写作模块里「从看板/白板生成大纲」，都从这里取数据，
 * 保证三处看到的层级完全一致（父任务/子任务、导图分支都靠 board_edges 推导）。
 */

import { useBoardStore } from "./store";
import { priorityOf } from "./types";
import type { Task } from "./types";
import type { ExportColumn, ExportTask } from "./exportMd";

/** 默认优先级"中"不标注，免得每条都挂个没信息量的标签 */
const DEFAULT_PRIORITY = 2;

export function boardColumns(): ExportColumn[] {
  const store = useBoardStore();
  const parentOf = store.taskParentOf;
  const kidsOf = new Map<number, number[]>();
  for (const [child, parent] of parentOf) {
    const arr = kidsOf.get(parent);
    if (arr) arr.push(child);
    else kidsOf.set(parent, [child]);
  }
  const byId = new Map<number, Task>(store.allTasks.map((t) => [t.id, t]));

  const toTask = (t: Task): ExportTask => ({
    title: t.title,
    description: t.description,
    priority: t.priority === DEFAULT_PRIORITY ? "" : priorityOf(t.priority).label,
    due: t.due_date,
    tags: (t.tags ?? []).map((id) => store.tagOf(id)?.name ?? "").filter(Boolean),
    done: !!t.completed_at,
    children: (kidsOf.get(t.id) ?? [])
      .map((id) => byId.get(id))
      .filter((x): x is Task => !!x)
      .map((x) => toTask(x)),
  });

  return store.columns.map((c) => {
    const list = store.sortedCol(c.id);
    const roots = list.filter((t) => !parentOf.has(t.id));
    return { name: c.name, tasks: roots.map((t) => toTask(t)) };
  });
}

/** 看板导出用的完整列（含空列也一样给，便于看出工作流全貌） */
export function boardExportColumns(includeEmpty = true): ExportColumn[] {
  const cols = boardColumns();
  return includeEmpty ? cols : cols.filter((c) => c.tasks.length > 0);
}

/**
 * 白板（任务 + 导图节点）→ 缩进大纲文本。
 * 走的是同一张 board_edges 图，所以和「整理布局」看到的树是同一棵。
 */
export function whiteboardOutlineText(): { text: string; count: number } {
  const store = useBoardStore();
  const keyOf = (kind: string, id: number) => `${kind}:${id}`;

  const label = (kind: string, id: number): string | null => {
    if (kind === "task") {
      const t = store.allTasks.find((x) => x.id === id);
      if (!t) return null;
      return `${t.completed_at ? "☑" : "☐"} ${t.title}`;
    }
    const n = store.notes.find((x) => x.id === id);
    if (!n) return null;
    if (n.kind === "file") return `📎 ${n.text || "资料"}`;
    if (n.kind === "box") return null;
    return n.text || "";
  };

  const kids = new Map<string, string[]>();
  const hasParent = new Set<string>();
  for (const e of store.edges) {
    const a = keyOf(e.from_kind, e.from_id);
    const b = keyOf(e.to_kind, e.to_id);
    const arr = kids.get(a);
    if (arr) arr.push(b);
    else kids.set(a, [b]);
    hasParent.add(b);
  }

  const allKeys: string[] = [];
  for (const t of store.allTasks) allKeys.push(keyOf("task", t.id));
  for (const n of store.notes) {
    if (n.kind === "box") continue; // 分组框只是视觉容器，不进大纲
    allKeys.push(keyOf("note", n.id));
  }

  interface Row {
    key: string;
    depth: number;
  }
  const rows: Row[] = [];
  const seen = new Set<string>();
  const walk = (key: string, depth: number) => {
    if (seen.has(key) || depth > 12) return;
    seen.add(key);
    rows.push({ key, depth });
    for (const k of kids.get(key) ?? []) walk(k, depth + 1);
  };
  for (const k of allKeys) if (!hasParent.has(k)) walk(k, 0);
  // 环里没被游走到的，兜底补上
  for (const k of allKeys) if (!seen.has(k)) walk(k, 0);

  const text = rows
    .map((r) => {
      const [kind, id] = r.key.split(":");
      const lb = label(kind, Number(id)) ?? "";
      return `${"  ".repeat(r.depth)}${lb}`;
    })
    .join("\n");

  return { text, count: rows.length };
}

/** 白板导图 → 只保留思维导图节点的版本（任务不出现在导图大纲里时用） */
export function mindOnlyOutlineText(): { text: string; count: number } {
  const store = useBoardStore();
  const minds = new Set(store.notes.filter((n) => n.kind === "mind").map((n) => n.id));
  const kids = new Map<number, number[]>();
  const hasParent = new Set<number>();
  for (const e of store.edges) {
    if (e.from_kind !== "note" || e.to_kind !== "note") continue;
    if (!minds.has(e.from_id) || !minds.has(e.to_id)) continue;
    const arr = kids.get(e.from_id);
    if (arr) arr.push(e.to_id);
    else kids.set(e.from_id, [e.to_id]);
    hasParent.add(e.to_id);
  }
  const byId = new Map(store.notes.map((n) => [n.id, n]));
  const rows: { id: number; depth: number }[] = [];
  const seen = new Set<number>();
  const walk = (id: number, depth: number) => {
    if (seen.has(id) || depth > 12) return;
    seen.add(id);
    rows.push({ id, depth });
    for (const k of kids.get(id) ?? []) walk(k, depth + 1);
  };
  for (const id of minds) if (!hasParent.has(id)) walk(id, 0);
  for (const id of minds) if (!seen.has(id)) walk(id, 0);

  const text = rows
    .map((r) => `${"  ".repeat(r.depth)}${byId.get(r.id)?.text ?? ""}`)
    .join("\n");
  return { text, count: rows.length };
}
