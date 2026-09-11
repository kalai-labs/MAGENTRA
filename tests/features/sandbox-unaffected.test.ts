/**
 * `sandbox-unaffected`.
 *
 * Chromium decides about its sandbox before any application code runs, and dies
 * with a FATAL on distros that restrict unprivileged user namespaces. So the
 * Linux package ships a shell wrapper in front of the binary, and that wrapper
 * adds `--no-sandbox` only when Chromium genuinely has no sandbox path.
 *
 * Then the terminal UI was added to the same wrapper. The risk is entirely
 * one-directional: if the TUI branch changed the GUI path, or let a
 * double-click bypass the wrapper, a user on such a distro would see nothing at
 * all — no window, no error. So what is tested here is that the sandbox logic
 * is untouched and still reached.
 *
 * `fs` for the packaging step (it renames a binary and writes a file), `proc`
 * for the wrapper itself — a shell script's behaviour is only knowable by
 * running it under a shell.
 *
 * THE WRAPPER IS A LINUX ARTIFACT, AND THE SUITE RUNS EVERYWHERE. What each
 * platform can express differs, and the tests say so rather than pretending
 * otherwise — the same reasoning that makes a file-mode assertion meaningless
 * on Windows:
 *
 *   - The TEXT of the wrapper, and what packaging does per platform, are facts
 *     everywhere. They are asserted unconditionally.
 *   - RUNNING it needs a POSIX shell. macOS and Linux have one and run the
 *     wrapper for real, including under a pseudo-terminal. Windows has neither
 *     `/bin/sh` nor `script(1)`, and ships no wrapper at all — `afterPack`'s
 *     win32 branch writes a console-subsystem copy instead — so what is
 *     asserted there is that no wrapper is produced, which is the Windows truth
 *     rather than a skipped Linux one.
 *
 * The `/proc` reads the wrapper makes all fall back (`|| echo`), so the branch
 * it takes on a developer machine is the sandbox-usable one — which is the
 * branch a desktop launch must reach.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";
import { repoRoot } from "../lib/inventory.ts";
import { ProcTest } from "../lib/procTest.ts";

const FEATURE = "sandbox-unaffected";

/** Verbatim from the record. */
const INVARIANT = "Packaging does not disturb Electron's sandbox detection on Linux.";

const requireFromHere = createRequire(import.meta.url);

type AfterPack = (context: { electronPlatformName: string; appOutDir: string; packager?: unknown }) => Promise<void>;

function afterPack(): AfterPack {
  return requireFromHere(join(repoRoot(), "app", "scripts", "afterPack.js")) as AfterPack;
}

/**
 * The sandbox decision, as it stood before the terminal UI was added to the
 * wrapper. Every line of it must still be there, unchanged — this is the golden
 * copy the checklist asks for, and the reason it is written out here rather
 * than read from the file is that reading the file would compare it with
 * itself.
 */
const GOLDEN_SANDBOX_LOGIC = [
  'case " $* " in *" --no-sandbox "*) exec "$BIN" "$@" ;; esac',
  "sandbox_usable() {",
  '  [ "$(id -u)" = "0" ] && return 1',
  '  if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" != "1" ] &&',
  '     [ "$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null || echo 1)" != "0" ]; then',
  "    return 0",
  '  if [ -u "$DIR/chrome-sandbox" ] && [ "$(stat -c %u "$DIR/chrome-sandbox" 2>/dev/null)" = "0" ]; then',
  "if sandbox_usable; then",
  '  exec "$BIN" "$@"',
  'exec "$BIN" "$@" --no-sandbox',
] as const;

/* ---- checklist 1 and 5 (the platform half) — fs ------------------------ */

class PackagingWrapsTheLinuxBinary extends FsTest {
  readonly featureId = FEATURE;
  readonly id = "packaging-renames-the-linux-binary-and-writes-the-wrapper";
  readonly invariant = INVARIANT;
  readonly whyItExists =
    "the wrapper is the only thing standing between a restricted-namespace distro and a FATAL at launch, and it exists solely because packaging put it there";

