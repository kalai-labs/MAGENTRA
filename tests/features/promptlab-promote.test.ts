/**
 * `promptlab-promote`.
 *
 * Promote turns a local override into the shipped default: it finds the
 * prompt's default text as a string literal in the engine's TypeScript
 * sources, replaces it in that file's own line endings, runs the TypeScript
 * build, and puts the original bytes back if the build fails. On success the
 * in-memory default is updated and the now-redundant override file is deleted.
 *
 * `proc`, and the record said `fs`. Re-declared 2026-09-20.
 * `tools/prompt-lab/server.mjs` EXPORTS NOTHING and starts listening on
 * import, so `promote`, `locateLiteral`, `toSourceLiteral`, `withEol` and
 * `tscBuild` cannot be called from a test at all — and adding an export, or
 * stubbing `tscBuild`, would be changing the product to make a test possible
 * and substituting a double that is not the model. Both are out. So every
 * clause below is proven through the REAL SERVER PROCESS, over its HTTP API,
 * against a REAL `tsc`: the kind is what proving it requires, which is a
 * spawned process this test owns.
 *
 * THE SANDBOX. `promote` writes into `REPO/engine/**.ts` where `REPO` is
 * `dirname(server.mjs)/../..`, and then runs `tsc -b` there — pointed at this
 * repository it would edit MAGENTRA's own sources and build the whole thing.
 * So each test copies `server.mjs` byte for byte (`copyFileSync`, never
 * edited) into a temp repository of its own:
 *
 *   tmp/tools/prompt-lab/server.mjs   the real file, unchanged
 *   tmp/node_modules                  a JUNCTION to this repo's node_modules,
 *                                     through which the copy resolves
 *                                     @magentra/core|tools|protocol to the
 *                                     built dist, and typescript/bin/tsc
 *   tmp/tsconfig.json                 a project over tmp/engine and nothing else
 *   tmp/engine/*.ts                   hand-written files holding REAL prompt
 *                                     defaults as source literals
 *
 * The registry inside that server is the real one with all 73 prompts, so the
 * defaults it searches for are the shipped defaults; what changes is only
 * WHICH sources it can find them in. `tsc -b` there compiles five small files
 * in about a second. `rmSync` does not follow the junction (verified on this
 * machine before these tests were written), and the child is killed in
 * `tearDown` before the directory goes, because Windows will not remove a
 * directory a live process holds.
 *
 * WHAT IS NOT OBSERVABLE FROM OUTSIDE, and is therefore stated rather than
 * asserted:
 *   - checklist 1's `quote "'"` — `locateLiteral`'s chosen quote style is
 *     internal. What the API shows is that the single-quoted form, with the
 *     apostrophe written `\'`, was FOUND at all, in the file holding it.
 *   - checklist 2's `eol '\r\n'` — likewise internal. Its observable
 *     consequence is the whole point of recording it, and that IS asserted:
 *     the CRLF file is still CRLF everywhere afterwards and the only bytes
 *     that moved are the ones inside the literal.
 *   - checklist 4's "with tscBuild stubbed to reject" — no stub. A source file
 *     that genuinely does not typecheck is planted in the sandbox, and the
 *     revert is the real compiler's real failure being handled.
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { ProcTest, type ProcHandle } from "../lib/procTest.ts";
import { repoRoot } from "../lib/inventory.ts";

const FEATURE = "promptlab-promote";

/** Verbatim from the record. */
const INVARIANT = "promote locates the prompt's TypeScript source literal, replaces it, typechecks, and restores the file if the typecheck fails.";

/**
 * Real shipped defaults, copied here as the literals the sandbox sources will
 * hold. They are asserted against the running server's own catalog before
 * anything depends on them, so a prompt reworded in the engine fails loudly as
 * a stale fixture instead of silently making a search vacuous.
 *
 * None of them contains a backslash, a backtick or `${`, so their backtick
 * source form is the text itself — which is why the expectations below are
 * written out rather than run through a copy of the server's escaper. The one
 * exception is ROLE, planted single-quoted precisely BECAUSE of its
 * apostrophe, which a `'` literal has to write as `\'`.
 */
