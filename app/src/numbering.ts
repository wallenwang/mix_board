/**
 * 任务的层级编号。
 *
 * 规则：父任务 T2 的子任务是 T2.1、T2.2，再下一层是 T2.1.1。
 *
 * 为什么编号是算出来的、不存进数据库：
 * 把 T3 挂到 T2 下面，它就应该是 T2.1，不是 T3。只要编号存在库里，
 * 这种"结构变了、号也该变"的时刻就得靠代码去同步，漏一处就前后不一致。
 * 每帧按当前结构算一遍，成本很低（一个项目几十个任务），永远不会错位。
 *
 * 库里保留的 tasks.seq 只用来决定同层之间的先后（按创建顺序），
 * 所以拖动、改列都不影响编号稳定性，只有父子关系变化才会变。
 */

import type { Task, BoardEdge } from "./types";

/**
 * 只有"分解"边表达父子归属；先后、依据、产出都不改变层级。
 *
 * ⚠️ 方向是**子 → 父**（from 是子、to 是父）：箭头指向被支撑的一方，
 * 跟依据（资料→任务）、先后（前置→后续）、产出（任务→产出物）保持同一套语义。
 */
function isParentEdge(e: BoardEdge, ids: Set<number>): boolean {
  return (
    e.kind === "decompose" &&
    e.from_kind === "task" &&
    e.to_kind === "task" &&
    e.from_id !== e.to_id &&
    ids.has(e.from_id) &&
    ids.has(e.to_id)
  );
}

/**
 * 算出每个任务的编号。
 * 返回 任务 id → 编号字符串（"1" / "2.1" / "2.1.3"）。
 */
export function computeTaskNumbers(tasks: Task[], edges: BoardEdge[]): Map<number, string> {
  const out = new Map<number, string>();
  if (!tasks.length) return out;

  const ids = new Set(tasks.map((t) => t.id));
  const byId = new Map(tasks.map((t) => [t.id, t]));

  // 一个任务只能有一个上级，多条分解边时取第一条，避免编号打架。
  // 边的方向是子 → 父，所以 from 的上级是 to。
  const parent = new Map<number, number>();
  for (const e of edges) {
    if (!isParentEdge(e, ids)) continue;
    if (parent.has(e.from_id)) continue;
    parent.set(e.from_id, e.to_id);
  }

  // 环保护：顺着上级往上走，走回自己就把这条边断掉。
  // 没有这一步，画出一个圈就会让下面的遍历无限递归。
  for (const child of [...parent.keys()]) {
    const seen = new Set<number>([child]);
    let cur = parent.get(child);
    while (cur != null) {
      if (seen.has(cur)) {
        parent.delete(child);
        break;
      }
      seen.add(cur);
      cur = parent.get(cur);
    }
  }

  const kids = new Map<number, number[]>();
  const roots: number[] = [];
  for (const t of tasks) {
    const p = parent.get(t.id);
    if (p == null) {
      roots.push(t.id);
    } else {
      const arr = kids.get(p);
      if (arr) arr.push(t.id);
      else kids.set(p, [t.id]);
    }
  }

  // 同层按创建顺序（seq），不看它现在在哪一列 —— 换列不该改号
  const bySeq = (a: number, b: number) => {
    const sa = byId.get(a)?.seq ?? 0;
    const sb = byId.get(b)?.seq ?? 0;
    return sa - sb || a - b;
  };
  roots.sort(bySeq);

  const walk = (id: number, label: string) => {
    out.set(id, label);
    const children = (kids.get(id) ?? []).sort(bySeq);
    children.forEach((cid, i) => walk(cid, `${label}.${i + 1}`));
  };
  roots.forEach((id, i) => walk(id, String(i + 1)));

  return out;
}
