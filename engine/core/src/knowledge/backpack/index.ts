import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { buildBm25, type Bm25Index } from "./bm25.js";

/**
 * The persisted knowledge backpack for one crew agent. It lives at
 * <cwd>/.magentra/team/backpacks/<agentId>/index.json and is written after each
 * phase of the build ladder, so a search can run the moment BM25 is ready and a
 * resumed build skips the phases whose source documents have not changed.
 */

export type DocPhase = "raw" | "noted" | "embedded";

export interface BackpackDocMeta {
  sha256: string;
  chunkCount: number;
  phase: DocPhase;
}

export interface BackpackChunk {
  text: string;
  loc: string;
  note?: string;
}

export interface BackpackIndex {
  version: 1;
  /** Keyed by the agent's declared workspace-relative doc path (posix separators), in build order. */
  docs: Record<string, BackpackDocMeta>;
  chunks: BackpackChunk[];
  /** BM25 over note+text (falling back to text) of every chunk; null before the raw phase. */
  bm25: Bm25Index | null;
  /** base64-encoded Float32 rows aligned to `chunks`; present only when every chunk is embedded. */
  embeddings?: string[];
  /** The embedding model id that produced `embeddings` (mismatched search models skip the vector leg). */
  embeddingModel?: string;
  /** Set when an embed phase ran but degraded — suppresses the pointless rebuild-on-start trigger. */
  embeddingsAttempted?: true;
  brief?: string;
}

export function emptyBackpackIndex(): BackpackIndex {
  return { version: 1, docs: {}, chunks: [], bm25: null };
}

export function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function backpackDir(cwd: string, agentId: string): string {
  return join(cwd, ".magentra", "team", "backpacks", agentId);
}

export function backpackIndexPath(cwd: string, agentId: string): string {
  return join(backpackDir(cwd, agentId), "index.json");
}

export function loadBackpackIndex(cwd: string, agentId: string): BackpackIndex | undefined {
  try {
    const raw = JSON.parse(readFileSync(backpackIndexPath(cwd, agentId), "utf8")) as unknown;
    if (isBackpackIndex(raw)) return migrateDocKeys(raw, cwd);
  } catch {
    /* missing or corrupt — treat as absent */
  }
  return undefined;
}

/** Canonical index key for a declared doc path: workspace-relative, posix separators. */
export function docKey(rel: string): string {
  return rel.replace(/\\/g, "/");
}

function isAbsoluteKey(key: string): boolean {
  return key.startsWith("/") || key.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(key);
}

/**
 * Older indexes keyed docs by absolute machine paths. Re-key them in memory to
 * workspace-relative posix paths; an entry outside cwd cannot be verified, so it
 * (and its chunk/embedding slice) is dropped. The next save persists the
 * migrated form.
 */
function migrateDocKeys(index: BackpackIndex, cwd: string): BackpackIndex {
  if (!Object.keys(index.docs).some(isAbsoluteKey)) return index;
  const docs: Record<string, BackpackDocMeta> = {};
  const chunks: BackpackChunk[] = [];
  const embeddings: string[] | undefined = index.embeddings ? [] : undefined;
  let offset = 0;
  let dropped = false;
  for (const [key, meta] of Object.entries(index.docs)) {
    const chunkSlice = index.chunks.slice(offset, offset + meta.chunkCount);
    const embSlice = index.embeddings?.slice(offset, offset + meta.chunkCount);
    offset += meta.chunkCount;
    let newKey = key;
    if (isAbsoluteKey(key)) {
      const rel = relative(cwd, key);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        dropped = true;
        continue;
      }
      newKey = docKey(rel);
    }
    docs[newKey] = meta;
    chunks.push(...chunkSlice);
    if (embeddings && embSlice) embeddings.push(...embSlice);
  }
  const migrated: BackpackIndex = { ...index, docs, chunks };
  if (embeddings) migrated.embeddings = embeddings;
  if (dropped) {
    // Dropped slices misalign the persisted BM25 postings — rebuild over what remains.
    migrated.bm25 =
      chunks.length > 0 ? buildBm25(chunks.map((c) => (c.note ? `${c.note}\n${c.text}` : c.text))) : null;
  }
  return migrated;
}

export function saveBackpackIndex(cwd: string, agentId: string, index: BackpackIndex): void {
  const dir = backpackDir(cwd, agentId);
  mkdirSync(dir, { recursive: true });
  const file = backpackIndexPath(cwd, agentId);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(index));
  try {
    renameSync(tmp, file);
  } catch {
    // Windows can refuse renaming over an existing/locked file (EEXIST/EPERM).
    rmSync(file, { force: true });
    renameSync(tmp, file);
  }
}

/** True when the doc exists under cwd and its bytes hash to the sha256 recorded for it. */
export function isDocCurrent(index: BackpackIndex, cwd: string, relPath: string): boolean {
  const meta = index.docs[docKey(relPath)];
  if (!meta) return false;
  const path = join(cwd, relPath);
  if (!existsSync(path)) return false;
  try {
    return sha256(readFileSync(path)) === meta.sha256;
  } catch {
    return false;
  }
}

export function encodeEmbedding(vec: Float32Array): string {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength).toString("base64");
}

export function decodeEmbedding(b64: string): Float32Array {
  const buf = Buffer.from(b64, "base64");
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
}

function isBackpackIndex(v: unknown): v is BackpackIndex {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return o.version === 1 && typeof o.docs === "object" && o.docs !== null && Array.isArray(o.chunks);
}
