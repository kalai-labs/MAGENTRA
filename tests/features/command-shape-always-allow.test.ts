/**
 * `command-shape-always-allow`.
 *
 * "Always allow" on a command remembers the command's SHAPE, not its text.
 * `deriveAlwaysGrant` keeps one token for an ordinary program (`mkdir -p a/b`
 * → `mkdir`), two for a CLI whose first argument is a subcommand (`git push
 * origin main` → `git push`), and three for a script runner (`npm run build
 * --silent` → `npm run build`); anything compound, substituted, quoted or
 * flag-headed has no shape and the grant stays literal. The prompt payload
 * carries the derived `grant` so the scope is never a surprise, and a shape
 * grant is stored with `prefix: true` — which `matchesExact(…, literalOnly)`
 * deliberately ignores, so no benign approval can widen into a destructive
 * variant past the deletion guard.
 *
 * `pure`, as the record declares. Verified 2026-09-20 against the code, with
 * two things the checklist could not know:
 *
 *   - PACKAGE SURFACE. `MULTI_COMMAND_CLIS` is module-private; the roster is
 *     proved through `deriveAlwaysGrant`'s own answers instead.
 *   - THE ASK BRANCH IS NOT REACHABLE WITH A SHIPPED TOOL. `stanceDefault()`
 *     returns "allow" for every class, so the only route to `"ask"` inside
 *     `check()` is the out-of-workspace downgrade — which requires
 *     `tool.isFileEdit` — while the shape is computed only when
 *     `tool.permissionClass === "execute"`. Write and Edit are the only
 *     `isFileEdit` tools and both are `mutate`, so no tool in the registry is
 *     both. Items 3 and 4 therefore hand `check()` the real Bash definition
 *     with `isFileEdit` set, which is the one input combination that reaches
 *     the branch. Reported as spec≠code rather than papered over.
 */

import { PermissionEngine, deriveAlwaysGrant, type AnyToolDefinition, type ApprovalSource, type ExactGrant, type PermissionRequestPayload } from "@magentra/core";
import type { PermissionDecision } from "@magentra/protocol";
import { bashTool } from "@magentra/tools";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { PureTest } from "../lib/pureTest.ts";

const FEATURE = "command-shape-always-allow";

/** Verbatim from the record. */
const INVARIANT =
  "An always-allow on an execute call remembers the command SHAPE, keeping two tokens for multi-command CLIs and three for script runners.";

/**
 * The real Bash tool — permission class, subject and deletion classifiers
 * included — with the one field that makes `check()`'s "ask" branch reachable
 * at all. See the header: no shipped tool is both execute-class and a file
 * edit, so this combination is what the checklist's "out-of-workspace-forced
 * ask for an execute tool" has to mean today.
 */
const EXECUTE_FILE_EDIT: AnyToolDefinition = { ...bashTool, isFileEdit: true };

interface Ask {
  readonly payload: PermissionRequestPayload;
  readonly source: ApprovalSource;
}

interface Probe {
  readonly engine: PermissionEngine;
  readonly asks: Ask[];
  /** Every `persistExact` call — what "always allow" asked the settings layer to keep. */
  readonly grants: { tool: string; subject: string; prefix: boolean | undefined }[];
}

function probe(opts: { allow?: string[]; allowExact?: ExactGrant[]; answer?: PermissionDecision } = {}): Probe {
  const asks: Ask[] = [];
  const grants: Probe["grants"] = [];
  const engine = new PermissionEngine(
    { allow: opts.allow ?? [], deny: [], allowExact: opts.allowExact ?? [] },
    async (payload, source) => {
      asks.push({ payload, source });
      return { decision: opts.answer ?? "allow_once" };
    },
    (tool, subject, prefix) => grants.push({ tool, subject, prefix }),
  );
  return { engine, asks, grants };
}

function bashInput(command: string): { command: string; description: string; run_in_background: boolean } {
  return { command, description: `run ${command}`, run_in_background: false };
}

abstract class ShapeTest extends PureTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
}

/* ---- checklist 1 ----------------------------------------------------- */

class TheShapeKeepsOneTwoOrThreeTokens extends ShapeTest {
  readonly id = "the-shape-keeps-one-token-two-for-a-multi-command-cli-and-three-for-a-script-runner";
  readonly whyItExists =
    "'always allow' on `mkdir -p a/b` remembered the exact string, so the next `mkdir -p a/c` asked again and the button read as broken — while the naive fix, keeping only the head token, turned one approved `git push` into a grant covering every git command there is";

