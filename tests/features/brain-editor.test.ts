/**
 * `brain-editor`.
 *
 * `npm run brain-editor` is the control center for brain/: a local page for
 * the owner and a command line for agents, both over one core
 * (tools/brain-editor/src/model.ts). A change is applied to a staged copy of
 * the brain, compiled there by tools/brain/compile.mjs and loaded by the built
 * engine (engine.ts, probe.mjs); it is written only when the brain still
 * compiles, the engine still loads it, every edited text compiles back to
 * exactly what was asked and the folder is still the revision it was planned
 * against. In the shipped brain/ a change that moves text a test holds is
 * refused until that test is acknowledged.
 *
 * Every write here goes to a COPY of brain/ in a temp folder. The shipped
 * brain is only ever read, and planned against (planning writes nothing; the
 * tests check that its revision does not move).
 *
 * `pure`: reading the shipped brain and checking the change vocabulary.
 * `fs`: plans and saves on a temp copy. Each plan also runs the engine probe as
 * a child process, which has finished before the call returns, so what the
 * test owns is the folder — the `fs` kind's promise (version-plan's reasoning).
 * `proc`: the real `npm run brain-editor` entry (tsx + cli.ts), as a server on
 * 127.0.0.1 and as the agents' command line.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";
import { repoRoot } from "../lib/inventory.ts";
import { ProcTest, type ProcHandle } from "../lib/procTest.ts";
import { PureTest } from "../lib/pureTest.ts";
import { compiler } from "../../tools/brain-editor/src/compiler.ts";
import { CHANGE_GUIDE } from "../../tools/brain-editor/src/guide.ts";
import { CHANGE_FIELDS, CHANGE_OPS, applyChanges, brainRevision, loadBrain, newProfile, parseChanges, planChanges } from "../../tools/brain-editor/src/model.ts";

const FEATURE = "brain-editor";

/** Verbatim from the record. */
const INVARIANT =
  "A change the brain editor saves, from its page or its command line, is compiled on a staged copy first and written only when the whole brain still compiles, every edited text compiles back to exactly what was asked, and the brain on disk is the one the change was planned against; otherwise nothing on disk changes.";

const BRAIN_DIR = join(repoRoot(), "brain");
const CLI = join(repoRoot(), "tools", "brain-editor", "src", "cli.ts");
const TSX = join(repoRoot(), "node_modules", "tsx", "dist", "cli.mjs");

type Bag = Record<string, unknown>;

/** Every file under `dir` with its bytes, so "nothing changed" is checked byte for byte. */
function filesOf(dir: string, sub = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const name of readdirSync(join(dir, sub), { withFileTypes: true })) {
    const rel = sub ? `${sub}/${name.name}` : name.name;
    if (name.isDirectory()) for (const [k, v] of filesOf(dir, rel)) out.set(k, v);
    else out.set(rel, readFileSync(join(dir, rel), "utf8"));
  }
  return out;
}

const getPath = (obj: unknown, path: string): unknown => path.split(".").reduce<unknown>((o, k) => (o !== null && typeof o === "object" ? (o as Bag)[k] : undefined), obj);

/* ---- pure: the shipped brain read, and the change vocabulary ---------------- */

abstract class EditorPureTest extends PureTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
}

class TheEditorReadsWhatTheCompilerReads extends EditorPureTest {
  readonly id = "the-editor-reads-every-prompt-tool-knob-and-tool-set-exactly-as-the-compiler-does";
  readonly whyItExists =
    "an editor with a reader of its own would show one text and save another the day its reader and the compiler disagreed, and the person editing would be changing a brain they never saw";

