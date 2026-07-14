import { z } from "zod";
import {
  DEFAULT_OPENAI_BASE_URL,
  backpackSearch,
  createEmbedder,
  loadBackpackIndex,
  resolveApiKey,
  type Embedder,
  type ToolDefinition,
} from "@magentra/core";

const inputSchema = z.object({
  query: z.string().describe("What to look up in the backpack — a question, term, or phrase."),
  agent: z
    .string()
    .optional()
    .describe("Which specialist's backpack to search. A specialist defaults to its own; the orchestrator must name one."),
  k: z.number().int().positive().max(20).optional().describe("How many passages to return (default 6, max 20)."),
});

type Input = z.infer<typeof inputSchema>;

export const backpackSearchTool: ToolDefinition<Input> = {
  name: "BackpackSearch",
  description: `Retrieve exact passages from a crew specialist's knowledge backpack (its indexed documents).

Hybrid BM25 + embedding search over the agent's chunked docs, fused by reciprocal rank. Use it to ground answers in the source rather than the distilled brief. A specialist searches its own backpack by default; the orchestrator must pass \`agent\` (a crew id). Returns ranked passages, each headed by its "<doc>#chunkN" location.`,
  permissionClass: "read",
  parallelSafe: true,
  describeInput: (input) => `BackpackSearch ${input.agent ? `[${input.agent}] ` : ""}"${input.query}"`,
  searchTerms: (input) => [input.query],
  inputSchema,
  execute: async (input, ctx) => {
    const agentId = input.agent ?? ctx.session.crewSelf;
    if (!agentId) {
      return {
        content:
          "BackpackSearch needs an agent id: name which specialist's backpack to search (the orchestrator carries no backpack of its own).",
        isError: true,
      };
    }
    const index = loadBackpackIndex(ctx.cwd, agentId);
    if (!index || !index.bm25 || index.chunks.length === 0) {
      return { content: `No backpack index for "${agentId}" yet (nothing indexed).`, isError: true };
    }

    const k = Math.min(input.k ?? 6, 20);
    let embedder: Embedder | undefined;
    const settings = ctx.session.settings;
    if (index.embeddings && settings.embeddings.enabled) {
      const apiKey = resolveApiKey(settings);
      if (apiKey) {
        embedder = createEmbedder({
          apiKey,
          baseUrl: settings.baseUrl ?? DEFAULT_OPENAI_BASE_URL,
          model: settings.embeddings.model,
        });
      }
    }

    const hits = await backpackSearch(index, input.query, k, embedder);
    if (hits.length === 0) return { content: `No matching passages in "${agentId}"'s backpack.` };

    const body = hits
      .map((h) => {
        const note = h.note ? `${h.note}\n---\n` : "";
        return `## ${h.loc}  (score ${h.score.toFixed(4)})\n${note}${h.text}`;
      })
      .join("\n\n");
    return { content: body };
  },
};
