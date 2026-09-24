/**
 * `process-kill-guard`.
 *
 * In the 2026-09-23 field test (finding S-01) the agent, in OVERDRIVE, ran
 * `taskkill //F //IM python.exe //FI "WINDOWTITLE eq *"` to stop its own game
 * server. That stops every python.exe on the computer. Nothing asked: no kill
 * form was classified, so the stance default (allow) ran it, and four seconds
 * later the agent used TaskStop on its own job — the tool it should have used.
 *
 * `pure` + `proc` + `ui`, as the record declares.
 *
 *   - `pure` is the classifier and the decision table. `bashProcessKillSubject`
 *     is a function of a string, and `PermissionEngine` takes the approval hop
 *     and the persistence hop as callbacks, so every branch is readable with no
 *     frontend and no disk.
 *   - `proc` is the claim a table cannot make: that the Session really consults
 *     the guard, so a real shell never runs the command. The command kills a
 *     process name that cannot exist and then writes a marker file — the marker
 *     is the proof the command did or did not run.
 *   - `ui` is the card: the guard's line under the command, in the single
 *     console and in a tiled pane. The frame is the one the real PermissionEngine
 *     asks with, delivered on the channel main delivers it on.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PermissionEngine, type ApprovalSource, type ExactGrant, type PermissionRequestPayload } from "@magentra/core";
import type { CoreEvent, PermissionDecision } from "@magentra/protocol";
import { bashProcessKillSubject, bashTool, monitorTool } from "@magentra/tools";

import { openWorkspace, waitForSpawn } from "../lib/appDriver.ts";
import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { ProcTest } from "../lib/procTest.ts";
import { PureTest } from "../lib/pureTest.ts";
import { startScriptedEngine, type ScriptedEngine } from "../lib/scriptedEngine.ts";
import { UiTest, type AppHandle } from "../lib/uiTest.ts";

const FEATURE = "process-kill-guard";

/** Verbatim from the record. */
const INVARIANT =
  "A command that stops processes by name never runs unasked: outside OVERDRIVE it asks, in OVERDRIVE it is refused, and only a literal grant or an explicit rule for that exact command lets it run without a question.";

/** The field command, verbatim from the transcript (s_mue8gg2u_5aed60.jsonl, 15:46:20Z). */
const FIELD_COMMAND =
  'cd /c/Users/alini/phdworks/test && (taskkill //F //IM python.exe //FI "WINDOWTITLE eq *" 2>/dev/null; true) | head -n 2; sleep 1; echo done';

/** Bash input for one command, as the tool's own schema produces it. */
function bashInput(command: string): { command: string; description: string; run_in_background: boolean } {
  return { command, description: "Stop the running server", run_in_background: false };
}

interface Ask {
  readonly payload: PermissionRequestPayload;
  readonly source: ApprovalSource;
}

interface Probe {
  readonly engine: PermissionEngine;
  /** Every `requestApproval` call, in order. Empty is the assertion that nothing asked. */
  readonly asks: Ask[];
}

/** A PermissionEngine whose frontend answers `answers` in order (then the last one again). */
function probe(opts: { allow?: string[]; allowExact?: ExactGrant[]; answers?: { decision: PermissionDecision; message?: string }[] } = {}): Probe {
  const asks: Ask[] = [];
  const answers = opts.answers ?? [{ decision: "allow_once" }];
  const engine = new PermissionEngine(
    { allow: opts.allow ?? [], deny: [], allowExact: opts.allowExact ?? [] },
    async (payload, source) => {
      asks.push({ payload, source });
      return answers[Math.min(asks.length - 1, answers.length - 1)]!;
    },
  );
  return { engine, asks };
}

/** `PermissionEngine.check` for one Bash command, with the arguments the Session passes. */
function check(p: Probe, command: string): ReturnType<PermissionEngine["check"]> {
  const input = bashInput(command);
  return p.engine.check(bashTool, input, command, input.description, "unknown", false, undefined);
}

abstract class KillGuardTest extends PureTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
}

/* ---- checklist 1 ----------------------------------------------------- */

class TheClassifier extends KillGuardTest {
  readonly id = "the-classifier-flags-kills-by-name-and-passes-over-kills-by-pid-and-look-alikes";
  readonly whyItExists =
    "no kill form was classified at all, so `taskkill //F //IM python.exe` ran in OVERDRIVE and stopped every Python process on the machine to end one game server";

