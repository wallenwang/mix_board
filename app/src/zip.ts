/**
 * 最小 ZIP 打包器（只做 stored / 不压缩）。用来把 OOXML 零件拼成 .docx。
 *
 * 不压缩是刻意的：不需要 deflate，也就没有兼容性风险，
 * docx 本来就很小（纯文本几 KB），存不存压缩对用户毫无感知。
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const TE = new TextEncoder();

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

export function utf8(s: string): Uint8Array {
  return TE.encode(s);
}

function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const u16 = (n: number) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff]);
const u32 = (n: number) =>
  new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);

export function makeZip(entries: ZipEntry[]): Uint8Array {
  const localChunks: Uint8Array[] = [];
  const centralChunks: Uint8Array[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBytes = utf8(e.name);
    const crc = crc32(e.data);
    const size = e.data.length;

    // 本地文件头：sig, version, flags(0x0800=UTF8 文件名), method=0,
    //             time, date, crc, csize, usize, nameLen, extraLen, name
    const local = concat([
      u32(0x04034b50),
      u16(20),
      u16(0x0800),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(size),
      u32(size),
      u16(nameBytes.length),
      u16(0),
      nameBytes,
    ]);
    localChunks.push(local, e.data);

    // 中央目录：sig, madeBy, needed, flags, method, time, date, crc,
    //           csize, usize, nameLen, extraLen, commentLen, diskNo, internAttr,
    //           externAttr, localOffset, name
    centralChunks.push(
      concat([
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(0x0800),
        u16(0),
        u16(0),
        u16(0),
        u32(crc),
        u32(size),
        u32(size),
        u16(nameBytes.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        nameBytes,
      ])
    );

    offset += local.length + size;
  }

  const central = concat(centralChunks);
  const end = concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(central.length),
    u32(offset),
    u16(0),
  ]);

  return concat([...localChunks, central, end]);
}
