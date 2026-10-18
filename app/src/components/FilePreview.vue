<template>
  <el-dialog
    v-model="visible"
    :title="file?.name || '资料预览'"
    class="fp-dialog"
    width="min(1200px, 95vw)"
    top="3vh"
    append-to-body
    destroy-on-close
    @closed="reset"
  >
    <div class="fp-head">
      <span class="fp-icon">{{ icon }}</span>
      <span class="fp-name" :title="file?.name">{{ file?.name }}</span>
      <span class="fp-meta">{{ sizeText }}</span>
      <div class="fp-tools">
        <button
          class="fp-btn"
          title="把这份资料引到白板上；先框选一段文字，就只引这一段（PDF 里选不了，会整份引用）"
          @click="citeToBoard"
        >
          📌 引用到白板
        </button>
        <button v-if="kind === 'img'" class="fp-btn" @click="resetView">适应窗口</button>
        <button class="fp-btn" @click="openExternal">↗ 用系统程序打开</button>
        <button class="fp-btn" @click="revealFile">📁 定位文件</button>
      </div>
    </div>

    <div class="fp-body">
      <div v-if="loading" class="fp-center">
        <span class="fp-spin"></span>
        <span>正在准备预览…</span>
      </div>

      <div v-else-if="kind === 'img'" class="fp-imgwrap">
        <img
          :src="imgUrl"
          :style="{ transform: `translate(${tx}px, ${ty}px) scale(${scale})` }"
          draggable="false"
          alt=""
          @wheel.prevent="onWheel"
          @pointerdown="startPan"
          @dblclick="resetView"
        />
        <div class="fp-zoomtip">滚轮缩放 · 拖动平移 · 双击复位 · {{ Math.round(scale * 100) }}%</div>
      </div>

      <iframe v-else-if="kind === 'pdf'" class="fp-frame" :src="blobUrl" title="PDF 预览"></iframe>

      <div v-else-if="kind === 'video'" class="fp-center">
        <video class="fp-media" :src="blobUrl" controls autoplay></video>
      </div>

      <div v-else-if="kind === 'audio'" class="fp-center">
        <div class="fp-audio">
          <div class="fp-audio-icon">🎵</div>
          <audio :src="blobUrl" controls></audio>
        </div>
      </div>

      <pre v-else-if="kind === 'text'" class="fp-text">{{ text }}</pre>

      <div v-else-if="kind === 'office'" class="fp-office">
        <div class="fp-docnote">
          ⚠️ 以下是<b>文字内容</b>，排版、图片、表格样式不会显示 —— 要看原始版式请点右上角「用系统程序打开」。
        </div>
        <div v-for="(b, bi) in office?.blocks || []" :key="bi" class="fp-block">
          <div v-if="(office?.blocks.length || 0) > 1" class="fp-block-label">{{ b.label }}</div>
          <p v-for="(l, li) in b.lines" :key="li">{{ l }}</p>
        </div>
      </div>

      <div v-else class="fp-center fp-fallback">
        <div class="fp-fallback-icon">{{ icon }}</div>
        <div class="fp-fallback-title">{{ fallbackTitle }}</div>
        <div class="fp-fallback-sub">{{ fallbackSub }}</div>
        <button class="fp-primary" @click="openExternal">↗ 用系统程序打开</button>
      </div>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { WbFile } from "../types";
import { extOf, fileIcon, formatBytes, isImageFile } from "../types";
import { api, isTauri } from "../api";
import { extractOfficeText, type OfficePreview } from "../ooxml";

const props = defineProps<{ modelValue: boolean; file: WbFile | null }>();
const emit = defineEmits<{
  (e: "update:modelValue", v: boolean): void;
  (e: "cite", payload: { file: WbFile; quote: string }): void;
}>();

const visible = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit("update:modelValue", v),
});

/** 预览区里选中的文字（PDF 是 iframe，拿不到选区，只能整份引用） */
function selectedText(): string {
  try {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return "";
    const t = sel.toString().replace(/\s+$/, "");
    return t.length > 2000 ? t.slice(0, 2000) : t;
  } catch {
    return "";
  }
}

function citeToBoard() {
  if (!props.file) return;
  emit("cite", { file: props.file, quote: selectedText() });
}

type Kind = "img" | "pdf" | "video" | "audio" | "text" | "office" | "other";

const VIDEO_EXTS = ["mp4", "webm", "ogv", "mov", "m4v"];
const AUDIO_EXTS = ["mp3", "wav", "ogg", "m4a", "flac", "aac"];
const TEXT_EXTS = [
  "txt", "md", "markdown", "log", "csv", "tsv", "json", "xml", "yml", "yaml",
  "html", "htm", "css", "js", "ts", "py", "java", "c", "cpp", "cs", "go", "rs",
  "sql", "ini", "conf", "bat", "sh",
];
const OFFICE_EXTS = ["docx", "pptx", "xlsx"];

