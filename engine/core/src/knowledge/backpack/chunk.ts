import { basename } from "node:path";
import { extractDocumentText } from "../docs.js";

/**
 * Splits a document into overlapping character windows for the knowledge
 * backpack. PDF/DOCX go through the dependency-free extractors in docs.ts; every
 * other file is read as UTF-8 text. Windows target ~4000 chars with a 400-char
 * overlap, ending at a paragraph boundary when one falls in the back half of the
 * window so a chunk rarely splits mid-thought.
 */

export const CHUNK_SIZE = 4000;
export const CHUNK_OVERLAP = 400;

export interface Chunk {
  text: string;
  /** "<docname>#chunk<N>", N zero-based. */
  loc: string;
}

/** Extract text from a buffer (document-aware) and split it into located chunks. */
export function chunkDocument(path: string, buf: Buffer): Chunk[] {
  const doc = extractDocumentText(path, buf);
  const text = doc ? doc.text : buf.toString("utf8");
  const name = basename(path);
  return splitText(text).map((t, i) => ({ text: t, loc: `${name}#chunk${i}` }));
}

/** Pure text splitter: overlapping windows, paragraph-boundary-aware. */
export function splitText(text: string): string[] {
  if (text.trim() === "") return [];
  if (text.length <= CHUNK_SIZE) return [text.trim()];

  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + CHUNK_SIZE, text.length);
    if (end < text.length) {
      // Prefer to end on a paragraph break in the back half of the window.
      const minEnd = start + Math.floor(CHUNK_SIZE / 2);
      const para = text.lastIndexOf("\n\n", end);
      if (para > minEnd) end = para;
    }
    const piece = text.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= text.length) break;
    start = Math.max(0, end - CHUNK_OVERLAP);
  }
  return chunks;
}