const ROLE_ID = "session.auto-name.role";
const ROLE = "You name chat sessions for a coding assistant's sidebar.";

const ENV_ID = "system.environment";
const ENV_TEXT =
  "Environment:\n- Working directory: {{cwd}}\n- Git repository: {{isGitRepo}}\n- Platform: {{platform}}\n- Model: {{model}}\n- Today's date: {{date}}";

/**
 * Planted with a tail, so the prompt's own text is only a PREFIX of the literal
 * in source.
 *
 * Single-quoted with its apostrophe escaped, deliberately: that is the one
 * plant only ONE of the three quote candidates can match, so with the
 * closing-quote check removed this prompt has exactly one hit and would be
 * promoted over — which is what makes the refusal below a finding rather than
 * an accident of the search being ambiguous anyway.
 */
const PREFIX_ID = "tool.Addon";
const PREFIX_TEXT =
  'Loads an addon\'s instructions into the conversation and follows them for the current task. Copy the addon name exactly as it appears in the "Available addons" list. Optional args are substituted into the addon or appended as ARGUMENTS.';

/** Planted twice, in two files, so there is no safe place to edit. */
const AMBIGUOUS_ID = "tool.CronList";
const AMBIGUOUS_TEXT = "Lists all scheduled cron jobs and wakeups for this session.";

const DOLLAR_ID = "tool.TaskGet";
const DOLLAR_TEXT =
  "Retrieves one task with its full description, status, owner, and dependency lists (blocks / blockedBy). Check that blockedBy is empty before starting the task.";

/** A source file that genuinely does not typecheck. No stub — this is what makes tsc fail. */
const BROKEN_SOURCE = 'export const n: number = "x";\n';

const CRLF = (text: string): string => text.replace(/\n/g, "\r\n");

/** Ask the OS for a port and give it straight back: `--port 0` would make the banner print `0`. */
async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => {
        if (port === 0) reject(new Error("the OS gave out no port"));
        else resolve(port);
      });
    });
  });
}

interface Answer {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

interface Located {
  readonly ok?: boolean;
  readonly file?: string;
  readonly reason?: string;
}

interface CatalogPrompt {
  readonly id?: string;
  readonly defaultText?: string;
  readonly currentText?: string;
  readonly overridden?: boolean;
}

abstract class PromoteTest extends ProcTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  /** A boot compiles the sandbox with the real tsc, and each promote runs it again. */
  override readonly timeoutMs: number = 180_000;

  #tmp: string | undefined;
  #port = 0;

  protected engineDir = "";
  protected overrides = "";