  override run(t: TestRun): void {
    const compiled = compiler.compileBrain(BRAIN_DIR, { complete: true });
    const snapshot = loadBrain(BRAIN_DIR);
    t.assert.deepEqual([...snapshot.problems], [], "the shipped brain reads with no problem, the editor's own cross-check included");
    t.assert.equal(snapshot.shipped, true);
    t.assert.deepEqual(
      snapshot.prompts.map((p) => p.id).sort(),
      (compiled.prompts ?? []).map((p) => p.id).sort(),
      "one editor prompt per compiled prompt",
    );
    for (const p of compiled.prompts ?? []) {
      const mine = snapshot.prompts.find((x) => x.id === p.id)!;
      if (p.enabled !== false) t.assert.equal(mine.text, p.text, `${p.id}: the text shown is the text compiled`);
      t.assert.equal(mine.label, p.label);
      t.assert.equal(mine.where, p.where);
      t.assert.deepEqual([...mine.placeholders], [...(p.placeholders ?? [])]);
      t.assert.equal(mine.order, p.order);
    }
    t.assert.deepEqual(
      snapshot.tools.map((x) => x.name).sort(),
      Object.keys(compiled.tools ?? {}).sort(),
    );
    for (const tool of snapshot.tools) {
      const c = compiled.tools![tool.name]!;
      t.assert.equal(tool.description, c.description, `${tool.name}: description`);
      t.assert.deepEqual(Object.fromEntries(tool.params.map((s) => [s.path, s.text])), { ...c.params }, `${tool.name}: parameter texts`);
      t.assert.equal(tool.offered.main, compiled.availability!.main.includes(tool.name));
      t.assert.equal(tool.offered.overdrive, compiled.availability!.overdrive.includes(tool.name));
    }
    t.assert.deepEqual(snapshot.knobs.map((k) => k.key), Object.keys(compiler.BEHAVIOR_SPEC_DATA.keys), "one knob per spec key, in spec order");
    for (const k of snapshot.knobs) t.assert.deepEqual(k.value, getPath(compiled.behavior, k.key), `${k.key}: the value shown is the value compiled`);
    t.assert.deepEqual([...snapshot.coreOrder], [...(compiled.coreOrder ?? [])]);
    t.assert.equal(loadBrain(BRAIN_DIR).revision, snapshot.revision, "reading twice gives the same revision");
  }
}

class TheGuideIsTheVocabulary extends EditorPureTest {
  readonly id = "the-change-guide-names-exactly-the-ops-and-fields-the-editor-accepts";
  readonly whyItExists =
    "agents build their change files from the guide; a guide that named a field the editor refuses, or missed one it accepts, would teach every agent a wrong change and they would learn it from the refusal, one save at a time";

  override run(t: TestRun): void {
    t.assert.deepEqual(CHANGE_GUIDE.ops.map((o) => o.op), [...CHANGE_OPS], "the guide covers every op, in order");
    for (const op of CHANGE_GUIDE.ops) {
      t.assert.deepEqual(["op", ...op.fields.map((f) => f.name)], [...CHANGE_FIELDS[op.op]], `${op.op}: the guide's fields are the accepted fields`);
      t.assert.doesNotThrow(() => parseChanges([op.example]), `${op.op}: its example is a valid change`);
      t.assert.throws(() => parseChanges([{ ...op.example, colour: "teal" }]), /unknown field\(s\) "colour"/, `${op.op}: a field the guide does not name is refused by name`);
      for (const f of op.fields.filter((x) => x.required)) {
        const without: Bag = { ...op.example };
        delete without[f.name];
        t.assert.throws(() => parseChanges([without]), new RegExp(`"${f.name}"`), `${op.op}: missing ${f.name} is refused by name`);
      }
    }
  }
}

/* ---- fs: saving on a copy --------------------------------------------------- */

abstract class EditorFsTest extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  override readonly timeoutMs: number = 120_000;

  protected brainCopy(): string {
    const copy = join(this.tempDir("magentra-brain-editor-"), "brain");
    cpSync(BRAIN_DIR, copy, { recursive: true });
    return copy;
  }
}

class ASavedTextRoundTrips extends EditorFsTest {
  readonly id = "a-saved-text-round-trips-byte-for-byte-including-the-whitespace-a-trim-would-take";
  readonly whyItExists =
    "brain bytes are what the model receives; an editor that trimmed a trailing space, dropped a final blank line or kept a Windows line end would change a prompt nobody meant to change, silently";