const kind = ref<Kind>("other");
const loading = ref(false);
// 图片缩放/平移。必须定义在下面的 watch(immediate) 之前：
// 那个 watch 会在 setup 期间立刻跑一次 load()，而 load() 会调 reset() 用到它们。
const scale = ref(1);
const tx = ref(0);
const ty = ref(0);
const errText = ref("");
const imgUrl = ref("");
const blobUrl = ref("");
const text = ref("");
const office = ref<OfficePreview | null>(null);

const icon = computed(() => fileIcon(props.file?.ext ?? ""));
const sizeText = computed(() => (props.file ? formatBytes(props.file.size) : ""));

const fallbackTitle = computed(() => {
  if (errText.value) return "打不开这份文件";
  const e = extOf(props.file?.name ?? "");
  if (["doc", "ppt", "xls"].includes(e)) return "这是老版 Office 格式（.doc/.ppt/.xls）";
  return "这类文件没法在应用内预览";
});
const fallbackSub = computed(() => {
  if (errText.value) return errText.value;
  const e = extOf(props.file?.name ?? "");
  if (["doc", "ppt", "xls"].includes(e)) {
    return "老格式不是压缩包结构，读不出文字。请用系统程序打开，或在 Office 里另存为新格式（.docx/.pptx/.xlsx）后再上传。";
  }
  if (["zip", "rar", "7z", "exe", "dwg", "psd", "ai"].includes(e)) {
    return "压缩包、安装程序、CAD/设计源文件等需要专门的软件打开。";
  }
  return "点击下面的按钮用系统默认程序打开。";
});

// ---------- 读取内容 ----------

function dataUrlToBlob(dataUrl: string, fallbackMime = "application/octet-stream"): Blob {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) throw new Error("文件内容格式不正确");
  const head = dataUrl.slice(0, comma);
  const body = dataUrl.slice(comma + 1);
  const mime = /^data:([^;,]+)/.exec(head)?.[1] || fallbackMime;
  if (/;base64/i.test(head)) {
    const bin = atob(body);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new Blob([u8], { type: mime });
  }
  return new Blob([decodeURIComponent(body)], { type: mime });
}

function revoke() {
  if (blobUrl.value) {
    URL.revokeObjectURL(blobUrl.value);
    blobUrl.value = "";
  }
}

function reset() {
  revoke();
  kind.value = "other";
  loading.value = false;
  errText.value = "";
  imgUrl.value = "";
  text.value = "";
  office.value = null;
  resetView();
}

function resetView() {
  scale.value = 1;
  tx.value = 0;
  ty.value = 0;
}

async function load() {
  reset();
  const f = props.file;
  if (!f || !props.modelValue) return;
  // 超大文件别硬读到内存里转 data URL，那会把页面撑爆 —— 直接引导去用系统程序
  if (f.size > 60 * 1024 * 1024) {
    errText.value = `这个文件有 ${formatBytes(f.size)}，太大，不适合在应用内预览。`;
    kind.value = "other";
    return;
  }
  loading.value = true;
  try {
    const dataUrl = await api.readAssetDataUrl(f.id);
    if (!dataUrl) throw new Error("读到的是空内容（浏览器预览模式下刷新过页面会清空）");
    const e = (f.ext || extOf(f.name)).toLowerCase();

    if (isImageFile(f)) {
      imgUrl.value = dataUrl;
      kind.value = "img";
    } else if (e === "pdf") {
      blobUrl.value = URL.createObjectURL(dataUrlToBlob(dataUrl, "application/pdf"));
      kind.value = "pdf";
    } else if (VIDEO_EXTS.includes(e) || (f.mime || "").startsWith("video/")) {
      blobUrl.value = URL.createObjectURL(dataUrlToBlob(dataUrl, f.mime));
      kind.value = "video";
    } else if (AUDIO_EXTS.includes(e) || (f.mime || "").startsWith("audio/")) {
      blobUrl.value = URL.createObjectURL(dataUrlToBlob(dataUrl, f.mime));
      kind.value = "audio";
    } else if (TEXT_EXTS.includes(e) || (f.mime || "").startsWith("text/")) {
      if (f.size > 3 * 1024 * 1024) throw new Error("文本超过 3MB，为免卡住就不在应用内打开了");
      const blob = dataUrlToBlob(dataUrl, f.mime || "text/plain");
      const raw = await blob.text();
      text.value = raw.length > 400000 ? raw.slice(0, 400000) + "\n\n…（内容过长，已截断）" : raw;
      kind.value = "text";
    } else if (OFFICE_EXTS.includes(e)) {
      const blob = dataUrlToBlob(dataUrl, f.mime);
      const res = await extractOfficeText(blob, e);
      if (res && res.lineCount > 0) {
        office.value = res;
        kind.value = "office";
      } else {
        errText.value = "这份文档里没读到文字（可能是空文档，或文字都在图片里）";
        kind.value = "other";
      }
    } else {
      kind.value = "other";
    }
  } catch (e: any) {
    errText.value = e?.message || String(e);
    kind.value = "other";
  } finally {
    loading.value = false;
  }
}

