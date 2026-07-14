import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CrewAgent } from "../../crew/team.js";
import { buildBm25 } from "./bm25.js";
import { chunkDocument } from "./chunk.js";
import type { Embedder } from "./embed.js";
import {
  docKey,
  emptyBackpackIndex,
  encodeEmbedding,
  loadBackpackIndex,
  saveBackpackIndex,
  sha256,
  type BackpackChunk,
  type BackpackIndex,
  type DocPhase,
} from "./index.js";

/**
 * Builds a crew agent's knowledge backpack along a readiness ladder, persisting
 * after every rung so partial progress survives a crash and a resumed build
 * redoes only what changed:
 *   raw      chunk every doc + BM25 over raw text (searchable immediately)
 *   noted    LLM note-extraction per chunk (concurrency 4) + BM25 over note+text
 *   embedded hosted embeddings per chunk (skipped if no embedder or it fails)
 *   brief    a distilled ~600-word working brief over the notes
 * Documents whose sha256 is unchanged keep their notes/embeddings across runs.
 */

const NOTE_CONCURRENCY = 4;
const NOTE_MAX_TOKENS = 500;
const BRIEF_MAX_TOKENS = 1000;
const BRIEF_NOTE_CAP = 24_000;

const NOTE_SYSTEM =
  "Extract the atomic knowledge from this passage as terse notes: definitions, theorems/rules with their conditions, formulas, key facts. Plain lines, no commentary.";
const BRIEF_SYSTEM =
  "Distill these notes into a ~600-word working brief a specialist keeps in mind: core concepts, key rules with conditions, main techniques.";

const PHASE_RANK: Record<DocPhase, number> = { raw: 0, noted: 1, embedded: 2 };

export interface BuildProgress {
  agentId: string;
  phase: string;
  done: number;
  total: number;
}

export interface BuildBackpackOptions {
  cwd: string;
  agent: CrewAgent;
  runInference: (o: { system: string; user: string; maxTokens: number }) => Promise<string>;
  embedder?: Embedder;
  onProgress: (p: BuildProgress) => void;
  signal?: AbortSignal;
}

export interface BuildResult {
  index: BackpackIndex;
  warnings: string[];
}

/** One document's working state during a build. */
interface DocWork {
  path: string;
  sha256: string;
  phase: DocPhase;
  chunks: BackpackChunk[];
  /** base64 rows aligned to `chunks`; undefined entries are not yet embedded. */
  embeddings: (string | undefined)[];
}

/** Reconstruct per-document chunk/embedding slices from a persisted flat index. */
function explode(index: BackpackIndex): Map<string, DocWork> {
  const map = new Map<string, DocWork>();
  let offset = 0;
  for (const [path, meta] of Object.entries(index.docs)) {
    const chunks = index.chunks.slice(offset, offset + meta.chunkCount);
    const embeddings = index.embeddings
      ? index.embeddings.slice(offset, offset + meta.chunkCount)
      : new Array<string | undefined>(meta.chunkCount).fill(undefined);
    map.set(path, { path, sha256: meta.sha256, phase: meta.phase, chunks, embeddings });
    offset += meta.chunkCount;
  }
  return map;
}

function bm25Text(chunk: BackpackChunk): string {
  return chunk.note ? `${chunk.note}\n${chunk.text}` : chunk.text;
}

