/**
 * Markdown → .docx（零依赖，自己拼 OOXML + ZIP）。
 *
 * 只生成 Word 打开必需的最少零件：Content_Types / rels / document / styles / docProps。
 * 样式按中文文档习惯定好（正文宋体小四、标题黑体、1.5 倍行距），
 * 导出后直接就是能交出去的稿子，不用再手动调格式。
 */

import { parseBlocks, type MdBlock } from "./markdown";
import { makeZip, utf8, type ZipEntry } from "./zip";

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------- 行内 → runs ----------

interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
}

const INLINE_RE =
  /(`[^`]+`)|(\*\*\*[^*]+\*\*\*)|(\*\*[^*]+\*\*)|(__[^_]+__)|(~~[^~]+~~)|(!\[[^\]]*\]\([^)]+\))|(\[([^\]]+)\]\(([^)]+)\))|(\*[^*\n]+\*)/g;

function parseRuns(src: string): Run[] {
  const runs: Run[] = [];
  const push = (text: string, st: Partial<Run> = {}) => {
    if (text) runs.push({ text, ...st });
  };
  let last = 0;
  let m: RegExpExecArray | null;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(src))) {
    push(src.slice(last, m.index));
    const t = m[0];
    if (t.startsWith("`")) push(t.slice(1, -1), { code: true });
    else if (t.startsWith("***")) push(t.slice(3, -3), { bold: true, italic: true });
    else if (t.startsWith("**")) push(t.slice(2, -2), { bold: true });
    else if (t.startsWith("__")) push(t.slice(2, -2), { bold: true });
    else if (t.startsWith("~~")) push(t.slice(2, -2), { strike: true });
    else if (t.startsWith("![")) push(t.replace(/^!\[([^\]]*)\]\([^)]*\)$/, "$1"));
    else if (t.startsWith("[")) push(`${m[8]}（${m[9]}）`);
    else push(t.slice(1, -1), { italic: true });
    last = m.index + t.length;
  }
  push(src.slice(last));
  return runs.length ? runs : [{ text: "" }];
}

function runsXml(src: string): string {
  return parseRuns(src)
    .map((r) => {
      const props: string[] = [];
      if (r.code) props.push('<w:rStyle w:val="InlineCode"/>');
      if (r.bold) props.push("<w:b/>");
      if (r.italic) props.push("<w:i/>");
      if (r.strike) props.push("<w:strike/>");
      const p = props.length ? `<w:rPr>${props.join("")}</w:rPr>` : "";
      return `<w:r>${p}<w:t xml:space="preserve">${esc(r.text)}</w:t></w:r>`;
    })
    .join("");
}

function p(
  src: string,
  opts: { style?: string; indent?: number; spacing?: string; align?: string } = {}
): string {
  const pr: string[] = [];
  if (opts.style) pr.push(`<w:pStyle w:val="${opts.style}"/>`);
  if (opts.indent != null)
    pr.push(`<w:ind w:left="${opts.indent}" w:hanging="${opts.indent > 0 ? 240 : 0}"/>`);
  if (opts.spacing) pr.push(opts.spacing);
  if (opts.align) pr.push(`<w:jc w:val="${opts.align}"/>`);
  const prXml = pr.length ? `<w:pPr>${pr.join("")}</w:pPr>` : "";
  return `<w:p>${prXml}${runsXml(src)}</w:p>`;
}

// ---------- 表格 ----------

