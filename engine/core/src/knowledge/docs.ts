import zlib from "node:zlib";
import { extname } from "node:path";

/**
 * Conservative, dependency-free text extraction for common document formats:
 * PDF, DOCX, PPTX, XLSX, RTF, ODT, and EPUB.
 *
 * Every extractor is hand-rolled and deliberately best-effort: they aim to
 * pull readable text out of the mainstream, unencrypted files an agent is
 * likely to be pointed at, not to be complete format implementations. When a
 * document is scanned, encrypted, or uses an encoding these parsers don't
 * model, they throw a clear error rather than return garbage — the caller
 * surfaces the message instead of crashing.
 */

// ---------------------------------------------------------------------------
// Shared string helpers.
// ---------------------------------------------------------------------------

/** Decode a raw byte sequence from a PDF string: UTF-16BE if it opens with a
 *  FEFF byte-order mark, otherwise Latin-1 (a superset-safe default for the
 *  8-bit PDFDocEncoding text we can handle). */
function decodePdfStringBytes(bytes: number[]): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let s = "";
    for (let k = 2; k + 1 < bytes.length; k += 2) s += String.fromCharCode((bytes[k]! << 8) | bytes[k + 1]!);
    return s;
  }
  return Buffer.from(bytes).toString("latin1");
}

// ---------------------------------------------------------------------------
// PDF.
// ---------------------------------------------------------------------------

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20].map((c) => String.fromCharCode(c)));
const DELIMITERS = new Set(["(", ")", "<", ">", "[", "]", "{", "}", "/", "%"]);

function isNumericToken(tok: string): boolean {
  return /^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok);
}

/** Parse a PDF literal string `( … )` starting at s[i]==='('. Returns the
 *  raw bytes and the index just past the closing paren. Handles balanced
 *  inner parens, the named escapes, octal \ddd escapes, and line continuations.
 *  Bytes are decoded later (decodeTextBytes) because the right decoding
 *  depends on the document's ToUnicode CMaps, not on the string itself. */
function parseLiteralString(s: string, i: number): [number[], number] {
  i++; // skip '('
  let depth = 1;
  const bytes: number[] = [];
  while (i < s.length && depth > 0) {
    const ch = s[i]!;
    if (ch === "\\") {
      const next = s[i + 1];
      if (next === undefined) {
        i++;
      } else if (next === "n") {
        bytes.push(0x0a);
        i += 2;
      } else if (next === "r") {
        bytes.push(0x0d);
        i += 2;
      } else if (next === "t") {
        bytes.push(0x09);
        i += 2;
      } else if (next === "b") {
        bytes.push(0x08);
        i += 2;
      } else if (next === "f") {
        bytes.push(0x0c);
        i += 2;
      } else if (next === "(" || next === ")" || next === "\\") {
        bytes.push(next.charCodeAt(0));
        i += 2;
      } else if (next >= "0" && next <= "7") {
        i++; // skip backslash
        let oct = "";
        while (oct.length < 3 && i < s.length && s[i]! >= "0" && s[i]! <= "7") {
          oct += s[i];
          i++;
        }
        bytes.push(parseInt(oct, 8) & 0xff);
      } else if (next === "\n") {
        i += 2; // line continuation
      } else if (next === "\r") {
        i += 2;
        if (s[i] === "\n") i++;
      } else {
        bytes.push(next.charCodeAt(0)); // unknown escape: keep the literal char
        i += 2;
      }
    } else if (ch === "(") {
      depth++;
      bytes.push(0x28);
      i++;
    } else if (ch === ")") {
      depth--;
      if (depth > 0) bytes.push(0x29);
      i++;
    } else {
      bytes.push(ch.charCodeAt(0) & 0xff);
      i++;
    }
  }
  return [bytes, i];
}

/** Parse a PDF hex string `< … >` starting at s[i]==='<'. */
function parseHexString(s: string, i: number): [number[], number] {
  i++; // skip '<'
  let hex = "";
  while (i < s.length && s[i] !== ">") {
    const ch = s[i]!;
    if (/[0-9A-Fa-f]/.test(ch)) hex += ch;
    i++;
  }
  i++; // skip '>'
  if (hex.length % 2 === 1) hex += "0";
  const bytes: number[] = [];
  for (let k = 0; k < hex.length; k += 2) bytes.push(parseInt(hex.slice(k, k + 2), 16));
  return [bytes, i];
}

