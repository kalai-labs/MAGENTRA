/**
 * `tool-graphquery`.
 *
 * GraphQuery answers structural questions from the workspace import graph.
 * Five ops: `blast` (everything that transitively imports the given files, by
 * hop distance), `deps` (the forward closure, with external packages listed
 * apart), `structure` (top files by PageRank, articulation points, bridges and
 * counts), `rank` (the most central files) and `slice` (a ranked minimal set
 * for a topic within a token budget). Every answer is capped at 200 lines.
 *
 * `fs`, as the record declares: each test builds a real workspace of real
 * source files in a temp directory, and the tool scans it, writes its
 * `.magentra/graph.json` there, and answers from it. The tool runs through the
 * Session's own validate-then-execute path (`tests/lib/directTool.ts`) against
 * `strictServices({})` — it reaches for `ctx.cwd` and no session service.
 *
 * WHICH IMPORT SPELLINGS THE SCANNER RESOLVES. `extractImports`/`resolveJsSpec`
 * resolve both the repo's own ESM convention (`from "./b.js"`, whose `.js` is
 * retried as `.ts`) and the extensionless form (`from "./c"`, retried through
 * TRY_EXTS). The fixture below deliberately uses one of each — `a.ts` imports
 * `"./b.js"`, `b.ts` imports `"./c"` — so a regression in either resolver
 * breaks the blast chain rather than passing unnoticed.
 *
 * TWO PLACES THE CHECKLIST AND THE CODE HAD TO BE RECONCILED, neither silently:
 *  - `budget_tokens: 100000` is REFUSED by the tool's own schema, which reads
 *    `z.number().int().positive().max(60000)`. The slice test asserts that
 *    refusal (it is the real contract) and then runs the slice at the cap,
 *    60000, which is still far above this fixture's ~48 tokens.
 *  - `structure`'s `edges:` count includes `pkg:` edges (`graphStats` sums
 *    every entry's `imports`), so the 'files: 4 edges: 3' workspace is kept
 *    free of external imports and the `zod` clause of the deps item gets a
 *    workspace of its own.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ToolContext } from "@magentra/core";
import { graphQueryTool } from "@magentra/tools";

import { resultText, runTool, strictServices } from "../lib/directTool.ts";
import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";

const FEATURE = "tool-graphquery";

/** Verbatim from the record. */
const INVARIANT = "All five modes answer from the workspace import graph: slice, blast, deps, structure and rank.";

/** a → b → c, and d → a. Four files, three edges, no external package. */
const CHAIN: Record<string, string> = {
  "a.ts": 'import { b } from "./b.js";\nexport const a = b;\n',
  "b.ts": 'import { c } from "./c";\nexport const b = c;\n',
  "c.ts": "export const c = 1;\n",
  "d.ts": 'import { a } from "./a.js";\nexport const d = a;\n',
};

abstract class GraphQueryTest extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  /** A real workspace of real source files; the graph is built by scanning it. */
  protected workspace(files: Record<string, string>): string {
    const dir = this.tempDir("magentra-graphquery-");
    for (const [rel, contents] of Object.entries(files)) {
      const abs = join(dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, contents, "utf8");
    }
    return dir;
  }

  protected ctx(dir: string): ToolContext {
    return { cwd: dir, session: strictServices({}) };
  }

  protected async query(dir: string, input: Record<string, unknown>): Promise<string> {
    const result = await runTool(graphQueryTool, input, this.ctx(dir));
    if (result.isError === true) throw new Error(`GraphQuery refused ${JSON.stringify(input)}: ${resultText(result)}`);
    return resultText(result);
  }
}

/* ---- checklist 1 ----------------------------------------------------- */

class BlastGroupsImportersByHopDistance extends GraphQueryTest {
  readonly id = "blast-lists-every-transitive-importer-with-its-hop-distance";
  readonly whyItExists =
    "blast reported only direct importers, so a change to a leaf module looked safe while the two modules that reached it through one hop broke";