  override async run(t: TestRun): Promise<void> {
    const brain = this.brainCopy();
    const before = loadBrain(brain);
    const prompt = "\n  leading blank line and spaces\nmiddle\ttab\ntrailing spaces  \n\n";
    const description = "Reads a file.\r\n\r\nWindows line ends become plain ones, as the compiler reads them. Up to {{maxLines}} lines. ";
    const param = "  An input text with edges  \n";
    const result = await applyChanges(
      brain,
      [
        { op: "prompt.update", id: "reminder.stall-ask", text: prompt },
        { op: "prompt.update", id: "reminder.wrapup-nudge", enabled: false },
        { op: "tool.update", name: "Read", description, params: { offset: param } },
      ],
      { expectRevision: before.revision },
    );
    t.assert.equal(result.applied, true, `saved: ${result.refusal?.message ?? ""}`);
    t.assert.deepEqual([...result.heldBy], [], "a copy of the brain is held by no test");

    const compiled = compiler.compileBrain(brain, { complete: true });
    t.assert.deepEqual([...compiled.problems], []);
    t.assert.equal(compiled.prompts!.find((p) => p.id === "reminder.stall-ask")!.text, prompt, "the prompt compiles to every byte that was sent");
    t.assert.equal(compiled.tools!.Read!.description, description.replace(/\r\n/g, "\n"), "CRLF folds to LF and nothing else moves");
    t.assert.equal(compiled.tools!.Read!.params.offset, param);
    const off = compiled.prompts!.find((p) => p.id === "reminder.wrapup-nudge")!;
    t.assert.equal(off.enabled, false, "switched off");
    t.assert.equal(off.text, "", "a switched-off prompt registers blank");
    const kept = loadBrain(brain).prompts.find((p) => p.id === "reminder.wrapup-nudge")!;
    t.assert.equal(kept.text, before.prompts.find((p) => p.id === "reminder.wrapup-nudge")!.text, "its text is kept in the file for switching back on");

    const files = filesOf(brain);
    const untouched = await applyChanges(brain, [{ op: "prompt.update", id: "reminder.stall-ask", text: prompt }]);
    t.assert.equal(untouched.files.length, 0, "saving the same text again writes no file");
    t.assert.deepEqual(filesOf(brain), files);

    const knob = await applyChanges(brain, [{ op: "behavior.set", key: "finishing.nudgeBudget", value: 2 }]);
    t.assert.equal(knob.applied, true);
    const changedLines = knob.files[0]!.after!.split("\n").filter((line, i) => line !== knob.files[0]!.before!.split("\n")[i]);
    t.assert.deepEqual(changedLines, ['    "nudgeBudget": 2,'], "one knob changes one line of behavior.json, and its hand-made layout stays");
  }
}

class ABrokenChangeWritesNothing extends EditorFsTest {
  readonly id = "a-change-that-breaks-the-brain-or-the-engine-writes-nothing-and-quotes-the-reason";
  readonly whyItExists =
    "the compiler alone accepts a params.md that lost a section the engine reads, and that brain builds green and then throws when the engine loads; an editor that wrote first and checked later would leave exactly such a brain on disk";

