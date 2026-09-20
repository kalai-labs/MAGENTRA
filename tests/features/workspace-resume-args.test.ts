/**
 * `workspace-resume-args` — `magentra [path] [--resume [id]]`.
 *
 * `tui/src/cli.tsx` resolves the workspace once, before anything else: the
 * positional path if one was given (and it must exist, or the process exits
 * 1 before an engine is ever spawned), else the launch directory — `INIT_CWD`
 * in a dev `npm run`, `process.cwd()` when packaged. `--resume` is parsed
 * separately: a bare flag asks the freshly-booted engine for this
 * workspace's saved sessions and opens a picker on the reply; `--resume <id>`
 * sends `resume_session` straight away, once, on the FIRST `session_started`
 * — and a token right after `--resume` that itself looks like a flag (starts
 * with `--`) is never mistaken for an id.
 *
 * `useEngine.ts` (where the resume dispatch and the session picker live)
 * imports React and Ink-adjacent modules — not all `node:` — so it cannot be
 * imported directly per this track's rule; it is driven the only honest way,
 * through the real built CLI as a real child process, exactly as a user's
 * shell would run it.
 *
 * THE ENGINE IS A STAND-IN, the same double `engineHarness.ts` and
 * `scriptedEngine.ts` already are for other tracks: something the TUI treats
 * as an opaque NDJSON peer over its stdio, never inspected as a module. This
 * file's stand-in does the minimum the checklist below needs — announce a
 * session, log every frame it receives to a file this test reads, and answer
 * `list_sessions` when asked — so what is proven is the CLI's OWN parsing and
 * dispatch, not the engine's turn loop (a different track's job).
 *
 * WHY EVERY RUN FINISHES ON ITS OWN. None of these launches has a TTY (no
 * pseudo-terminal exists on Windows — tests/README's platform section), so
 * `app.tsx`'s own `!interactive` effect ends the process a beat after mount
 * regardless of what this file asks for. That is not fought here — it is
 * timing room: the workspace resolves and the resume dispatch fires at
 * mount, well before that effect's ~100ms timer, and this suite here waits
 * for the process's own natural exit rather than racing it.
 *
 * WHAT IS NOT PROVEN HERE. Checklist 4's PACKAGED half (`launchDir` under
 * `isPackagedRun()`) is not reachable at all without a real interactive
 * terminal: the packaged branch hands off to the desktop app whenever there
 * is no tty (`tty-dispatch`'s own invariant), before `workspace` is ever
 * used for anything — so on this platform there is no path through the real
 * CLI that both is packaged and ever reaches `resolveEngineSpawn`. Stated,
 * not faked; see `tty-dispatch.test.ts` for the packaged branch's own,
 * reachable claims.
 *
 * Checklist 5's "a following session_list frame populates sessionPicker" is
 * proven only as far as the request (list_sessions is sent, and only that);
 * the reply actually reaching a rendered picker is a race against the same
 * ~100ms non-interactive shutdown, measured to lose roughly one run in three
 * even against a near-instant stand-in engine — and a picker that DID render
 * in that mode could not be acted on anyway, since `useInput`'s handler is
 * `{ isActive: interactive }`. See the class below for the measurement.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { repoRoot } from "../lib/inventory.ts";
import { ProcTest, type ProcHandle } from "../lib/procTest.ts";

const FEATURE = "workspace-resume-args";

/** Verbatim from the record. The base fails the test if these ever differ. */
const INVARIANT = "The workspace is the positional path if given, else the launch directory; --resume takes an optional id.";

const BUILT_CLI = join("tui", "dist", "cli.js");

/**
 * The stand-in engine: announces itself, logs every frame it receives (as
 * NDJSON, to the path in `MAGENTRA_TEST_ENGINE_LOG`) for this test to read
 * back, answers `list_sessions` from `MAGENTRA_TEST_SESSIONS` if set, and
 * ends when its stdin does — the same contract `host.ts` spawns against.
 */