  override async run(t: TestRun): Promise<void> {
    const out = this.tempDir("magentra-pack-");
    const original = "#!/usr/bin/env true\nthe real electron binary\n";
    writeFileSync(join(out, "magentra"), original, { encoding: "utf8", mode: 0o755 });

    await afterPack()({ electronPlatformName: "linux", appOutDir: out });

    const moved = readFileSync(join(out, "magentra-bin"), "utf8");
    t.assert.equal(moved, original, "the real binary must survive, under its new name");

    const wrapper = readFileSync(join(out, "magentra"), "utf8");
    t.assert.ok(wrapper.startsWith("#!/bin/sh"), "what takes its place must be a shell script");
    t.assert.match(wrapper, /magentra-bin/, "and it must launch the binary it displaced");
    if (process.platform !== "win32") {
      t.assert.equal(statSync(join(out, "magentra")).mode & 0o777, 0o755, "a launcher nobody can execute is not a launcher");
    }

    // Checklist 5's other half: no other platform gets its binary renamed.
    for (const platform of ["win32", "darwin", "freebsd"]) {
      const other = this.tempDir(`magentra-${platform}-`);
      writeFileSync(join(other, "magentra"), original, { encoding: "utf8", mode: 0o755 });
      try {
        await afterPack()({
          electronPlatformName: platform,
          appOutDir: other,
          packager: { appInfo: { productFilename: "MAGENTRA" } },
        });
      } catch {
        // win32 wants a real PE to copy; what matters is what it did NOT do.
      }
      t.assert.equal(existsSync(join(other, "magentra-bin")), false, `${platform} must not have its binary renamed`);
      t.assert.equal(readFileSync(join(other, "magentra"), "utf8"), original, `${platform} must not have its binary replaced`);
    }
  }
}

/**
 * Run a command attached to a pseudo-terminal, so `[ -t 0 ]` is true.
 *
 * `script(1)` is the portable way to get one without a pty binding, and its
 * argument order differs between BSD and util-linux. There is no fallback: a
 * platform where this cannot run is a platform where the terminal branch cannot
 * be tested, and the test says so rather than quietly proving less.
 */
function ptyRun(command: string, args: readonly string[]): [string, string[]] {
  const line = [command, ...args].map((a) => `"${a}"`).join(" ");
  // `script`'s OWN stdin must not be a pipe: it copies terminal attributes from
  // it, and a socket makes it exit with "tcgetattr/ioctl: Operation not
  // supported". A test spawns with piped stdio, so the redirection happens
  // inside a shell, before script is exec'd.
  const inner = process.platform === "linux"
    ? `exec script -qec "/bin/sh ${line}" /dev/null < /dev/null`
    : `exec script -q /dev/null /bin/sh ${line} < /dev/null`;
  return ["/bin/sh", ["-c", inner]];
}

/* ---- checklist 2, 3, 4 — proc ----------------------------------------- */

class TheWrapperStillDecidesTheSandbox extends ProcTest {
  readonly featureId = FEATURE;
  readonly id = "the-wrapper-reaches-the-sandbox-decision-not-the-tui";
  readonly invariant = INVARIANT;
  readonly whyItExists =
    "the terminal UI was added to the front of this wrapper; a branch that swallowed a desktop launch would leave a double-click user on a restricted distro with no window and no message";

  /** EVERY staged tree, not the last one: `#stage` is called several times per
   *  run, and keeping only the most recent leaked the rest into the temp
   *  directory — 177 of them before anyone counted. */
  #dirs: string[] = [];