  override async run(t: TestRun): Promise<void> {
    const brain = this.brainCopy();
    const files = filesOf(brain);
    const cases: { change: Bag; code: string; quote: RegExp }[] = [
      { change: { op: "behavior.set", key: "stall.pivots", value: 99 }, code: "breaks-brain", quote: /stall\.pivots: 99 is out of range 0\.\.5/ },
      { change: { op: "prompt.update", id: "reminder.stall-ask", text: "Ask about {{nothing}}." }, code: "breaks-brain", quote: /not declared in placeholders: nothing/ },
      { change: { op: "prompt.delete", id: "reminder.stall-ask" }, code: "breaks-brain", quote: /no prompt file for id "reminder\.stall-ask"/ },
      { change: { op: "tool.update", name: "Read", params: { file_path: null } }, code: "breaks-engine", quote: /unknown brain tool param: Read file_path/ },
      { change: { op: "tool.update", name: "Monitor", params: { timeout_ms: "How long to watch." } }, code: "breaks-engine", quote: /does not state "\(default 300000\)"/ },
      { change: { op: "file.write", path: "../escape.md", content: "x" }, code: "invalid-change", quote: /not a brain file path/ },
      { change: { op: "prompt.update", id: "reminder.stall-ask", label: "two\nlines" }, code: "invalid-change", quote: /must be one line/ },
      { change: { op: "availability.update", tool: "Teleport", main: true }, code: "invalid-change", quote: /unknown tool "Teleport"/ },
    ];
    for (const { change, code, quote } of cases) {
      const result = await applyChanges(brain, [change]);
      t.assert.equal(result.applied, false, `${JSON.stringify(change)} is not saved`);
      t.assert.equal(result.refusal?.code, code, `${JSON.stringify(change)}: ${result.refusal?.message}`);
      t.assert.match(result.refusal!.message, quote, "the refusal quotes the compiler's or the engine's own words");
    }
    // A valid change batched with a breaking one is not half-saved.
    const mixed = await applyChanges(brain, [
      { op: "prompt.update", id: "reminder.wrapup-nudge", text: "A valid new text." },
      { op: "behavior.set", key: "stall.pivots", value: 99 },
    ]);
    t.assert.equal(mixed.applied, false);
    t.assert.deepEqual(filesOf(brain), files, "no refused change, alone or batched, moved one byte");
    t.assert.equal(existsSync(join(brain, "..", "escape.md")), false, "nothing was written outside the brain folder");
  }
}

class AStaleChangeIsRefused extends EditorFsTest {
  readonly id = "a-change-planned-against-an-older-revision-is-refused-and-writes-nothing";
  readonly whyItExists =
    "the owner's page and an agent's command line edit the same folder; a save planned before someone else's edit would overwrite it without either of them seeing the other's change";

  override async run(t: TestRun): Promise<void> {
    const brain = this.brainCopy();
    const read = loadBrain(brain);
    const file = join(brain, "prompts", "3-in-turn-reminders", "reminder.stall-ask.md");
    const theirs = readFileSync(file, "utf8").replace(/\n$/, " Edited elsewhere.\n");
    writeFileSync(file, theirs);
    const plan = await planChanges(brain, [{ op: "prompt.update", id: "reminder.stall-ask", text: "Mine." }], { expectRevision: read.revision });
    t.assert.equal(plan.ok, false);
    t.assert.equal(plan.refusal?.code, "stale");
    const result = await applyChanges(brain, [{ op: "prompt.update", id: "reminder.stall-ask", text: "Mine." }], { expectRevision: read.revision });
    t.assert.equal(result.applied, false);
    t.assert.equal(result.refusal?.code, "stale");
    t.assert.equal(readFileSync(file, "utf8"), theirs, "the other edit is still on disk, untouched");
    const fresh = await applyChanges(brain, [{ op: "prompt.update", id: "reminder.stall-ask", text: "Mine." }], { expectRevision: loadBrain(brain).revision });
    t.assert.equal(fresh.applied, true, "planned against the current revision, the same change saves");
    t.assert.equal(fresh.newRevision, brainRevision(brain));
  }
}

class HeldTextNeedsAcknowledging extends EditorFsTest {
  readonly id = "in-the-shipped-brain-a-change-to-held-text-is-refused-until-its-test-is-acknowledged";
  readonly whyItExists =
    "pinned bytes move only by a person (AGENTS.md rule 5); an agent saving into brain/ without being told which tests it breaks would turn the suite red with no one having decided to";