const ENGINE_SOURCE = [
  "const fs = require('node:fs');",
  "const log = (o) => fs.appendFileSync(process.env.MAGENTRA_TEST_ENGINE_LOG, JSON.stringify(o) + '\\n');",
  "log({ ev: 'start', cwd: process.cwd(), argv: process.argv.slice(2) });",
  "process.stdout.write(JSON.stringify({type:'session_started',sessionId:'s1',model:'m',overdrive:false,commands:[],v:1,cwd:process.cwd()})+'\\n');",
  "let buf = '';",
  "process.stdin.on('data', (c) => {",
  "  buf += c;",
  "  let nl;",
  "  while ((nl = buf.indexOf('\\n')) !== -1) {",
  "    const line = buf.slice(0, nl).trim();",
  "    buf = buf.slice(nl + 1);",
  "    if (!line) continue;",
  "    let frame;",
  "    try { frame = JSON.parse(line); } catch { continue; }",
  "    log({ ev: 'recv', frame });",
  "    if (frame.type === 'list_sessions') {",
  "      const sessions = process.env.MAGENTRA_TEST_SESSIONS ? JSON.parse(process.env.MAGENTRA_TEST_SESSIONS) : [];",
  "      process.stdout.write(JSON.stringify({type:'session_list',sessions})+'\\n');",
  "    }",
  "  }",
  "});",
  "process.stdin.on('end', () => process.exit(0));",
].join("\n");

interface LogEntry {
  readonly ev: "start" | "recv";
  readonly cwd?: string;
  readonly argv?: readonly string[];
  readonly frame?: { readonly type?: string; readonly id?: string };
}

abstract class WorkspaceArgsTest extends ProcTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  #dirs: string[] = [];

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

  protected tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    this.#dirs.push(dir);
    return dir;
  }

  /** A home whose `~/.magentra-tui.json` points at a working stand-in engine — this test's own, isolated from the real repo's HOME. */
  protected setUpHome(): string {
    const home = this.tempDir("magentra-resume-home-");
    const engineHome = this.tempDir("magentra-resume-enginehome-");
    mkdirSync(join(engineHome, "engine", "host", "dist"), { recursive: true });
    writeFileSync(join(engineHome, "engine", "host", "dist", "main.js"), ENGINE_SOURCE);
    writeFileSync(join(home, ".magentra-tui.json"), JSON.stringify({ engineHome }));
    return home;
  }

  /** Record `workspace` as trusted in `home`, exactly the shape `trust.ts` writes — so the trust gate never stands between mount and the engine spawn this test is about. */
  protected trust(home: string, workspace: string): void {
    mkdirSync(join(home, ".magentra"), { recursive: true });
    writeFileSync(
      join(home, ".magentra", "trusted-folders.json"),
      JSON.stringify({ version: 1, folders: { [workspace]: { trustedAt: new Date().toISOString() } } }),
    );
  }

  /** Run the real built CLI against `home`, from `cwd`, with `args` — piped, so never a tty (see the file header). */
  protected runCli(args: readonly string[], cwd: string, home: string, extraEnv: Readonly<Record<string, string | undefined>> = {}): ProcHandle {
    const built = join(repoRoot(), BUILT_CLI);
    if (!existsSync(built)) {
      throw new Error(`${BUILT_CLI} does not exist. Run \`npm run build\` — this test drives the built TUI.`);
    }
    return this.spawn(process.execPath, [built, ...args], {
      cwd,
      env: { HOME: home, USERPROFILE: home, ...extraEnv },
      label: `tui ${args.join(" ")} in ${cwd}`,
    });
  }

  /** The stand-in engine's log, parsed — waiting up to `timeoutMs` for the CLI's own process to end on its own. */
  protected async readLog(child: ProcHandle, logPath: string, timeoutMs = 10_000): Promise<LogEntry[]> {
    await Promise.race([
      child.exited(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("the tui process did not exit on its own (no tty) within the timeout")), timeoutMs);
      }),
    ]);
    if (!existsSync(logPath)) return [];
    return readFileSync(logPath, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as LogEntry);
  }
}

