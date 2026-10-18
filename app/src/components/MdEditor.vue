<script setup lang="ts">
/**
 * 所见即所得 Markdown 编辑器（基于 Vditor）。
 *
 * 为什么用 Vditor：
 *   MarkText 的编辑器是它自研的 `packages/muya`（contenteditable 自绘块级编辑器），
 *   和它的 store / i18n / 主题深度耦合、几万行代码，没法搬进来。
 *   而 Vditor 是现成的、**Markdown 原生**的编辑器，wysiwyg 模式完全不显示语法，
 *   中文文档齐全，并且 getValue() 直接给 Markdown —— 和我们的导出管线（md/docx/导图）无缝对接。
 *
 * 资源离线化：见 scripts/sync-vditor-assets.mjs（把 dist 同步到 public/vditor/dist）。
 * 这里动态加载它的 UMD 包，不参与 Vite 打包（它的 npm 入口依赖 .less，会额外牵扯构建链）。
 */
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { reportError } from "../diag";
import { api } from "../api";

/** 启动性能探针（写 diag.log；浏览器里打控制台），失败不影响功能 */
const apiPerf = (line: string) => void api.diagLog(line);

type MdVariant = "wysiwyg" | "ir";

const props = withDefaults(
  defineProps<{
    modelValue: string;
    /** wysiwyg = 完全不显示语法；ir = 即时渲染（光标那行露语法，风格更像 MarkText） */
    variant?: MdVariant;
  }>(),
  { variant: "wysiwyg" }
);
const emit = defineEmits<{
  (e: "update:modelValue", v: string): void;
  (e: "ready"): void;
}>();

/** 只留写作真正用得上的按钮（不装数学/图表那些扩展资源） */
const TOOLBAR = [
  "headings",
  "bold",
  "italic",
  "strike",
  "link",
  "|",
  "list",
  "ordered-list",
  "check",
  "|",
  "quote",
  "line",
  "code",
  "inline-code",
  "|",
  "table",
  "undo",
  "redo",
  "|",
  "fullscreen",
];

const host = ref<HTMLElement | null>(null);
const failed = ref(false);
let vd: any = null;
let ready = false;
/** 记下「是自己敲出来的值」，外部值等于它时不要回灌（回灌会让光标跳到开头） */
let selfValue = props.modelValue;
let observer: MutationObserver | null = null;
/**
 * 编辑器就绪前收到的插入请求（比如白板右键图片"发送到文档"时，
 * 文档栏刚好刚挂载、Vditor 脚本还在加载）。就绪后按顺序补插，
 * 否则 `insertValue` 会在 vd 还是 null 时被静默丢掉，用户以为没生效。
 */
const pendingInserts: string[] = [];

/**
 * 用户有没有在这篇里放过光标（点过/打过字）。
 * 白板右键「发送到文档」时，如果文档栏才刚打开、用户根本没点进去，
 * Vditor 的"当前光标"其实是文档开头 —— 图片会插到标题上面，很怪。
 * 这种情况改成追加到正文末尾；用户真点了某处，就老老实实插在他点的位置。
 */
let caretPlaced = false;

/**
 * 插完后主动把 Markdown 回吐给外面。
 * ⚠️ 不能指望 Vditor 的 `input` 回调：`insertValue` / `setValue` 这类"程序插入"
 * 在所见即所得模式下不一定会触发 input，外面拿到的正文就还是旧的 ——
 * 表现是"图看得见，但保存下来没有"。
 */
function syncOut() {
  const v = vd?.getValue();
  if (typeof v === "string") {
    selfValue = v;
    emit("update:modelValue", v);
  }
}

function doInsert(md: string) {
  if (!vd) return;
  if (!caretPlaced) {
    const cur = String(vd.getValue() ?? "");
    const sep = cur.trim() ? "\n\n" : "";
    vd.setValue(cur.replace(/\s+$/, "") + sep + md + "\n");
    syncOut();
    return;
  }
  vd.insertValue(md, true);
  syncOut();
}

const isDark = () => document.documentElement.classList.contains("dark");

/** 模块级单例：多个写作栏共用一份 Vditor */
let loader: Promise<void> | null = null;
function loadVditor(): Promise<void> {
  const w = window as any;
  if (w.Vditor) return Promise.resolve();
  if (loader) return loader;
  loader = new Promise<void>((resolve, reject) => {
    if (!document.getElementById("vditor-assets")) {
      const link = document.createElement("link");
      link.id = "vditor-assets";
      link.rel = "stylesheet";
      link.href = "/vditor/dist/index.css";
      document.head.appendChild(link);
    }
    const s = document.createElement("script");
    s.src = "/vditor/dist/index.min.js";
    s.async = true;
    s.onload = () => (w.Vditor ? resolve() : reject(new Error("Vditor 没有挂到 window 上")));
    s.onerror = () => reject(new Error("Vditor 脚本加载失败（public/vditor 资源缺失？）"));
    document.head.appendChild(s);
  });
  return loader;
}