/** Parse a PDF array `[ … ]` (as used by TJ): a mix of strings and numbers. */
function parseArray(s: string, i: number): [Array<number[] | number>, number] {
  i++; // skip '['
  const items: Array<number[] | number> = [];
  while (i < s.length && s[i] !== "]") {
    const ch = s[i]!;
    if (ch === "(") {
      const [str, ni] = parseLiteralString(s, i);
      items.push(str);
      i = ni;
    } else if (ch === "<") {
      const [str, ni] = parseHexString(s, i);
      items.push(str);
      i = ni;
    } else if (ch === "-" || ch === "+" || ch === "." || (ch >= "0" && ch <= "9")) {
      let num = "";
      while (i < s.length && /[-+.\d]/.test(s[i]!)) {
        num += s[i];
        i++;
      }
      items.push(parseFloat(num));
    } else {
      i++;
    }
  }
  i++; // skip ']'
  return [items, i];
}

/** Decode a `<hex>` destination from a ToUnicode CMap: UTF-16BE code units. */
function utf16HexToString(hex: string): string {
  let out = "";
  for (let k = 0; k + 4 <= hex.length; k += 4) {
    out += String.fromCharCode(parseInt(hex.slice(k, k + 4), 16));
  }
  return out;
}

/**
 * Parse every ToUnicode CMap in the document into one merged glyph-code →
 * text table. Modern PDFs (Chrome print, Word export, LaTeX) embed subset
 * fonts with Identity-H encoding: content-stream strings hold 2-byte glyph
 * ids, meaningless without this mapping. Merging all fonts' CMaps into one
 * table is a best-effort simplification (two subset fonts could reuse a
 * glyph id), but it turns otherwise unreadable documents into text.
 */
function parseToUnicodeCMaps(streams: string[]): Map<number, string> {
  const map = new Map<number, string>();
  const pairRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
  const rangeRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[([\s\S]*?)\])/g;

  for (const s of streams) {
    for (const block of s.match(/beginbfchar([\s\S]*?)endbfchar/g) ?? []) {
      let m: RegExpExecArray | null;
      pairRe.lastIndex = 0;
      while ((m = pairRe.exec(block)) !== null) {
        const src = parseInt(m[1]!, 16);
        if (!map.has(src)) map.set(src, utf16HexToString(m[2]!));
      }
    }
    for (const block of s.match(/beginbfrange([\s\S]*?)endbfrange/g) ?? []) {
      let m: RegExpExecArray | null;
      rangeRe.lastIndex = 0;
      while ((m = rangeRe.exec(block)) !== null) {
        const lo = parseInt(m[1]!, 16);
        const hi = parseInt(m[2]!, 16);
        if (!(hi >= lo) || hi - lo > 0xffff) continue;
        if (m[3] !== undefined) {
          // <lo> <hi> <dstStart>: destination increments with the code.
          const base = utf16HexToString(m[3]);
          const head = base.slice(0, -1);
          const last = base.charCodeAt(base.length - 1);
          for (let c = lo; c <= hi; c++) {
            if (!map.has(c)) map.set(c, head + String.fromCharCode(last + (c - lo)));
          }
        } else if (m[4] !== undefined) {
          // <lo> <hi> [<dst> <dst> …]: one destination per code.
          const dsts = m[4].match(/<([0-9A-Fa-f]+)>/g) ?? [];
          for (let k = 0; k < dsts.length && lo + k <= hi; k++) {
            if (!map.has(lo + k)) map.set(lo + k, utf16HexToString(dsts[k]!.slice(1, -1)));
          }
        }
      }
    }
  }
  return map;
}

/** Decode one text-showing operand. When the document has ToUnicode CMaps and
 *  the bytes read cleanly as mapped 16-bit codes, use the mapping (CID font);
 *  otherwise fall back to BOM-checked UTF-16BE / Latin-1. */