function tableXml(b: Extract<MdBlock, { type: "table" }>): string {
  const cols = b.head.length || 1;
  const width = Math.floor(9360 / cols);
  const grid = `<w:tblGrid>${Array.from({ length: cols }, () => `<w:gridCol w:w="${width}"/>`).join(
    ""
  )}</w:tblGrid>`;
  const borders =
    "<w:tblBorders>" +
    ["top", "left", "bottom", "right", "insideH", "insideV"]
      .map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>`)
      .join("") +
    "</w:tblBorders>";
  const headRow =
    "<w:tr>" +
    b.head
      .map(
        (c) =>
          `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/><w:shd w:val="clear" w:fill="F2F2F2"/></w:tcPr>${p(
            c,
            { style: "TableHead" }
          )}</w:tc>`
      )
      .join("") +
    "</w:tr>";
  const bodyRows = b.rows
    .map(
      (r) =>
        "<w:tr>" +
        Array.from({ length: cols }, (_v, k) => {
          const txt = r[k] ?? "";
          return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/></w:tcPr>${p(txt, {
            style: "TableText",
          })}</w:tc>`;
        }).join("") +
        "</w:tr>"
    )
    .join("");

  return (
    `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>${borders}</w:tblPr>${grid}` +
    headRow +
    bodyRows +
    "</w:tbl>" +
    p("", { style: "TableGap" })
  );
}

// ---------- 块 → 文档体 ----------

function bodyXml(blocks: MdBlock[]): string {
  const out: string[] = [];
  // 有序列表按层级各自计数，遇到非列表块就归零
  const olCounters = new Map<number, number>();
  for (const b of blocks) {
    if (b.type !== "list") olCounters.clear();
    switch (b.type) {
      case "heading": {
        const lv = Math.min(6, Math.max(1, b.level));
        out.push(p(b.text, { style: `Heading${lv}` }));
        break;
      }
      case "para":
        out.push(p(b.text.replace(/\n/g, " "), { style: "Body" }));
        break;
      case "list": {
        let bullet: string;
        if (b.task) bullet = b.checked ? "☑ " : "☐ ";
        else if (b.ordered) {
          const n = (olCounters.get(b.depth) ?? 0) + 1;
          olCounters.set(b.depth, n);
          bullet = `${n}. `;
        } else bullet = "• ";
        out.push(p(bullet + b.text, { style: "Body", indent: 480 + b.depth * 360 }));
        break;
      }
      case "quote":
        out.push(p(b.text.replace(/\n/g, " "), { style: "Quote" }));
        break;
      case "code":
        for (const line of b.text.split("\n")) out.push(p(line || " ", { style: "CodeBlock" }));
        break;
      case "hr":
        out.push('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="BFBFBF"/></w:pBdr></w:pPr></w:p>');
        break;
      case "table":
        out.push(tableXml(b));
        break;
    }
  }
  return out.join("");
}

// ---------- 样式 ----------

