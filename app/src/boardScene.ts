/**
 * 看板 → 导出场景。
 *
 * 和白板导出共用同一套渲染器（exportImage.renderScene），所以颜色走 CSS 变量、
 * 字体走 --font-ui，不在这里另抄一份样式 —— 否则早晚又是"屏幕一个样、导出另一个样"。
 *
 * 布局是"所有列横向排开"的长图：给同事看、贴进文档、打印都合适。
 */

import type { ExportNode, ExportScene, NodeStyle } from "./exportImage";
import { priorityOf, type Column, type Task } from "./types";

const COL_W = 300;
const GAP = 26;
const HEAD_H = 54;
const CARD_H = 78;
const CARD_GAP = 10;
const PAD = 40;

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function uiFont(): string {
  return cssVar("--font-ui", '"Microsoft YaHei", "PingFang SC", system-ui, sans-serif');
}

function baseStyle(over: Partial<NodeStyle>): NodeStyle {
  return {
    bg: "",
    border: "",
    borderW: 0,
    radius: 12,
    shadow: "",
    color: "#1f2328",
    font: uiFont(),
    fontSize: 13,
    lineHeight: 19,
    weight: 400,
    align: "left",
    padT: 10,
    padR: 12,
    padB: 10,
    padL: 12,
    ...over,
  };
}

export interface BoardSceneInput {
  projectName: string;
  columns: Column[];
  tasksByCol: Record<number, Task[]>;
  /** 任务所属标签名，用于卡片第二行 */
  tagNames?: (t: Task) => string[];
}

/** 画布底色：跟界面一致（深色主题下导出也是深色，不做"强制白底"的意外） */
export function boardBg(): string {
  const v = cssVar("--bg", "");
  return v || "#ffffff";
}

export function buildBoardScene(input: BoardSceneInput): ExportScene {
  const { columns, tasksByCol } = input;
  const panel = cssVar("--bg-elevated", "#ffffff");
  const text = cssVar("--text", "#1f2328");
  const muted = cssVar("--text-faint", "#8b949e");
  const border = cssVar("--border", "rgba(127,127,127,.22)");

  const nodes: ExportNode[] = [];
  const cols = columns.filter((c) => !c.collapsed);

  cols.forEach((c, i) => {
    const x = PAD + i * (COL_W + GAP);
    const list = tasksByCol[c.id] ?? [];

    // 列头：左侧一条列色 + 列名 + 任务数
    nodes.push({
      kind: "note",
      x,
      y: PAD + 9,
      w: 4,
      h: 16,
      title: "",
      style: baseStyle({
        bg: c.color,
        radius: 2,
        padT: 0,
        padR: 0,
        padB: 0,
        padL: 0,
      }),
    });
    nodes.push({
      kind: "text",
      x: x + 14,
      y: PAD,
      w: COL_W - 14,
      h: HEAD_H - 10,
      title: `${c.name}   ${list.length}`,
      style: baseStyle({
        color: text,
        fontSize: 15,
        lineHeight: 22,
        weight: 600,
        bg: "",
        padL: 2,
        padT: 8,
      }),
    });

    list.forEach((t, j) => {
      const ty = PAD + HEAD_H + j * (CARD_H + CARD_GAP);
      const pr = priorityOf(t.priority);
      const tags = input.tagNames ? input.tagNames(t) : [];
      const sub: string[] = [pr.label];
      if (t.start_date || t.due_date) {
        const s = t.start_date ? String(t.start_date).slice(5) : "?";
        const e = t.due_date ? String(t.due_date).slice(5) : "?";
        sub.push(`${s} → ${e}`);
      }
      if (tags.length) sub.push(tags.slice(0, 2).join("·"));
      if (t.progress != null) sub.push(`${t.progress}%`);

      nodes.push({
        kind: "task",
        x,
        y: ty,
        w: COL_W,
        h: CARD_H,
        title: t.title,
        body: t.description || "",
        accent: pr.color,
        done: !!t.completed_at,
        sub,
        subColor: muted,
        style: baseStyle({
          bg: panel,
          border,
          borderW: 1,
          radius: 12,
          color: t.completed_at ? muted : text,
          shadow: "0 1px 2px rgba(17,24,39,.06)",
          padT: 10,
          padL: 12,
          padR: 12,
        }),
      });
    });

    // 空列不画占位框：列头已经写了 0，画个空框反而像漏了内容
  });

  return { nodes, lines: [], bg: boardBg(), title: input.projectName };
}