function decodeTextBytes(bytes: number[], cmap: Map<number, string> | undefined): string {
  if (cmap && cmap.size > 0 && bytes.length >= 2 && bytes.length % 2 === 0) {
    const units: number[] = [];
    for (let k = 0; k + 1 < bytes.length; k += 2) units.push((bytes[k]! << 8) | bytes[k + 1]!);
    const mapped = units.filter((u) => cmap.has(u)).length;
    if (mapped / units.length >= 0.75) {
      return units.map((u) => cmap.get(u) ?? "").join("");
    }
  }
  return decodePdfStringBytes(bytes);
}

/** Scan one decoded content stream for text-showing operators and reconstruct
 *  a plausible plain-text rendering. */
function scanContentStream(content: string, cmap?: Map<number, string>): string {
  let out = "";
  const operands: Array<{ bytes?: number[]; arr?: Array<number[] | number>; num?: number }> = [];
  let lastTmY: number | undefined;
  let i = 0;
  const n = content.length;
  while (i < n) {
    const ch = content[i]!;
    if (ch === "(") {
      const [bytes, ni] = parseLiteralString(content, i);
      operands.push({ bytes });
      i = ni;
    } else if (ch === "<" && content[i + 1] === "<") {
      // Inline dictionary — skip to its matching ">>" and reset operands.
      const end = content.indexOf(">>", i + 2);
      i = end === -1 ? n : end + 2;
      operands.length = 0;
    } else if (ch === "<") {
      const [bytes, ni] = parseHexString(content, i);
      operands.push({ bytes });
      i = ni;
    } else if (ch === "[") {
      const [arr, ni] = parseArray(content, i);
      operands.push({ arr });
      i = ni;
    } else if (ch === "/") {
      // Name token (e.g. /F1) — an operand we ignore; skip it.
      i++;
      while (i < n && !WHITESPACE.has(content[i]!) && !DELIMITERS.has(content[i]!)) i++;
    } else if (WHITESPACE.has(ch) || ch === ")" || ch === "]" || ch === ">" || ch === "{" || ch === "}") {
      i++;
    } else {
      // Read a bare token: either a numeric operand or an operator keyword.
      let tok = "";
      while (i < n && !WHITESPACE.has(content[i]!) && !DELIMITERS.has(content[i]!)) {
        tok += content[i];
        i++;
      }
      if (tok === "") {
        i++;
        continue;
      }
      if (isNumericToken(tok)) {
        operands.push({ num: parseFloat(tok) });
        continue;
      }
      // Operator keyword.
      const last = operands[operands.length - 1];
      switch (tok) {
        case "Tj":
          if (last?.bytes !== undefined) out += decodeTextBytes(last.bytes, cmap);
          break;
        case "'":
        case '"':
          // (aw ac) string — the string is the last operand either way.
          out += "\n" + (last?.bytes !== undefined ? decodeTextBytes(last.bytes, cmap) : "");
          break;
        case "TJ":
          if (last?.arr) {
            for (const item of last.arr) {
              if (typeof item !== "number") out += decodeTextBytes(item, cmap);
              else if (item < -200) out += " "; // large negative kern → word space
            }
          }
          break;
        case "Td":
        case "TD": {
          // tx ty Td — only vertical movement is a line break. PDFs that
          // position every glyph run individually (Chrome print output) emit
          // ty=0 constantly; treating those as newlines shreds the text.
          const ty = last?.num;
          if (ty === undefined || Math.abs(ty) > 0.01) out += "\n";
          break;
        }
        case "Tm": {
          // a b c d e f Tm — a new text matrix; break only when the baseline
          // (f) actually moved.
          const f = last?.num;
          if (f !== undefined && lastTmY !== undefined && Math.abs(f - lastTmY) > 0.01) out += "\n";
          if (f !== undefined) lastTmY = f;
          break;
        }
        case "T*":
          out += "\n";
          break;
        default:
          break;
      }
      operands.length = 0;
    }
  }
  return out;
}