  override async run(t: TestRun): Promise<void> {
    const shippedBefore = brainRevision(BRAIN_DIR);
    const cases: { change: Bag; held: string }[] = [
      { change: { op: "prompt.update", id: "system.git", text: "Git: be careful." }, held: "system-prompt-is-pinned" },
      { change: { op: "prompt.update", id: "reminder.stall-ask", text: "Ask." }, held: "brain-is-the-single-source" },
      { change: { op: "tool.update", name: "Read", description: "Reads a file of up to {{maxLines}} lines." }, held: "tool-wire-contract-is-pinned" },
      { change: { op: "behavior.set", key: "finishing.nudgeBudget", value: 2 }, held: "brain-controls-behavior" },
      { change: { op: "availability.update", tool: "Agent", main: true }, held: "brain-is-the-single-source" },
    ];
    const copy = this.brainCopy();
    for (const { change, held } of cases) {
      const plan = await planChanges(BRAIN_DIR, [change]);
      t.assert.equal(plan.refusal?.code, "needs-acknowledge", `${JSON.stringify(change)}: ${plan.refusal?.message}`);
      t.assert.deepEqual(plan.heldBy.map((h) => h.test), [held], "it names exactly the test it moves");
      const acknowledged = await planChanges(BRAIN_DIR, [change], { acknowledge: [held] });
      t.assert.equal(acknowledged.ok, true, "acknowledged, the same change would save");
      const inCopy = await planChanges(copy, [change]);
      t.assert.equal(inCopy.ok, true, "a profile folder is held by no test");
      t.assert.deepEqual([...inCopy.heldBy], []);
    }
    const reminder = await planChanges(BRAIN_DIR, [{ op: "prompt.update", id: "reminder.stall-ask", text: "Ask." }]);
    t.assert.equal(reminder.engine.checked, true, "the built engine was asked");
    t.assert.equal(reminder.engine.systemPromptChanged, false, "a reminder does not move the system prompt pin, so it is not named");
    t.assert.equal(brainRevision(BRAIN_DIR), shippedBefore, "planning against the shipped brain wrote nothing");
  }
}

class NewProfileNeverOverwrites extends EditorFsTest {
  readonly id = "new-profile-copies-a-complete-brain-and-never-overwrites-a-folder";
  readonly whyItExists =
    "a profile is where agents will build new brains; a copy that dropped a file would start broken, and a copy into an existing folder would destroy whatever brain was there";

  override run(t: TestRun): void {
    const root = this.tempDir("magentra-brain-profile-");
    const target = join(root, "careful");
    const made = newProfile(BRAIN_DIR, target);
    t.assert.equal(made.ok, true, made.message);
    t.assert.deepEqual([...compiler.compileBrain(target, { complete: true }).problems], [], "the profile compiles as a complete brain");
    t.assert.deepEqual(filesOf(target), filesOf(BRAIN_DIR), "every file, byte for byte");
    t.assert.equal(loadBrain(target).shipped, false, "a profile is not the shipped brain");

    const occupied = join(root, "occupied");
    mkdirSync(occupied);
    writeFileSync(join(occupied, "keep.txt"), "mine\n");
    const refused = newProfile(BRAIN_DIR, occupied);
    t.assert.equal(refused.ok, false);
    t.assert.match(refused.message, /never overwrites/);
    t.assert.deepEqual([...readdirSync(occupied)], ["keep.txt"], "the existing folder is untouched");
    t.assert.equal(newProfile(target, join(target, "inner")).ok, false, "a profile cannot be made inside the brain it copies");
    t.assert.equal(newProfile(BRAIN_DIR, target).ok, false, "nor over a profile that exists");
  }
}

/* ---- proc: the real entry point ---------------------------------------------- */

/** Asks the OS for a free port and gives it straight back. */
async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error("the OS gave out no port"))));
    });
  });
}

interface Answer {
  readonly status: number;
  readonly body: Bag;
  readonly text: string;
}