  override run(t: TestRun): void {
    t.assert.equal(deriveAlwaysGrant("mkdir -p a/b"), "mkdir", "an ordinary program keeps its name and nothing else");
    t.assert.equal(deriveAlwaysGrant("mkdir"), "mkdir", "with no arguments the shape IS the subject");
    t.assert.equal(deriveAlwaysGrant("git push origin main"), "git push", "a multi-command CLI keeps its subcommand");
    t.assert.equal(deriveAlwaysGrant("docker ps -a"), "docker ps");
    t.assert.equal(deriveAlwaysGrant("npm run build --silent"), "npm run build", "a script runner keeps the script name too");
    t.assert.equal(deriveAlwaysGrant("yarn run test"), "yarn run test");
    t.assert.equal(deriveAlwaysGrant("pnpm run lint --fix"), "pnpm run lint");
    // `npm run` alone would grant every script in the package.
    t.assert.equal(deriveAlwaysGrant("npm run"), undefined, "a runner with no script named has no safe shape");
    // A CLI that is not in the multi-command roster keeps one token.
    t.assert.equal(deriveAlwaysGrant("mypy --strict src"), "mypy");
    t.assert.equal(deriveAlwaysGrant("./scripts/build.sh --release"), "./scripts/build.sh", "a path-spelled program is still one token");
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class ACompoundCommandHasNoShape extends ShapeTest {
  readonly id = "a-compound-substituted-quoted-or-flag-headed-command-has-no-shape";
  readonly whyItExists =
    "a shape derived from `rm \"my file\"` or `echo $(date)` would grant a prefix that matches text the user never read — one approval of `ls | grep x` must not license every command that happens to start with those four characters";

  override run(t: TestRun): void {
    for (const command of ["ls | grep x", "a && b", "a; b", "echo $(date)", 'rm "my file"', "echo `date`", "cat < in", "cat > out"]) {
      t.assert.equal(deriveAlwaysGrant(command), undefined, `${command} keeps the grant literal`);
    }
    t.assert.equal(deriveAlwaysGrant("git --version"), undefined, "a flag where the subcommand should be is not a shape");
    // Only the SUBCOMMAND token is inspected, so a flag further along does not
    // suppress the shape: `git push --force` still derives `git push`. That is
    // safe by construction rather than by luck — a forced push is a deletion
    // subject, the deletion guard is resolved before the "ask" branch that
    // derives shapes, and the grant it would leave behind is a prefix one,
    // which the guard refuses to accept (the last test in this file).
    t.assert.equal(deriveAlwaysGrant("git push --force"), "git push", "a flag after the subcommand is part of the arguments, not of the shape");
    t.assert.equal(deriveAlwaysGrant(""), undefined, "and an empty subject has nothing to derive from");
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class AnAlwaysAllowPersistsTheShape extends ShapeTest {
  readonly id = "an-always-allow-persists-the-shape-and-a-different-argument-list-stops-asking";
  readonly whyItExists =
    "the grant was persisted as the exact command, so 'always allow' on `mkdir -p a` re-asked on `mkdir -p b` — and the grant has to be written with prefix:true, or the reload after a restart narrows it back to the one command that was approved";

  override async run(t: TestRun): Promise<void> {
    const p = probe({ answer: "allow_always" });

    const first = await p.engine.check(EXECUTE_FILE_EDIT, bashInput("mkdir -p a"), "mkdir -p a", "make a", undefined, true, undefined);
    t.assert.equal(p.asks.length, 1, "the out-of-workspace downgrade is what forces the prompt");
    t.assert.equal(p.asks[0]?.source, "ask");
    t.assert.equal(first.allowed, true);
    t.assert.equal(first.source, "user");
    t.assert.deepEqual(p.grants, [{ tool: "Bash", subject: "mkdir", prefix: true }], "the SHAPE was persisted, as a prefix grant");

    const second = await p.engine.check(EXECUTE_FILE_EDIT, bashInput("mkdir -p b"), "mkdir -p b", "make b", undefined, true, undefined);
    t.assert.equal(p.asks.length, 1, "a different argument list does not ask again");
    t.assert.equal(second.allowed, true);
    t.assert.equal(second.source, "rule", "the in-memory grant answers it, above the stance");

    // The prefix is a token boundary, not a string prefix.
    const lookalike = await p.engine.check(EXECUTE_FILE_EDIT, bashInput("mkdirs -p c"), "mkdirs -p c", "another program", undefined, true, undefined);
    t.assert.equal(p.asks.length, 2, "a different program whose name merely starts with the grant still asks");
    t.assert.equal(lookalike.source, "user");
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class ThePayloadNamesTheGrantOnlyWhenItIsBroader extends ShapeTest {
  readonly id = "the-prompt-payload-names-the-grant-only-when-it-is-broader-than-the-subject";
  readonly whyItExists =
    "the card said 'Always allow' over the command the user was reading while the click actually granted `git push`, and there was nothing on screen that said so";

  override async run(t: TestRun): Promise<void> {
    const p = probe();

    await p.engine.check(EXECUTE_FILE_EDIT, bashInput("git push origin main"), "git push origin main", "push", undefined, true, undefined);
    t.assert.equal(p.asks[0]?.payload.subject, "git push origin main", "the subject is the command as typed");
    t.assert.equal(p.asks[0]?.payload.grant, "git push", "and the grant names the broader scope the click would record");

    await p.engine.check(EXECUTE_FILE_EDIT, bashInput("mkdir"), "mkdir", "make", undefined, true, undefined);
    t.assert.equal(p.asks[1]?.payload.subject, "mkdir");
    t.assert.equal("grant" in (p.asks[1]?.payload ?? {}), false, "a shape equal to the subject is not mentioned at all, so no card shows a redundant scope");

    await p.engine.check(EXECUTE_FILE_EDIT, bashInput("ls | grep x"), "ls | grep x", "list", undefined, true, undefined);
    t.assert.equal("grant" in (p.asks[2]?.payload ?? {}), false, "a command with no shape is granted literally, and says nothing about a scope");

    // A non-execute tool never derives a shape, whatever its subject looks like.
    const write = probe();
    await write.engine.check({ ...bashTool, permissionClass: "mutate", isFileEdit: true }, bashInput("git push origin main"), "git push origin main", "push", undefined, true, undefined);
    t.assert.equal("grant" in (write.asks[0]?.payload ?? {}), false, "the shape is an execute-class idea only");
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

class APrefixGrantNeverSatisfiesTheDeletionGuard extends ShapeTest {
  readonly id = "a-prefix-grant-never-satisfies-the-deletion-guard";
  readonly whyItExists =
    "one 'always allow' on a harmless `git push origin main` recorded `git push`, and the next turn's `git push --force` — a history rewrite — matched that prefix and ran with no prompt at all";

  override async run(t: TestRun): Promise<void> {
    const shape: ExactGrant = { tool: "Bash", subject: "git push", prefix: true };
    const force = "git push --force origin main";
    t.assert.notEqual(bashTool.deletionSubject?.(bashInput(force)), undefined, "the real classifier does flag a forced push as destructive");

    const p = probe({ allowExact: [shape] });
    const guarded = await p.engine.check(bashTool, bashInput(force), force, "force push", "unknown", false, undefined);
    t.assert.equal(p.asks.length, 1, "the destructive variant still asks");
    t.assert.equal(p.asks[0]?.source, "deletion-guard");
    t.assert.equal(guarded.source, "user");

    // The same grant does cover the benign command it was derived from.
    const benign = await p.engine.check(bashTool, bashInput("git push origin main"), "git push origin main", "push", "unknown", false, undefined);
    t.assert.equal(p.asks.length, 1, "no second prompt");
    t.assert.equal(benign.allowed, true);
    t.assert.equal(benign.source, "rule");

    // And the distinction really is `prefix`, not "exact grants never count":
    // a LITERAL grant for the destructive command does override the guard.
    const literal = probe({ allowExact: [{ tool: "Bash", subject: force }] });
    const deliberate = await literal.engine.check(bashTool, bashInput(force), force, "force push", "unknown", false, undefined);
    t.assert.deepEqual(literal.asks, [], "a literal grant for this exact command is the deliberate standing decision");
    t.assert.equal(deliberate.source, "rule");
  }
}

registerFeatureTests(
  new TheShapeKeepsOneTwoOrThreeTokens(),
  new ACompoundCommandHasNoShape(),
  new AnAlwaysAllowPersistsTheShape(),
  new ThePayloadNamesTheGrantOnlyWhenItIsBroader(),
  new APrefixGrantNeverSatisfiesTheDeletionGuard(),
);