/**
 * Minimal PDF text extractor. Locates `stream … endstream` objects, inflates
 * FlateDecode streams (zlib, with a raw-deflate fallback), and scans each
 * decoded content stream for text-showing operators. Not a full PDF reader:
 * encrypted files are rejected up front, and files with no extractable text
 * (scanned images, unmodelled encodings) throw rather than return nothing.
 */
export function extractPdfText(buf: Buffer): string {
  const s = buf.toString("latin1");
  if (/\/Encrypt\b/.test(s)) {
    throw new Error("encrypted PDF not supported");
  }

  // Pass 1: decode every stream, separating ToUnicode CMaps from content.
  const cmapStreams: string[] = [];
  const contentStreams: string[] = [];
  let pos = 0;
  while (true) {
    const sIdx = s.indexOf("stream", pos);
    if (sIdx === -1) break;
    // Skip the "stream" inside "endstream".
    if (s.slice(sIdx - 3, sIdx) === "end") {
      pos = sIdx + 6;
      continue;
    }
    let dataStart = sIdx + 6;
    if (s[dataStart] === "\r") dataStart++;
    if (s[dataStart] === "\n") dataStart++;
    const endIdx = s.indexOf("endstream", dataStart);
    if (endIdx === -1) break;

    const objIdx = s.lastIndexOf("obj", sIdx);
    const dict = objIdx === -1 ? "" : s.slice(objIdx, sIdx);
    const isFlate = /\/FlateDecode\b/.test(dict);
    const rawBytes = buf.subarray(dataStart, endIdx);

    let content: string | undefined;
    if (isFlate) {
      try {
        content = zlib.inflateSync(rawBytes).toString("latin1");
      } catch {
        try {
          content = zlib.inflateRawSync(rawBytes).toString("latin1");
        } catch {
          content = undefined; // unreadable stream — skip it
        }
      }
    } else {
      content = rawBytes.toString("latin1");
    }
    if (content !== undefined) {
      if (content.includes("beginbfchar") || content.includes("beginbfrange")) cmapStreams.push(content);
      else contentStreams.push(content);
    }

    pos = endIdx + 9; // past "endstream"
  }

  // Pass 2: scan the content streams with the merged glyph mapping.
  const cmap = parseToUnicodeCMaps(cmapStreams);
  let out = "";
  for (const content of contentStreams) out += scanContentStream(content, cmap);

  if (out.trim() === "") {
    throw new Error("no extractable text (scanned or unsupported encoding)");
  }
  return out;
}

// ---------------------------------------------------------------------------
// DOCX (Office Open XML — a ZIP of parts).
// ---------------------------------------------------------------------------

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/** Parse a ZIP central directory and return each entry's decompressed bytes.
 *  Supports stored (0) and deflate (8) methods; other methods are skipped. */
function readZipEntries(buf: Buffer): Map<string, Buffer> {
  const map = new Map<string, Buffer>();
  // Locate the End Of Central Directory record by scanning back from the tail
  // (its variable-length comment is bounded at 65535 bytes).
  let eocd = -1;
  const minPos = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error("not a valid ZIP (no end-of-central-directory record)");

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== CD_SIG) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const fnLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + fnLen);

    if (localOff + 30 <= buf.length && buf.readUInt32LE(localOff) === LOCAL_SIG) {
      const lfnLen = buf.readUInt16LE(localOff + 26);
      const lextraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lfnLen + lextraLen;
      const comp = buf.subarray(dataStart, dataStart + compSize);
      if (method === 0) {
        map.set(name, Buffer.from(comp));
      } else if (method === 8) {
        try {
          map.set(name, zlib.inflateRawSync(comp));
        } catch {
          /* skip an entry we cannot inflate */
        }
      }
    }
    p += 46 + fnLen + extraLen + commentLen;
  }
  return map;
}

/** Decode the five predefined XML entities plus decimal/hex numeric refs. */
function decodeXmlEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (m, ent: string) => {
    switch (ent) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default: {
        const code =
          ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
        return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
      }
    }
  });
}

/** Turn word/document.xml markup into plain text: paragraph ends → newlines,
 *  tabs → tabs, every other tag removed, XML entities decoded. */
