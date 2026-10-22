/**
 * 把一个任务连同它的上下文，拼成一段可以直接粘给 AI 的话。
 *
 * 为什么要在软件里生成，而不是让用户自己写：
 * AI 答得泛，多数时候是它不知道这个任务的约束、依赖和素材。
 * 这些信息本来就存在白板和库里，只是没被翻译成 AI 能读的形式。
 *
 * 三档依据的写法是刻意的：写成「必须遵守 / 可以参考 / 仅作背景」，
 * 而不是给一个权重数字。AI 拿到数字不知道该怎么办，拿到指令才能执行。
 */

import type { RefLevel } from "./types";

export interface PromptRef {
  /** 资料在任务卡上显示的短名 */
  label: string;
  /** 0 必须遵守 / 1 可以参考 / 2 仅作背景 */
  level: RefLevel;
  /** 文件名（有的话），比节点文字更准确 */
  fileName?: string;
}

export interface PromptNeighbor {
  label: string;
  /** 层级编号（"2.1"），没有就不显示 */
  seq?: string;
  /** decompose 上级 / precede 前置 / produce 上游产出 */
  kind: string;
  done?: boolean;
}

export interface PromptCtx {
  projectName: string;
  taskTitle: string;
  /** 层级编号，如 "2.1" */
  taskSeq: string;
  columnName: string;
  description: string;
  refs: PromptRef[];
  upstream: PromptNeighbor[];
  downstream: PromptNeighbor[];
}

const LEVEL_TITLE: Record<number, string> = {
  0: "必须遵守（违反即作废）",
  1: "可以参考（不强制）",
  2: "仅作背景（了解即可，不要引用）",
};

const LEVEL_HINT: Record<number, string> = {
  0: "冲突时以它为准",
  1: "没有冲突时补充进来",
  2: "只用来理解语境",
};

/**
 * 上下游的括号里不能写同一句话：
 * 上游关心「做完没有」，下游关心「它要用我的什么东西」。
 * 早先把下游也写成"还没做完"，读起来像是下游在等我，意思反了。
 */
function neighborLine(n: PromptNeighbor, dir: "up" | "down"): string {
  let tail: string;
  if (dir === "up") {
    tail =
      n.kind === "precede"
        ? n.done
          ? "（已完成）"
          : "（还没做完，它的结论会变）"
        : n.kind === "produce"
          ? "（它交出来的东西是我的输入）"
          : "（上级）";
  } else {
    tail =
      n.kind === "precede"
        ? "（要等我这边做完）"
        : n.kind === "produce"
          ? "（我的成果会交给它）"
          : "（下级）";
  }
  return `- ${n.seq ? `T${n.seq} ` : ""}${n.label}${tail}`;
}

/** 组一段给 AI 的话。没有内容的小节整节省略，不留空标题。 */
export function buildTaskPrompt(ctx: PromptCtx): string {
  const out: string[] = [];
  const head = `【任务 T${ctx.taskSeq} · ${ctx.taskTitle}】`;
  out.push(head, "");

  out.push("## 项目背景");
  out.push(`项目：${ctx.projectName}`);
  if (ctx.columnName) out.push(`当前阶段：${ctx.columnName}`);
  out.push("");

  out.push("## 要做的事");
  const desc = ctx.description.trim();
  out.push(desc || "（这个任务还没写说明。请先补充：要交什么、给谁看、什么标准算做完。）");
  out.push("");

  const byLevel = new Map<number, PromptRef[]>();
  for (const r of ctx.refs) {
    const arr = byLevel.get(r.level);
    if (arr) arr.push(r);
    else byLevel.set(r.level, [r]);
  }
  for (const lv of [0, 1, 2]) {
    const list = byLevel.get(lv);
    if (!list?.length) continue;
    out.push(`## ${LEVEL_TITLE[lv]}`);
    for (const r of list) {
      const name = r.fileName && r.fileName !== r.label ? `${r.label}（${r.fileName}）` : r.label;
      out.push(`- ${name}，${LEVEL_HINT[lv]}`);
    }
    out.push("");
  }

  if (ctx.upstream.length || ctx.downstream.length) {
    out.push("## 上下文");
    if (ctx.upstream.length) {
      out.push("上游：");
      ctx.upstream.forEach((n) => out.push(neighborLine(n, "up")));
    }
    if (ctx.downstream.length) {
      out.push("下游：");
      ctx.downstream.forEach((n) => out.push(neighborLine(n, "down")));
    }
    out.push("");
  }

  if (ctx.refs.length) {
    out.push("## 素材");
    for (const r of ctx.refs) out.push(`- ${r.fileName || r.label}`);
    out.push("（素材是白板上的资料卡片。如果我能读你电脑上的文件，请告诉我路径。）");
    out.push("");
  }

  out.push("## 输出要求");
  out.push("- 直接给结论，不要复述这个任务");
  out.push("- 用表格列：要点 / 依据 / 说明");
  out.push("- 只引用「必须遵守」和「可以参考」里的材料");
  out.push("- 发现材料之间有冲突，直接指出来，不要自己圆场");
  out.push("");

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/** 复制到剪贴板。非安全上下文（file:// 之类）下 clipboard 不可用，退回老办法。 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 继续走备用方案 */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
