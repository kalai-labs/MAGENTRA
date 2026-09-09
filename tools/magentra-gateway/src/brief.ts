/**
 * The agent briefing — SPEC §8.
 *
 * One document per feature: prose, kinds, invariant, entry files, resolved
 * dependencies (§6), existing tests with their `whyItExists`, and every
 * `pending` description targeting it.
 *
 * This is the payload that makes ability 4 real — an agent asked to write tests
 * is TOLD what else to check instead of guessing. Keep it stable: other tools
 * consume it.
 *
 * It is deliberately renderable two ways from one source. `buildBrief` is the
 * JSON `GET /api/features/:id/brief` returns; `renderBrief` is the Markdown a
 * human or an agent reads, so the CLI and the HTTP surface can never drift into
 * describing a feature differently.
 */

import { resolveDependencies, type DependencyReport } from "./deps.js";
import type { DescriptionRecord, Feature } from "./schema.js";

export interface Brief {
  readonly feature: {
    readonly id: string;
    readonly name: string;
    readonly area: string;
    readonly section: string;
    readonly prose: string;
    readonly invariant: string;
    readonly kinds: readonly string[];
    readonly entryFiles: readonly string[];
    readonly status: string;
    readonly deferred: boolean;
  };
  readonly freshness: { readonly hash: string; readonly recordedAt: string };
  readonly dependencies: DependencyReport;
  readonly tests: readonly { readonly id: string; readonly whyItExists: string | null }[];
  readonly descriptions: readonly DescriptionRecord[];
  readonly generatedAt: string;
}

export async function buildBrief(
  root: string,
  feature: Feature,
  all: readonly Feature[],
  descriptions: readonly DescriptionRecord[],
): Promise<Brief> {
  return {
    feature: {
      id: feature.id,
      name: feature.name,
      area: feature.area,
      section: feature.section,
      prose: feature.prose,
      invariant: feature.invariant,
      kinds: feature.kinds,
      entryFiles: feature.entryFiles,
      status: feature.status,
      deferred: feature.deferred === true,
    },
    freshness: { hash: feature.freshness.hash, recordedAt: feature.freshness.recordedAt },
    dependencies: await resolveDependencies(root, feature, all),
    // `whyItExists` lives in the test file, as the class the test extends
    // declares it (decisions/0004). Until tests/lib/ exists (SPEC §11 step 6)
    // there is nothing to read it from, so it is null rather than invented —
    // a brief that made one up would be the scaffold this effort removed.
    tests: feature.tests.map((id) => ({ id, whyItExists: null })),
    // Pending only: a description already marked done is history, and history
    // in a brief reads as an instruction.
    descriptions: descriptions.filter((d) => d.featureIds.includes(feature.id) && d.status === "pending"),
    generatedAt: new Date().toISOString(),
  };
}

function bullet(items: readonly string[], limit = 40): string {
  if (items.length === 0) return "  (none)\n";
  const shown = items.slice(0, limit).map((i) => `  - ${i}`);
  if (items.length > limit) shown.push(`  - … ${items.length - limit} more`);
  return shown.join("\n") + "\n";
}