function stripDocxXml(xml: string): string {
  let s = xml;
  s = s.replace(/<w:tab\b[^>]*\/?>/g, "\t");
  s = s.replace(/<w:br\b[^>]*\/?>/g, "\n");
  s = s.replace(/<\/w:p>/g, "\n");
  s = s.replace(/<[^>]*>/g, "");
  s = decodeXmlEntities(s);
  return s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * DOCX text extractor. Parses the ZIP container by hand, pulls
 * `word/document.xml`, and reduces its WordprocessingML to plain text.
 */
export function extractDocxText(buf: Buffer): string {
  const entries = readZipEntries(buf);
  const doc = entries.get("word/document.xml");
  if (!doc) throw new Error("no word/document.xml found in DOCX");
  const text = stripDocxXml(doc.toString("utf8"));
  if (text.trim() === "") {
    throw new Error("no extractable text in DOCX document body");
  }
  return text;
}

// ---------------------------------------------------------------------------
// PPTX (Office Open XML — a ZIP of slides).
// ---------------------------------------------------------------------------

/** Pull the DrawingML text runs (<a:t>) out of one slide/notes XML part. */
function collectDrawingText(xml: string): string[] {
  const texts: string[] = [];
  for (const match of xml.match(/<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>/g) ?? []) {
    const text = decodeXmlEntities(match.replace(/<[^>]*>/g, ""));
    if (text.trim() !== "") texts.push(text);
  }
  return texts;
}

/**
 * PPTX text extractor. Parses the ZIP container, pulls each slide's text runs
 * (and speaker notes), and renders them in slide-number order — the ZIP's
 * central-directory order is not guaranteed to match it.
 */
export function extractPptxText(buf: Buffer): string {
  const entries = readZipEntries(buf);
  const slides = new Map<number, { body: string[]; notes: string[] }>();

  for (const [name, data] of entries) {
    const slideMatch = /^ppt\/slides\/slide(\d+)\.xml$/.exec(name);
    const notesMatch = /^ppt\/notesSlides\/notesSlide(\d+)\.xml$/.exec(name);
    const m = slideMatch ?? notesMatch;
    if (!m) continue;
    const num = parseInt(m[1]!, 10);
    const slide = slides.get(num) ?? { body: [], notes: [] };
    const texts = collectDrawingText(data.toString("utf8"));
    if (slideMatch) slide.body.push(...texts);
    else slide.notes.push(...texts);
    slides.set(num, slide);
  }

  const parts: string[] = [];
  for (const num of [...slides.keys()].sort((a, b) => a - b)) {
    const { body, notes } = slides.get(num)!;
    if (body.length > 0) parts.push(`[Slide ${num}]\n${body.join("\n")}`);
    if (notes.length > 0) parts.push(`[Slide ${num} notes]\n${notes.join("\n")}`);
  }

  if (parts.length === 0) {
    throw new Error("no extractable text in PPTX (slides may contain only images)");
  }
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// XLSX (Office Open XML — a ZIP of worksheets).
// ---------------------------------------------------------------------------

/** Parse xl/sharedStrings.xml into an index-aligned array: exactly one entry
 *  per <si> item (a rich-text <si> holds several <t> runs that must be joined,
 *  and an empty <si/> must still occupy its slot — otherwise every subsequent
 *  cell's string index points at the wrong text). */
function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  for (const si of xml.match(/<si\b[^>]*\/>|<si\b[^>]*>[\s\S]*?<\/si>/g) ?? []) {
    let text = "";
    for (const run of si.match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g) ?? []) {
      text += decodeXmlEntities(run.replace(/<[^>]*>/g, ""));
    }
    out.push(text);
  }
  return out;
}

/**
 * XLSX text extractor. Parses the ZIP container, resolves each cell by its
 * declared type (shared string, inline string, boolean, or raw value), and
 * formats worksheets as readable `ref: value | ref: value` rows.
 */
