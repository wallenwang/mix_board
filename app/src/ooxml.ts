/**
 * 零依赖读取 Office 文档（docx / pptx / xlsx）里的文字。
 *
 * 这些格式本质就是 ZIP：条目用 deflate 压缩。浏览器原生 `DecompressionStream("deflate-raw")`
 * 就能解，所以既不引第三方库，也不需要后端参与 —— 纯前端离线完成。
 *
 * 只提取**文字**：排版信息（字体、颜色、图片、表格线）会丢掉，
 * 所以界面上要明确标一句"仅文字内容，排版请用系统程序打开"。
 */

export interface OfficeBlock {
  /** 段落分组标题，例如「正文」「第 3 页」「工作表 1」 */
  label: string;
  lines: string[];
}

export interface OfficePreview {
  kind: "doc" | "ppt" | "xls";
  blocks: OfficeBlock[];
  /** 提取到多少非空行，用于判断是不是空文档 */
  lineCount: number;
}

const TD = new TextDecoder("utf-8");

function DS(): any {
  return (globalThis as any).DecompressionStream;
}

export function canExtractOffice(): boolean {
  return typeof DS() === "function";
}

// ---------------- 最小 ZIP 读取器 ----------------

interface ZipEntry {
  name: string;
  method: number;
  compSize: number;
  offset: number;
}

/** 从中央目录读出所有条目（EOCD 从文件尾部往前找） */
function readEntries(buf: ArrayBuffer): ZipEntry[] {
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  const minOff = Math.max(0, buf.byteLength - 66000);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= minOff; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return [];

  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.byteLength || dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const offset = dv.getUint32(p + 42, true);
    const name = TD.decode(u8.subarray(p + 46, p + 46 + nameLen));
    out.push({ name, method, compSize, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function toBlobPart(u8: Uint8Array): BlobPart {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

function inflateRaw(raw: Uint8Array): Promise<Uint8Array> {
  const Stream = DS();
  if (!Stream) return Promise.reject(new Error("当前环境不支持解压"));
  const stream = new Blob([toBlobPart(raw)]).stream().pipeThrough(new Stream("deflate-raw"));
  return new Response(stream).arrayBuffer().then((b) => new Uint8Array(b));
}

/** 解出某个条目的原文（method 0 = 不压缩，8 = deflate） */
async function readEntry(buf: ArrayBuffer, e: ZipEntry): Promise<string | null> {
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  if (e.offset + 30 > buf.byteLength) return null;
  if (dv.getUint32(e.offset, true) !== 0x04034b50) return null;
  const nameLen = dv.getUint16(e.offset + 26, true);
  const extraLen = dv.getUint16(e.offset + 28, true);
  const start = e.offset + 30 + nameLen + extraLen;
  const size = e.compSize || dv.getUint32(e.offset + 18, true);
  const raw = u8.subarray(start, start + size);
  try {
    if (e.method === 0) return TD.decode(raw);
    if (e.method === 8) return TD.decode(await inflateRaw(raw));
  } catch {
    return null;
  }
  return null;
}

// ---------------- OOXML → 纯文本 ----------------

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, "&");
}

/** 把一段 XML 里的 <w:t>/<a:t>/<t> 文本按顺序抽出来 */
function collectTexts(chunk: string, tag: string): string {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  let out = "";
  for (const m of chunk.matchAll(re)) out += unescapeXml(m[1]);
  return out;
}

function docxBlocks(xml: string): OfficeBlock[] {
  const lines: string[] = [];
  // 按段落切：<w:p> / <w:p ...>
  const paras = xml.split(/<w:p(?:\s[^>]*)?\/?>|<\/w:p>/).slice(1);
  for (const p of paras) {
    const chunks: string[] = [];
    // 逐个 run 取文本，回车符 <w:br/> 转成换行
    for (const part of p.split(/<w:br\s*\/?>/)) chunks.push(collectTexts(part, "w:t"));
    const line = chunks.join("\n").trim();
    if (line) lines.push(line);
  }
  // 表格里的文字 <w:tbl> 也已经被上面的 <w:p> 覆盖到了
  return [{ label: "正文", lines }];
}

function pptxBlocks(slides: { name: string; xml: string }[]): OfficeBlock[] {
  const blocks: OfficeBlock[] = [];
  slides.forEach((s, i) => {
    const lines: string[] = [];
    const paras = s.xml.split(/<a:p(?:\s[^>]*)?>|<\/a:p>/).slice(1);
    for (const p of paras) {
      const line = collectTexts(p, "a:t").trim();
      if (line) lines.push(line);
    }
    if (lines.length) blocks.push({ label: `第 ${i + 1} 页`, lines });
  });
  return blocks;
}

function xlsxBlocks(
  shared: string[],
  sheets: { name: string; xml: string }[]
): OfficeBlock[] {
  const blocks: OfficeBlock[] = [];
  sheets.forEach((s) => {
    const lines: string[] = [];
    const rows = s.xml.split(/<row(?:\s[^>]*)?>|<\/row>/).slice(1);
    for (const row of rows) {
      const cells: string[] = [];
      for (const m of row.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        const attrs = m[1];
        const body = m[2];
        const type = /t="([^"]+)"/.exec(attrs)?.[1] ?? "";
        const inline = /<is>([\s\S]*?)<\/is>/.exec(body)?.[1];
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        if (inline != null) cells.push(collectTexts(inline, "t"));
        else if (v == null) cells.push("");
        else if (type === "s") cells.push(shared[Number(v)] ?? "");
        else if (type === "b") cells.push(v === "1" ? "TRUE" : "FALSE");
        else cells.push(unescapeXml(v));
      }
      const line = cells.join("  |  ").trim();
      if (line.replace(/[|\s]/g, "")) lines.push(line);
    }
    if (lines.length) blocks.push({ label: s.name, lines });
  });
  return blocks;
}

