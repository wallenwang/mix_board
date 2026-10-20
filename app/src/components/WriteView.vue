<script setup lang="ts">
/**
 * 写作视图：在应用里直接写 Markdown。
 *
 * 设计原则沿用整个应用的习惯 —— **没有保存按钮**：停下来 700ms 自动落库，
 * 切文档 / 关视图 / 卸载组件时立刻补一次，绝不丢字。
 */
import { ref, computed, watch, nextTick, onBeforeUnmount } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useBoardStore } from "../store";
import { api } from "../api";
import { renderMarkdown } from "../markdown";
import { markdownToDocx } from "../docx";
import { boardToMarkdown, outlineToMarkdown } from "../exportMd";
import { boardExportColumns, whiteboardOutlineText, mindOnlyOutlineText } from "../boardExport";
import { downloadBlob, safeFileName } from "../exportImage";
import { reportError } from "../diag";
import MdEditor from "./MdEditor.vue";
import { DOC_MIME, charCount } from "../docnode";
import { isImageFile, formatBytes } from "../types";
import { readAsDataURL, inkOn } from "../wb";
import { toEditorText, fromEditorText, releaseBlobs } from "../docimg";
import type { Doc } from "../types";

const store = useBoardStore();

const activeId = ref<number | null>(null);
const title = ref("");
const body = ref("");
/**
 * 喂给编辑器的文本。与 body 的区别只在图片：
 * body 是**落库格式**（插图是内嵌 base64）；editorText 把图片换成 blob 短链。
 * ⚠️ 一定要走这条转换，否则一篇 4MB 的文档会让 Vditor 首屏卡 10 秒（已实测）。
 */
const editorText = ref("");
/** 正在拖到白板上的那篇（列表里高亮一下，让用户知道拖起来了） */
const draggingId = ref<number | null>(null);

/**
 * 编辑器形态：
 *  - wysiwyg（默认）= 所见即所得，正文里根本不出现 `**` `#` 这些语法，直接在排版结果上写（像 Typora）
 *  - source = 老的「源码 + 预览」分屏，留给想看着语法写的人
 */
const kind = ref<"wysiwyg" | "source">("wysiwyg");
const mdRef = ref<InstanceType<typeof MdEditor> | null>(null);
const mode = ref<"split" | "edit" | "preview">("split");
const renamingId = ref<number | null>(null);
const renameText = ref("");
const saveState = ref<"idle" | "saving" | "saved">("idle");
const taRef = ref<HTMLTextAreaElement | null>(null);