export function extractXlsxText(buf: Buffer): string {
  const entries = readZipEntries(buf);
  const ssEntry = entries.get("xl/sharedStrings.xml");
  const sharedStrings = ssEntry ? parseSharedStrings(ssEntry.toString("utf8")) : [];

  const sheetMatches = [...entries.keys()]
    .map((name) => /^xl\/worksheets\/sheet(\d+)\.xml$/.exec(name))
    .filter((m): m is RegExpExecArray => m !== null)
    .sort((a, b) => parseInt(a[1]!, 10) - parseInt(b[1]!, 10));

  const output: string[] = [];
  for (const m of sheetMatches) {
    const xml = entries.get(m[0])!.toString("utf8");
    const rows: string[] = [];

    for (const rowXml of xml.match(/<row\b[^>]*>[\s\S]*?<\/row>/g) ?? []) {
      const cells: string[] = [];
      // Match self-closing cells first so an empty <c .../> cannot swallow its
      // neighbours into one bogus match.
      for (const cellXml of rowXml.match(/<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g) ?? []) {
        const openTag = /^<c\b([^>]*?)\/?>/.exec(cellXml)?.[1] ?? "";
        const ref = /(?:^|\s)r="([^"]*)"/.exec(openTag)?.[1] ?? "";
        const type = /(?:^|\s)t="([^"]*)"/.exec(openTag)?.[1] ?? "";

        let text = "";
        if (type === "inlineStr") {
          for (const run of cellXml.match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g) ?? []) {
            text += decodeXmlEntities(run.replace(/<[^>]*>/g, ""));
          }
        } else {
          const v = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(cellXml)?.[1];
          if (v === undefined) continue;
          if (type === "s") {
            // Only a t="s" cell's <v> is a shared-string index.
            const idx = parseInt(v, 10);
            text = Number.isFinite(idx) ? (sharedStrings[idx] ?? "") : "";
          } else if (type === "b") {
            text = v === "1" ? "TRUE" : "FALSE";
          } else {
            text = decodeXmlEntities(v); // number, formula string, or date serial
          }
        }

        if (text === "") continue;
        cells.push(ref ? `${ref}: ${text}` : text);
      }
      if (cells.length > 0) rows.push(cells.join(" | "));
    }

    if (rows.length > 0) output.push(`[Sheet ${m[1]}]\n${rows.join("\n")}`);
  }

  if (output.length === 0) {
    throw new Error("no extractable cell content in XLSX (may be empty or encrypted)");
  }
  return output.join("\n\n");
}

// ---------------------------------------------------------------------------
// RTF (Rich Text Format).
// ---------------------------------------------------------------------------

/** Destination groups whose content is metadata or binary, never body text. */
const RTF_SKIP_DESTINATIONS = new Set([
  "fonttbl", "colortbl", "stylesheet", "info", "pict", "object", "filetbl",
  "listtable", "listoverridetable", "revtbl", "themedata", "colorschememapping",
  "latentstyles", "datastore", "generator", "xmlnstbl", "fldinst",
  "header", "headerl", "headerr", "headerf", "footer", "footerl", "footerr", "footerf",
]);

/** Control words that render as a character or break. */
const RTF_SYMBOLS: Record<string, string> = {
  par: "\n", line: "\n", sect: "\n", page: "\n", row: "\n",
  tab: "\t", cell: "\t",
  emdash: "—", endash: "–",
  lquote: "‘", rquote: "’", ldblquote: "“", rdblquote: "”",
  bullet: "•", emspace: " ", enspace: " ", qmspace: " ",
};

/**
 * RTF text extractor: a single-pass tokenizer over groups, control words, and
 * plain text. Group state (skipped destination, \ucN fallback count) is kept
 * on a stack so `{...}` nesting restores it correctly. Handles \'hh hex
 * escapes, \uN unicode (including the negative signed-16-bit form Word emits
 * for non-Latin text) with its \uc fallback characters, and the common symbol
 * control words; every other control word is consumed whole and dropped.
 */