abstract class EditorProcTest extends ProcTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  override readonly timeoutMs: number = 120_000;
  #dirs: string[] = [];

  protected brainCopy(): string {
    const dir = mkdtempSync(join(tmpdir(), "magentra-brain-editor-proc-"));
    this.#dirs.push(dir);
    const copy = join(dir, "brain");
    cpSync(BRAIN_DIR, copy, { recursive: true });
    return copy;
  }

  /** `npm run brain-editor -- <args>`, minus npm: the script's own command, tsx on cli.ts. */
  protected editor(args: readonly string[], label: string): ProcHandle {
    return this.spawn(process.execPath, [TSX, CLI, ...args], { cwd: repoRoot(), label });
  }

  override async tearDown(): Promise<void> {
    for (const child of this.children) {
      if (!child.hasExited()) {
        child.kill();
        await child.exited();
      }
    }
    for (const dir of this.#dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
    this.#dirs = [];
  }
}

function call(port: number, method: string, path: string, opts: { headers?: Record<string, string>; body?: unknown } = {}): Promise<Answer> {
  return new Promise<Answer>((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = request({ host: "127.0.0.1", port, path, method, timeout: 60_000, headers: { ...(payload ? { "content-type": "application/json" } : {}), ...opts.headers } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (text += chunk));
      res.on("end", () => {
        let body: Bag = {};
        try {
          if (text) body = JSON.parse(text) as Bag;
        } catch {
          // not JSON
        }
        resolve({ status: res.statusCode ?? 0, body, text });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("request timed out")));
    if (payload) req.write(payload);
    req.end();
  });
}

class TheServerGuardsItsWrites extends EditorProcTest {
  readonly id = "the-server-answers-only-on-loopback-and-refuses-a-write-without-the-action-header";
  readonly whyItExists =
    "the page writes into brain/ with no login; a server reachable from the network, from another site's page in the browser or through a rebound host name would let anyone rewrite what the agent is told";

  override async run(t: TestRun): Promise<void> {
    const brain = this.brainCopy();
    const port = await freePort();
    const server = this.editor(["--no-open", "--port", String(port), "--brain", brain], `brain editor on ${port}`);
    await server.nextLine((line) => line.includes(`http://127.0.0.1:${port}`), 60_000);

    const page = await call(port, "GET", "/");
    t.assert.equal(page.status, 200);
    t.assert.match(page.text, /<title>Brain editor · MAGENTRA<\/title>/);
    const state = await call(port, "GET", "/api/brain");
    t.assert.equal(state.status, 200);
    t.assert.equal(state.body.dir, brain);
    t.assert.equal(state.body.revision, brainRevision(brain));

    const files = filesOf(brain);
    const change = { changes: [{ op: "prompt.update", id: "reminder.stall-ask", text: "Ask one question." }], expectRevision: state.body.revision };
    const bare = await call(port, "POST", "/api/apply", { body: change });
    t.assert.equal(bare.status, 403, "no action header, no write");
    const crossSite = await call(port, "POST", "/api/apply", { body: change, headers: { "x-magentra-brain-action": "1", origin: "http://evil.example" } });
    t.assert.equal(crossSite.status, 403, "another site's origin, no write");
    const rebound = await call(port, "GET", "/api/brain", { headers: { host: `evil.example:${port}` } });
    t.assert.equal(rebound.status, 421, "a foreign Host header is refused");
    t.assert.deepEqual(filesOf(brain), files, "nothing was written by the refused requests");

    const saved = await call(port, "POST", "/api/apply", { body: change, headers: { "x-magentra-brain-action": "1" } });
    t.assert.equal(saved.status, 200, saved.text);
    t.assert.equal(saved.body.applied, true);
    t.assert.equal(loadBrain(brain).prompts.find((p) => p.id === "reminder.stall-ask")!.text, "Ask one question.", "the page's save is on disk");
    const again = await call(port, "POST", "/api/apply", { body: change, headers: { "x-magentra-brain-action": "1" } });
    t.assert.equal(again.status, 409, "the same change, planned against the old revision, is refused");
    t.assert.equal((again.body.refusal as Bag).code, "stale");

    const refused = await new Promise<boolean>((resolve) => {
      const socket = connect({ host: "::1", port, family: 6, timeout: 3_000 });
      socket.once("connect", () => (socket.destroy(), resolve(false)));
      socket.once("error", () => (socket.destroy(), resolve(true)));
      socket.once("timeout", () => (socket.destroy(), resolve(true)));
    });
    t.assert.equal(refused, true, "the server binds 127.0.0.1 only; the IPv6 loopback is refused");
  }
}

class TheCommandLineIsTheSamePath extends EditorProcTest {
  readonly id = "the-command-line-plans-and-applies-the-change-the-page-sends";
  readonly whyItExists =
    "agents change the brain from a shell; a command line with its own write path would let an agent save what the page would refuse, and an exit code of 0 on a refusal would let a script report success";

  async #run(args: readonly string[]): Promise<{ code: number | null; json: Bag; stderr: string }> {
    const child = this.editor(args, `brain-editor ${args[0]}`);
    const exit = await child.exited();
    let json: Bag = {};
    try {
      json = JSON.parse(child.stdout()) as Bag;
    } catch {
      // asserted below through `json`
    }
    return { code: exit.code, json, stderr: child.stderr() };
  }

  override async run(t: TestRun): Promise<void> {
    const brain = this.brainCopy();
    const dir = join(brain, "..");
    const changes = join(dir, "changes.json");
    writeFileSync(changes, JSON.stringify([{ op: "behavior.set", key: "stall.pivots", value: 1 }]));

    const check = await this.#run(["check", "--brain", brain, "--json"]);
    t.assert.equal(check.code, 0, check.stderr);
    t.assert.equal(check.json.ok, true);
    const revision = check.json.revision as string;

    const files = filesOf(brain);
    const plan = await this.#run(["plan", changes, "--brain", brain, "--expect", revision, "--json"]);
    t.assert.equal(plan.code, 0, plan.stderr);
    t.assert.equal(plan.json.ok, true);
    t.assert.deepEqual((plan.json.files as Bag[]).map((f) => f.path), ["behavior.json"]);
    t.assert.deepEqual(filesOf(brain), files, "plan writes nothing");

    writeFileSync(join(dir, "bad.json"), JSON.stringify([{ op: "behavior.set", key: "stall.pivots", value: 9 }]));
    const bad = await this.#run(["apply", join(dir, "bad.json"), "--brain", brain, "--json"]);
    t.assert.equal(bad.code, 1, "a refusal exits 1");
    t.assert.equal((bad.json.refusal as Bag).code, "breaks-brain");
    t.assert.deepEqual(filesOf(brain), files, "and writes nothing");

    const applied = await this.#run(["apply", changes, "--brain", brain, "--expect", revision, "--json"]);
    t.assert.equal(applied.code, 0, applied.stderr);
    t.assert.equal(applied.json.applied, true);
    t.assert.equal(getPath(compiler.compileBrain(brain, { complete: true }).behavior, "stall.pivots"), 1, "the knob is saved");

    const stale = await this.#run(["apply", changes, "--brain", brain, "--expect", revision, "--json"]);
    t.assert.equal(stale.code, 1, "the old revision is refused once the brain moved on");
    t.assert.equal((stale.json.refusal as Bag).code, "stale");

    const usage = await this.#run(["frobnicate"]);
    t.assert.equal(usage.code, 2, "an unknown command is a usage error");
    t.assert.match(usage.stderr, /unknown command "frobnicate"/);

    const pkg = JSON.parse(readFileSync(join(repoRoot(), "package.json"), "utf8")) as { scripts: Record<string, string> };
    t.assert.equal(pkg.scripts["brain-editor"], "tsx tools/brain-editor/src/cli.ts", "npm run brain-editor runs this same entry point");
  }
}

registerFeatureTests(
  new TheEditorReadsWhatTheCompilerReads(),
  new TheGuideIsTheVocabulary(),
  new ASavedTextRoundTrips(),
  new ABrokenChangeWritesNothing(),
  new AStaleChangeIsRefused(),
  new HeldTextNeedsAcknowledging(),
  new NewProfileNeverOverwrites(),
  new TheServerGuardsItsWrites(),
  new TheCommandLineIsTheSamePath(),
);