function sheetIndex(name: string): number {
  const m = /sheet(\d+)\.xml$/i.exec(name);
  return m ? Number(m[1]) : 0;
}

/**
 * 提取 Office 文档的文字。失败（老式 .doc/.ppt、加密、损坏）返回 null。
 */
export async function extractOfficeText(blob: Blob, ext: string): Promise<OfficePreview | null> {
  const e = (ext || "").toLowerCase();
  if (!canExtractOffice()) return null;
  const buf = await blob.arrayBuffer();
  const entries = readEntries(buf);
  if (!entries.length) return null;

  if (e === "docx") {
    const target = entries.find((x) => x.name === "word/document.xml");
    if (!target) return null;
    const xml = await readEntry(buf, target);
    if (!xml) return null;
    const blocks = docxBlocks(xml);
    return { kind: "doc", blocks: blocks.filter((b) => b.lines.length), lineCount: countLines(blocks) };
  }

  if (e === "pptx") {
    const slides = entries
      .filter((x) => /^ppt\/slides\/slide\d+\.xml$/.test(x.name))
      .sort((a, b) => sheetIndex(a.name) - sheetIndex(b.name));
    if (!slides.length) return null;
    const loaded: { name: string; xml: string }[] = [];
    for (const s of slides) {
      const xml = await readEntry(buf, s);
      if (xml) loaded.push({ name: s.name, xml });
    }
    const blocks = pptxBlocks(loaded);
    return { kind: "ppt", blocks, lineCount: countLines(blocks) };
  }

  if (e === "xlsx") {
    const sharedEntry = entries.find((x) => x.name === "xl/sharedStrings.xml");
    let shared: string[] = [];
    if (sharedEntry) {
      const xml = await readEntry(buf, sharedEntry);
      if (xml) {
        shared = [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => collectTexts(m[1], "t"));
      }
    }
    const sheets = entries
      .filter((x) => /^xl\/worksheets\/sheet\d+\.xml$/.test(x.name))
      .sort((a, b) => sheetIndex(a.name) - sheetIndex(b.name));
    const loaded: { name: string; xml: string }[] = [];
    for (let i = 0; i < sheets.length; i++) {
      const xml = await readEntry(buf, sheets[i]);
      if (xml) loaded.push({ name: `工作表 ${i + 1}`, xml });
    }
    const blocks = xlsxBlocks(shared, loaded);
    return { kind: "xls", blocks, lineCount: countLines(blocks) };
  }

  return null;
}

function countLines(blocks: OfficeBlock[]): number {
  return blocks.reduce((n, b) => n + b.lines.length, 0);
}