export function extractRtfText(buf: Buffer): string {
  const rtf = buf.toString("latin1");
  if (!rtf.startsWith("{\\rtf")) throw new Error("not an RTF file (missing {\\rtf header)");

  let out = "";
  let i = 0;
  const n = rtf.length;
  const stack: Array<{ skip: boolean; uc: number }> = [];
  let group = { skip: false, uc: 1 };

  while (i < n) {
    const ch = rtf[i]!;
    if (ch === "{") {
      stack.push(group);
      group = { ...group };
      i++;
      // `{\*\dest ...}` — an optional destination: skip the whole group.
      if (rtf[i] === "\\" && rtf[i + 1] === "*") {
        group.skip = true;
        i += 2;
      }
    } else if (ch === "}") {
      group = stack.pop() ?? { skip: false, uc: 1 };
      i++;
    } else if (ch === "\\") {
      const next = rtf[i + 1];
      if (next === undefined) {
        i++;
      } else if (next === "\\" || next === "{" || next === "}") {
        if (!group.skip) out += next;
        i += 2;
      } else if (next === "'") {
        const code = parseInt(rtf.slice(i + 2, i + 4), 16);
        if (!group.skip && Number.isFinite(code)) out += String.fromCharCode(code);
        i += 4;
      } else if (next === "~") {
        if (!group.skip) out += " "; // non-breaking space
        i += 2;
      } else if (next === "-" || next === "_") {
        i += 2; // optional/non-breaking hyphen — drop
      } else if (next === "\r" || next === "\n") {
        // An escaped raw newline is an implicit \par.
        if (!group.skip) out += "\n";
        i += 2;
        if (next === "\r" && rtf[i] === "\n") i++;
      } else if (/[a-zA-Z]/.test(next)) {
        // Control word: \letters, optional signed integer, optional one
        // delimiter space (which belongs to the control word, not the text).
        let j = i + 1;
        let word = "";
        while (j < n && /[a-zA-Z]/.test(rtf[j]!)) {
          word += rtf[j];
          j++;
        }
        let param = "";
        if (rtf[j] === "-") {
          param = "-";
          j++;
        }
        while (j < n && rtf[j]! >= "0" && rtf[j]! <= "9") {
          param += rtf[j];
          j++;
        }
        if (rtf[j] === " ") j++;
        i = j;

        if (RTF_SKIP_DESTINATIONS.has(word)) {
          group.skip = true;
        } else if (word === "uc") {
          group.uc = Math.max(0, parseInt(param, 10) || 0);
        } else if (word === "u") {
          let code = parseInt(param, 10);
          if (Number.isFinite(code)) {
            if (code < 0) code += 65536; // signed 16-bit form Word emits for non-Latin text
            if (!group.skip && code >= 0 && code <= 0x10ffff) out += String.fromCodePoint(code);
          }
          // Consume the \uc fallback characters that follow (each may itself
          // be a \'hh escape); stop early at a group boundary.
          for (let skip = group.uc; skip > 0 && i < n; skip--) {
            if (rtf[i] === "\\" && rtf[i + 1] === "'") i += 4;
            else if (rtf[i] === "{" || rtf[i] === "}") break;
            else i++;
          }
        } else if (!group.skip) {
          const symbol = RTF_SYMBOLS[word];
          if (symbol !== undefined) out += symbol;
          // else: a formatting word (\b, \fs24, ...) — ignore
        }
      } else {
        i += 2; // unknown control symbol — drop
      }
    } else if (ch === "\r" || ch === "\n") {
      i++; // raw newlines in RTF source are markup whitespace, not text
    } else {
      if (!group.skip) out += ch;
      i++;
    }
  }

  const cleaned = out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (cleaned === "") {
    throw new Error("no extractable text in RTF");
  }
  return cleaned;
}

// ---------------------------------------------------------------------------
// ODT (OpenDocument Text — a ZIP with content.xml).
// ---------------------------------------------------------------------------

/**
 * ODT text extractor. Parses the ZIP container, pulls content.xml, and reduces
 * its OpenDocument markup to plain text (paragraph/heading ends → newlines).
 */
export function extractOdtText(buf: Buffer): string {
  const entries = readZipEntries(buf);
  const doc = entries.get("content.xml");
  if (!doc) throw new Error("no content.xml found in ODT");
  let s = doc.toString("utf8");
  s = s.replace(/<text:tab\b[^>]*\/?>/g, "\t");
  s = s.replace(/<text:line-break\b[^>]*\/?>/g, "\n");
  s = s.replace(/<text:s\b[^>]*\/>/g, " ");
  s = s.replace(/<\/text:(p|h)>/g, "\n");
  s = s.replace(/<[^>]*>/g, "");
  const text = decodeXmlEntities(s).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (text === "") {
    throw new Error("no extractable text in ODT document body");
  }
  return text;
}