  /**
   * Build the sandbox repository and start the real server in it.
   *
   * @param extraSources - files added to `tmp/engine` beyond the five below.
   */
  protected async startLab(extraSources: Readonly<Record<string, string>> = {}): Promise<ProcHandle> {
    const tmp = mkdtempSync(join(tmpdir(), "magentra-promote-"));
    this.#tmp = tmp;

    mkdirSync(join(tmp, "tools", "prompt-lab"), { recursive: true });
    const from = join(repoRoot(), "tools", "prompt-lab");
    copyFileSync(join(from, "server.mjs"), join(tmp, "tools", "prompt-lab", "server.mjs"));
    copyFileSync(join(from, "index.html"), join(tmp, "tools", "prompt-lab", "index.html"));
    symlinkSync(join(repoRoot(), "node_modules"), join(tmp, "node_modules"), "junction");

    writeFileSync(
      join(tmp, "tsconfig.json"),
      `${JSON.stringify(
        {
          compilerOptions: { target: "es2022", module: "nodenext", moduleResolution: "nodenext", strict: true, rootDir: "engine", outDir: "out", types: [] },
          include: ["engine"],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    this.engineDir = join(tmp, "engine");
    mkdirSync(this.engineDir, { recursive: true });
    const sources: Record<string, string> = {
      // Single-quoted, with the apostrophe escaped the way a `'` literal must.
      "a.ts": `export const ROLE = '${ROLE.split("'").join("\\'")}';\n`,
      // CRLF throughout, holding a multi-line template literal.
      "b.ts": CRLF(`export const ENVIRONMENT = \`${ENV_TEXT}\`;\n`),
      // The prompt's text is only a prefix of what is actually in source here.
      "c.ts": `export const ADDON = '${`${PREFIX_TEXT}-tail`.split("'").join("\\'")}';\n`,
      "d.ts": `export const CRON_LIST = \`${AMBIGUOUS_TEXT}\`;\n`,
      "e.ts": `export const CRON_LIST_AGAIN = \`${AMBIGUOUS_TEXT}\`;\n`,
      "f.ts": `export const TASK_GET = \`${DOLLAR_TEXT}\`;\n`,
      ...extraSources,
    };
    for (const [name, body] of Object.entries(sources)) writeFileSync(join(this.engineDir, name), body, "utf8");

    this.overrides = join(tmp, "overrides");
    mkdirSync(this.overrides, { recursive: true });
    const home = join(tmp, "home");
    mkdirSync(home, { recursive: true });

    this.#port = await freePort();
    const child = this.spawn(
      process.execPath,
      [join(tmp, "tools", "prompt-lab", "server.mjs"), "--dir", this.overrides, "--port", String(this.#port)],
      {
        cwd: tmp,
        label: `prompt-lab on 127.0.0.1:${this.#port}`,
        env: { HOME: home, USERPROFILE: home, MAGENTRA_PROMPTS_DIR: undefined },
      },
    );
    // The startup `tsc -b` runs before the banner, so this wait covers it.
    await child.nextLine((line) => line.includes(`http://127.0.0.1:${this.#port}`), 120_000);
    return child;
  }

  protected async call(method: string, path: string, body?: string): Promise<Answer> {
    return await new Promise<Answer>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: this.#port, path, method }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) as Record<string, unknown> });
        });
      });
      req.on("error", reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  }

  /** `source[id]` out of GET /api/catalog — the observable form of `locateLiteral`. */
  protected async located(id: string): Promise<Located> {
    const catalog = await this.call("GET", "/api/catalog");
    const source = (catalog.body["source"] ?? {}) as Record<string, Located>;
    return source[id] ?? {};
  }

  protected async prompts(): Promise<CatalogPrompt[]> {
    const catalog = await this.call("GET", "/api/catalog");
    return (catalog.body["prompts"] ?? []) as CatalogPrompt[];
  }

  /**
   * The running server's own default for `id`, so a fixture written against a
   * prompt the engine has since reworded fails as a stale fixture rather than
   * as a search that could never have hit.
   */
  protected async assertFixtureMatchesShippedDefault(t: TestRun, id: string, text: string): Promise<void> {
    const entry = (await this.prompts()).find((p) => p.id === id);
    t.assert.equal(entry?.defaultText, text, `the fixture's copy of ${id} is not the shipped default any more — update the constant in this test`);
  }

  /** Every engine source, by name, as bytes. */
  protected snapshot(): Map<string, Buffer> {
    const out = new Map<string, Buffer>();
    for (const name of readdirSync(this.engineDir)) out.set(name, readFileSync(join(this.engineDir, name)));
    return out;
  }

  protected assertUnchanged(t: TestRun, before: Map<string, Buffer>, why: string): void {
    const now = this.snapshot();
    t.assert.deepEqual([...now.keys()].sort(), [...before.keys()].sort(), `${why}: the set of source files changed`);
    for (const [name, bytes] of before) {
      t.assert.equal(now.get(name)?.equals(bytes), true, `${why}: ${name} was modified`);
    }
  }

  /** Children die here so Windows will let the directory go; the kind still guarantees no orphan. */
  override async tearDown(): Promise<void> {
    for (const child of this.children) {
      if (!child.hasExited()) {
        child.kill();
        await child.exited();
      }
    }
    const tmp = this.#tmp;
    this.#tmp = undefined;
    if (tmp !== undefined) rmSync(tmp, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
  }
}

/* ---- checklist 1 ------------------------------------------------------- */