/** Flatten the working docs into a persistable index and save it. */
function assembleAndSave(cwd: string, agent: CrewAgent, docs: DocWork[]): BackpackIndex {
  const meta: Record<string, { sha256: string; chunkCount: number; phase: DocPhase }> = {};
  const chunks: BackpackChunk[] = [];
  const embeddings: (string | undefined)[] = [];
  for (const d of docs) {
    meta[d.path] = { sha256: d.sha256, chunkCount: d.chunks.length, phase: d.phase };
    chunks.push(...d.chunks);
    embeddings.push(...d.embeddings);
  }
  const allEmbedded = chunks.length > 0 && embeddings.every((e) => e !== undefined);
  const index: BackpackIndex = {
    version: 1,
    docs: meta,
    chunks,
    bm25: chunks.length > 0 ? buildBm25(chunks.map(bm25Text)) : null,
  };
  if (allEmbedded) index.embeddings = embeddings as string[];
  const previous = docs.length > 0 ? loadBackpackIndex(cwd, agent.id) : undefined;
  if (previous?.brief !== undefined) index.brief = previous.brief;
  if (allEmbedded && previous?.embeddingModel !== undefined) index.embeddingModel = previous.embeddingModel;
  if (!allEmbedded && previous?.embeddingsAttempted) index.embeddingsAttempted = true;
  saveBackpackIndex(cwd, agent.id, index);
  return index;
}