// ---------------------------------------------------------------------------
// EPUB (a ZIP of XHTML chapters with an OPF manifest).
// ---------------------------------------------------------------------------

/** Strip one XHTML chapter to plain text: block-element closers → newlines. */
function stripXhtml(xml: string): string {
  let s = xml;
  s = s.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "");
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<br\b[^>]*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section|article|title|td|th)>/gi, "\n");
  s = s.replace(/<[^>]*>/g, "");
  return decodeXmlEntities(s).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * EPUB text extractor. Resolves the reading order from the OPF spine
 * (META-INF/container.xml → package .opf → manifest/spine) and strips each
 * chapter's XHTML; when the spine cannot be resolved, falls back to every
 * XHTML entry in archive order.
 */
export function extractEpubText(buf: Buffer): string {
  const entries = readZipEntries(buf);

  let chapterPaths: string[] = [];
  const containerXml = entries.get("META-INF/container.xml")?.toString("utf8") ?? "";
  const opfPath = /full-path="([^"]+)"/.exec(containerXml)?.[1];
  const opfXml = opfPath ? entries.get(opfPath)?.toString("utf8") : undefined;
  if (opfPath && opfXml) {
    const opfDir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
    const hrefById = new Map<string, string>();
    for (const item of opfXml.match(/<item\b[^>]*>/g) ?? []) {
      const id = /(?:^|\s)id="([^"]+)"/.exec(item)?.[1];
      const href = /(?:^|\s)href="([^"]+)"/.exec(item)?.[1];
      if (!id || !href) continue;
      let resolved = opfDir + decodeXmlEntities(href);
      if (!entries.has(resolved)) {
        try {
          resolved = decodeURIComponent(resolved);
        } catch {
          /* keep the raw href */
        }
      }
      hrefById.set(id, resolved);
    }
    for (const ref of opfXml.match(/<itemref\b[^>]*>/g) ?? []) {
      const idref = /(?:^|\s)idref="([^"]+)"/.exec(ref)?.[1];
      const href = idref ? hrefById.get(idref) : undefined;
      if (href && entries.has(href)) chapterPaths.push(href);
    }
  }
  if (chapterPaths.length === 0) {
    chapterPaths = [...entries.keys()].filter((name) => /\.(xhtml|html|htm)$/i.test(name));
  }

  const chapters: string[] = [];
  for (const path of chapterPaths) {
    const data = entries.get(path);
    if (!data) continue;
    const text = stripXhtml(data.toString("utf8"));
    if (text !== "") chapters.push(text);
  }
  if (chapters.length === 0) {
    throw new Error("no extractable text in EPUB");
  }
  return chapters.join("\n\n");
}

// ---------------------------------------------------------------------------
// Dispatch.
// ---------------------------------------------------------------------------

/**
 * Extract text from a supported document by file extension. Returns the text
 * and a short kind tag, or `undefined` when the extension is not a recognized
 * document type (the caller then falls through to plain-text handling).
 * Extraction failures propagate as thrown errors.
 */
export function extractDocumentText(path: string, buf: Buffer): { text: string; kind: string } | undefined {
  switch (extname(path).toLowerCase()) {
    case ".pdf":
      return { text: extractPdfText(buf), kind: "pdf" };
    case ".docx":
      return { text: extractDocxText(buf), kind: "docx" };
    case ".pptx":
      return { text: extractPptxText(buf), kind: "pptx" };
    case ".xlsx":
      return { text: extractXlsxText(buf), kind: "xlsx" };
    case ".rtf":
      return { text: extractRtfText(buf), kind: "rtf" };
    case ".odt":
      return { text: extractOdtText(buf), kind: "odt" };
    case ".epub":
      return { text: extractEpubText(buf), kind: "epub" };
    default:
      return undefined;
  }
}
