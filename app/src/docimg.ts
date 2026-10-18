/**
 * 文档插图：**内嵌 base64 ↔ 编辑器里的 blob 短链**。
 *
 * 为什么需要这层转换（2026-10-18 实测）：
 * 一篇 4.4MB 的文档，图片全是以 `![x](data:image/png;base64,...)` 内嵌的。
 * Vditor 初始化时要把**整篇 Markdown** 过一遍解析器（Lute），
 * 实测主线程被堵 **9.9 秒**（diag.log: `VDITOR ready=9905ms`），
 * 表现就是"界面已经出来了，但点不动、平移缩放全无响应"。
 *
 * 而 base64 对「显示」毫无必要 —— 换成 `blob:` 短链后：
 *   · 编辑器只解析几十 KB 文本，初始化回到几百毫秒；
 *   · 图片照常显示（浏览器直接读内存里的 blob）；
 *   · 写回正文/落库时再换回 data URL —— `.md` 文件格式一个字节都不变，
 *     拷给别人、用 Typora 打开仍然自带图片。
 *
 * ⚠️ 只做「图片语法里的 data URL」替换，正文里的普通文本不动，避免误伤。
 */

/** `![alt](data:image/png;base64,....)` */
const DATA_IMG_RE = /!\[([^\]]*)\]\((data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+)\)/g;

/** 编辑器里出现的 blob 地址（Tauri 与浏览器 origin 不同，统一按 blob: 前缀认） */
const BLOB_RE = /blob:https?:\/\/[^\s)"']+/g;

/** data URL → blob URL（同一张图只解码一次，编辑器里可能被引用多次） */
const blobOf = new Map<string, string>();
/** blob URL → data URL（写回正文时用） */
const dataOf = new Map<string, string>();

/** 小于这个长度就没必要转（转换本身也有成本，小文档本来就秒开） */
const SHRINK_MIN = 120_000;

function dataUrlToBlobUrl(dataUrl: string): string {
  const hit = blobOf.get(dataUrl);
  if (hit) return hit;
  try {
    const comma = dataUrl.indexOf(",");
    if (comma < 0) return dataUrl;
    const meta = dataUrl.slice("data:".length, comma); // 例如 image/png;base64
    const mime = meta.split(";")[0] || "image/png";
    const bin = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    blobOf.set(dataUrl, url);
    dataOf.set(url, dataUrl);
    return url;
  } catch {
    // 解不出来就原样留着（宁可慢一点，也不能把图弄丢）
    return dataUrl;
  }
}

/**
 * 正文 → 编辑器文本：把内嵌图片换成 blob 短链。
 * 只在「把文档灌进编辑器」时调用，不是每次按键都跑。
 */
export function toEditorText(md: string): string {
  if (!md || md.length < SHRINK_MIN) return md;
  return md.replace(DATA_IMG_RE, (_m, alt: string, url: string) => {
    return `![${alt}](${dataUrlToBlobUrl(url)})`;
  });
}

/**
 * 编辑器文本 → 正文：把 blob 短链换回原来的 data URL。
 * 编辑时编辑器里一直是短链，落库/导出/字数统计前过这一道。
 */
export function fromEditorText(md: string): string {
  if (!md || !md.includes("blob:")) return md;
  return md.replace(BLOB_RE, (url) => dataOf.get(url) ?? url);
}

/** 当前有没有被替换过的图（没有就不必走 fromEditorText 的正则） */
export function hasBlobs(): boolean {
  return dataOf.size > 0;
}

/** 退出编辑器时释放 blob（页面关闭前调用；不释放会一直占内存） */
export function releaseBlobs(): void {
  for (const url of dataOf.keys()) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* 忽略 */
    }
  }
  blobOf.clear();
  dataOf.clear();
}
