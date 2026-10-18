/**
 * 截止日期的「紧迫度」与配色。
 *
 * 规则（颜色越暖 = 越紧迫，用户一眼就能看出该先干哪件）：
 *   已完成            → 绿    #67C23A
 *   已经过期          → 红    #F56C6C（再加一层深色描边，逾期最扎眼）
 *   今天到期 / ≤3 天  → 橙    #E6A23C
 *   ≤7 天            → 黄    #D9C36A
 *   >7 天             → 中性  （白 / 灰，不抢注意力）
 *   没有截止日期      → 中性
 *
 * 天数一律按**自然天**算：今天到期算 0 天，逾期为负数；
 * 有具体时刻的（比如 18:00 截止）当天仍算 0 天，过了当天才算逾期。
 *
 * 日期取本机时间（new Date）—— 用户说"要不要调网络日期"：
 * 本机时钟就是唯一可信来源，网络时间反而会因为时区/网络问题引入误差。
 */
import type { Task } from "./types";

/** 今天 0 点的时间戳（每次调用取一次，当天不会跨天漂） */
function todayStart(now = new Date()): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

/**
 * 解析数据库里的日期字符串。
 * 兼容三种常见写法：`2026-10-20`、`2026-10-20 18:00:00`（SQLite datetime 格式）、
 * 以及完整 ISO 串。空格格式必须替换成 T，否则 Safari/WebView 会当成无效日期。
 */
export function parseDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const raw = String(s).trim();
  if (!raw) return null;
  const iso = /^\d{4}-\d{2}-\d{2} /.test(raw) ? raw.replace(" ", "T") : raw;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  // 只有年月日时，Safari 对 "2026-10-20" 也可能按 UTC 解析，这里统一按本地时间校正
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    d.setTime(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime());
  }
  return d;
}

/** 距今天还有几天：今天=0，明天=1，已过期为负 */
export function daysLeft(due: string | null | undefined, now = new Date()): number | null {
  const d = parseDate(due);
  if (!d) return null;
  const start = todayStart(now);
  const dueDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((dueDay - start) / 86400000);
}

export type Urgency = "done" | "overdue" | "today" | "soon" | "normal";

/** 紧迫度分级 */
export function urgencyOf(t: Pick<Task, "due_date" | "completed_at">, now = new Date()): Urgency {
  if (t.completed_at) return "done";
  const left = daysLeft(t.due_date, now);
  if (left === null) return "normal";
  if (left < 0) return "overdue";
  if (left <= 3) return "today";
  if (left <= 7) return "soon";
  return "normal";
}

/** 卡片左边条 / 徽章用的颜色 */
/**
 * ⚠️ 这里必须是具体色值，不能写成 var(--ok) 之类 ——
 * 白板/看板导出走 Canvas 2D，`ctx.fillStyle = "var(--ok)"` 是无效值。
 * 色值跟着 styles.css 的令牌走（--ok / --danger / --warn / --text-faint）。
 */
export const URGENCY_COLOR: Record<Urgency, string> = {
  done: "#2f9e6a",
  overdue: "#dc5346",
  today: "#cf8a28",
  soon: "#c9a63c",
  // 「不急」要安静，别在卡片上抢注意力
  normal: "#a8b2c2",
};

/** 徽章底色（淡一点，不刺眼） */
export const URGENCY_BG: Record<Urgency, string> = {
  done: "rgba(47,158,106,.14)",
  overdue: "rgba(220,83,70,.15)",
  today: "rgba(207,138,40,.16)",
  soon: "rgba(201,166,60,.18)",
  normal: "transparent",
};

/** 日期徽章上写什么 */
export function urgencyText(
  t: Pick<Task, "due_date" | "completed_at">,
  now = new Date()
): string {
  if (t.completed_at) return "已完成";
  const left = daysLeft(t.due_date, now);
  if (left === null) return "";
  if (left < 0) return left === -1 ? "昨天到期" : `逾期 ${-left} 天`;
  if (left === 0) return "今天到期";
  if (left === 1) return "明天到期";
  return `还剩 ${left} 天`;
}

/** 短日期（10-20 → 10/20），没有就返回空串 */
export function shortDate(s: string | null | undefined): string {
  const d = parseDate(s);
  if (!d) return "";
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/**
 * 甘特图用的区间（毫秒时间戳）。
 * 没有截止日期就不进甘特图；有截止没开始 → 从「今天」算起；
 * 起止反了就自动对调（用户手滑很容易填反）。
 */
export function taskSpan(
  t: Pick<Task, "start_date" | "due_date" | "completed_at">,
  now = new Date()
): { from: Date; to: Date } | null {
  const due = parseDate(t.due_date);
  if (!due) return null;
  const start = parseDate(t.start_date) ?? new Date(todayStart(now));
  let from = start;
  let to = due;
  if (from.getTime() > to.getTime()) {
    [from, to] = [to, from];
  }
  return { from, to };
}

/** 任务完成百分比：有 completed_at 就是 100，否则用 progress 字段（0~100） */
export function taskPercent(
  t: Pick<Task, "progress" | "completed_at">,
  now = new Date()
): number {
  if (t.completed_at) return 100;
  const p = typeof t.progress === "number" ? t.progress : null;
  if (p !== null && p > 0) return Math.min(100, Math.round(p));
  // 没填进度：按「开始 → 截止」的时间流逝推一个参考值（只用于甘特图条内填充）
  const span = taskSpan(t as any, now);
  if (!span) return 0;
  const s = todayStart(now);
  const pct = Math.round(((s - span.from.getTime()) / (span.to.getTime() - span.from.getTime())) * 100);
  return Math.min(95, Math.max(0, pct));
}