function stylesXml(): string {
  const heading = (
    id: number,
    name: string,
    size: number,
    font: string,
    before: number,
    after: number
  ) =>
    `<w:style w:type="paragraph" w:styleId="Heading${id}"><w:name w:val="${name}"/>` +
    `<w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:outlineLvl w:val="${id}"/>` +
    `<w:spacing w:before="${before}" w:after="${after}" w:line="360" w:lineRule="auto"/></w:pPr>` +
    `<w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:eastAsia="${font}"/><w:b/>` +
    `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`;

  return (
    XML_HEAD +
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    "<w:docDefaults><w:rPrDefault><w:rPr>" +
    '<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体" w:cs="Times New Roman"/>' +
    '<w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:rPrDefault>' +
    '<w:pPrDefault><w:pPr><w:spacing w:line="360" w:lineRule="auto"/></w:pPr></w:pPrDefault>' +
    "</w:docDefaults>" +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Body"><w:name w:val="Body Text"/><w:basedOn w:val="Normal"/>' +
    '<w:pPr><w:spacing w:before="0" w:after="120" w:line="360" w:lineRule="auto"/><w:ind w:firstLine="480"/></w:pPr>' +
    '<w:rPr><w:rFonts w:eastAsia="宋体"/><w:sz w:val="24"/></w:rPr></w:style>' +
    heading(1, "heading 1", 36, "黑体", 320, 200) +
    heading(2, "heading 2", 32, "黑体", 280, 160) +
    heading(3, "heading 3", 28, "黑体", 240, 120) +
    heading(4, "heading 4", 24, "黑体", 200, 100) +
    heading(5, "heading 5", 24, "黑体", 160, 80) +
    heading(6, "heading 6", 24, "黑体", 160, 80) +
    '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/>' +
    '<w:pPr><w:ind w:left="480" w:right="480"/><w:spacing w:before="120" w:after="120" w:line="360" w:lineRule="auto"/></w:pPr>' +
    '<w:rPr><w:rFonts w:eastAsia="楷体"/><w:color w:val="595959"/><w:i/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="CodeBlock"><w:name w:val="Code Block"/><w:basedOn w:val="Normal"/>' +
    '<w:pPr><w:ind w:left="360"/><w:spacing w:before="0" w:after="0" w:line="280" w:lineRule="auto"/></w:pPr>' +
    '<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="宋体"/><w:sz w:val="21"/></w:rPr></w:style>' +
    '<w:style w:type="character" w:styleId="InlineCode"><w:name w:val="Inline Code"/>' +
    '<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="21"/><w:color w:val="C7254E"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="TableHead"><w:name w:val="Table Head"/><w:basedOn w:val="Normal"/>' +
    '<w:pPr><w:spacing w:before="40" w:after="40" w:line="300" w:lineRule="auto"/></w:pPr>' +
    '<w:rPr><w:b/><w:sz w:val="21"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="TableText"><w:name w:val="Table Text"/><w:basedOn w:val="Normal"/>' +
    '<w:pPr><w:spacing w:before="40" w:after="40" w:line="300" w:lineRule="auto"/></w:pPr>' +
    '<w:rPr><w:sz w:val="21"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="TableGap"><w:name w:val="Table Gap"/><w:basedOn w:val="Normal"/>' +
    '<w:pPr><w:spacing w:before="0" w:after="0" w:line="120" w:lineRule="auto"/><w:rPr><w:sz w:val="8"/></w:rPr></w:pPr></w:style>' +
    "</w:styles>"
  );
}

const CONTENT_TYPES =
  XML_HEAD +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
  '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
  '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
  "</Types>";

const ROOT_RELS =
  XML_HEAD +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
  '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
  "</Relationships>";

const DOC_RELS =
  XML_HEAD +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
  "</Relationships>";

function coreXml(title: string): string {
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  return (
    XML_HEAD +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${esc(title)}</dc:title>` +
    "<dc:creator>工作看板</dc:creator>" +
    "<cp:lastModifiedBy>工作看板</cp:lastModifiedBy>" +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>` +
    "</cp:coreProperties>"
  );
}

const APP_XML =
  XML_HEAD +
  '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
  "<Application>工作看板</Application><AppVersion>1.0</AppVersion>" +
  "</Properties>";

/** Markdown 文本 → .docx 字节流 */
export function markdownToDocx(md: string, title = "文档"): Uint8Array {
  const body = bodyXml(parseBlocks(md));
  const sect =
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
    '<w:pgMar w:top="1440" w:right="1797" w:bottom="1440" w:left="1797" w:header="851" w:footer="992" w:gutter="0"/>' +
    "</w:sectPr>";
  const document =
    XML_HEAD +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${body}${sect}</w:body></w:document>`;

  const entries: ZipEntry[] = [
    { name: "[Content_Types].xml", data: utf8(CONTENT_TYPES) },
    { name: "_rels/.rels", data: utf8(ROOT_RELS) },
    { name: "word/document.xml", data: utf8(document) },
    { name: "word/_rels/document.xml.rels", data: utf8(DOC_RELS) },
    { name: "word/styles.xml", data: utf8(stylesXml()) },
    { name: "docProps/core.xml", data: utf8(coreXml(title)) },
    { name: "docProps/app.xml", data: utf8(APP_XML) },
  ];
  return makeZip(entries);
}