/** Run `fn` over items with a fixed concurrency limit, honoring an abort signal. */
async function mapConcurrent<T>(
  items: T[],
  limit: number,
  fn: (item: T, i: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      if (signal?.aborted) return;
      const i = next++;
      await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export async function buildBackpack(opts: BuildBackpackOptions): Promise<BuildResult> {
  const { cwd, agent, runInference, embedder, onProgress, signal } = opts;
  const warnings: string[] = [];
  const existing = loadBackpackIndex(cwd, agent.id);
  const prior = existing ? explode(existing) : new Map<string, DocWork>();

  // ----- Assemble the working document set, reusing unchanged docs. ----------
  const docs: DocWork[] = [];
  for (const rel of agent.docs) {
    const key = docKey(rel);
    let buf: Buffer;
    try {
      buf = readFileSync(join(cwd, rel));
    } catch {
      warnings.push(`backpack: document not found, skipped: ${rel}`);
      continue;
    }
    const hash = sha256(buf);
    const prev = prior.get(key);
    if (prev && prev.sha256 === hash) {
      docs.push(prev);
    } else {
      const chunks = chunkDocument(rel, buf).map((c) => ({ text: c.text, loc: c.loc }));
      docs.push({ path: key, sha256: hash, phase: "raw", chunks, embeddings: chunks.map(() => undefined) });
    }
  }

  const totalChunks = docs.reduce((n, d) => n + d.chunks.length, 0);

  // ----- Phase 1: raw (chunks + BM25). ---------------------------------------
  let index = assembleAndSave(cwd, agent, docs);
  onProgress({ agentId: agent.id, phase: "raw", done: totalChunks, total: totalChunks });
  if (signal?.aborted) return { index, warnings };

  // ----- Phase 2: note extraction. -------------------------------------------
  const toNote: { chunk: BackpackChunk }[] = [];
  for (const d of docs) {
    for (const c of d.chunks) if (c.note === undefined) toNote.push({ chunk: c });
  }
  if (toNote.length > 0) {
    let done = 0;
    onProgress({ agentId: agent.id, phase: "noted", done, total: toNote.length });
    await mapConcurrent(
      toNote,
      NOTE_CONCURRENCY,
      async ({ chunk }) => {
        try {
          const note = await runInference({ system: NOTE_SYSTEM, user: chunk.text, maxTokens: NOTE_MAX_TOKENS });
          chunk.note = note.trim();
        } catch (err) {
          // The chunk stays searchable via raw text and is re-noted on the next build.
          warnings.push(`backpack: note extraction failed for ${chunk.loc} (${(err as Error).message})`);
        }
        onProgress({ agentId: agent.id, phase: "noted", done: ++done, total: toNote.length });
      },
      signal,
    );
  }
  for (const d of docs) d.phase = maxPhase(d.phase, "noted");
  index = assembleAndSave(cwd, agent, docs);
  onProgress({ agentId: agent.id, phase: "noted", done: toNote.length, total: toNote.length });
  if (signal?.aborted) return { index, warnings };

  // ----- Phase 3: embeddings (optional; degrade on failure). -----------------
  if (embedder) {
    let degraded = false;
    const pending: { doc: DocWork; slot: number; text: string }[] = [];
    for (const d of docs) {
      d.chunks.forEach((c, slot) => {
        if (d.embeddings[slot] === undefined) pending.push({ doc: d, slot, text: c.note || c.text });
      });
    }
    if (pending.length > 0) {
      onProgress({ agentId: agent.id, phase: "embedded", done: 0, total: pending.length });
      try {
        const vectors = await embedder.embed(pending.map((p) => p.text));
        pending.forEach((p, i) => {
          p.doc.embeddings[p.slot] = encodeEmbedding(vectors[i]!);
        });
        for (const d of docs) {
          if (d.embeddings.every((e) => e !== undefined)) d.phase = maxPhase(d.phase, "embedded");
        }
        onProgress({ agentId: agent.id, phase: "embedded", done: pending.length, total: pending.length });
      } catch (err) {
        degraded = true;
        warnings.push(`backpack: embeddings unavailable, BM25-only (${(err as Error).message})`);
      }
    } else if (docs.every((d) => d.chunks.length > 0 && d.embeddings.every((e) => e !== undefined))) {
      for (const d of docs) d.phase = maxPhase(d.phase, "embedded");
    }
    index = assembleAndSave(cwd, agent, docs);
    if (index.embeddings !== undefined && embedder.model !== undefined && index.embeddingModel !== embedder.model) {
      index.embeddingModel = embedder.model;
      saveBackpackIndex(cwd, agent.id, index);
    } else if (degraded && !index.embeddingsAttempted) {
      // Remember the attempt so a permanently failing endpoint doesn't relaunch a build every session start.
      index.embeddingsAttempted = true;
      saveBackpackIndex(cwd, agent.id, index);
    }
    if (signal?.aborted) return { index, warnings };
  }

  // ----- Phase 4: distilled brief. -------------------------------------------
  // Regenerate only when there is no brief yet or fresh notes were produced —
  // a pure resume with an existing brief and no changes redoes nothing.
  const notes = docs.flatMap((d) => d.chunks.map((c) => c.note ?? "")).filter((n) => n.trim() !== "");
  const needBrief = existing?.brief === undefined || toNote.length > 0;
  if (notes.length > 0 && needBrief) {
    onProgress({ agentId: agent.id, phase: "brief", done: 0, total: 1 });
    const brief = await distill(notes.join("\n"), runInference);
    index.brief = brief;
    saveBackpackIndex(cwd, agent.id, index);
    onProgress({ agentId: agent.id, phase: "brief", done: 1, total: 1 });
  } else if (index.chunks.length === 0 && index.brief === undefined) {
    // Nothing to distill (all docs missing/empty). Persist an empty brief —
    // "attempted, nothing here" — so session start stops relaunching this build.
    index.brief = "";
    saveBackpackIndex(cwd, agent.id, index);
  }

  return { index, warnings };
}

function maxPhase(a: DocPhase, b: DocPhase): DocPhase {
  return PHASE_RANK[a] >= PHASE_RANK[b] ? a : b;
}

/** Distill notes into a brief, summarizing in halves first when over the cap. */
async function distill(
  notes: string,
  runInference: (o: { system: string; user: string; maxTokens: number }) => Promise<string>,
): Promise<string> {
  if (notes.length <= BRIEF_NOTE_CAP) {
    return (await runInference({ system: BRIEF_SYSTEM, user: notes, maxTokens: BRIEF_MAX_TOKENS })).trim();
  }
  const mid = Math.floor(notes.length / 2);
  const split = notes.indexOf("\n", mid);
  const cut = split === -1 ? mid : split;
  const [first, second] = await Promise.all([
    runInference({ system: BRIEF_SYSTEM, user: notes.slice(0, cut), maxTokens: BRIEF_MAX_TOKENS }),
    runInference({ system: BRIEF_SYSTEM, user: notes.slice(cut), maxTokens: BRIEF_MAX_TOKENS }),
  ]);
  return (
    await runInference({ system: BRIEF_SYSTEM, user: `${first.trim()}\n${second.trim()}`, maxTokens: BRIEF_MAX_TOKENS })
  ).trim();
}