  override async run(t: TestRun): Promise<void> {
    const dir = this.workspace(CHAIN);
    const out = await this.query(dir, { op: "blast", files: ["c.ts"] });

    t.assert.equal(out.split("\n")[0], "change amplification: 3 modules", `header; got ${JSON.stringify(out)}`);
    t.assert.equal(
      out,
      ["change amplification: 3 modules", "", "distance 1:", "  b.ts", "distance 2:", "  a.ts", "distance 3:", "  d.ts"].join("\n"),
      "b at one hop, a at two, d at three — grouped, in ascending distance",
    );
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class DepsSeparatesExternalPackages extends GraphQueryTest {
  readonly id = "deps-lists-the-forward-closure-with-packages-on-an-external-line";
  readonly whyItExists =
    "the forward closure mixed `pkg:zod` in with the workspace files as if it were one, so the agent tried to open a node_modules path the graph had never scanned";

  override async run(t: TestRun): Promise<void> {
    const dir = this.workspace({
      ...CHAIN,
      "a.ts": 'import { z } from "zod";\nimport { b } from "./b.js";\nexport const a = z && b;\n',
    });
    const out = await this.query(dir, { op: "deps", files: ["a.ts"] });

    t.assert.equal(out.split("\n")[0], "a.ts depends on 3:", `header; got ${JSON.stringify(out)}`);
    t.assert.ok(out.includes("\n  d1  b.ts"), "b.ts at distance 1");
    t.assert.ok(out.includes("\n  d2  c.ts"), "c.ts at distance 2, reached through b.ts");
    t.assert.ok(out.includes("\n  external: zod"), "the package is named on its own line, not as a file");
    t.assert.equal(out.includes("pkg:zod"), false, "and the synthetic node id never reaches the model");
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class StructureIsTheRepoSkeleton extends GraphQueryTest {
  readonly id = "structure-reports-pagerank-articulation-points-bridges-and-counts";
  readonly whyItExists =
    "structure counted `pkg:` nodes as files, so a workspace of four modules that imported three libraries reported seven files and an articulation point that was a package";

  override async run(t: TestRun): Promise<void> {
    const dir = this.workspace(CHAIN);
    const out = await this.query(dir, { op: "structure" });
    const lines = out.split("\n");

    t.assert.equal(lines[0], "graph skeleton of 4 files:");
    t.assert.ok(lines.includes("top files (pagerank):"), `a pagerank section; got ${JSON.stringify(out)}`);
    t.assert.ok(out.includes("\narticulation points (2):"), "articulation points, counted");
    t.assert.ok(out.includes("\n  a.ts\n  b.ts"), "a.ts and b.ts are the cut vertices of a→b→c with d→a");
    t.assert.ok(out.includes("\nbridges (3):"), "bridges, counted");
    t.assert.ok(out.includes("\n  b.ts -- c.ts"), "every edge of a tree is a bridge");
    t.assert.equal(lines[lines.length - 1], "components: 1   files: 4   edges: 3", "one component, four files, three edges");

    // The pagerank block is real scores, descending, over files only.
    const rankStart = lines.indexOf("top files (pagerank):") + 1;
    const ranks: string[] = [];
    for (let i = rankStart; i < lines.length && lines[i]!.startsWith("  "); i++) ranks.push(lines[i]!);
    t.assert.equal(ranks.length, 4, `one line per file; got ${JSON.stringify(ranks)}`);
    t.assert.equal(
      ranks.some((l) => l.includes("pkg:")),
      false,
      "packages are filtered out of the skeleton",
    );
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class RankAndSliceAreOrderedByRelevance extends GraphQueryTest {
  readonly id = "rank-sorts-by-descending-score-and-slice-puts-its-seed-first-with-the-edges-among-it";
  readonly whyItExists =
    "slice returned the selected files without the edges among them, so the agent got a bag of paths and still had to open each one to learn which imported which";

  override async run(t: TestRun): Promise<void> {
    const dir = this.workspace(CHAIN);

    const ranked = await this.query(dir, { op: "rank" });
    const rankLines = ranked.split("\n");
    t.assert.equal(rankLines[0], "top 20 pagerank:", `header; got ${JSON.stringify(ranked)}`);
    const scores = rankLines.slice(1).map((l) => Number(l.trim().split(/\s+/)[0]));
    t.assert.equal(scores.length, 4, "one line per node");
    t.assert.equal(
      scores.every((s, i) => i === 0 || s <= scores[i - 1]!),
      true,
      `descending score; got ${JSON.stringify(scores)}`,
    );

    // The schema caps the budget at 60000 — 100000 is refused before execute
    // is ever reached, which is the real contract and is asserted as such.
    const tooBig = graphQueryTool.inputSchema.safeParse({ op: "slice", query: "a", budget_tokens: 100000 });
    t.assert.equal(tooBig.success, false, "budget_tokens is capped by the tool's own schema");
    t.assert.ok(
      tooBig.success === false && tooBig.error.issues.some((i) => i.message.includes("60000")),
      "and the cap is 60000",
    );

    const sliced = await this.query(dir, { op: "slice", query: "a", budget_tokens: 60000 });
    const sliceLines = sliced.split("\n");
    t.assert.equal(sliceLines[0], "slice of 4 files (budget 60000 tokens):");
    t.assert.ok(sliceLines[2]?.endsWith("  a.ts"), `the seed is first; got ${JSON.stringify(sliceLines[2])}`);
    t.assert.ok(sliced.includes("\nedges among selected:"), "the edges section exists");
    t.assert.ok(sliced.includes("\n  a.ts -> b.ts"), "and it names the edge between two selected files");
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

class MissingSeedsAreRefusedAndLongAnswersAreCapped extends GraphQueryTest {
  readonly id = "a-seedless-query-is-an-error-and-a-long-answer-is-truncated-at-200-lines";
  readonly whyItExists =
    "a blast on a path the graph did not hold answered 'change amplification: 0 modules', which reads as 'nothing depends on this' rather than 'I could not find that file'";

  override readonly timeoutMs = 60_000;

  override async run(t: TestRun): Promise<void> {
    const dir = this.workspace(CHAIN);

    const missing = await runTool(graphQueryTool, { op: "blast", files: ["missing.ts"] }, this.ctx(dir));
    t.assert.equal(missing.isError, true, "a seed the graph does not hold is an error, not an empty answer");
    t.assert.equal(resultText(missing), "blast needs one or more existing files. Ops: slice, blast, deps, structure, rank.");

    const seedless = await runTool(graphQueryTool, { op: "slice" }, this.ctx(dir));
    t.assert.equal(seedless.isError, true, "slice with neither files nor query is an error");
    t.assert.equal(resultText(seedless), "slice needs seeds — pass files and/or a query. Ops: slice, blast, deps, structure, rank.");

    // 300 modules on one hub: the blast answer is 303 lines before the cap.
    const many: Record<string, string> = { "hub.ts": "export const hub = 1;\n" };
    for (let i = 0; i < 300; i++) many[`m${i}.ts`] = `import { hub } from "./hub.js";\nexport const m${i} = hub;\n`;
    const bigDir = this.workspace(many);

    const blast = await this.query(bigDir, { op: "blast", files: ["hub.ts"] });
    const lines = blast.split("\n");
    t.assert.equal(lines.length, 201, "200 lines plus the truncation note");
    t.assert.ok(lines[200]?.startsWith("[truncated — "), `the note is last; got ${JSON.stringify(lines[200])}`);
    t.assert.equal(lines[200], "[truncated — 103 more lines; narrow the query]", "and it says exactly how many were dropped");
  }
}

registerFeatureTests(
  new BlastGroupsImportersByHopDistance(),
  new DepsSeparatesExternalPackages(),
  new StructureIsTheRepoSkeleton(),
  new RankAndSliceAreOrderedByRelevance(),
  new MissingSeedsAreRefusedAndLongAnswersAreCapped(),
);
