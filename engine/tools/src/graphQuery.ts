import { isAbsolute, relative } from "node:path";
import { z } from "zod";
import {
  articulationPoints,
  blastRadius,
  dependencies,
  graphStats,
  loadOrBuildGraph,
  pagerank,
  slice,
  type GraphData,
  type ToolDefinition,
} from "@magentra/core";

const inputSchema = z.object({
  op: z.enum(["slice", "blast", "deps", "structure", "rank"]),
  files: z.array(z.string()).optional(),
  query: z.string().optional(),
  budget_tokens: z.number().int().positive().max(60000).optional(),
});

type Input = z.infer<typeof inputSchema>;

const MAX_LINES = 200;

function normalizeToId(cwd: string, path: string): string {
  const rel = isAbsolute(path) ? relative(cwd, path) : path;
  return rel.split(/[\\/]/).join("/").replace(/^\.\//, "");
}

/** Resolve seeds from explicit files (normalized) plus `query` substring matches. */
function resolveSeeds(g: GraphData, cwd: string, input: Input): string[] {
  const seeds = new Set<string>();
  for (const f of input.files ?? []) {
    const id = normalizeToId(cwd, f);
    if (g.files[id]) seeds.add(id);
  }
  if (input.query) {
    const keywords = input.query.toLowerCase().split(/\s+/).filter(Boolean);
    if (keywords.length > 0) {
      for (const id of Object.keys(g.files)) {
        const lower = id.toLowerCase();
        if (keywords.some((k) => lower.includes(k))) seeds.add(id);
      }
    }
  }
  return [...seeds];
}

function cap(lines: string[]): string {
  if (lines.length <= MAX_LINES) return lines.join("\n");
  return lines.slice(0, MAX_LINES).join("\n") + `\n[truncated — ${lines.length - MAX_LINES} more lines; narrow the query]`;
}

export const graphQueryTool: ToolDefinition<Input> = {
  name: "GraphQuery",
  description: `Query the workspace import graph to LOCATE code and judge IMPACT — a structural alternative to reading files one by one.

- slice: ranked minimal context for a topic. Give files and/or a query; returns the highest-relevance files (personalized PageRank) that fit a token budget, plus the edges among them. Use this instead of guessing which files to open.
- blast: what breaks if these files change — the transitive set of modules that import them, grouped by hop distance. Run before editing anything widely imported.
- deps: what a file relies on — its forward dependency closure, with external packages listed separately.
- structure: the skeleton of the repo — top files by PageRank, articulation points, bridges, component and file/edge counts. Use when drafting or refreshing the atlas.
- rank: the most central files overall, or personalized to given seeds.

Seeds come from files (paths) and/or query (space-separated keywords, ANY substring match against paths). Results are computed from the import graph: they are structural, not semantic — a file the graph never links is invisible here.`,
  permissionClass: "read",
  parallelSafe: true,
  describeInput: (input) =>
    `${input.op}${input.files?.length ? " " + input.files.join(",") : ""}${input.query ? " ?" + input.query : ""}`,
  searchTerms: (input) => [...(input.files ?? []), ...(input.query ? [input.query] : [])],
  inputSchema,
  execute: async (input, ctx) => {
    const g = loadOrBuildGraph(ctx.cwd);
    const stats = graphStats(g);

    if (input.op === "structure") {
      const lines: string[] = [`graph skeleton of ${stats.fileCount} files:`, ""];
      const ranks = [...pagerank(g).entries()]
        .filter(([id]) => !id.startsWith("pkg:") && g.files[id])
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15);
      lines.push("top files (pagerank):");
      for (const [id, score] of ranks) lines.push(`  ${score.toFixed(5)}  ${id}`);
      const { points, bridges } = articulationPoints(g);
      lines.push("", `articulation points (${points.length}):`);
      for (const p of points) lines.push(`  ${p}`);
      lines.push("", `bridges (${bridges.length}):`);
      for (const [a, b] of bridges) lines.push(`  ${a} -- ${b}`);
      lines.push(
        "",
        `components: ${stats.componentCount}   files: ${stats.fileCount}   edges: ${stats.edgeCount}`,
      );
      return { content: cap(lines) };
    }

    if (input.op === "rank") {
      const seeds = resolveSeeds(g, ctx.cwd, input);
      const ranks = [...pagerank(g, seeds.length ? { seeds } : {}).entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20);
      const header = seeds.length ? `top 20 pagerank (personalized to ${seeds.length} seed(s)):` : "top 20 pagerank:";
      const lines = [header, ...ranks.map(([id, s]) => `  ${s.toFixed(5)}  ${id}`)];
      return { content: cap(lines) };
    }

    if (input.op === "blast") {
      const seeds = (input.files ?? []).map((f) => normalizeToId(ctx.cwd, f)).filter((id) => g.files[id]);
      if (seeds.length === 0) {
        return {
          content: "blast needs one or more existing files. Ops: slice, blast, deps, structure, rank.",
          isError: true,
        };
      }
      const hits = blastRadius(g, seeds);
      const lines = [`change amplification: ${hits.length} modules`, ""];
      let lastDist = -1;
      for (const { file, distance } of hits) {
        if (distance !== lastDist) {
          lines.push(`distance ${distance}:`);
          lastDist = distance;
        }
        lines.push(`  ${file}`);
      }
      return { content: cap(lines) };
    }

    if (input.op === "deps") {
      const seeds = (input.files ?? []).map((f) => normalizeToId(ctx.cwd, f)).filter((id) => g.files[id]);
      if (seeds.length === 0) {
        return {
          content: "deps needs one or more existing files. Ops: slice, blast, deps, structure, rank.",
          isError: true,
        };
      }
      const lines: string[] = [];
      for (const seed of seeds) {
        const deps = dependencies(g, seed);
        lines.push(`${seed} depends on ${deps.length}:`);
        const external: string[] = [];
        for (const { file, distance } of deps) {
          if (file.startsWith("pkg:")) external.push(file.slice(4));
          else lines.push(`  d${distance}  ${file}`);
        }
        if (external.length > 0) lines.push(`  external: ${external.join(", ")}`);
        lines.push("");
      }
      return { content: cap(lines) };
    }

    // slice
    const seeds = resolveSeeds(g, ctx.cwd, input);
    if (seeds.length === 0) {
      return {
        content: "slice needs seeds — pass files and/or a query. Ops: slice, blast, deps, structure, rank.",
        isError: true,
      };
    }
    const budget = input.budget_tokens ?? 12000;
    const selected = slice(g, seeds, budget);
    const selectedSet = new Set(selected.map((s) => s.file));
    const lines: string[] = [`slice of ${selected.length} files (budget ${budget} tokens):`, ""];
    for (const { file, score, estTokens } of selected) {
      lines.push(`  ${score.toFixed(5)}  ${String(estTokens).padStart(6)}  ${file}`);
    }
    lines.push("", "edges among selected:");
    for (const file of selectedSet) {
      for (const target of g.files[file]?.imports ?? []) {
        if (selectedSet.has(target)) lines.push(`  ${file} -> ${target}`);
      }
    }
    return { content: cap(lines) };
  },
};