class ASingleQuotedLiteralWithAnApostropheIsFound extends PromoteTest {
  readonly id = "a-single-quoted-default-with-an-escaped-apostrophe-is-located";
  readonly whyItExists =
    "only the backtick form was searched for, so every single-quoted default containing an apostrophe missed — the text carries a real ' and the source carries \\', so the two never compared equal — and the lab told the operator the prompt was 'assembled from variables' and could not be promoted";

  override async run(t: TestRun): Promise<void> {
    await this.startLab();
    await this.assertFixtureMatchesShippedDefault(t, ROLE_ID, ROLE);

    const planted = readFileSync(join(this.engineDir, "a.ts"), "utf8");
    t.assert.ok(planted.includes("assistant\\'s"), "the fixture really is the single-quoted form with an escaped apostrophe");

    const found = await this.located(ROLE_ID);
    t.assert.equal(found.ok, true, `the default was not located: ${found.reason}`);
    t.assert.equal(found.file, join("engine", "a.ts"), "and it names the file the literal is in");
  }
}

/* ---- checklist 3 ------------------------------------------------------- */

class APrefixOfALongerLiteralIsNotAMatch extends PromoteTest {
  readonly id = "a-default-that-is-only-a-prefix-of-the-source-literal-is-refused";
  readonly whyItExists =
    "a bare indexOf also matched a PREFIX of a longer literal — which is exactly what source drifting ahead of the running lab looks like — and promoting over it left the tail of the old text dangling after the new";

  override async run(t: TestRun): Promise<void> {
    await this.startLab();
    await this.assertFixtureMatchesShippedDefault(t, PREFIX_ID, PREFIX_TEXT);

    // The control: this sandbox IS searchable, so "not found" below is a
    // finding about the prefix and not about an empty search.
    t.assert.equal((await this.located(ROLE_ID)).ok, true, "the search works in this sandbox");

    const planted = readFileSync(join(this.engineDir, "c.ts"), "utf8");
    t.assert.ok(planted.includes("as ARGUMENTS.-tail'"), "the source literal really does start with the default and carry on past where it ends");

    const found = await this.located(PREFIX_ID);
    t.assert.equal(found.ok, false, "a match that does not reach the closing quote is not a match");
    t.assert.match(String(found.reason), /no verbatim match/);

    const before = this.snapshot();
    const refused = await this.call("POST", `/api/promote/${PREFIX_ID}`, "a replacement that must never be written");
    t.assert.equal(refused.status, 409);
    t.assert.equal(refused.body["ok"], false);
    t.assert.match(String(refused.body["reason"]), /no verbatim match/);
    this.assertUnchanged(t, before, "a promote refused for no verbatim match");
    t.assert.equal(readFileSync(join(this.engineDir, "c.ts"), "utf8"), planted, "the longer literal was left exactly as it was");
  }
}

/* ---- checklist 5, the refusals ----------------------------------------- */

class EveryRefusedPromoteWritesNothing extends PromoteTest {
  readonly id = "empty-text-an-unknown-id-and-two-identical-literals-are-each-refused-without-a-write";
  readonly whyItExists =
    "a promote that could not be done safely still wrote first and asked later: blank text emptied a shipped default, an unknown id reported success over nothing, and two identical literals in source meant the edit landed in whichever file the walk reached first";

  override async run(t: TestRun): Promise<void> {
    await this.startLab();
    await this.assertFixtureMatchesShippedDefault(t, AMBIGUOUS_ID, AMBIGUOUS_TEXT);
    const before = this.snapshot();

    const ambiguous = await this.located(AMBIGUOUS_ID);
    t.assert.equal(ambiguous.ok, false);
    t.assert.match(String(ambiguous.reason), /identical literals in source — too ambiguous/);

    const twice = await this.call("POST", `/api/promote/${AMBIGUOUS_ID}`, "a replacement with nowhere safe to go");
    t.assert.equal(twice.status, 409);
    t.assert.equal(twice.body["ok"], false);
    t.assert.match(String(twice.body["reason"]), /identical literals in source — too ambiguous/);

    const blank = await this.call("POST", `/api/promote/${ROLE_ID}`, "   ");
    t.assert.equal(blank.status, 409);
    t.assert.equal(blank.body["ok"], false);
    t.assert.equal(blank.body["reason"], "refusing to promote empty text");

    const unknown = await this.call("POST", "/api/promote/no.such.id", "x");
    t.assert.equal(unknown.status, 409);
    t.assert.equal(unknown.body["ok"], false);
    t.assert.match(String(unknown.body["reason"]), /^unknown prompt id/);

    this.assertUnchanged(t, before, "three refused promotes");
  }
}