  override async run(t: TestRun): Promise<void> {
    const byName = [
      FIELD_COMMAND,
      "taskkill /F /IM node.exe",
      "TASKKILL.EXE -f -im chrome.exe",
      'taskkill /FI "IMAGENAME eq python*"',
      "pkill -f server.py",
      "sudo killall -9 node",
      "/usr/bin/pkill -u me",
      "tskill python",
      'powershell -NoProfile -Command "Stop-Process -Name python -Force"',
      "Get-Process python | Stop-Process -Force",
      "Stop-Process -ProcessName node",
      "spps -Name python",
      "kill -Name python",
      "kill -9 -1",
      "kill -- -1",
      "kill $(pgrep -f server.py)",
      'kill "$(pgrep x)"',
      "pgrep node | xargs kill -9",
      "ps aux | grep python | awk '{print $2}' | xargs -r kill",
      "pidof python3 | xargs kill",
      "gps node | kill",
      "(Get-Process python).Kill()",
      'wmic process where name="python.exe" delete',
      "wmic process where \"name='node.exe'\" call terminate",
      "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Invoke-CimMethod -MethodName Terminate",
      'bash -c "pkill node"',
      "cmd /c taskkill /F /IM python.exe",
      "npm test && killall node",
      "nohup pkill -f worker &",
      // behind shell keywords, eval, comments and here-documents
      "if pgrep -f server >/dev/null; then pkill -f server; fi",
      "for pid in $(pgrep -f server); do kill $pid; done",
      "while pgrep node; do pkill node; done",
      "! pkill node",
      'eval "pkill node"',
      '"C:\\Windows\\System32\\taskkill.exe" /F /IM python.exe',
      "# servers that won't die\npkill -f server",
      "cat <<EOF\ndon't\nEOF\npkill node",
      "bash <<'EOF'\npkill node\nEOF",
    ];
    for (const command of byName) {
      t.assert.equal(bashProcessKillSubject(command), command, `"${command}" stops processes by name and must be flagged`);
    }

    const notByName = [
      // by pid
      "taskkill /PID 1234 /T /F",
      "taskkill //PID 1234 //F",
      "kill 1234",
      "kill -9 1234",
      "kill -TERM $!",
      "kill -1 1234",
      "kill -n 9 4321",
      "kill %1",
      "Stop-Process -Id 1234 -Force",
      "Stop-Process 1234",
      // by port
      "npx kill-port 3000",
      "lsof -ti:3000 | xargs kill",
      "fuser -k 8000/tcp",
      // listing only
      "ps aux | grep python",
      "pgrep -f server.py",
      'tasklist /FI "IMAGENAME eq python.exe"',
      "Get-Process python",
      "wmic process list brief",
      "command -v pkill",
      // the word, but not in a command position
      "grep -rn kill src/",
      "echo pkill",
      'git commit -m "stop using pkill and taskkill /IM in the scripts"',
      "touch killed.txt && cat killall.log",
      "cat .claude/skills/bigboycoding/SKILL.md",
      "docker kill web && tmux kill-session -t dev",
      "kill 1234 2>&1 | tee out.log",
      // a kill by pid beside a lookup that does not feed it
      "kill 12345 && sleep 1 && ps aux | grep node",
      "taskkill /PID 1234 /F && tasklist | findstr node",
      "npm run dev & sleep 5; ps aux | grep vite; kill %1",
      // a here-document is data: the commit and PR bodies Bash's own description asks for
      "git commit -m \"$(cat <<'EOF'\nfix: stop using pkill\n\n(pkill node was too broad)\n`pkill node`\nEOF\n)\"",
      "cat > README.md <<'EOF'\nNever run taskkill /IM python.exe\nEOF",
    ];
    for (const command of notByName) {
      t.assert.equal(bashProcessKillSubject(command), undefined, `"${command}" does not stop processes by name`);
    }

    // The Session reaches the classifier through the tool definitions, and
    // Monitor runs its command in the same shell.
    t.assert.equal(bashTool.processKillSubject?.(bashInput("pkill node")), "pkill node");
    t.assert.equal(bashTool.processKillSubject?.(bashInput("kill 1234")), undefined);
    t.assert.equal(
      monitorTool.processKillSubject?.({ command: "pkill node", description: "watch", timeout_ms: 1000, persistent: false }),
      "pkill node",
      "a kill by name must not get past the guard by switching to Monitor",
    );
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class OutsideOverdriveItAsks extends KillGuardTest {
  readonly id = "outside-overdrive-a-kill-by-name-asks-as-the-guard-and-a-decline-names-taskstop";
  readonly whyItExists =
    "with Bash allowed outright the stance ran the field command with `source: mode` — the user was never shown that it would stop every python.exe on the computer";

  override async run(t: TestRun): Promise<void> {
    const p = probe({ allow: ["Bash"], answers: [{ decision: "deny" }] });
    const out = await check(p, FIELD_COMMAND);

    t.assert.equal(p.asks.length, 1, "a kill by name asks, although settings allow Bash outright");
    t.assert.equal(p.asks[0]?.source, "process-kill-guard", "and it asks AS the guard, not as the stance");
    t.assert.match(p.asks[0]?.payload.description ?? "", /stops processes by name — every matching process on this computer/i);
    t.assert.equal(p.asks[0]?.payload.subject, FIELD_COMMAND, "the card shows the command itself");
    t.assert.equal(p.asks[0]?.payload.grant, undefined, "and offers no command shape to remember");

    t.assert.equal(out.allowed, false);
    t.assert.equal(out.source, "user");
    t.assert.match(out.message ?? "", /TaskStop/, "a decline tells the model which tool stops its own job");
    t.assert.match(out.message ?? "", /do not retry the same call/);
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class InOverdriveItIsRefused extends KillGuardTest {
  readonly id = "in-overdrive-a-kill-by-name-is-refused-and-nothing-asks";
  readonly whyItExists =
    "OVERDRIVE ran the field command silently; asking instead would stall an unattended run on a prompt nobody is there to answer, which is the failure OVERDRIVE was rebuilt to remove";

  override async run(t: TestRun): Promise<void> {
    const p = probe({ allow: ["Bash"] });
    p.engine.setOverdrive(true);
    const out = await check(p, FIELD_COMMAND);

    t.assert.deepEqual(p.asks, [], "OVERDRIVE never asks");
    t.assert.equal(out.allowed, false, "and a kill by name never runs there");
    t.assert.match(out.message ?? "", /TaskStop/);
    t.assert.match(out.message ?? "", /OVERDRIVE/);

    // Everything else still runs unasked in that stance.
    const kill = await check(p, "kill 4321");
    t.assert.equal(kill.allowed, true, "a kill by pid is not this guard's business");
    t.assert.deepEqual(p.asks, []);
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class BroadGrantsNeverCoverIt extends KillGuardTest {
  readonly id = "a-broad-rule-a-session-allow-or-a-command-shape-grant-never-covers-a-kill-by-name";
  readonly whyItExists =
    "an 'always allow' on a harmless `taskkill /PID …` remembers the shape `taskkill`, and a guard that honoured shapes would let the next `taskkill /IM python.exe` through on that one old click";

  override async run(t: TestRun): Promise<void> {
    const command = "taskkill /F /IM python.exe";
    const broad: { name: string; p: Probe }[] = [
      { name: "a bare Bash rule", p: probe({ allow: ["Bash"] }) },
      { name: "Bash(*)", p: probe({ allow: ["Bash(*)"] }) },
      { name: "a command-shape grant", p: probe({ allowExact: [{ tool: "Bash", subject: "taskkill", prefix: true }] }) },
      { name: "a session allow", p: probe() },
    ];
    broad[3]!.p.engine.addSessionAllow("Bash");
    for (const { name, p } of broad) {
      await check(p, command);
      t.assert.equal(p.asks.length, 1, `${name} must not cover a kill by name`);
      t.assert.equal(p.asks[0]?.source, "process-kill-guard");
      p.engine.setOverdrive(true);
      const out = await check(p, command);
      t.assert.equal(out.allowed, false, `${name} must not let it run in OVERDRIVE either`);
    }

    // "Allow deletions" is the deletion guard's switch, not this one's.
    const noDeletionGuard = probe({ allow: ["Bash"] });
    noDeletionGuard.engine.setDeletionGuard(false);
    await check(noDeletionGuard, command);
    t.assert.equal(noDeletionGuard.asks.length, 1, "switching the deletion guard off does not switch this guard off");
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

class TheLiteralGrantIsTheOverride extends KillGuardTest {
  readonly id = "always-allow-grants-that-literal-command-and-an-explicit-rule-is-the-override-in-both-stances";
  readonly whyItExists =
    "without a standing override a user who really means `taskkill /IM myapp.exe` is asked on every run forever, and an override that widened to a shape would quietly turn the guard off";

  override async run(t: TestRun): Promise<void> {
    const command = "taskkill /F /IM myapp.exe";
    const p = probe({ answers: [{ decision: "allow_always" }] });
    const first = await check(p, command);
    t.assert.equal(first.allowed, true);
    t.assert.equal(p.asks.length, 1);

    const again = await check(p, command);
    t.assert.equal(again.allowed, true, "the approved command runs again");
    t.assert.equal(p.asks.length, 1, "with no second prompt");
    await check(p, "taskkill /F /IM otherapp.exe");
    t.assert.equal(p.asks.length, 2, "a variant still asks — the grant is that literal command, not its shape");

    const ruled = probe({ allow: [`Bash(${command})`] });
    const normal = await check(ruled, command);
    ruled.engine.setOverdrive(true);
    const overdrive = await check(ruled, command);
    t.assert.equal(normal.allowed, true);
    t.assert.equal(overdrive.allowed, true, "an explicit rule for the exact command is the user's standing answer, in both stances");
    t.assert.deepEqual(ruled.asks, []);
  }
}

/* ---- checklist 6 ----------------------------------------------------- */

class AKillThatAlsoDeletes extends KillGuardTest {
  readonly id = "a-kill-that-also-deletes-asks-for-both-and-the-kill-approval-note-reaches-the-model";
  readonly whyItExists =
    "the kill guard sits ahead of the deletion guard; had its approval ended the check, `pkill node && rm -rf build` would have skipped the deletion prompt, and a note typed on the first card would have been lost";

  override async run(t: TestRun): Promise<void> {
    const p = probe({ answers: [{ decision: "allow_once", message: "only the dev server" }, { decision: "allow_once" }] });
    const out = await check(p, "pkill node && rm -rf build");

    t.assert.deepEqual(
      p.asks.map((a) => a.source),
      ["process-kill-guard", "deletion-guard"],
      "both guards ask, the kill first",
    );
    t.assert.equal(out.allowed, true);
    t.assert.equal(out.source, "user");
    t.assert.equal(out.note, "only the dev server", "the note on the kill approval still reaches the model");
  }
}

/* ---- checklist 7: the live half --------------------------------------- */

/** A process name nothing on any machine runs, so the kill itself is harmless. */
const NO_SUCH_PROCESS = "magentra-no-such-process-7f3a.exe";

class ARealSessionNeverRunsItUnasked extends ProcTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  readonly id = "a-real-session-refuses-it-in-overdrive-and-runs-it-only-on-approval";
  readonly whyItExists =
    "a guard can be right in every unit and unwired in the Session — the deletion guard once was — and then the real shell runs the field command anyway";

  #engines: ScriptedEngine[] = [];
  #dirs: string[] = [];
  #savedEnv = new Map<string, string | undefined>();

  /** `loadSettings` merges `~/.magentra/settings.json` over the workspace's, so HOME is redirected. */
  override setUp(): void {
    const home = this.#makeDir("magentra-kill-home-");
    for (const name of ["HOME", "USERPROFILE"] as const) {
      this.#savedEnv.set(name, process.env[name]);
      process.env[name] = home;
    }
  }

  #makeDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    this.#dirs.push(dir);
    return dir;
  }

  /** Engines close before their directories go: a live shell holds its cwd on Windows. */
  override async tearDown(): Promise<void> {
    try {
      for (const engine of this.#engines) await engine.close();
      this.#engines = [];
    } finally {
      for (const [name, value] of this.#savedEnv) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      this.#savedEnv.clear();
      for (const dir of this.#dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
    }
  }

  /** A session whose model issues the field-shaped kill, then writes a marker. Bash is allowed outright. */
  async #session(decision: PermissionDecision, overdrive: boolean): Promise<{ engine: ScriptedEngine; marker: string }> {
    const workspace = this.#makeDir("magentra-kill-ws-");
    const command = `(taskkill //F //IM ${NO_SUCH_PROCESS} //FI "WINDOWTITLE eq *" 2>/dev/null; true) | head -n 2; echo ran > marker.txt`;
    const engine = await startScriptedEngine({
      workspace,
      settings: { permissions: { allow: ["Bash"], deny: [], allowExact: [] } },
      permissions: decision,
      turns: [
        { toolCalls: [{ name: "Bash", input: { command, description: "Stop the running server", run_in_background: false } }] },
        { text: "handled" },
        { text: "nothing further" },
        { text: "nothing further" },
        { text: "nothing further" },
      ],
    });
    this.#engines.push(engine);
    if (overdrive) {
      engine.send({ type: "set_overdrive", enabled: true });
      await engine.waitFor((e) => e.type === "overdrive_changed");
    }
    return { engine, marker: join(workspace, "marker.txt") };
  }

  override async run(t: TestRun): Promise<void> {
    const asked = (events: readonly CoreEvent[]) => events.filter((e) => e.type === "permission_request");

    /* --- OVERDRIVE: refused, never asked, never run ------------------- */
    const od = await this.#session("allow_once", true);
    const odTurn = await od.engine.runTurn("restart the server");
    t.assert.deepEqual(odTurn.errors, [], odTurn.errors.join(" | "));
    t.assert.equal(existsSync(od.marker), false, "the command ran in OVERDRIVE");
    t.assert.equal(asked(odTurn.events).length, 0, "OVERDRIVE asked");
    t.assert.equal(odTurn.toolResults[0]?.isError, true, "the refusal reaches the model as an error it can read");
    t.assert.match(odTurn.toolResults[0]?.resultPreview ?? "", /TaskStop/);

    /* --- normal stance, declined: asked, not run ---------------------- */
    const no = await this.#session("deny", false);
    const noTurn = await no.engine.runTurn("restart the server");
    t.assert.deepEqual(noTurn.errors, [], noTurn.errors.join(" | "));
    const request = asked(noTurn.events)[0] as Extract<CoreEvent, { type: "permission_request" }> | undefined;
    t.assert.equal(asked(noTurn.events).length, 1, "a kill by name asked once");
    t.assert.match(request?.description ?? "", /stops processes by name/i, "and the request says why it asks");
    t.assert.equal(existsSync(no.marker), false, "a declined command ran");

    /* --- normal stance, approved: it really runs ---------------------- */
    const yes = await this.#session("allow_once", false);
    const yesTurn = await yes.engine.runTurn("restart the server");
    t.assert.deepEqual(yesTurn.errors, [], yesTurn.errors.join(" | "));
    t.assert.equal(asked(yesTurn.events).length, 1);
    t.assert.equal(yesTurn.toolResults[0]?.isError, false, `the approved command failed: ${yesTurn.toolResults[0]?.resultPreview}`);
    t.assert.equal(existsSync(yes.marker), true, "the approved command never ran, so the guard refuses what the user allowed");
  }
}

/* ---- checklist 8: the card ------------------------------------------- */

const LOCAL_ENDPOINT = "http://127.0.0.1:11434/v1";

class TheCardSaysWhy extends UiTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  readonly id = "the-approval-card-shows-the-guards-line-in-the-single-console-and-in-a-tiled-pane";
  readonly whyItExists =
    "the desktop card printed only the command, so `taskkill /F /IM python.exe` looked like the agent stopping its own server — the one fact that makes it dangerous never reached the person deciding";

  #workspace(tag: string): string {
    const dir = this.makeTempDir(`magentra-kill-ui-${tag}-`);
    this.writeJsonFile(join(dir, ".magentra", "settings.json"), { provider: "openai-compatible", baseUrl: LOCAL_ENDPOINT, model: `model-${tag}` });
    return dir;
  }

  /** The request the real PermissionEngine makes for `command`, as the engine frames it. */
  async #frame(command: string, id: string, tabId: string): Promise<Record<string, unknown>> {
    let payload: PermissionRequestPayload | undefined;
    const engine = new PermissionEngine({ allow: [], deny: [] }, async (req) => {
      payload = req;
      return { decision: "deny" };
    });
    const input = bashInput(command);
    await engine.check(bashTool, input, command, input.description, "unknown", false, undefined);
    if (!payload) throw new Error(`the permission engine did not ask for ${command}`);
    return { type: "permission_request", id, ...payload, tabId };
  }

  async #card(app: AppHandle): Promise<{ where: string; subject: string; why: string | null }> {
    return app.evaluate(`
      (() => {
        const pane = [...document.querySelectorAll(".pane-approval")].find((el) => !el.classList.contains("hidden"));
        const root = pane || document.getElementById("deleteModal");
        if (!pane && root.classList.contains("hidden")) return { where: "none", subject: "", why: null };
        const subject = (pane ? pane.querySelector(".pane-approval-subject") : document.getElementById("deleteSubject")).textContent.trim();
        const whyEl = pane ? pane.querySelector(".pane-approval-why") : document.getElementById("permissionWhy");
        return { where: pane ? "pane" : "modal", subject, why: whyEl && !whyEl.classList.contains("hidden") ? whyEl.textContent : null };
      })()
    `);
  }

  async #deliverAndRead(app: AppHandle, frame: Record<string, unknown>): Promise<{ where: string; subject: string; why: string | null }> {
    await app.evaluateInMain(`win.webContents.send("engine:event", ${JSON.stringify(frame)}); return true;`);
    return this.waitFor(app, `(() => { const up = document.querySelector(".pane-approval:not(.hidden)") || !document.getElementById("deleteModal").classList.contains("hidden"); return up ? true : null; })()`, "the approval card").then(() => this.#card(app));
  }

  async #deny(app: AppHandle): Promise<void> {
    await app.evaluate(`(() => { const b = document.querySelector(".pane-approval:not(.hidden) .pa-deny") || document.getElementById("denyBtn"); b.click(); return true; })()`);
    await this.waitFor(app, `(!document.querySelector(".pane-approval:not(.hidden)") && document.getElementById("deleteModal").classList.contains("hidden")) ? true : null`, "the card to close");
  }

  override async run(t: TestRun): Promise<void> {
    const home = this.makeTempDir("magentra-kill-ui-home-");
    const first = this.#workspace("a");
    const app = await this.launchApp({ HOME: home, USERPROFILE: home });
    await openWorkspace(app, first);
    await waitForSpawn(first);
    const firstTab = (await this.waitFor(app, `typeof focusedTabId === "string" && focusedTabId ? focusedTabId : null`, "the first tab")) as string;

    const kill = "taskkill /F /IM python.exe";
    const killFrame = await this.#frame(kill, "perm_kill_1", firstTab);
    const single = await this.#deliverAndRead(app, killFrame);
    t.assert.equal(single.where, "modal", "one console answers in the shared modal");
    t.assert.equal(single.subject, kill);
    t.assert.equal(single.why, killFrame["description"], "the guard's line sits under the command");
    await this.#deny(app);

    const deletion = await this.#deliverAndRead(app, await this.#frame("rm -rf build", "perm_rm_1", firstTab));
    t.assert.equal(deletion.subject, "rm -rf build");
    t.assert.equal(deletion.why, null, "a deletion prompt's description is its command, so it adds no line");
    await this.#deny(app);

    // Tiled: a second workspace, and the first tab's card appears in its pane.
    const second = this.#workspace("b");
    await openWorkspace(app, second);
    await waitForSpawn(second);
    await this.waitFor(app, `tabs.size === 2 ? true : null`, "two tiled consoles");
    const tiled = await this.#deliverAndRead(app, await this.#frame(kill, "perm_kill_2", firstTab));
    t.assert.equal(tiled.where, "pane", "tiled consoles answer in their own pane");
    t.assert.equal(tiled.subject, kill);
    t.assert.equal(tiled.why, killFrame["description"], "the pane shows the guard's line too");
    await this.#deny(app);
  }
}

registerFeatureTests(
  new TheClassifier(),
  new OutsideOverdriveItAsks(),
  new InOverdriveItIsRefused(),
  new BroadGrantsNeverCoverIt(),
  new TheLiteralGrantIsTheOverride(),
  new AKillThatAlsoDeletes(),
  new ARealSessionNeverRunsItUnasked(),
  new TheCardSaysWhy(),
);