const current = computed(() => store.docs.find((d) => d.id === activeId.value) ?? null);
const previewHtml = computed(() => renderMarkdown(body.value));
const stats = computed(() => {
  const text = body.value;
  const chars = charCount(text);
  const lines = text ? text.split("\n").length : 0;
  const headings = (text.match(/^#{1,6}\s/gm) ?? []).length;
  return `${chars} 字 · ${lines} 行 · ${headings} 个标题`;
});
const saveHint = computed(() => {
  if (saveState.value === "saving") return "保存中…";
  if (saveState.value === "saved") return "已保存";
  return "未保存";
});

// ---------- 正文底色（护眼） ----------

/** 预设底色；护眼绿放第一个，也是默认值 */
const DOC_BG_PRESETS = [
  { hex: "#e9f4e3", label: "护眼绿" },
  { hex: "#ffffff", label: "纸白" },
  { hex: "#fdf6e3", label: "米黄" },
  { hex: "#e8f1fa", label: "淡蓝" },
  { hex: "#f4eefa", label: "淡紫" },
];
const DOC_BG_DEFAULT = DOC_BG_PRESETS[0].hex;
const DOC_BG_KEY = "kanban.docBg";
/** null = 跟随主题（浅色模式纸白 / 深色模式深底），不设 --doc-bg 变量 */
const docBg = ref<string | null>(null);
try {
  const v = localStorage.getItem(DOC_BG_KEY);
  if (v && /^#[0-9a-fA-F]{6}$/.test(v)) docBg.value = v;
} catch {
  /* 读不到就用默认 */
}
/** 底色定了字色也跟着定（深底浅字 / 浅底深字），保证看得清 */
const docStyle = computed(() =>
  docBg.value
    ? ({ "--doc-bg": docBg.value, "--doc-ink": inkOn(docBg.value) } as Record<string, string>)
    : ({ "--doc-bg": DOC_BG_DEFAULT } as Record<string, string>)
);

function pickDocBg(hex: string | null) {
  docBg.value = hex;
  try {
    if (hex) localStorage.setItem(DOC_BG_KEY, hex);
    else localStorage.removeItem(DOC_BG_KEY);
  } catch {
    /* 忽略配额问题 */
  }
}

function onBgCmd(cmd: string) {
  if (cmd === "__theme") pickDocBg(null);
  else if (cmd !== "__custom") pickDocBg(cmd);
}

function onCustomBg(e: Event) {
  const v = (e.target as HTMLInputElement).value;
  if (/^#[0-9a-fA-F]{6}$/.test(v)) pickDocBg(v);
}

// ---------- 选中 / 打开 ----------

function openDoc(d: Doc) {
  if (d.id === activeId.value) return;
  void flush();
  activeId.value = d.id;
  title.value = d.title;
  body.value = d.body;
  // 插图换成 blob 短链再交给编辑器（见 docimg.ts 的说明）
  editorText.value = toEditorText(d.body);
  saveState.value = "idle";
}

/**
 * 把这篇文档拖到白板：白板 onDrop 认 DOC_MIME，落点会生成一张「文档卡片」。
 * effectAllowed 必须写 copy —— 白板那边要 preventDefault 才放得下，
 * 而 dropEffect 只有在源允许 copy 时才会生效，否则浏览器直接显示 🚫。
 */
function onDocDragStart(e: DragEvent, d: Doc) {
  const dt = e.dataTransfer;
  if (!dt) return;
  try {
    dt.setData(DOC_MIME, JSON.stringify({ id: d.id, title: d.title }));
    // 自定义类型在不同浏览器上未必都读得到，再放一份纯文本兜底（仅作提示用）
    dt.setData("text/plain", `${d.title || "未命名文档"}.md`);
  } catch {
    /* 某些环境禁了自定义类型，拖不动也不至于报错 */
  }
  dt.effectAllowed = "copy";
  draggingId.value = d.id;
}

function onDocDragEnd() {
  draggingId.value = null;
}

async function newDoc() {
  if (store.currentProjectId == null) return;
  await flush();
  try {
    const id = await api.createDoc(store.currentProjectId, "未命名文档", "");
    await store.refreshDocs();
    const d = store.docs.find((x) => x.id === id);
    if (d) {
      activeId.value = d.id;
      title.value = d.title;
      body.value = d.body;
      editorText.value = d.body;
      saveState.value = "idle";
      await nextTick();
      if (kind.value === "wysiwyg") mdRef.value?.focus();
      else taRef.value?.focus();
    }
  } catch (e) {
    reportError("新建文档", e);
  }
}

function startRename(d: Doc) {
  renamingId.value = d.id;
  renameText.value = d.title;
}

async function commitRename(d: Doc) {
  if (renamingId.value !== d.id) return;
  renamingId.value = null;
  const t = renameText.value.trim() || "未命名文档";
  if (t === d.title) return;
  try {
    await api.updateDoc(d.id, { title: t });
    d.title = t;
    if (d.id === activeId.value) title.value = t;
  } catch (e) {
    reportError("重命名", e);
  }
}

async function removeDoc(d: Doc) {
  try {
    await ElMessageBox.confirm(`删除文档「${d.title || "未命名文档"}」？`, "删除", {
      type: "warning",
      confirmButtonText: "删除",
      cancelButtonText: "取消",
    });
  } catch {
    return;
  }
  try {
    await api.deleteDoc(d.id);
    if (activeId.value === d.id) {
      activeId.value = null;
      title.value = "";
      body.value = "";
      editorText.value = "";
    }
    await store.refreshDocs();
    if (activeId.value == null && store.docs.length) openDoc(store.docs[0]);
  } catch (e) {
    reportError("删除文档", e);
  }
}

// ---------- 自动保存 ----------

let saveTimer = 0;
let dirty = false;

function scheduleSave() {
  dirty = true;
  saveState.value = "idle";
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void flush(), 700);
}

async function flush() {
  window.clearTimeout(saveTimer);
  if (!dirty || activeId.value == null) return;
  const id = activeId.value;
  const t = title.value.trim() || "未命名文档";
  const b = body.value;
  dirty = false;
  saveState.value = "saving";
  try {
    await api.updateDoc(id, { title: t, body: b });
    const d = store.docs.find((x) => x.id === id);
    if (d) {
      d.title = t;
      d.body = b;
      d.updated_at = new Date().toLocaleString("sv-SE");
    }
    saveState.value = "saved";
  } catch (e) {
    dirty = true;
    saveState.value = "idle";
    reportError("保存文档", e);
  }
}

// ---------- 插入内容 ----------

/** 所见即所得编辑器里改字 → 更新正文并排队保存（没有保存按钮，停手就写库） */
function onMdInput(v: string) {
  // 编辑器里是 blob 短链，落库要换回内嵌 base64（.md 格式不变）
  body.value = fromEditorText(v);
  editorText.value = v;
  scheduleSave();
}

function insertText(chunk: string) {
  const text = chunk.trimEnd() + "\n";
  // 所见即所得模式：交给编辑器插到光标处（它会按块渲染，不会露出语法）
  if (kind.value === "wysiwyg") {
    // 插进去的图片也先转成 blob 短链，编辑器才不会被新 base64 拖慢
    mdRef.value?.insert(toEditorText(text));
    scheduleSave();
    return;
  }
  const ta = taRef.value;
  if (!ta || mode.value === "preview") {
    body.value = body.value.replace(/\s*$/, "") + (body.value.trim() ? "\n\n" : "") + text;
    scheduleSave();
    return;
  }
  const s = ta.selectionStart ?? body.value.length;
  const e = ta.selectionEnd ?? s;
  const before = body.value.slice(0, s);
  const after = body.value.slice(e);
  const pad = before.trim() ? "\n\n" : "";
  body.value = before + pad + text + after;
  const pos = (before + pad + text).length;
  void nextTick(() => {
    ta.focus();
    ta.setSelectionRange(pos, pos);
  });
  scheduleSave();
}

function insertBoard() {
  const cols = boardExportColumns();
  const total = cols.reduce((n, c) => n + c.tasks.length, 0);
  if (!total) {
    ElMessage.warning("当前看板还没有任务");
    return;
  }
  insertText(boardToMarkdown({ project: store.currentProject?.name ?? "项目", columns: cols }));
  ElMessage.success("已插入看板任务清单");
}

function insertMind() {
  const mind = mindOnlyOutlineText();
  const use = mind.count ? mind : whiteboardOutlineText();
  if (!use.count) {
    ElMessage.warning("白板上还没有节点");
    return;
  }
  insertText(outlineToMarkdown(store.currentProject?.name ?? "项目", use.text, `${use.count} 个节点`));
  ElMessage.success(`已插入白板大纲（${use.count} 个节点）`);
}

// ---------- 插入图片 ----------
/**
 * 图片统一以 data URL 写进 Markdown。
 *
 * 为什么不写磁盘路径（`![](../附件/a.png)`）：桌面版的页面是从内嵌资源里加载的，
 * WebView 不认相对磁盘路径，图片会显示成裂图；而编辑器（Vditor）在所见即所得模式下
 * 会拿 DOM 反推 Markdown，任何"把 src 偷偷换成 data URL"的做法都会把一长串 base64
 * 写回正文。直接存 data URL 虽然让 .md 变大，但**编辑、预览、拷给别人、换个文件夹打开**
 * 都能原样显示，是最稳的一条路。
 */
const IMG_WARN_BYTES = 6 * 1024 * 1024;
const IMG_MAX_BYTES = 24 * 1024 * 1024;

const imgLocalOpen = ref(false);
const imgBoardOpen = ref(false);
const imgBusy = ref(false);
const boardThumbs = ref<Record<number, string>>({});
const boardImages = computed(() => store.assets.filter((f) => isImageFile(f)));

function openBoardImages() {
  imgBoardOpen.value = true;
  void loadBoardThumbs();
}

async function loadBoardThumbs() {
  for (const f of boardImages.value) {
    if (boardThumbs.value[f.id] !== undefined) continue;
    boardThumbs.value[f.id] = "";
    try {
      boardThumbs.value[f.id] = await api.readAssetDataUrl(f.id);
    } catch {
      boardThumbs.value[f.id] = "";
    }
  }
}

/**
 * SVG 要转成 PNG 再插。
 * 原因：编辑器的 Markdown 转换器（Lute）会把 `data:image/svg+xml;base64,...` 当危险内容丢掉，
 * 存回去就变成 `![xxx]()`（裂图）。PNG/JPG/GIF 的 data URL 是原样保留的。
 */
function svgToPng(dataUrl: string): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const w = img.naturalWidth || 1200;
        const h = img.naturalHeight || 800;
        const scale = Math.min(1, 2000 / Math.max(w, h));
        const cv = document.createElement("canvas");
        cv.width = Math.max(1, Math.round(w * scale));
        cv.height = Math.max(1, Math.round(h * scale));
        const ctx = cv.getContext("2d");
        if (!ctx) return resolve(dataUrl);
        ctx.drawImage(img, 0, 0, cv.width, cv.height);
        resolve(cv.toDataURL("image/png"));
      } catch {
        resolve(dataUrl);
      }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

async function normalizeForDoc(dataUrl: string): Promise<string> {
  if (!dataUrl.startsWith("data:image/svg")) return dataUrl;
  return svgToPng(dataUrl);
}

/** 把一张图按 Markdown 图片插到光标处 */
async function insertImageMarkdown(name: string, dataUrl: string) {
  if (!dataUrl.startsWith("data:")) {
    ElMessage.warning("这张图读不出来（文件可能已经不在了）");
    return;
  }
  const url = await normalizeForDoc(dataUrl);
  const alt = (name || "图片").replace(/[[\]]/g, "").replace(/\s+/g, " ").trim();
  insertText(`![${alt}](${url})`);
}

async function pickBoardImage(f: { id: number; name: string }) {
  imgBusy.value = true;
  try {
    let url = boardThumbs.value[f.id];
    if (!url) url = await api.readAssetDataUrl(f.id);
    await insertImageMarkdown(f.name, url);
    imgBoardOpen.value = false;
  } catch (e) {
    reportError("插入白板图片", e);
    ElMessage.warning("插入失败，文件可能已经被删掉了");
  } finally {
    imgBusy.value = false;
  }
}

async function onLocalImages(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = "";
  if (!files.length) return;
  imgBusy.value = true;
  try {
    for (const f of files) {
      if (!isImageFile({ ext: (f.name.split(".").pop() ?? "").toLowerCase(), mime: f.type })) {
        ElMessage.warning(`「${f.name}」不是图片，已跳过`);
        continue;
      }
      if (f.size > IMG_MAX_BYTES) {
        ElMessage.warning(`「${f.name}」太大（${formatBytes(f.size)}），先压缩一下再插`);
        continue;
      }
      if (f.size > IMG_WARN_BYTES) {
        const ok = await ElMessageBox.confirm(
          `「${f.name}」有 ${formatBytes(f.size)}，插进文档后 .md 会明显变大（内容会一起带走图片）。继续吗？`,
          "图片有点大",
          { type: "warning", confirmButtonText: "继续插入", cancelButtonText: "算了" }
        ).catch(() => false);
        if (!ok) continue;
      }
      await insertImageMarkdown(f.name, await readAsDataURL(f));
    }
    imgLocalOpen.value = false;
  } catch (err) {
    reportError("插入图片", err);
  } finally {
    imgBusy.value = false;
  }
}

/** 图片菜单：本机文件 / 白板里已经上传的图 */
function onImageCmd(cmd: string) {
  if (cmd === "local") imgLocalOpen.value = true;
  else if (cmd === "board") openBoardImages();
}

// ---------- 格式工具栏（Typora 式：点按钮/快捷键，不必记 Markdown 语法） ----------

type FmtKind =
  | "h1" | "h2" | "h3" | "bold" | "italic" | "strike" | "code" | "link"
  | "quote" | "ul" | "ol" | "task" | "table" | "codeblock" | "hr";

const TABLE_TPL = "| 表头一 | 表头二 | 表头三 |\n| --- | --- | --- |\n| 内容 | 内容 | 内容 |";

const HEAD_RE = /^(\s*)#{1,6}\s+/;
const LIST_RE = /^(\s*)(?:[-*+]\s\[[ xX]\]\s|[-*+]\s|\d+\.\s)/;
const QUOTE_RE = /^(\s*)>\s?/;
/** 加新前缀时先把任何旧前缀（标题/列表/待办/引用）都清掉，避免叠成 "- > xxx" */
const ANY_PREFIX_RE = /^(\s*)(?:[-*+]\s\[[ xX]\]\s|[-*+]\s|\d+\.\s|>\s?)/;

function edCaret() {
  const ta = taRef.value;
  if (!ta || mode.value === "preview") return null;
  return { ta, s: ta.selectionStart ?? 0, e: ta.selectionEnd ?? 0 };
}

function putText(ta: HTMLTextAreaElement, s: number, e: number, text: string, cs: number, ce: number) {
  body.value = body.value.slice(0, s) + text + body.value.slice(e);
  scheduleSave();
  void nextTick(() => {
    ta.focus();
    ta.setSelectionRange(cs, ce);
  });
}

/** 包裹式：粗体/斜体/删除线/行内代码/链接。选区内或选区外已包着标记时再点 = 解开 */
function wrapSel(left: string, right: string, ph: string, s: number, e: number, ta: HTMLTextAreaElement) {
  const text = body.value;
  const selText = text.slice(s, e);
  // 情况一：选区本身就把标记包进去了（如 "**粗体**"）→ 直接剥掉
  if (
    selText.length >= left.length + right.length &&
    selText.startsWith(left) &&
    selText.endsWith(right)
  ) {
    const inner = selText.slice(left.length, selText.length - right.length);
    putText(ta, s, e, inner, s, s + inner.length);
    return;
  }
  // 情况二：选区紧贴在两侧标记内（如只选中"粗体"两个字）→ 解开
  if (
    s >= left.length &&
    e + right.length <= text.length &&
    text.slice(s - left.length, s) === left &&
    text.slice(e, e + right.length) === right
  ) {
    putText(ta, s - left.length, e + right.length, selText, s - left.length, s - left.length + selText.length);
    return;
  }
  const hasSel = e > s;
  const sel = hasSel ? selText : ph;
  putText(ta, s, e, left + sel + right, s + left.length, s + left.length + (hasSel ? sel.length : ph.length));
}

/** 找到覆盖选区的整行范围 */
function lineBounds(s: number, e: number) {
  const text = body.value;
  const ls = text.lastIndexOf("\n", Math.max(0, s - 1)) + 1;
  const ni = text.indexOf("\n", e);
  return { ls, le: ni === -1 ? text.length : ni };
}

/** 把选中的行设为 N 级标题；这些行已经是该级别时 = 取消标题 */
function setHeading(level: number, s: number, e: number, ta: HTMLTextAreaElement) {
  const { ls, le } = lineBounds(s, e);
  const lines = body.value.slice(ls, le).split("\n");
  const mark = "#".repeat(level) + " ";
  const stripped = lines.map((l) => l.replace(HEAD_RE, "$1"));
  const already = lines.every((l) => l.trimStart().startsWith(mark));
  const out = (already ? stripped : stripped.map((l) => mark + l)).join("\n");
  putText(ta, ls, le, out, ls, ls + out.length);
}

/** 行前缀开关：引用 / 无序列表 / 待办（加前缀时先清掉旧前缀） */
function togglePrefix(prefix: string, strip: RegExp, s: number, e: number, ta: HTMLTextAreaElement) {
  const { ls, le } = lineBounds(s, e);
  const lines = body.value.slice(ls, le).split("\n");
  const already = lines.every((l) => l.trimStart().startsWith(prefix));
  const out = lines
    .map((l) => (already ? l.replace(strip, "$1") : prefix + l.replace(ANY_PREFIX_RE, "$1")))
    .join("\n");
  putText(ta, ls, le, out, ls, ls + out.length);
}

/** 有序列表：自动编 1. 2. 3.；已是有序时 = 取消 */
function toggleOrdered(s: number, e: number, ta: HTMLTextAreaElement) {
  const { ls, le } = lineBounds(s, e);
  const lines = body.value.slice(ls, le).split("\n");
  const already = lines.every((l) => /^\s*\d+\.\s/.test(l));
  const out = lines
    .map((l, i) => (already ? l.replace(LIST_RE, "$1") : `${i + 1}. ` + l.replace(ANY_PREFIX_RE, "$1")))
    .join("\n");
  putText(ta, ls, le, out, ls, ls + out.length);
}

/** 插入独立块（表格/代码块/分割线），前后自动补空行 */
function insertBlock(text: string, s: number, e: number, ta: HTMLTextAreaElement) {
  const before = body.value.slice(0, s);
  const after = body.value.slice(e);
  const lead = !before ? "" : before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const tail = !after || after.startsWith("\n") ? "" : "\n\n";
  const out = before + lead + text + tail + after;
  const pos = (before + lead + text).length;
  body.value = out;
  scheduleSave();
  void nextTick(() => {
    ta.focus();
    ta.setSelectionRange(pos, pos);
  });
}

function fmt(kind: FmtKind) {
  const c = edCaret();
  if (!c) return;
  const { ta, s, e } = c;
  switch (kind) {
    case "bold": wrapSel("**", "**", "粗体", s, e, ta); break;
    case "italic": wrapSel("*", "*", "斜体", s, e, ta); break;
    case "strike": wrapSel("~~", "~~", "删除线", s, e, ta); break;
    case "code": wrapSel("`", "`", "代码", s, e, ta); break;
    case "link": wrapSel("[", "](https://)", "链接文字", s, e, ta); break;
    case "h1": setHeading(1, s, e, ta); break;
    case "h2": setHeading(2, s, e, ta); break;
    case "h3": setHeading(3, s, e, ta); break;
    case "quote": togglePrefix("> ", QUOTE_RE, s, e, ta); break;
    case "ul": togglePrefix("- ", LIST_RE, s, e, ta); break;
    case "task": togglePrefix("- [ ] ", LIST_RE, s, e, ta); break;
    case "ol": toggleOrdered(s, e, ta); break;
    case "table": insertBlock(TABLE_TPL, s, e, ta); break;
    case "codeblock": insertBlock("```\n这里放代码\n```", s, e, ta); break;
    case "hr": insertBlock("---", s, e, ta); break;
  }
}

function onEdKey(e: KeyboardEvent) {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === "b") { e.preventDefault(); fmt("bold"); }
  else if (k === "i") { e.preventDefault(); fmt("italic"); }
  else if (k === "k") { e.preventDefault(); fmt("link"); }
}

// ---------- 导出 ----------

function download(blob: Blob, ext: string) {
  const base = safeFileName(title.value || "未命名文档");
  downloadBlob(blob, `${base}.${ext}`);
}

function exportMdFile() {
  download(new Blob([body.value], { type: "text/markdown;charset=utf-8" }), "md");
  ElMessage.success("已导出 Markdown");
}

function exportDocxFile() {
  try {
    const bytes = markdownToDocx(body.value, title.value || "未命名文档");
    download(new Blob([bytes as unknown as BlobPart], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), "docx");
    ElMessage.success("已导出 Word");
  } catch (e) {
    reportError("导出 Word", e);
  }
}

// ---------- 生命周期 ----------

// 项目切换 → 重置
watch(
  () => store.currentProjectId,
  () => {
    activeId.value = null;
    title.value = "";
    body.value = "";
    editorText.value = "";
    dirty = false;
    saveState.value = "idle";
    window.clearTimeout(saveTimer);
  }
);

// 文档列表就绪 / 变化 → 保证有一个选中的
watch(
  () => store.docs.map((d) => d.id).join(","),
  () => {
    if (activeId.value != null && store.docs.some((d) => d.id === activeId.value)) return;
    if (store.docs.length) openDoc(store.docs[0]);
    else {
      activeId.value = null;
      title.value = "";
      body.value = "";
      editorText.value = "";
    }
  },
  { immediate: true }
);

onBeforeUnmount(() => {
  void flush();
  // 释放编辑器里用过的图片 blob（否则每打开一次文档就漏一批内存）
  releaseBlobs();
});

/**
 * 白板上的文档卡片就地保存后 → store.docTouched 变了，这里把本地副本换成最新的。
 *
 * ⚠️ 这里绝对不能先 flush()：flush 会把**本地这份可能已经过时的正文**写回去，
 * 等于把白板刚存的内容又覆盖掉（曾导致"白板里改了字、写作栏一保存就变回去"）。
 * 正确做法是：
 *   - 本地没有未保存改动 → 直接换成白板那份；
 *   - 本地正在打字（dirty）→ 不动，让本地这份赢（它会自动落库，白板卡片会跟着刷新）。
 */
watch(
  () => store.docTouched?.seq,
  () => {
    const id = store.docTouched?.id;
    if (id == null || id !== activeId.value) return;
    const d = store.docs.find((x) => x.id === id);
    if (!d || d.body === body.value) return;
    if (dirty) {
      ElMessage.warning("这篇文档刚在白板上被改过，但你这边还有没保存的改动，以你这边为准");
      return;
    }
    title.value = d.title;
    body.value = d.body;
    // 外部改过的正文同样要换成"编辑器文本"再喂进去
    editorText.value = toEditorText(d.body);
    saveState.value = "idle";
    // 顺手撤掉排队的自动保存：内容刚被换过，别让旧值再落一次库
    window.clearTimeout(saveTimer);
  }
);

/**
 * 白板上文档卡片点「↗ 去写作」→ store.focusDoc 变了，这里切过去。
 * 顺带把切进来的文档标记成"刚被引用"，列表里闪一下，用户知道是哪一篇。
 */
const flashId = ref<number | null>(null);
watch(
  () => store.docFocus?.seq,
  () => {
    const id = store.docFocus?.id;
    if (id == null) return;
    const d = store.docs.find((x) => x.id === id);
    if (!d) return;
    openDoc(d);
    flashId.value = id;
    window.setTimeout(() => {
      if (flashId.value === id) flashId.value = null;
    }, 1600);
  }
);

/** 让白板知道「文档栏现在开着哪一篇」（右键图片「发送到文档」要往这篇里插） */
watch(activeId, (id) => store.setActiveDoc(id), { immediate: true });

/**
 * 白板右键图片 →「发送到文档」：把图片 Markdown 插到光标处。
 *
 * 带 immediate 是必须的：文档栏是"打开才挂载"的组件，
 * 请求可能先于组件到达（用户在白板上右键时文档栏还没开），
 * 挂载时就得把排队的那条捞出来；takeDocInsert() 保证只处理一次。
 */
watch(
  () => store.docInsert?.seq,
  () => {
    if (!store.docInsert) return;
    const req = store.takeDocInsert();
    if (!req) return;
    void insertIntoCurrentDoc(req.md, req.docId);
  },
  { immediate: true }
);

async function insertIntoCurrentDoc(rawMd: string, docId: number | null) {
  // 白板上发过来的可能是 SVG，先转 PNG，否则编辑器的 Markdown 转换会把 src 丢成空
  let md = rawMd;
  const sv = md.match(/\((data:image\/svg[^)]+)\)/);
  if (sv) md = md.replace(sv[1], await normalizeForDoc(sv[1]));
  const target =
    (docId != null ? store.docs.find((d) => d.id === docId) : null) ??
    current.value ??
    store.docs[0];
  if (!target) {
    ElMessage.warning("还没有文档。先在「文档」栏新建一篇，再把图片发过来");
    return;
  }
  if (target.id !== activeId.value) {
    openDoc(target);
    await nextTick();
  }
  // 文档栏可能刚挂载：等编辑器组件出现（Vditor 本体还没就绪时它自己会排队）
  for (let i = 0; i < 40 && kind.value === "wysiwyg" && !mdRef.value; i++) {
    await new Promise((r) => setTimeout(r, 80));
  }
  if (kind.value === "wysiwyg" && mdRef.value) {
    // 同样先换成 blob 短链：白板发来的图是 base64，直接塞进去会拖慢编辑器
    mdRef.value.insert(toEditorText(md) + "\n");
    scheduleSave();
  } else if (kind.value === "source") {
    insertText(md);
  } else {
    // 编辑器实在没起来：直接落到正文末尾，至少不丢内容
    body.value = body.value.replace(/\s*$/, "") + "\n\n" + md + "\n";
    scheduleSave();
  }
  ElMessage.success(`已发送到「${target.title || "未命名文档"}」光标处`);
}

