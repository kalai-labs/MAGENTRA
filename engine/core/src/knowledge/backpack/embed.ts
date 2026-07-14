/**
 * Hosted embeddings over an OpenAI-compatible /embeddings endpoint (DeepInfra
 * serves this). No local model, no torch — a single POST per batch. `fetchFn`
 * is injectable so tests never touch the network. Any failure throws; the
 * caller degrades to BM25-only rather than blocking.
 */

const BATCH_SIZE = 64;

export interface Embedder {
  embed(texts: string[]): Promise<Float32Array[]>;
  /** The embedding model id this embedder queries (recorded in the index to fence stale vectors). */
  model?: string;
}

export interface EmbedderOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  fetchFn?: typeof fetch;
}

interface EmbeddingResponse {
  data?: { index: number; embedding: number[] }[];
}

export function createEmbedder(opts: EmbedderOptions): Embedder {
  const fetchFn = opts.fetchFn ?? fetch;
  return {
    model: opts.model,
    async embed(texts: string[]): Promise<Float32Array[]> {
      const out: Float32Array[] = [];
      for (let start = 0; start < texts.length; start += BATCH_SIZE) {
        const batch = texts.slice(start, start + BATCH_SIZE);
        const res = await fetchFn(`${opts.baseUrl}/embeddings`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${opts.apiKey}`,
          },
          body: JSON.stringify({ model: opts.model, input: batch, encoding_format: "float" }),
        });
        if (!res.ok) {
          throw new Error(`embeddings request failed: ${res.status} ${res.statusText}`);
        }
        const json = (await res.json()) as EmbeddingResponse;
        if (!Array.isArray(json.data) || json.data.length !== batch.length) {
          throw new Error("embeddings response malformed (missing or short data array)");
        }
        const rows = new Array<Float32Array | undefined>(batch.length);
        for (const item of json.data) rows[item.index] = Float32Array.from(item.embedding);
        for (const row of rows) {
          if (!row) throw new Error("embeddings response missing a row index");
          out.push(row);
        }
      }
      return out;
    },
  };
}

/** Cosine similarity; 0 when either is a zero vector or the dimensions differ (incomparable models). */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = a.length;
  for (let i = 0; i < len; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