/* ---- checklist 2 and checklist 4's success path ------------------------ */

class ACrlfLiteralIsRewrittenInPlaceAndTheOverrideRetires extends PromoteTest {
  readonly id = "a-successful-promote-rewrites-the-crlf-literal-in-place-and-deletes-the-override";
  readonly whyItExists =
    "a multi-line default arrives from the TypeScript parser with LF while 68 of this repo's 71 engine sources are checked out CRLF, so splicing LF text in rewrote the whole file's endings on the next editor save and buried the prompt change in the diff — and the promoted override was left on disk, so the machine that promoted it kept reading its own local copy";

  override async run(t: TestRun): Promise<void> {
    await this.startLab();
    await this.assertFixtureMatchesShippedDefault(t, ENV_ID, ENV_TEXT);

    const file = join(this.engineDir, "b.ts");
    const before = readFileSync(file, "utf8");
    t.assert.equal(/[^\r]\n/.test(before), false, "the fixture file is CRLF throughout to begin with");

    // The state promote is FOR: a local override the operator wants shipped.
    const overrideFile = join(this.overrides, `${ENV_ID}.txt`);
    const NEW_TEXT = "Environment now:\n- Where: {{cwd}}\n- What: {{platform}}";
    const saved = await this.call("PUT", `/api/prompt/${ENV_ID}`, NEW_TEXT);
    t.assert.equal(saved.body["overridden"], true);
    t.assert.equal(existsSync(overrideFile), true, "there is an override to retire");

    const promoted = await this.call("POST", `/api/promote/${ENV_ID}`, NEW_TEXT);
    t.assert.equal(promoted.status, 200, JSON.stringify(promoted.body));
    t.assert.equal(promoted.body["ok"], true);
    t.assert.equal(promoted.body["file"], join("engine", "b.ts"), "it reports the file it edited, repo-relative");

    // The file's own line endings survive, and the ONLY bytes that moved are
    // the ones inside the literal — the expectation is built here rather than
    // read back from the server.
    const oldLiteral = CRLF(ENV_TEXT);
    const newLiteral = CRLF(NEW_TEXT);
    const at = before.indexOf(oldLiteral);
    t.assert.notEqual(at, -1, "the fixture holds the old literal");
    const after = readFileSync(file, "utf8");
    t.assert.equal(after, before.slice(0, at) + newLiteral + before.slice(at + oldLiteral.length), "the splice is the literal and nothing else");
    t.assert.equal(/[^\r]\n/.test(after), false, "every newline in the file is still CRLF — not one lone LF was introduced");

    // The override is now redundant, and the in-memory default is the new text.
    t.assert.equal(existsSync(overrideFile), false, "the promoted override file was deleted");
    const entry = (await this.prompts()).find((p) => p.id === ENV_ID);
    t.assert.equal(entry?.defaultText, NEW_TEXT, "the lab now serves the promoted text as the shipped default");
    t.assert.equal(entry?.overridden, false, "with no override in front of it");
    t.assert.equal(entry?.currentText, NEW_TEXT);
  }
}

/* ---- checklist 5, the `$&` clause -------------------------------------- */

class DollarAmpersandIsInsertedLiterally extends PromoteTest {
  readonly id = "replacement-text-containing-dollar-ampersand-is-written-verbatim";
  readonly whyItExists =
    "String.replace expands $&, $' and $` inside a STRING replacement, so promoting prose that happened to contain one of them spliced the matched default back into the file instead of the new text — prompt text is prose and can contain any of them";