/** The same brief as Markdown — what `npm run gateway -- brief <id>` prints. */
export function renderBrief(brief: Brief): string {
  const f = brief.feature;
  const out: string[] = [];

  out.push(`# ${f.name}`);
  out.push("");
  out.push(`- **id** \`${f.id}\`  ·  **area** ${f.area}  ·  **section** ${f.section}`);
  out.push(`- **kinds** ${f.kinds.join(", ")}  ·  **status** ${f.status}${f.deferred ? "  ·  **deferred**" : ""}`);
  out.push(`- **recorded** ${brief.freshness.recordedAt} (\`${brief.freshness.hash}\`)`);
  out.push("");
  out.push("## What it is");
  out.push("");
  out.push(f.prose);
  out.push("");
  out.push("## The invariant a test must prove");
  out.push("");
  out.push(`> ${f.invariant}`);
  out.push("");
  out.push("## Entry files");
  out.push("");
  out.push(bullet(f.entryFiles));

  out.push("## What else this touches");
  out.push("");
  const deps = brief.dependencies;
  if (!deps.available) {
    out.push(`**Unresolved.** ${deps.reason}`);
    out.push("");
  } else {
    const s = deps.summary;
    out.push(
      `${s.directImporters} direct importer(s), ${s.transitiveImporters} transitive, ` +
        `${s.untypedAppReach} untyped \`app/\` file(s) downstream, ${s.frameSeams} frame seam(s).`,
    );
    out.push("");
    if (s.crossesUntypedSeam) {
      out.push(
        "> **This crosses into `app/`, which nothing typechecks.** `npm run build` passing " +
          "proves nothing here. Read the handler by hand and change both sides in one edit.",
      );
      out.push("");
    }
    for (const [file, d] of Object.entries(deps.files)) {
      out.push(`### \`${file}\``);
      out.push("");
      out.push(`- risk: ${d.risk}`);
      if (d.exports.length) out.push(`- exports: ${d.exports.map((e) => `\`${e}\``).join(", ")}`);
      out.push(`- imported by ${d.directImporters.length} directly, ${d.transitiveImporters.length} transitively`);
      if (d.directImporters.length) {
        out.push("");
        out.push("importers:");
        out.push(bullet(d.directImporters, 15));
      }
      if (d.untypedAppReach.length) {
        out.push("");
        out.push("**untyped `app/` files that reach this:**");
        out.push(bullet(d.untypedAppReach, 15));
      }
      if (d.untypedSeam.length) {
        out.push("");
        out.push("**exports named in `app/` by string — a rename will NOT fail the build:**");
        out.push(bullet(d.untypedSeam.map((x) => `\`${x.name}\` → ${x.files.join(", ")}`)));
      }
      if (d.frames.length) {
        out.push("");
        out.push("**protocol frame strings crossed:**");
        out.push(
          bullet(
            d.frames.map(
              (x) =>
                `\`${x.type}\` — emitted in ${x.emitted.length} place(s), handled in ${x.handled.length}` +
                `${x.crossesIntoApp ? " **(one side is in `app/`)**" : ""}`,
            ),
          ),
        );
      }
      out.push("");
    }
    if (deps.mirroredConstants.length) {
      out.push("### Mirrored constants this sits on");
      out.push("");
      out.push("Literal pairs `tsc` cannot compare. Change one side and change the other:");
      out.push("");
      for (const m of deps.mirroredConstants) {
        out.push(`- **${m.name}** (\`${m.id}\`) — ${m.invariant}`);
      }
      out.push("");
    }
    if (deps.unindexed.length) {
      out.push(`_Not in the scanned graph: ${deps.unindexed.join(", ")}_`);
      out.push("");
    }
  }

  out.push("## Tests that exist");
  out.push("");
  if (brief.tests.length === 0) {
    out.push("**None.** This feature is unproven: nothing in the repository asserts the invariant above.");
  } else {
    for (const t of brief.tests) {
      out.push(`- \`${t.id}\` — ${t.whyItExists ?? "_whyItExists not yet readable (SPEC §11 step 6)_"}`);
    }
  }
  out.push("");

  out.push("## What you have been asked to write");
  out.push("");
  if (brief.descriptions.length === 0) {
    out.push("_No pending description targets this feature._");
  } else {
    for (const d of brief.descriptions) {
      out.push(`### Description \`${d.id}\` (updated ${d.updatedAt})`);
      out.push("");
      out.push(d.body);
      out.push("");
    }
  }
  out.push("");
  out.push("---");
  out.push("");
  out.push(
    `Every test must declare \`featureId: "${f.id}"\`, this invariant, and a \`whyItExists\` naming ` +
      "the failure it would have caught. No skip, no soft assert, no expected-failure state " +
      "(decisions/0004).",
  );
  out.push("");
  return out.join("\n");
}
