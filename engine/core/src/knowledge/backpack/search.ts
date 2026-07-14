import { bm25Search } from "./bm25.js";
import { cosine, type Embedder } from "./embed.js";
import { decodeEmbedding, type BackpackIndex } from "./index.js";

/**
 * Hybrid retrieval over a backpack: BM25 always, plus embedding cosine when the
 * index carries vectors and an embedder is available. The two rankings are
 * fused with Reciprocal Rank Fusion (RRF), so a passage ranked highly by either
 * signal surfaces. An embedder failure degrades silently to BM25-only.
 */

const RRF_K = 60;
const CANDIDATES = 20;

export interface BackpackHit {
  loc: string;
  text: string;
  note?: string;
  score: number;
}

/** Fold a ranked list of chunk indices into an RRF-score map (1-based ranks). */
function accumulateRrf(target: Map<number, number>, ranked: number[]): void {
  ranked.forEach((chunkIndex, pos) => {
    target.set(chunkIndex, (target.get(chunkIndex) ?? 0) + 1 / (RRF_K + pos + 1));
  });
}

export async function backpackSearch(
  index: BackpackIndex,
  query: string,
  k: number,
  embedder?: Embedder,
): Promise<BackpackHit[]> {
  if (!index.bm25 || index.chunks.length === 0) return [];

  const bm25Ranked = bm25Search(index.bm25, query, CANDIDATES).map((r) => r.i);

  // Vectors from a different embedding model are incomparable — skip the
  // embedding leg (BM25-only) rather than fusing garbage cosine scores.
  const modelMismatch =
    index.embeddingModel !== undefined && embedder?.model !== undefined && index.embeddingModel !== embedder.model;

  let embRanked: number[] = [];
  if (index.embeddings && embedder && !modelMismatch) {
    try {
      const [q] = await embedder.embed([query]);
      if (q) {
        const scored = index.embeddings.map((b64, i) => ({ i, score: cosine(q, decodeEmbedding(b64)) }));
        embRanked = scored
          .sort((a, b) => b.score - a.score || a.i - b.i)
          .slice(0, CANDIDATES)
          .map((r) => r.i);
      }
    } catch {
      embRanked = []; // degrade to BM25-only
    }
  }

  const fused = new Map<number, number>();
  accumulateRrf(fused, bm25Ranked);
  accumulateRrf(fused, embRanked);

  return [...fused.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, k)
    .map(([i, score]) => {
      const chunk = index.chunks[i]!;
      return {
        loc: chunk.loc,
        text: chunk.text,
        ...(chunk.note !== undefined ? { note: chunk.note } : {}),
        score,
      };
    });
}