/** Tab 插入两个空格（写 Markdown 缩进顺手），而不是切换焦点 */function onTab(e: KeyboardEvent) {
  const ta = e.target as HTMLTextAreaElement;
  const s = ta.selectionStart ?? 0;
  const end = ta.selectionEnd ?? s;
  const v = ta.value;
  ta.value = v.slice(0, s) + "  " + v.slice(end);
  ta.selectionStart = ta.selectionEnd = s + 2;
  ta.dispatchEvent(new Event("input", { bubbles: true }));
}
</script>

<template>
  <div class="write" :style="docStyle">
    <aside class="doc-list">
      <div class="dl-head">
        <span class="dl-count">文档 · {{ store.docs.length }}</span>
        <el-button size="small" text type="primary" @click="newDoc">＋ 新建</el-button>
      </div>
      <div class="dl-body">
        <div
          v-for="d in store.docs"
          :key="d.id"
          class="dl-item"
          :class="{ on: d.id === activeId, dragging: d.id === draggingId, flash: d.id === flashId }"
          draggable="true"
          :title="`${d.title || '未命名文档'} —— 按住拖到白板上，就能在白板里直接改这篇文档`"
          @click="openDoc(d)"
          @dblclick="startRename(d)"
          @dragstart="onDocDragStart($event, d)"
          @dragend="onDocDragEnd"
        >
          <span class="dl-grip" title="拖到白板">⠿</span>
          <input
            v-if="renamingId === d.id"
            v-model="renameText"
            class="dl-rename"
            @click.stop
            @blur="commitRename(d)"
            @keydown.enter.prevent="commitRename(d)"
            @keydown.esc="renamingId = null"
          />
          <template v-else>
            <span class="dl-title" :title="d.title">{{ d.title || "未命名文档" }}</span>
            <span class="dl-count2">{{ charCount(d.body) }} 字</span>
            <button class="dl-del" title="删除" @click.stop="removeDoc(d)">✕</button>
          </template>
        </div>
        <div v-if="!store.docs.length" class="dl-empty">
          还没有文档<br />点上面「＋ 新建」开始写
        </div>
      </div>
      <div v-if="store.docs.length" class="dl-tip">
        按住 <b>⠿</b> 拖到右边的白板上 → 变成文档卡片，双击就能在白板里改这篇文档
      </div>
    </aside>

    <section v-if="current" class="editor">
      <div class="ed-head">
        <input v-model="title" class="ed-title" placeholder="文档标题" @input="scheduleSave" />
        <span class="ed-stat">{{ stats }}</span>
        <span class="ed-save" :class="saveState">{{ saveHint }}</span>
        <el-radio-group v-model="kind" size="small">
          <el-radio-button value="wysiwyg">所见即所得</el-radio-button>
          <el-radio-button value="source">源码</el-radio-button>
        </el-radio-group>
        <el-radio-group v-if="kind === 'source'" v-model="mode" size="small">
          <el-radio-button value="split">分栏</el-radio-button>
          <el-radio-button value="edit">只写</el-radio-button>
          <el-radio-button value="preview">预览</el-radio-button>
        </el-radio-group>
        <el-button size="small" @click="insertBoard">＋ 看板任务</el-button>
        <el-button size="small" @click="insertMind">＋ 白板大纲</el-button>
        <el-dropdown trigger="click" placement="bottom-end" @command="onImageCmd">
          <el-button size="small">🖼 插入图片</el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="local">💻 从本机选择图片…</el-dropdown-item>
              <el-dropdown-item command="board" :disabled="!boardImages.length">
                🖼 从白板图片里选（{{ boardImages.length }} 张）
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <el-dropdown trigger="click" placement="bottom-end" @command="onBgCmd">
          <el-button size="small" title="正文底色：护眼绿是默认，也可以自己挑">🎨 底色</el-button>
          <template #dropdown>
            <el-dropdown-menu class="bg-menu">
              <el-dropdown-item command="__theme" :class="{ on: !docBg }">
                <span class="bg-dot bg-dot-theme"></span>跟随主题
              </el-dropdown-item>
              <el-dropdown-item
                v-for="p in DOC_BG_PRESETS"
                :key="p.hex"
                :command="p.hex"
                :class="{ on: docBg === p.hex }"
              >
                <span class="bg-dot" :style="{ background: p.hex }"></span>{{ p.label }}
              </el-dropdown-item>
              <el-dropdown-item command="__custom" divided>
                <label class="bg-custom" @click.stop>
                  自定义…
                  <input type="color" :value="docBg || DOC_BG_DEFAULT" @input="onCustomBg" />
                </label>
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <el-button size="small" @click="exportMdFile">导出 .md</el-button>
        <el-button size="small" type="primary" @click="exportDocxFile">导出 Word</el-button>
      </div>

      <!-- 格式工具栏：只在源码模式下需要（所见即所得模式下由编辑器自带的工具栏负责） -->
      <div v-if="kind === 'source' && mode !== 'preview'" class="ed-tools">
        <button class="ft ft-wide" title="一级标题" @mousedown.prevent @click="fmt('h1')">H1</button>
        <button class="ft ft-wide" title="二级标题" @mousedown.prevent @click="fmt('h2')">H2</button>
        <button class="ft ft-wide" title="三级标题" @mousedown.prevent @click="fmt('h3')">H3</button>
        <span class="ft-sep"></span>
        <button class="ft" title="粗体（Ctrl+B）" @mousedown.prevent @click="fmt('bold')"><b>B</b></button>
        <button class="ft" title="斜体（Ctrl+I）" @mousedown.prevent @click="fmt('italic')"><i>I</i></button>
        <button class="ft" title="删除线" @mousedown.prevent @click="fmt('strike')"><s>S</s></button>
        <button class="ft" title="行内代码" @mousedown.prevent @click="fmt('code')">&lt;/&gt;</button>
        <button class="ft" title="插入链接" @mousedown.prevent @click="fmt('link')">🔗</button>
        <span class="ft-sep"></span>
        <button class="ft" title="引用" @mousedown.prevent @click="fmt('quote')">❝ 引用</button>
        <button class="ft" title="无序列表" @mousedown.prevent @click="fmt('ul')">• 列表</button>
        <button class="ft" title="有序列表（自动 1. 2. 3.）" @mousedown.prevent @click="fmt('ol')">⒈ 列表</button>
        <button class="ft" title="待办清单" @mousedown.prevent @click="fmt('task')">☐ 待办</button>
        <span class="ft-sep"></span>
        <button class="ft" title="插入表格" @mousedown.prevent @click="fmt('table')">⊞ 表格</button>
        <button class="ft" title="插入代码块" @mousedown.prevent @click="fmt('codeblock')">▦ 代码块</button>
        <button class="ft" title="插入分割线" @mousedown.prevent @click="fmt('hr')">— 分割线</button>
      </div>

      <div class="ed-body" :class="{ 'only-md': kind === 'wysiwyg' }">
        <!-- 所见即所得：正文里根本不出现 Markdown 语法，直接在排版结果上写 -->
        <MdEditor
          v-if="kind === 'wysiwyg'"
          ref="mdRef"
          :model-value="editorText"
          @update:model-value="onMdInput"
        />
        <template v-else>
          <textarea
            v-if="mode !== 'preview'"
            ref="taRef"
            v-model="body"
            class="ed-ta"
            spellcheck="false"
            placeholder="在这里写，用上面的按钮加格式……&#10;&#10;也可以直接写 Markdown：# 标题、- 列表、- [ ] 待办"
            @input="scheduleSave"
            @keydown.ctrl.s.prevent="flush"
            @keydown.tab.prevent="onTab"
            @keydown="onEdKey"
          ></textarea>
          <div v-if="mode !== 'edit'" class="ed-prev md-body" v-html="previewHtml"></div>
        </template>
      </div>
    </section>

    <section v-else class="editor editor-empty">
      <div class="ee-icon">📝</div>
      <div class="ee-title">在这里写 Markdown，写完直接导出 Word</div>
      <div class="ee-sub">
        左侧新建一份文档开始；「＋ 看板任务」能把看板里的任务连同父子层级一起贴进来，<br />
        「＋ 白板大纲」能把思维导图变成缩进大纲。内容自动保存，不用点保存按钮。
      </div>
      <el-button type="primary" @click="newDoc">＋ 新建文档</el-button>
    </section>

    <!-- 插入图片：从本机选（可见的原生 input，不走 JS click） -->
    <el-dialog
      v-model="imgLocalOpen"
      title="插入图片 · 从本机选择"
      width="460px"
      append-to-body
      class="wv-img-dialog"
    >
      <label class="wi-zone">
        <input class="wi-input" type="file" accept="image/*" multiple @change="onLocalImages" />
        <div class="wi-ico">🖼</div>
        <div class="wi-main">点击这里选图片（可多选）</div>
        <div class="wi-sub">PNG / JPG / GIF / WebP / SVG</div>
      </label>
      <div class="wi-note">
        图片会以 data URL 直接写进这篇 Markdown —— 之后无论把 .md 拷到哪里、
        发给谁，图片都跟着走，不会变成裂图。
      </div>
      <template #footer>
        <el-button @click="imgLocalOpen = false">关闭</el-button>
      </template>
    </el-dialog>

    <!-- 插入图片：从白板已经上传的图片里挑 -->
    <el-dialog
      v-model="imgBoardOpen"
      title="插入图片 · 从白板选择"
      width="720px"
      append-to-body
      class="wv-img-dialog"
    >
      <div v-if="!boardImages.length" class="wi-empty">
        这个项目的白板上还没有图片。<br />
        先把图片拖进白板（或者点白板的「上传资料」），再回来这里选。
      </div>
      <div v-else class="wi-grid">
        <button
          v-for="f in boardImages"
          :key="f.id"
          class="wi-card"
          :disabled="imgBusy"
          :title="`${f.name} · ${formatBytes(f.size)}`"
          @click="pickBoardImage(f)"
        >
          <img v-if="boardThumbs[f.id]" :src="boardThumbs[f.id]" alt="" />
          <span v-else class="wi-wait">…</span>
          <span class="wi-name">{{ f.name }}</span>
        </button>
      </div>
      <div class="wi-note">
        也可以直接在白板上<b>右键图片 → 发送到文档</b>，会插到光标所在的位置。
      </div>
      <template #footer>
        <el-button @click="imgBoardOpen = false">关闭</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script lang="ts">