  override async tearDown(): Promise<void> {
    for (const child of this.children) {
      if (!child.hasExited()) {
        child.kill();
        await child.exited();
      }
    }
    for (const dir of this.#dirs) rmSync(dir, { recursive: true, force: true });
    this.#dirs = [];
  }

  /** A packaged tree: the wrapper, a stub binary that records how it was called, and a stub TUI. */
  #stage(withTui: boolean): { dir: string; wrapper: string; record: string } {
    const dir = mkdtempSync(join(tmpdir(), "magentra-wrap-"));
    this.#dirs.push(dir);
    const record = join(dir, "argv.txt");

    const source = readFileSync(join(repoRoot(), "app", "scripts", "afterPack.js"), "utf8");
    const start = source.indexOf("const WRAPPER = `") + "const WRAPPER = `".length;
    const wrapperText = source.slice(start, source.indexOf("\n`;", start));
    writeFileSync(join(dir, "magentra"), wrapperText, { encoding: "utf8", mode: 0o755 });
    chmodSync(join(dir, "magentra"), 0o755);

    // The stub stands in for Electron: it records its argv and exits.
    writeFileSync(
      join(dir, "magentra-bin"),
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(record)}\nprintf 'RUN_AS_NODE=%s\\n' "$ELECTRON_RUN_AS_NODE" >> ${JSON.stringify(record)}\nexit 0\n`,
      { encoding: "utf8", mode: 0o755 },
    );
    chmodSync(join(dir, "magentra-bin"), 0o755);

    if (withTui) {
      mkdirSync(join(dir, "resources", "engine"), { recursive: true });
      writeFileSync(join(dir, "resources", "engine", "tui.mjs"), "process.exit(0);\n");
    }
    return { dir, wrapper: join(dir, "magentra"), record };
  }

  override async run(t: TestRun): Promise<void> {
    // Checklist 2: the sandbox decision, line for line.
    const wrapperSource = readFileSync(join(repoRoot(), "app", "scripts", "afterPack.js"), "utf8");
    for (const line of GOLDEN_SANDBOX_LOGIC) {
      t.assert.ok(
        wrapperSource.includes(line),
        `the wrapper no longer contains the sandbox line:\n    ${line}\nChromium decides about its sandbox before any app code runs, so this shell is the only place the decision can be made.`,
      );
    }
    // The TUI branch must sit in FRONT of that decision, never inside it.
    t.assert.ok(
      wrapperSource.indexOf("ELECTRON_RUN_AS_NODE=1 exec") < wrapperSource.indexOf("sandbox_usable()"),
      "the terminal branch must come before the sandbox logic, so the GUI path still falls through it",
    );

    if (process.platform === "win32") {
      // No POSIX shell, and no wrapper shipped: what Windows can express is
      // that packaging leaves its binary alone and writes the console copy
      // instead. Asserted here so the run is not silently thinner.
      const out = mkdtempSync(join(tmpdir(), "magentra-win-"));
      try {
        writeFileSync(join(out, "MAGENTRA.exe"), "not a real PE", "utf8");
        await afterPack()({ electronPlatformName: "win32", appOutDir: out }).catch(() => undefined);
        t.assert.equal(existsSync(join(out, "magentra-bin")), false, "Windows ships no launcher wrapper, so nothing may be renamed");
      } finally {
        rmSync(out, { recursive: true, force: true });
      }
      return;
    }

    // Checklist 3: no TTY, a TUI present — the GUI branch must still be taken.
    const staged = this.#stage(true);
    const notATty = this.spawn("/bin/sh", [staged.wrapper], { cwd: staged.dir, label: "wrapper (no tty)" });
    notATty.endInput();
    const exit = await notATty.exited();
    t.assert.equal(exit.code, 0, `the wrapper failed: ${notATty.stderr()}`);
    t.assert.equal(existsSync(staged.record), true, "the GUI binary must have been executed when there is no terminal");
    t.assert.doesNotMatch(readFileSync(staged.record, "utf8"), /tui\.mjs/, "a desktop launch must never be handed to the terminal UI");

    // Checklist 4: --gui is explicit, and must reach the binary with its flag intact.
    const gui = this.#stage(true);
    const explicit = this.spawn("/bin/sh", [gui.wrapper, "--gui"], { cwd: gui.dir, label: "wrapper (--gui)" });
    explicit.endInput();
    await explicit.exited();
    const argv = readFileSync(gui.record, "utf8");
    t.assert.match(argv, /--gui/, "the flag the user passed must reach the binary");
    t.assert.doesNotMatch(argv, /tui\.mjs/, "--gui must never reach the terminal UI");

    // And with no TUI installed at all, the GUI path is the only one there is.
    const bare = this.#stage(false);
    const withoutTui = this.spawn("/bin/sh", [bare.wrapper], { cwd: bare.dir, label: "wrapper (no tui)" });
    withoutTui.endInput();
    await withoutTui.exited();
    t.assert.equal(existsSync(bare.record), true, "with no tui.mjs present the binary must still launch");

    // THE BRANCH THAT ONLY EXISTS WITH A TERMINAL. Everything above runs with
    // piped stdio, where `[ -t 0 ]` is false and the TUI branch can never be
    // reached — so `--gui` has nothing to opt out of, and a mutation that broke
    // the flag passed unnoticed. A pty is what makes the two paths distinct.
    const terminal = this.#stage(true);
    const tui = this.spawn(...ptyRun(terminal.wrapper, []), { cwd: terminal.dir, label: "wrapper (pty)" });
    tui.endInput();
    await tui.exited();
    t.assert.equal(existsSync(terminal.record), true, `a terminal launch produced nothing — is script(1) present? ${tui.stderr()}`);
    const terminalArgv = readFileSync(terminal.record, "utf8");
    t.assert.match(terminalArgv, /tui\.mjs/, "with a terminal and no --gui, the terminal UI is what should run");
    t.assert.match(terminalArgv, /RUN_AS_NODE=1/, "and it must run through Electron's Node, which starts no Chromium");

    // The same terminal, with --gui: the desktop path, and therefore the
    // sandbox decision, must be what happens.
    const optedOut = this.#stage(true);
    const gui2 = this.spawn(...ptyRun(optedOut.wrapper, ["--gui"]), { cwd: optedOut.dir, label: "wrapper (pty --gui)" });
    gui2.endInput();
    await gui2.exited();
    const optedArgv = readFileSync(optedOut.record, "utf8");
    t.assert.doesNotMatch(optedArgv, /tui\.mjs/, "--gui from a terminal must still reach the GUI, and the sandbox check with it");
    t.assert.match(optedArgv, /--gui/);
  }
}

registerFeatureTests(new PackagingWrapsTheLinuxBinary(), new TheWrapperStillDecidesTheSandbox());