  override async run(t: TestRun): Promise<void> {
    await this.startLab();
    await this.assertFixtureMatchesShippedDefault(t, DOLLAR_ID, DOLLAR_TEXT);

    const file = join(this.engineDir, "f.ts");
    const before = readFileSync(file, "utf8");
    const NEW_TEXT = "Keep $& and $' exactly as written, every one of them.";

    const promoted = await this.call("POST", `/api/promote/${DOLLAR_ID}`, NEW_TEXT);
    t.assert.equal(promoted.status, 200, JSON.stringify(promoted.body));
    t.assert.equal(promoted.body["file"], join("engine", "f.ts"));

    const after = readFileSync(file, "utf8");
    // A string replacement would have expanded $& into the whole old default
    // and $' into everything after it; this is the exact file a FUNCTION
    // replacement produces.
    t.assert.equal(after, before.replace(DOLLAR_TEXT, () => NEW_TEXT), "the dollar sequences went in verbatim");
    t.assert.ok(after.includes("Keep $& and $' exactly as written"), after);
    t.assert.equal(after.includes(DOLLAR_TEXT), false, "no part of the old default was spliced back in by an expansion");

    const entry = (await this.prompts()).find((p) => p.id === DOLLAR_ID);
    t.assert.equal(entry?.defaultText, NEW_TEXT, "and the in-memory default is the text as typed");
  }
}

/* ---- checklist 4's failure path ---------------------------------------- */

class AFailingTypecheckRestoresTheFile extends PromoteTest {
  readonly id = "a-failing-typecheck-restores-the-source-file-byte-for-byte";
  readonly whyItExists =
    "a prompt edit left the repository uncompilable: the literal was written, the build failed, and the half-edited file stayed on disk — and because the compiler could not even be spawned the operator was told 'typecheck failed' with an empty body and no cause";

  override async run(t: TestRun): Promise<void> {
    // The real compiler really fails here: broken.ts does not typecheck. No
    // stub stands in for tscBuild.
    await this.startLab({ "broken.ts": BROKEN_SOURCE });
    await this.assertFixtureMatchesShippedDefault(t, ENV_ID, ENV_TEXT);

    const file = join(this.engineDir, "b.ts");
    const before = readFileSync(file);
    const overrideFile = join(this.overrides, `${ENV_ID}.txt`);
    const NEW_TEXT = "Environment now:\n- Where: {{cwd}}";

    await this.call("PUT", `/api/prompt/${ENV_ID}`, NEW_TEXT);
    t.assert.equal(existsSync(overrideFile), true);

    const snapshot = this.snapshot();
    const refused = await this.call("POST", `/api/promote/${ENV_ID}`, NEW_TEXT);
    t.assert.equal(refused.status, 409);
    t.assert.equal(refused.body["ok"], false);
    t.assert.equal(refused.body["reverted"], true, "the answer says the file was put back");
    t.assert.match(String(refused.body["reason"]), /^typecheck failed/);
    t.assert.match(String(refused.body["reason"]), /error TS2322/, "and carries the compiler's own cause, never an empty body");

    t.assert.equal(readFileSync(file).equals(before), true, "b.ts is byte-for-byte what it was before the promote");
    this.assertUnchanged(t, snapshot, "a promote whose typecheck failed");

    const entry = (await this.prompts()).find((p) => p.id === ENV_ID);
    t.assert.equal(entry?.defaultText, ENV_TEXT, "the in-memory default was not updated either");
    t.assert.equal(existsSync(overrideFile), true, "and the override was kept — it is still the only place the edit exists");
  }
}

registerFeatureTests(
  new ASingleQuotedLiteralWithAnApostropheIsFound(),
  new APrefixOfALongerLiteralIsNotAMatch(),
  new EveryRefusedPromoteWritesNothing(),
  new ACrlfLiteralIsRewrittenInPlaceAndTheOverrideRetires(),
  new DollarAmpersandIsInsertedLiterally(),
  new AFailingTypecheckRestoresTheFile(),
);