export default { name: "WriteView" };
</script>

<style scoped>
.write {
  flex: 1;
  display: flex;
  min-height: 0;
  min-width: 0;
}

/* ---- 左：文档列表 ---- */
.doc-list {
  width: 210px;
  flex: none;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border);
  background: var(--bg-elevated);
  min-height: 0;
}
.dl-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 10px 9px;
  border-bottom: 1px solid var(--border);
}
.dl-count {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--text-subtle);
}
.dl-new {
  font-family: inherit;
  font-size: 12px;
  padding: 3px 9px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--bg-elevated);
  color: var(--text-subtle);
  cursor: pointer;
  transition: border-color 0.14s var(--ease), color 0.14s var(--ease),
    background 0.14s var(--ease);
}
.dl-new:hover {
  border-color: transparent;
  background: var(--accent-soft);
  color: var(--accent);
}
/* 文档项：可拖到白板 → 加一个抓手 + 字数 */
.dl-item.dragging {
  opacity: 0.45;
}
.dl-item.flash {
  box-shadow: 0 0 0 2px var(--accent, #0079bf);
}
.dl-grip {
  flex: none;
  font-size: 11px;
  color: var(--text-subtle);
  cursor: grab;
  letter-spacing: -2px;
}
.dl-grip:active {
  cursor: grabbing;
}
.dl-item.on .dl-grip {
  color: var(--accent);
}
.dl-count2 {
  flex: none;
  font-size: 10px;
  color: var(--text-faint);
}
.dl-item.on .dl-count2 {
  color: var(--accent);
}
.dl-tip {
  flex: none;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-subtle);
  padding: 7px 10px;
  border-top: 1px solid var(--border);
}
.dl-tip b {
  color: var(--accent, #0079bf);
}
.dl-body {
  flex: 1;
  overflow: auto;
  padding: 6px;
}
.dl-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 9px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
  color: var(--text);
  transition: background 0.13s var(--ease), color 0.13s var(--ease);
}
.dl-item:hover {
  background: var(--bg-sunken);
}
.dl-item.on {
  position: relative;
  background: var(--accent-soft);
  color: var(--text);
  font-weight: 550;
}
/* 选中态左侧一条小竖条 —— 比整行变色克制，也和参考稿的列表样式一致 */
.dl-item.on::before {
  content: "";
  position: absolute;
  left: 1px;
  top: 50%;
  width: 3px;
  height: 14px;
  border-radius: 2px;
  background: var(--accent);
  transform: translateY(-50%);
}
.dl-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dl-del {
  border: none;
  background: transparent;
  color: inherit;
  opacity: 0;
  cursor: pointer;
  font-size: 12px;
  padding: 0 2px;
}
.dl-item:hover .dl-del {
  opacity: 0.65;
}
.dl-del:hover {
  opacity: 1 !important;
  color: var(--danger);
}
.dl-rename {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-family: inherit;
  padding: 2px 5px;
  border: 1px solid var(--accent);
  border-radius: 6px;
  background: var(--bg-elevated);
  color: var(--text);
  outline: none;
}
.dl-empty {
  font-size: 12px;
  color: var(--text-subtle);
  text-align: center;
  line-height: 2;
  padding: 24px 8px;
}

