/**
 * `promptlab-build-guard`.
 *
 * Prompt Lab sometimes has to compile the repository with `tsc`. It resolves
 * the compiler's own entry script once (`typescript/bin/tsc`) and runs it with
 * `process.execPath` — the same node binary already running the server — with
 * no shell involved. It never spawns `npx tsc`: on Windows `npx` is `npx.cmd`,
 * and `execFile` without a shell cannot start a `.cmd` file at all, so that
 * invocation failed with ENOENT before the compiler was ever reached. The
 * failure was invisible in both places it happened — `promote` reported
 * "typecheck failed" with an empty body, and startup printed "BUILD FAILED"
 * with nothing after it — because both call sites fall back to `err.message`
 * only when `err.stdout`/`err.stderr` are both empty, and an `ENOENT` from
 * `execFile` carries neither.
 *
 * `proc`, as the record declares. `tools/prompt-lab/server.mjs` EXPORTS
 * NOTHING and starts building and listening as a side effect of being
 * imported (see `promptlab-promote.test.ts`, which established this first and
 * is this suite's read-only reference for the point) — so every clause below
 * is proven through the REAL SERVER PROCESS, spawned from a sandbox copy of
 * it, never through a stub or an added export.
 *
 * THE SANDBOX differs from `promptlab-promote.test.ts`'s in exactly one way,
 * used only by the two classes that need it: instead of junctioning the whole
 * of this repository's `node_modules` (which contains `typescript`), it
 * junctions ONLY `node_modules/@magentra/{core,tools,protocol}` — the three
 * packages `server.mjs` imports. Node's module resolution walks up from a
 * required module's REAL (symlink-resolved) directory, so those three still
 * find every one of THEIR OWN dependencies (`zod`, `fast-glob`, …) in this
 * repository's real `node_modules` once loaded; what genuinely disappears is
 * `typescript` itself, because the sandbox root has no `node_modules/typescript`
 * and neither does anything above it in a temp directory's ancestry. This is a
 * real absence — the one `npm install` never having run would produce — not a
 * stub standing in for one.
 *
 * ONE CLAUSE COULD NOT BE PROVEN AS WRITTEN, and is recorded as blocked rather
 * than quietly weakened: the ready description's checklist item 3 asks for
 * "execFile stubbed to reject with … 'spawn ENOENT'". `execFile` is not
 * exported, and reproducing a REAL execFile-level ENOENT against
 * `process.execPath` (always a valid path — it is this process's own
 * interpreter) is not achievable without either a stub or deleting the
 * server's own working directory out from under itself while it runs — both
 * excluded here. What IS proven for real, by the second class below, is the
 * identical fallback this guards: an error with no `stdout`/`stderr` at all
 * (the exact shape an ENOENT carries) reaching both `ensureBuilt()` and
 * `promote()`, via `tscBuild()` throwing synchronously because `typescript`
 * cannot be resolved — the other real way this repository can put `execFile`'s
 * catch handler in that shape.
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { ProcTest, type ProcHandle } from "../lib/procTest.ts";
import { repoRoot } from "../lib/inventory.ts";

const FEATURE = "promptlab-build-guard";

/** Verbatim from the record. */
const INVARIANT = "The TypeScript entry script runs under the already-executing node binary, with no shell in the path, on every platform.";

interface Answer {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

interface CatalogPrompt {
  readonly id?: string;
  readonly defaultText?: string;
}

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

abstract class BuildGuardTest extends ProcTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  /** A boot can compile the sandbox with the real tsc. */
  override readonly timeoutMs: number = 180_000;

  #tmps: string[] = [];
  #port = 0;