/* ---- checklist 2 -------------------------------------------------------- */

class PositionalPathWinsAndTheResumeIdIsNeverMistakenForIt extends WorkspaceArgsTest {
  readonly id = "a-positional-path-is-the-workspace-and-the-resume-id-is-never-a-second-path";
  readonly whyItExists =
    "if the token after --resume were ever treated as a second positional path, --resume <id> would try to open the id as a folder instead of resuming a session in the given workspace — and if no positional path fell back to the launch directory, a bare `magentra --resume <id>` would have nowhere to open at all";

  override async run(t: TestRun): Promise<void> {
    const home = this.setUpHome();

    // With a positional path: it — not the launch directory — is the workspace.
    const ws1 = this.tempDir("magentra-resume-ws1-");
    this.trust(home, ws1);
    const log1 = join(home, "engine1.log");
    const child1 = this.runCli([ws1, "--resume", "id1"], repoRoot(), home, { MAGENTRA_TEST_ENGINE_LOG: log1 });
    const entries1 = await this.readLog(child1, log1);

    const start1 = entries1.find((e) => e.ev === "start");
    t.assert.equal(start1?.cwd, ws1, "the engine must be spawned with the positional path as its cwd, not the launch directory");
    const resumes1 = entries1.filter((e) => e.ev === "recv" && e.frame?.type === "resume_session");
    t.assert.equal(resumes1.length, 1, "exactly one resume_session must be sent");
    t.assert.equal(resumes1[0]?.frame?.id, "id1", "the id must be the token after --resume, not the workspace path");

    // With NO positional path: the launch directory (this run's cwd) is the workspace.
    const ws2 = this.tempDir("magentra-resume-ws2-");
    this.trust(home, ws2);
    const log2 = join(home, "engine2.log");
    const child2 = this.runCli(["--resume", "id1"], ws2, home, { MAGENTRA_TEST_ENGINE_LOG: log2 });
    const entries2 = await this.readLog(child2, log2);

    const start2 = entries2.find((e) => e.ev === "start");
    t.assert.equal(start2?.cwd, ws2, "with no positional path, the workspace must be the launch directory");
    const resumes2 = entries2.filter((e) => e.ev === "recv" && e.frame?.type === "resume_session");
    t.assert.equal(resumes2.length, 1);
    t.assert.equal(resumes2[0]?.frame?.id, "id1");
  }
}

/* ---- checklist 3 -------------------------------------------------------- */

class AMissingDirectoryExitsBeforeAnyEngineIsSpawned extends WorkspaceArgsTest {
  readonly id = "a-missing-positional-directory-exits-1-before-any-engine-spawns";
  readonly whyItExists =
    "if the existsSync guard ever ran after the engine was resolved or spawned, a mistyped path would boot an engine pointed at a folder that is not there instead of failing loud and immediately — this proves the process exits 1, naming the path, with no engine ever started";