/* ---- 右：编辑器 ---- */
.editor {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  /* 正文底色：默认护眼绿（可在「🎨 底色」里换）；字色随底色自动取深/浅 */
  --doc-bg: var(--bg);
}
.ed-body {
  flex: 1;
  display: flex;
  min-height: 0;
  min-width: 0;
  border-radius: 0 0 12px 12px;
  overflow: hidden;
}
.ed-ta {
  flex: 1;
  min-width: 0;
  resize: none;
  border: none;
  outline: none;
  padding: 16px 18px;
  font-family: Consolas, "Cascadia Mono", "Microsoft YaHei", monospace;
  font-size: 13.5px;
  line-height: 1.85;
  color: var(--doc-ink, var(--text));
  background: var(--doc-bg);
  tab-size: 2;
}
.ed-prev {
  flex: 1;
  min-width: 0;
  overflow: auto;
  padding: 16px 22px 60px;
  border-left: 1px solid var(--border);
  color: var(--doc-ink, var(--text));
  background: var(--doc-bg);
}
/* Vditor（所见即所得）的正文区跟着底色走；工具栏保持主题色不动 */
.ed-body :deep(.vditor),
.ed-body :deep(.vditor-wysiwyg pre.vditor-reset) {
  background: var(--doc-bg);
}
.ed-body :deep(.vditor-wysiwyg pre.vditor-reset) {
  color: var(--doc-ink, var(--text));
}
/* 预览里的行内代码 / 引用块在绿底上也要看得出来 */
.ed-prev :deep(.md-body code) {
  background: rgba(127, 127, 127, 0.14);
}
/* 「🎨 底色」菜单 */
.bg-dot {
  display: inline-block;
  width: 14px;
  height: 14px;
  border-radius: 4px;
  margin-right: 6px;
  vertical-align: -2px;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.12);
}
.bg-dot-theme {
  background: linear-gradient(135deg, #fff 0 50%, #2b2f36 50% 100%);
}
.bg-custom {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  width: 100%;
}
.bg-custom input[type="color"] {
  width: 26px;
  height: 18px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: transparent;
  cursor: pointer;
}
.bg-menu .on {
  color: var(--accent, #409eff);
  font-weight: 600;
}
.ed-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-elevated, var(--bg));
}
.ed-title {
  flex: 1;
  min-width: 160px;
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
  background: transparent;
  border: none;
  border-bottom: 1px dashed transparent;
  outline: none;
  padding: 3px 2px;
}
.ed-title:focus {
  border-bottom-color: var(--accent, #0079bf);
}
.ed-stat {
  font-size: 12px;
  color: var(--text-subtle);
  white-space: nowrap;
}
.ed-save {
  font-size: 12px;
  color: var(--text-subtle);
  min-width: 48px;
  white-space: nowrap;
}
.ed-save.saved {
  color: var(--ok);
}
.ed-save.saving {
  color: var(--warn);
}

/* ---- 格式工具栏 ---- */
.ed-tools {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-wrap: wrap;
  padding: 5px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-elevated, var(--bg));
}
.ft {
  border: 1px solid transparent;
  background: transparent;
  color: var(--text);
  font-size: 12px;
  line-height: 1.4;
  padding: 3px 7px;
  border-radius: 5px;
  cursor: pointer;
  white-space: nowrap;
  user-select: none;
}
.ft:hover {
  background: var(--bg-sunken, rgba(127, 127, 127, 0.12));
  border-color: var(--border);
}
.ft-wide {
  font-weight: 600;
  font-family: Consolas, "Cascadia Mono", monospace;
}
.ft-sep {
  width: 1px;
  height: 16px;
  background: var(--border);
  margin: 0 6px;
  flex: none;
}

