// Test-only: extracts the text of a PDF produced by Chromium (Skia): Flate content streams, hex strings drawn with Type0/Type3 fonts that
// carry a ToUnicode map. It is enough to prove WHAT a generated invoice PDF says (number, customer, total, DEMO marking); it is not a
// general PDF reader.
import { inflateSync } from 'node:zlib';

interface PdfObject {
  num: number;
  dict: string;
  stream?: Buffer;
}

function parseObjects(buf: Buffer): Map<number, PdfObject> {
  const text = buf.toString('latin1');
  const out = new Map<number, PdfObject>();
  const re = /(\d+) 0 obj/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const start = m.index + m[0].length;
    const end = text.indexOf('endobj', start);
    if (end < 0) break;
    const body = text.slice(start, end);
    const sIdx = body.indexOf('stream');
    const num = Number(m[1]);
    if (sIdx >= 0 && /\/Length/.test(body.slice(0, sIdx))) {
      const dict = body.slice(0, sIdx);
      let s = start + sIdx + 'stream'.length;
      if (text[s] === '\r') s++;
      if (text[s] === '\n') s++;
      const e = text.indexOf('endstream', s);
      let data: Buffer = buf.subarray(s, e);
      if (/FlateDecode/.test(dict)) {
        try {
          data = inflateSync(data);
        } catch {
          data = Buffer.alloc(0);
        }
      }
      out.set(num, { num, dict, stream: data });
    } else {
      out.set(num, { num, dict: body });
    }
    re.lastIndex = end;
  }
  return out;
}

type CMap = { size: number; map: Map<number, string> };

function parseCMap(src: string): CMap {
  const map = new Map<number, string>();
  let size = 2;
  const hexToStr = (h: string) => {
    let s = '';
    for (let i = 0; i + 3 < h.length + 1; i += 4)
      s += String.fromCharCode(parseInt(h.slice(i, i + 4), 16));
    return s;
  };
  for (const block of src.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const p of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      size = p[1]!.length / 2;
      map.set(parseInt(p[1]!, 16), hexToStr(p[2]!));
    }
  }
  for (const block of src.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const p of block[1]!.matchAll(
      /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<([0-9a-fA-F]+)>|\[([^\]]*)\])/g,
    )) {
      size = p[1]!.length / 2;
      const lo = parseInt(p[1]!, 16);
      const hi = parseInt(p[2]!, 16);
      if (p[4]) {
        const base = hexToStr(p[4]);
        for (let c = lo; c <= hi; c++)
          map.set(
            c,
            base.slice(0, -1) + String.fromCharCode(base.charCodeAt(base.length - 1) + (c - lo)),
          );
      } else if (p[5]) {
        let c = lo;
        for (const h of p[5].matchAll(/<([0-9a-fA-F]+)>/g)) map.set(c++, hexToStr(h[1]!));
      }
    }
  }
  return { size, map };
}

/** All text of the document, in drawing order, as one string (glyph runs joined; spacing between runs is not reconstructed). */
export function pdfText(buf: Buffer): string {
  const objects = parseObjects(buf);
  const cmaps = new Map<number, CMap>();
  const cmapOf = (fontObjNum: number): CMap | undefined => {
    const font = objects.get(fontObjNum);
    const tu = font && /\/ToUnicode\s+(\d+) 0 R/.exec(font.dict);
    if (!tu) return undefined;
    const n = Number(tu[1]);
    if (!cmaps.has(n)) cmaps.set(n, parseCMap(objects.get(n)?.stream?.toString('latin1') ?? ''));
    return cmaps.get(n);
  };
  const fontByName = new Map<string, number>();
  for (const o of objects.values())
    if (!o.stream)
      for (const m of o.dict.matchAll(/\/(F\d+)\s+(\d+) 0 R/g)) fontByName.set(m[1]!, Number(m[2]));
  let out = '';
  for (const o of objects.values()) {
    if (!o.stream || !/\bBT\b/.test(o.stream.toString('latin1', 0, o.stream.length))) continue;
    const src = o.stream.toString('latin1');
    let cm: CMap | undefined;
    const tokens = src.matchAll(
      /\/(F\d+)\s+[\d.]+\s+Tf|<([0-9a-fA-F]*)>\s*Tj|\[((?:[^\]])*)\]\s*TJ/g,
    );
    for (const t of tokens) {
      if (t[1]) {
        const f = fontByName.get(t[1]);
        cm = f === undefined ? undefined : cmapOf(f);
        continue;
      }
      const hexes =
        t[2] !== undefined
          ? [t[2]]
          : [...(t[3] ?? '').matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => x[1]!);
      for (const h of hexes) {
        const size = (cm?.size ?? 2) * 2;
        for (let i = 0; i + size <= h.length; i += size)
          out += cm?.map.get(parseInt(h.slice(i, i + size), 16)) ?? '';
      }
    }
    out += '\n';
  }
  return out;
}

/** Removes every whitespace, so a search does not depend on how the runs were spaced. */
export const squash = (s: string): string => s.replace(/\s+/g, '');