  override async tearDown(): Promise<void> {
    for (const child of this.children) {
      if (!child.hasExited()) {
        child.kill();
        await child.exited();
      }
    }
    for (const tmp of this.#tmps) rmSync(tmp, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
    this.#tmps = [];
  }

  /** The parts every sandbox needs, regardless of what `node_modules` ends up holding. */
  protected buildSandboxFiles(): { tmp: string; overrides: string; engineDir: string } {
    const tmp = mkdtempSync(join(tmpdir(), "magentra-buildguard-"));
    this.#tmps.push(tmp);

    mkdirSync(join(tmp, "tools", "prompt-lab"), { recursive: true });
    const from = join(repoRoot(), "tools", "prompt-lab");
    copyFileSync(join(from, "server.mjs"), join(tmp, "tools", "prompt-lab", "server.mjs"));
    copyFileSync(join(from, "index.html"), join(tmp, "tools", "prompt-lab", "index.html"));

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
    const engineDir = join(tmp, "engine");
    mkdirSync(engineDir, { recursive: true });
    // Trivial and valid: newer than the (nonexistent) `out/`, so ensureBuilt()
    // always decides a build is needed — that decision is what makes every
    // class below actually reach `tscBuild()` at startup.
    writeFileSync(join(engineDir, "a.ts"), "export const A: number = 1;\n", "utf8");

    const overrides = join(tmp, "overrides");
    mkdirSync(overrides, { recursive: true });
    const home = join(tmp, "home");
    mkdirSync(home, { recursive: true });

    return { tmp, overrides, engineDir };
  }

  /** `typescript` fully resolvable — the fix, exercised for real. */
  protected linkFullNodeModules(tmp: string): void {
    symlinkSync(join(repoRoot(), "node_modules"), join(tmp, "node_modules"), "junction");
  }

  /**
   * `@magentra/{core,tools,protocol}` resolvable, `typescript` genuinely NOT —
   * see the header for why this is a real absence and not a stub.
   */
  protected linkRestrictedNodeModules(tmp: string): void {
    mkdirSync(join(tmp, "node_modules", "@magentra"), { recursive: true });
    for (const name of ["core", "tools", "protocol"]) {
      symlinkSync(join(repoRoot(), "node_modules", "@magentra", name), join(tmp, "node_modules", "@magentra", name), "junction");
    }
  }

  /** Boots the sandboxed server and waits for its banner — which prints whether or not the build inside it failed. */
  protected async startLab(tmp: string, overrides: string): Promise<{ child: ProcHandle; port: number }> {
    this.#port = await freePort();
    const home = join(tmp, "home");
    const child = this.spawn(process.execPath, [join(tmp, "tools", "prompt-lab", "server.mjs"), "--dir", overrides, "--port", String(this.#port)], {
      cwd: tmp,
      label: `prompt-lab on 127.0.0.1:${this.#port}`,
      env: { HOME: home, USERPROFILE: home, MAGENTRA_PROMPTS_DIR: undefined },
    });
    await child.nextLine((line) => line.includes(`http://127.0.0.1:${this.#port}`), 150_000);
    return { child, port: this.#port };
  }

  protected async call(method: string, path: string, body?: string): Promise<Answer> {
    return await new Promise<Answer>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: this.#port, path, method }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) as Record<string, unknown> }));
      });
      req.on("error", reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  }
}

/* ---- checklist 1 ----------------------------------------------------- */

class TheCompilerIsNeverInvokedThroughNpxOrAShell extends BuildGuardTest {
  readonly id = "the-source-invokes-the-compiler-with-the-running-node-binary-and-no-shell";
  readonly whyItExists =
    "invoking the compiler through 'npx tsc' or with a shell would put a .cmd shim, or a branch/path string, in a position to fail silently or run as a command on Windows — the exact failure this feature removed";

  override run(t: TestRun): void {
    const source = readFileSync(join(repoRoot(), "tools", "prompt-lab", "server.mjs"), "utf8");

    // The word "npx" appears once, in the comment explaining why it is NOT
    // used — so the check is for npx as a literal command argument, not for
    // the word's absence from the file entirely.
    t.assert.equal(/["']npx(\.cmd)?["']/.test(source), false, "npx must never appear as a command string passed to a child-process call");
    t.assert.equal(/\bshell\s*:\s*true/.test(source), false, "no child-process call may pass shell: true");

    const runCalls = [...source.matchAll(/\brun\(([^)]*)\)/gs)];
    t.assert.equal(runCalls.length, 1, "every compiler invocation must funnel through the one tscBuild() call site");
    t.assert.match(
      runCalls[0]?.[1] ?? "",
      /^\s*process\.execPath\s*,\s*\[TSC,\s*"-b"\]/,
      "the compiler must be run as an argument to the current node binary, not as its own command",
    );

    t.assert.match(source, /const TSC = \(\(\) => \{/, "TSC must be resolved once, not re-resolved per call");
    t.assert.match(source, /\.resolve\(\s*"typescript\/bin\/tsc"\s*\)/, "the compiler's own entry script must be resolved by name, not guessed at a fixed path");
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class WhenTypescriptCannotBeResolvedStartupNeverAttemptsASpawn extends BuildGuardTest {
  readonly id = "an-unresolvable-typescript-fails-the-startup-build-with-its-own-cause-and-never-spawns";
  readonly whyItExists =
    "startup used to print a bare 'BUILD FAILED' with nothing after it when the compiler could not even be reached, leaving the operator with no idea whether the repository was actually broken or the guard itself was";

  override async run(t: TestRun): Promise<void> {
    const { tmp, overrides } = this.buildSandboxFiles();
    this.linkRestrictedNodeModules(tmp);

    // `startLab` waits for the banner, which prints once the server actually
    // reaches `server.listen(...)` — after `ensureBuilt()` has already run and
    // (in this sandbox) already failed, so its stdout by then carries both.
    const { child } = await this.startLab(tmp, overrides);
    const stdout = child.stdout();

    t.assert.match(stdout, /BUILD FAILED — defaults may not match source:/, "the header must still print — this is not about hiding the failure");
    t.assert.match(stdout, /typescript is not installed — run `npm install`/, "the real cause must follow the header, not an empty line");
    t.assert.equal(stdout.includes("ENOENT"), false, "no spawn was ever attempted, so no spawn error can appear");
    t.assert.match(stdout, /Prompt Lab — \d+ prompts/, "the guard must not stop the server from booting and serving the real catalog afterward");
  }
}

/* ---- checklist 3 (see the header for what this substitutes, and why) -- */

class WhenTypescriptCannotBeResolvedPromoteRevertsWithoutASpawnEither extends BuildGuardTest {
  readonly id = "an-unresolvable-typescript-makes-promote-report-a-real-cause-and-revert-without-a-spawn";
  readonly whyItExists =
    "promote used to catch an ENOENT the same way ensureBuilt() did — an empty stdout and stderr — and report 'typecheck failed' with nothing after it, leaving the operator unable to tell a real compile error from the guard never having run at all";

  override async run(t: TestRun): Promise<void> {
    const { tmp, overrides, engineDir } = this.buildSandboxFiles();
    this.linkRestrictedNodeModules(tmp);
    await this.startLab(tmp, overrides);

    const before = await this.call("GET", "/api/catalog");
    t.assert.equal(before.status, 200, "the server must be up despite the startup build having failed");
    const prompts = (before.body["prompts"] ?? []) as CatalogPrompt[];
    // Short, plain candidates — long enough odds that ordinary prose round-trips
    // through toSourceLiteral()'s escaping the same way JSON.stringify's does.
    const candidates = prompts.filter((p) => (p.defaultText?.length ?? 999) < 80 && !/[`\\]/.test(p.defaultText ?? "")).slice(0, 8);
    t.assert.ok(candidates.length > 0, "the real registry must have at least one short, plantable default");

    // Planted AFTER boot, in a real .ts source file — `sourceFiles()` rescans
    // on every call, keyed off directory contents and mtimes, so this is
    // picked up the same way an operator's own edit to the checked-out
    // sources would be. Each candidate gets its own file; whichever one
    // `locateLiteral` actually confirms is the one this test proceeds with.
    candidates.forEach((p, i) => {
      writeFileSync(join(engineDir, `planted-${i}.ts`), `export const PLANTED_${i} = ${JSON.stringify(p.defaultText)};\n`, "utf8");
    });
    const located = await this.call("GET", "/api/catalog");
    const source = (located.body["source"] ?? {}) as Record<string, { ok?: boolean }>;
    const chosenIndex = candidates.findIndex((p) => source[p.id ?? ""]?.ok === true);
    t.assert.notEqual(chosenIndex, -1, `none of the planted candidates were located: ${JSON.stringify(source)}`);
    const id = candidates[chosenIndex]!.id!;
    const plantedFile = join(engineDir, `planted-${chosenIndex}.ts`);

    const beforeBytes = readFileSync(plantedFile, "utf8");
    const promoted = await this.call("POST", `/api/promote/${encodeURIComponent(id)}`, "a replacement the compiler is never reached to typecheck");

    t.assert.equal(promoted.status, 409);
    t.assert.equal(promoted.body["ok"], false);
    t.assert.equal(promoted.body["reverted"], true, "reverted must be true — the file was written, then put back, never left half-edited");
    t.assert.match(String(promoted.body["reason"]), /^typecheck failed/);
    t.assert.match(String(promoted.body["reason"]), /typescript is not installed — run `npm install`/, "the real cause must follow, not an empty body");
    t.assert.equal(String(promoted.body["reason"]).includes("ENOENT"), false, "no spawn was attempted here either");

    t.assert.equal(readFileSync(plantedFile, "utf8"), beforeBytes, "the planted file must be byte-identical after the revert");
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class TheRealCompilerRunsWithNoCmdShimInThePath extends BuildGuardTest {
  readonly id = "the-real-compiler-runs-to-completion-with-no-cmd-shim-in-the-path";
  readonly whyItExists =
    "the bug this feature fixed was exactly this call resolving to a .cmd file and failing with ENOENT before the compiler ever ran — proving the real invocation completes (or fails on its own compiler output) is the only way to know the fix still holds on the platform where the bug existed";

  override async run(t: TestRun): Promise<void> {
    if (process.platform === "win32") {
      // The ground truth this feature routes around: on Windows, `npx` is
      // `npx.cmd`, and `execFile` with no shell cannot start a `.cmd` at all.
      const probe = spawnSync("npx", ["--version"], { encoding: "utf8" });
      t.assert.notEqual(probe.status, 0, "npx must fail to spawn directly on this platform — otherwise this feature is not testing what it claims to fix");
      t.assert.match(String(probe.error?.message ?? probe.stderr ?? ""), /ENOENT/i, "the failure must be the ENOENT this feature routes around");
    }

    const { tmp, overrides } = this.buildSandboxFiles();
    this.linkFullNodeModules(tmp);

    const { child } = await this.startLab(tmp, overrides);
    const stdout = child.stdout();

    t.assert.equal(stdout.includes("BUILD FAILED"), false, "with a real, resolvable typescript the trivial fixture must actually compile — no failure to fall back from");
    t.assert.equal(stdout.includes("ENOENT"), false, "the real compiler entry script, run under process.execPath, must not hit the shim failure");
    t.assert.match(stdout, /Prompt Lab — \d+ prompts/, "and the server must still reach its banner");
  }
}

registerFeatureTests(
  new TheCompilerIsNeverInvokedThroughNpxOrAShell(),
  new WhenTypescriptCannotBeResolvedStartupNeverAttemptsASpawn(),
  new WhenTypescriptCannotBeResolvedPromoteRevertsWithoutASpawnEither(),
  new TheRealCompilerRunsWithNoCmdShimInThePath(),
);