.editor-empty {
  align-items: center;
  justify-content: center;
  text-align: center;
  color: var(--text-subtle);
  gap: 6px;
}
.ee-icon {
  font-size: 38px;
}
.ee-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
  margin-top: 6px;
}
.ee-sub {
  font-size: 13px;
  line-height: 1.9;
  margin-bottom: 12px;
}

/* ---------- 窄栏自适应（放在最后，才能盖住上面的固定宽度）----------
   分屏（尤其三栏）时写作栏可能只有 400px 出头，
   左侧固定 210px 的文档列表会把编辑器挤到没法写字
   → 把文档列表折成顶部一条可横向滚动的「文档胶囊」，编辑器独占整宽。 */
@container (max-width: 660px) {
  .write {
    flex-direction: column;
  }
  .doc-list {
    width: auto;
    flex: none;
    border-right: none;
    border-bottom: 1px solid var(--border);
  }
  .dl-head {
    padding: 5px 9px;
  }
  .dl-body {
    display: flex;
    gap: 5px;
    flex: none;
    overflow-x: auto;
    overflow-y: hidden;
    padding: 5px 9px;
  }
  .dl-item {
    flex: none;
    max-width: 156px;
    padding: 3px 10px;
    font-size: 12px;
    border: 1px solid var(--border);
    border-radius: 999px;
  }
  .dl-item.on {
    border-color: transparent;
  }
  .dl-del {
    opacity: 0.55;
  }
  .dl-empty {
    padding: 6px 0;
    text-align: left;
  }
}
@container (max-width: 470px) {
  .ed-head {
    gap: 6px;
    padding: 6px 9px;
  }
  .ed-stat {
    display: none;
  }
  .ed-tools {
    gap: 3px;
    padding: 5px 9px;
  }
}
</style>