watch(() => [props.modelValue, props.file?.id] as const, () => void load(), { immediate: true });
onBeforeUnmount(revoke);

// ---------- 图片缩放 / 平移 ----------

function onWheel(e: WheelEvent) {
  const next = scale.value * (e.deltaY > 0 ? 0.9 : 1.1);
  scale.value = Math.min(10, Math.max(0.1, next));
}

function startPan(e: PointerEvent) {
  if (e.button !== 0) return;
  e.preventDefault();
  const sx = e.clientX;
  const sy = e.clientY;
  const ox = tx.value;
  const oy = ty.value;
  const el = e.currentTarget as HTMLElement;
  const move = (ev: PointerEvent) => {
    tx.value = ox + (ev.clientX - sx);
    ty.value = oy + (ev.clientY - sy);
    if (el) el.style.cursor = "grabbing";
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    if (el) el.style.cursor = "grab";
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

// ---------- 外部程序 ----------

async function openExternal() {
  if (!props.file) return;
  if (!isTauri) {
    alert("浏览器预览模式下没有真实文件系统。要用系统程序打开，请在桌面版里操作。");
    return;
  }
  try {
    await api.openAsset(props.file.id);
  } catch (e: any) {
    alert("打开失败：" + (e?.message || e));
  }
}
async function revealFile() {
  if (!props.file) return;
  if (!isTauri) {
    alert("浏览器预览模式下没有真实文件系统。要定位文件，请在桌面版里操作。");
    return;
  }
  try {
    await api.revealAsset(props.file.id);
  } catch (e: any) {
    alert("定位失败：" + (e?.message || e));
  }
}
</script>

<style scoped>
.fp-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 10px;
}
.fp-icon {
  font-size: 18px;
}
.fp-name {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 44%;
}
.fp-meta {
  font-size: 12px;
  color: var(--text-subtle);
}
.fp-tools {
  margin-left: auto;
  display: flex;
  gap: 8px;
}
.fp-btn {
  font-size: 12px;
  padding: 3px 10px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  color: var(--text);
  cursor: pointer;
}
.fp-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.fp-body {
  height: 72vh;
  overflow: auto;
  background: var(--bg-sunken);
  border-radius: 8px;
  position: relative;
}
.fp-center {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--text-subtle);
  font-size: 13px;
}
.fp-spin {
  width: 22px;
  height: 22px;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: fpspin 0.8s linear infinite;
}
@keyframes fpspin {
  to {
    transform: rotate(360deg);
  }
}

/* 图片 */
.fp-imgwrap {
  height: 100%;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: grab;
}
.fp-imgwrap img {
  max-width: 100%;
  max-height: 100%;
  user-select: none;
  transition: transform 0.06s linear;
}
.fp-zoomtip {
  position: absolute;
  left: 10px;
  bottom: 8px;
  font-size: 12px;
  color: var(--text-subtle);
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 2px 8px;
}

/* PDF */
.fp-frame {
  width: 100%;
  height: 100%;
  border: 0;
  background: #fff;
}

/* 媒体 */
.fp-media {
  max-width: 92%;
  max-height: 68vh;
  background: #000;
  border-radius: 6px;
}
.fp-audio {
  display: flex;
  align-items: center;
  gap: 14px;
}
.fp-audio-icon {
  font-size: 40px;
}

/* 文本 */
.fp-text {
  margin: 0;
  padding: 16px 18px;
  font-family: "Cascadia Mono", Consolas, "Courier New", monospace;
  font-size: 13px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text);
}

/* Office 文字稿 */
.fp-office {
  padding: 14px 18px 22px;
  color: var(--text);
  font-size: 14px;
  line-height: 1.8;
}
.fp-docnote {
  font-size: 12px;
  color: #b88230;
  background: #fff7e6;
  border: 1px solid #ffe0a3;
  border-radius: 6px;
  padding: 8px 10px;
  margin-bottom: 14px;
  line-height: 1.6;
}
.fp-block {
  margin-bottom: 18px;
}
.fp-block-label {
  font-weight: 600;
  font-size: 13px;
  color: var(--text-subtle);
  margin: 0 0 6px;
  padding-bottom: 4px;
  border-bottom: 1px dashed var(--border);
}
.fp-office p {
  margin: 0 0 6px;
  white-space: pre-wrap;
  word-break: break-word;
}

/* 兜底 */
.fp-fallback-icon {
  font-size: 46px;
}
.fp-fallback-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}
.fp-fallback-sub {
  max-width: 520px;
  text-align: center;
  line-height: 1.7;
  padding: 0 20px;
}
.fp-primary {
  margin-top: 6px;
  padding: 7px 20px;
  border-radius: 8px;
  border: 0;
  background: var(--accent);
  color: #fff;
  font-size: 13px;
  cursor: pointer;
}
</style>

<style>
.fp-dialog .el-dialog__body {
  padding: 10px 16px 16px;
}
html.dark .fp-docnote {
  background: #3a2f14;
  border-color: #6b551f;
  color: #e8c47a;
}
</style>