async function create() {
  const t0 = performance.now();
  try {
    await loadVditor();
  } catch (e) {
    failed.value = true;
    reportError("加载 Markdown 编辑器", e);
    return;
  }
  if (!host.value) return;
  const Vditor = (window as any).Vditor;
  const dark = isDark();
  vd = new Vditor(host.value, {
    mode: props.variant,
    value: props.modelValue || "",
    // 资源走本地（绝对路径在 dev / Tauri 下都指向 dist 根）
    cdn: "/vditor",
    height: "100%",
    lang: "zh_CN",
    // 不要它自带的 localStorage 缓存 —— 我们有自己的文档表，别插一手
    cache: { enable: false },
    placeholder: "在这里直接写正文 —— 像 Word 一样，不用管语法。",
    theme: dark ? "dark" : "classic",
    preview: {
      theme: { current: dark ? "dark" : "light" },
      hljs: { style: dark ? "monokai" : "github", lineNumber: false },
    },
    toolbarConfig: { pin: true },
    toolbar: TOOLBAR,
    // 字数统计在 App 自己的头部（而且要把图片的 data URL 排除掉），
    // Vditor 自带那个会把 base64 也算进去，显示成"20 万字"，纯属吓人。
    counter: { enable: false },
    input: (v: string) => {
      selfValue = v;
      emit("update:modelValue", v);
    },
    after: () => {
      ready = true;
      emit("ready");
      // 启动卡顿排查：Vditor 从开始加载到真正就绪用了多久
      void apiPerf(`VDITOR ready=${(performance.now() - t0).toFixed(0)}ms`);
      while (pendingInserts.length) {
        const md = pendingInserts.shift() as string;
        try {
          doInsert(md);
        } catch {
          /* 单条失败不影响后面的 */
        }
      }
    },
  });

  // 用户一旦点进正文/开始打字，就记下"光标是他自己放的"
  const markCaret = () => {
    caretPlaced = true;
  };
  host.value.addEventListener("mouseup", markCaret);
  host.value.addEventListener("keyup", markCaret);

  // 跟随应用主题（html.dark）
  observer = new MutationObserver(() => {
    if (!vd) return;
    const d = isDark();
    vd.setTheme(d ? "dark" : "classic", d ? "dark" : "light", d ? "monokai" : "github");
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
}

onMounted(create);

watch(
  () => props.modelValue,
  (v) => {
    if (v === selfValue) return;
    selfValue = v;
    if (ready && vd) vd.setValue(v || "");
  }
);

onBeforeUnmount(() => {
  observer?.disconnect();
  observer = null;
  ready = false;
  try {
    vd?.destroy();
  } catch {
    /* 忽略 */
  }
  vd = null;
});

defineExpose({
  /** 插入 Markdown；用户放过光标就插在光标处，否则追加到末尾。没就绪先排队 */
  insert: (md: string) => {
    if (ready && vd) doInsert(md);
    else pendingInserts.push(md);
  },
  focus: () => vd?.focus(),
  getValue: (): string => vd?.getValue() ?? props.modelValue,
});
</script>

<template>
  <div class="md-editor">
    <div v-show="!failed" ref="host" class="me-host"></div>
    <div v-if="failed" class="me-fail">
      <div style="font-size: 30px">⚠️</div>
      <div>编辑器资源没加载出来（`public/vditor` 缺失）。</div>
      <div class="me-fail-sub">
        在 app 目录执行 <code>node scripts/sync-vditor-assets.mjs</code> 重新同步即可。<br />
        这期间可以先用下面的「⌨ 源码」模式写作。
      </div>
    </div>
  </div>
</template>

<style scoped>
.md-editor {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.me-host {
  flex: 1;
  min-height: 0;
}
.me-fail {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: var(--text-subtle);
  text-align: center;
  padding: 24px;
}
.me-fail-sub {
  font-size: 12px;
  line-height: 1.9;
}
.me-fail code {
  background: var(--bg-sunken, rgba(127, 127, 127, 0.14));
  padding: 1px 5px;
  border-radius: 4px;
}
</style>

<style>
/* Vditor 内部样式微调（非 scoped，它渲染出来的 DOM 在组件外） */
.md-editor .vditor {
  border: none !important;
  border-radius: 0 !important;
}
.md-editor .vditor-toolbar {
  border-bottom: 1px solid var(--border) !important;
  padding-left: 10px !important;
  background: var(--bg-elevated, var(--bg)) !important;
}
.md-editor .vditor-reset {
  font-size: 15px;
  line-height: 1.9;
  padding: 20px 26px 80px;
}
.md-editor .vditor-counter {
  color: var(--text-subtle);
}
</style>