  override async run(t: TestRun): Promise<void> {
    const home = this.setUpHome();
    const parent = this.tempDir("magentra-resume-missing-");
    const missing = join(parent, "does-not-exist");
    const log = join(home, "engine.log");

    const child = this.runCli([missing], repoRoot(), home, { MAGENTRA_TEST_ENGINE_LOG: log });
    const exit = await child.exited();

    t.assert.equal(exit.code, 1);
    t.assert.match(child.stderr(), new RegExp(`magentra: no such directory: ${missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    t.assert.equal(child.stdout(), "", "nothing should render — the process must exit before App ever mounts");
    t.assert.equal(existsSync(log), false, "the engine's own log file must never appear — it was never spawned");
  }
}

/* ---- checklist 4 (dev half) & checklist 5's "resume undefined" clause --- */

class DevLaunchDirFollowsInitCwdAndSendsNoResumeFrameByDefault extends WorkspaceArgsTest {
  readonly id = "dev-launch-dir-follows-init-cwd-and-sends-no-resume-frame-by-default";
  readonly whyItExists =
    "if a dev run stopped reading INIT_CWD, `npm run start` from the package root would always open the package folder regardless of where the user actually ran it from — and if resume dispatch fired with nothing asked for, every plain launch would needlessly query or restore a session";

  override async run(t: TestRun): Promise<void> {
    const home = this.setUpHome();
    const initCwd = this.tempDir("magentra-resume-initcwd-");
    const processCwd = this.tempDir("magentra-resume-processcwd-");
    this.trust(home, initCwd);
    const log = join(home, "engine.log");

    const child = this.runCli([], processCwd, home, { INIT_CWD: initCwd, MAGENTRA_TEST_ENGINE_LOG: log });
    const entries = await this.readLog(child, log);

    const starts = entries.filter((e) => e.ev === "start");
    t.assert.equal(starts.length, 1, "the engine must be spawned exactly once");
    t.assert.equal(starts[0]?.cwd, initCwd, "a dev run must follow INIT_CWD, not this process's own cwd");
    // A trusted folder's own OVERDRIVE default (a different feature) also
    // writes to this engine on first boot — resume dispatch is the only thing
    // under test here, so only resume_session/list_sessions are asserted absent.
    const resumeFrames = entries.filter((e) => e.ev === "recv" && (e.frame?.type === "resume_session" || e.frame?.type === "list_sessions"));
    t.assert.deepEqual(resumeFrames, [], "with no --resume at all, neither resume_session nor list_sessions may be sent");
  }
}

/* ---- checklist 1 (the tricky parse) & checklist 5's list_sessions clause */

class AFlagRightAfterResumeIsNeverTakenAsAnId extends WorkspaceArgsTest {
  readonly id = "a-flag-right-after-resume-is-never-taken-as-an-id";
  readonly whyItExists =
    "if the token right after --resume were accepted as an id merely by position, `--resume --gui` would try to resume a session literally named \"--gui\" instead of opening the picker — this proves a token starting with -- is read as bare --resume (list_sessions), never as an id (resume_session)";

  override async run(t: TestRun): Promise<void> {
    const home = this.setUpHome();
    const ws = this.tempDir("magentra-resume-picker-ws-");
    this.trust(home, ws);
    const log = join(home, "engine.log");
    const sessions = [{ id: "abc12345", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", cwd: ws, label: "resume me please" }];

    const child = this.runCli(["--resume", "--gui"], ws, home, {
      MAGENTRA_TEST_ENGINE_LOG: log,
      MAGENTRA_TEST_SESSIONS: JSON.stringify(sessions),
    });
    const entries = await this.readLog(child, log);

    const received = entries.filter((e) => e.ev === "recv");
    t.assert.equal(received.length, 1, "exactly one request must follow a bare --resume");
    t.assert.equal(received[0]?.frame?.type, "list_sessions", "--gui must not be read as a session id — this must be the bare-resume request");
    t.assert.equal(received.some((e) => e.frame?.type === "resume_session"), false, '"--gui" must never be sent as a resume_session id');

    // NOT asserted: that the session_list reply this run's engine sent back
    // goes on to render the picker. Measured directly (three consecutive runs,
    // asserting on rendered stdout): it wins the race against app.tsx's own
    // ~100ms non-interactive shutdown roughly two times in three, even against
    // this near-instant stand-in engine, and loses outright once React has
    // unmounted for that shutdown — a real engine's own boot cost only makes
    // that worse. It is also not a loss with a user-visible consequence in
    // this mode: useInput's handler is `{ isActive: interactive }`, so a
    // picker that DID render non-interactively could never be driven by a key
    // anyway. Stated per tests/README's platform section, not asserted
    // flakily and not faked with a longer wait that this platform's own
    // timing does not actually give the feature.
  }
}

registerFeatureTests(
  new PositionalPathWinsAndTheResumeIdIsNeverMistakenForIt(),
  new AMissingDirectoryExitsBeforeAnyEngineIsSpawned(),
  new DevLaunchDirFollowsInitCwdAndSendsNoResumeFrameByDefault(),
  new AFlagRightAfterResumeIsNeverTakenAsAnId(),
);