<style>
/* 预览区排版（不加 scoped，v-html 生成的内容才吃得到） */
.md-body {
  font-size: 14px;
  line-height: 1.85;
  color: var(--text);
  word-wrap: break-word;
}
.md-body h1,
.md-body h2,
.md-body h3,
.md-body h4,
.md-body h5,
.md-body h6 {
  font-weight: 600;
  line-height: 1.4;
  margin: 1.2em 0 0.5em;
}
.md-body h1 {
  font-size: 22px;
  border-bottom: 1px solid var(--border);
  padding-bottom: 6px;
}
.md-body h2 {
  font-size: 18px;
}
.md-body h3 {
  font-size: 16px;
}
.md-body h4,
.md-body h5,
.md-body h6 {
  font-size: 14px;
}
.md-body p {
  margin: 0.6em 0;
}
.md-body ul,
.md-body ol {
  margin: 0.5em 0;
  padding-left: 1.6em;
}
.md-body li {
  margin: 0.22em 0;
}
.md-body blockquote {
  margin: 0.7em 0;
  padding: 6px 14px;
  border-left: 3px solid var(--border);
  color: var(--text-subtle);
  background: rgba(127, 127, 127, 0.07);
  border-radius: 0 6px 6px 0;
}
.md-body code {
  font-family: Consolas, Menlo, monospace;
  font-size: 0.9em;
  background: rgba(127, 127, 127, 0.15);
  padding: 1px 5px;
  border-radius: 4px;
  color: #c7254e;
}
.md-body pre {
  background: rgba(127, 127, 127, 0.12);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 14px;
  overflow: auto;
  margin: 0.7em 0;
}
.md-body pre code {
  background: none;
  color: var(--text);
  padding: 0;
}
.md-body table {
  border-collapse: collapse;
  margin: 0.8em 0;
  width: 100%;
  font-size: 13px;
}
.md-body th,
.md-body td {
  border: 1px solid var(--border);
  padding: 6px 10px;
  text-align: left;
}
.md-body th {
  background: rgba(127, 127, 127, 0.12);
  font-weight: 600;
}
.md-body hr {
  border: none;
  border-top: 1px solid var(--border);
  margin: 1.4em 0;
}
.md-body a {
  color: var(--accent, #0079bf);
}
.md-body img {
  max-width: 100%;
  border-radius: 6px;
}
.md-body input[type="checkbox"] {
  margin-right: 5px;
}

/* ---- 插入图片弹窗 ---- */
.wi-zone {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 22px 16px;
  border: 1.5px dashed var(--border-strong, var(--border));
  border-radius: var(--radius-md, 10px);
  background: var(--bg-sunken, rgba(127, 127, 127, 0.04));
  cursor: pointer;
  position: relative;
}
.wi-zone:hover {
  border-color: var(--accent);
}
/* 原生 input 保持可见 —— 用户 Edge 会静默拦截 JS click 打开的文件框 */
.wi-input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}
.wi-ico {
  font-size: 24px;
}
.wi-main {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.wi-sub {
  font-size: 11.5px;
  color: var(--text-subtle);
}
.wi-note {
  margin-top: 12px;
  font-size: 11.5px;
  line-height: 1.8;
  color: var(--text-subtle);
}
.wi-empty {
  padding: 26px 10px;
  text-align: center;
  font-size: 12.5px;
  line-height: 2;
  color: var(--text-subtle);
}
.wi-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
  gap: 10px;
  max-height: 52vh;
  overflow-y: auto;
  padding: 2px;
}
.wi-card {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 6px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--bg-elevated);
  cursor: pointer;
  overflow: hidden;
}
.wi-card:hover {
  border-color: var(--accent);
  box-shadow: var(--shadow-sm);
}
.wi-card img {
  width: 100%;
  height: 92px;
  object-fit: cover;
  border-radius: 5px;
  display: block;
  background: var(--bg-sunken, rgba(127, 127, 127, 0.08));
}
.wi-wait {
  height: 92px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-faint);
}
.wi-name {
  font-size: 11px;
  color: var(--text-subtle);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ---------------------------------------------------------------
   底色作用于**整个文档栏**：左侧列表 + 顶部标题 + 格式条 + 正文一体，
   不再只染中间那块文字区（看起来更像"一页纸"，也和白板/看板的面板一致）。
   --doc-bg / --doc-ink 挂在外层 .write 上，这里只负责"别挡住它"。
   --------------------------------------------------------------- */
.write {
  background: var(--doc-bg);
  color: var(--doc-ink, var(--text));
}
.write .doc-list,
.write .ed-head,
.write .ed-tools,
.write .ed-body,
.write .ed-ta,
.write .ed-prev {
  background: transparent;
}
/* 分隔线改用"半透明墨色"，落在任何底色上都不突兀 */
.write .doc-list {
  border-right: 1px solid rgba(127, 127, 127, 0.24);
}
.write .dl-head {
  border-bottom: 1px solid rgba(127, 127, 127, 0.2);
}
.write .ed-tools {
  border-bottom: 1px solid rgba(127, 127, 127, 0.18);
}
/* 列表里的文字跟着底色走（深色底自动变浅字，浅色底变深字） */
.write .dl-count,
.write .dl-tip {
  color: var(--doc-ink, var(--text));
  opacity: 0.62;
}
.write .dl-item {
  color: var(--doc-ink, var(--text));
}
.write .dl-item.on {
  background: rgba(127, 127, 127, 0.16);
}
/* 格式条上的按钮：不用主题底色，免得在绿底/深底上显出一块白 */
.write .ed-tools .ft {
  background: rgba(127, 127, 127, 0.1);
  color: var(--doc-ink, var(--text));
  border-color: rgba(127, 127, 127, 0.22);
}
.write .ed-tools .ft:hover {
  background: rgba(127, 127, 127, 0.18);
}
/* 工具条上的 Element 按钮（看板任务 / 插入图片 / 导出…）同样融入底色 */
.write .ed-tools :deep(.el-button) {
  background: rgba(127, 127, 127, 0.1);
  border-color: rgba(127, 127, 127, 0.22);
  color: var(--doc-ink, var(--text));
}
.write .ed-tools :deep(.el-button:hover) {
  background: rgba(127, 127, 127, 0.18);
  border-color: rgba(127, 127, 127, 0.3);
  color: var(--doc-ink, var(--text));
}
.write .ed-tools :deep(.el-button--primary) {
  background: rgba(90, 103, 200, 0.92);
  border-color: transparent;
  color: #fff;
}
/* 列表里的小按钮（＋新建 等）也跟着底色走，别在绿底上冒白块 */
.write .dl-new,
.write .dl-item .dl-count2 {
  background: rgba(127, 127, 127, 0.1);
  border-color: rgba(127, 127, 127, 0.22);
  color: var(--doc-ink, var(--text));
}
/* Vditor 自己的白底也要让开，否则正文区会露出一块 */
.write .ed-body :deep(.vditor),
.write .ed-body :deep(.vditor-reset),
.write .ed-body :deep(.vditor-wysiwyg pre.vditor-reset) {
  background: transparent;
}
</style>
