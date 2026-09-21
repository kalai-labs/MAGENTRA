/**
 * `tool-wire-contract-is-pinned`.
 *
 * `tool-registry-contract` proves 27 tools exist and that each has a name, a
 * description, a real zod schema, a permission class and an `execute`. It does
 * not prove what any schema SAYS. Rename a field, make a required field
 * optional, widen an enum, reword a description — the model's behaviour
 * changes and every existing assertion still holds.
 *
 * Hyrum's law applies to a model exactly as it applies to a caller: with
 * enough use, every observable detail of these schemas is something the
 * model's behaviour already depends on. So the observable detail is the thing
 * pinned, byte for byte, and a change to it arrives as a diff a person reads.
 *
 * `pure`: every item is the registry as a function of nothing, plus a file
 * read. Nothing here writes — see `system-prompt-is-pinned`'s item 5, which
 * asserts that over this file too.
 *
 * WHAT IS FROZEN is the description TEMPLATE, `{{slots}}` unfilled. The
 * resolved text is what the model receives, but resolving it here would drag a
 * runtime value into a committed file and make the artifact machine-specific.
 * The template is also what Prompt Lab edits, so it is what a person changes
 * on purpose.
 */

import { createDefaultRegistry } from "@magentra/tools";

import { firstDifference, readApproved, renderToolContract } from "../lib/approved.ts";
import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { PureTest } from "../lib/pureTest.ts";

const FEATURE = "tool-wire-contract-is-pinned";
const ARTIFACT = "tools.json";

/** Verbatim from the record. */
const INVARIANT =
  "Every registered tool's name, permission class, description template and JSON Schema is byte-identical to the approved artifact.";

interface FrozenTool {
  name: string;
  permissionClass: string;
  description: string;
  descriptionVars: string[];
  inputSchema: unknown;
}

function approvedTools(): FrozenTool[] {
  return JSON.parse(readApproved(FEATURE, ARTIFACT)) as FrozenTool[];
}

abstract class PinnedToolsTest extends PureTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
}

/* ---- checklist 1 ----------------------------------------------------- */

class TheContractIsByteIdenticalToTheArtifact extends PinnedToolsTest {
  readonly id = "the-rendered-contract-is-byte-identical-to-the-approved-artifact";
  readonly whyItExists =
    "a widened enum, a required field made optional or a reworded description changes what the model will call, and every assertion the registry already carries stays green through all three";

  override run(t: TestRun): void {
    const rendered = renderToolContract();
    const approved = readApproved(FEATURE, ARTIFACT);

    if (rendered !== approved) {
      // Name the tool before the line. A 900-line JSON document told apart by
      // line number alone says only that something moved.
      const a = JSON.parse(rendered) as FrozenTool[];
      const b = approvedTools();
      const names = [...new Set([...a.map((x) => x.name), ...b.map((x) => x.name)])].sort();
      for (const name of names) {
        const left = JSON.stringify(a.find((x) => x.name === name) ?? null, null, 2);
        const right = JSON.stringify(b.find((x) => x.name === name) ?? null, null, 2);
        t.assert.equal(
          left,
          right,
          `the wire contract for ${name} has changed.\n` +
            "If that was intended, regenerate with `npm run approve` and commit the diff —\n" +
            "that diff is the review this artifact exists for.",
        );
      }
    }

    const difference = firstDifference(rendered, approved);
    t.assert.equal(difference, undefined, difference ?? "the contract and the approved artifact agree");
    t.assert.equal(rendered, approved);
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class EveryRegisteredToolIsInTheArtifact extends PinnedToolsTest {
  readonly id = "every-tool-the-registry-returns-has-an-entry-and-the-counts-agree";
  readonly whyItExists =
    "a printer that silently skipped a tool would freeze a contract that omitted it, and the comparison would pass for as long as that tool was never added to the artifact — the count has to be checked against the registry, not against the file";

  override run(t: TestRun): void {
    const registered = createDefaultRegistry()
      .list()
      .map((tool) => tool.name)
      .sort();
    const frozen = approvedTools().map((tool) => tool.name);

    t.assert.deepEqual(
      frozen,
      registered,
      "the approved artifact and the registry disagree about which tools exist",
    );
    t.assert.equal(frozen.length, registered.length);
    t.assert.deepEqual([...frozen].sort(), frozen, "the artifact must be sorted by name, or its diffs are unreadable");
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class TemplatesAreFrozenUnresolved extends PinnedToolsTest {
  readonly id = "descriptions-are-frozen-as-templates-with-their-slots-unfilled";
  readonly whyItExists =
    "resolving a description puts a runtime value into a committed file, which makes the artifact machine-specific and turns every run on a different machine into a false red";

  override run(t: TestRun): void {
    const frozen = approvedTools();
    const registry = new Map(createDefaultRegistry().list().map((tool) => [tool.name, tool]));

    for (const tool of frozen) {
      const live = registry.get(tool.name);
      t.assert.ok(live, `${tool.name} is in the artifact but not in the registry`);
      if (!live) continue;

      t.assert.equal(
        tool.description,
        live.description.replace(/\r\n/g, "\n"),
        `${tool.name}'s frozen description is not the source template`,
      );
      t.assert.deepEqual(
        tool.descriptionVars,
        Object.keys(live.descriptionVars ?? {}).sort(),
        `${tool.name}'s frozen descriptionVars do not match the tool's own`,
      );

      // Every slot the template declares must still be a slot in the artifact.
      for (const slot of live.description.match(/\{\{\w+\}\}/g) ?? []) {
        t.assert.ok(
          tool.description.includes(slot),
          `${tool.name}'s frozen description has lost the slot ${slot}, so a runtime value was resolved into it`,
        );
      }
    }
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class SerialisationIsStable extends PinnedToolsTest {
  readonly id = "two-renders-and-two-registries-produce-identical-bytes";
  readonly whyItExists =
    "a document whose key or tool order follows a map's insertion order pins that order and not the contract, and it starts failing on an unrelated change to how the registry is built";

  override run(t: TestRun): void {
    t.assert.equal(renderToolContract(), renderToolContract(), "two renders in one process must agree");

    const first = createDefaultRegistry().list().map((tool) => tool.name);
    const second = createDefaultRegistry().list().map((tool) => tool.name);
    t.assert.deepEqual(second, first, "two registries built in one process must hold the same tools");
  }
}

registerFeatureTests(
  new TheContractIsByteIdenticalToTheArtifact(),
  new EveryRegisteredToolIsInTheArtifact(),
  new TemplatesAreFrozenUnresolved(),
  new SerialisationIsStable(),
);
