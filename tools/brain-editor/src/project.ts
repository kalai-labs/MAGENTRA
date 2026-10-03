/**
 * What the editor knows about the repository around a brain: which tests hold
 * the shipped brain's tool access and knob values, which engine file uses each
 * prompt, which prompts this machine overrides, whether the engine was built
 * from the brain on disk, and the build itself.
 *
 * Each answer is read from the place that owns it — the compiler, the built
 * protocol package, the root package.json's `build` script — never restated.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { GENERATED_MODULE, REPO, SHIPPED_BRAIN, compiler } from "./compiler.ts";

/** Whether `dir` is the brain the engine is built from (brain/ in this repo). */
export function isShippedBrain(dir: string): boolean {
  try {
    return realpathSync(resolve(dir)) === realpathSync(SHIPPED_BRAIN);
  } catch {
    return false;
  }
}

/* ---- the tests that hold the shipped brain -------------------------------- */

export interface Holder {
  /** The feature id whose test fails when this file changes, until a person updates what it expects. */
  readonly test: string;
  /** What that test compares the file against, in plain words. */
  readonly why: string;
}

const AVAILABILITY: Holder = {
  test: "brain-is-the-single-source",
  why: "The shipped tool access is checked: every built-in tool except Agent and Workflow, in both contexts.",
};
const BEHAVIOR: Holder = {
  test: "brain-controls-behavior",
  why: "The shipped knob values are checked against the constants the engine used before behavior.json existed.",
};

/**
 * The tests a change to `path` (brain-relative, "/"-separated) makes fail in
 * the SHIPPED brain. Prompt and tool texts are held by no test: rewording them
 * is free. A profile folder is held by nothing.
 */
export function holdersOf(path: string, shipped: boolean): Holder[] {
  if (!shipped) return [];
  if (path === "availability.json") return [AVAILABILITY];
  if (path === "behavior.json") return [BEHAVIOR];
  return [];
}

/* ---- which engine file uses a prompt ------------------------------------- */

/** Prompt id → the engine source file that names it with brainPrompt("<id>"), read off the source by the compiler. */
export function promptUsers(): Map<string, string> {
  return compiler.brainPromptIdsInSource(REPO);
}

/* ---- this machine's prompt overrides ------------------------------------- */

export interface LocalOverride {
  readonly file: string;
  /** A blank override file switches the prompt off on this machine. */
  readonly blank: boolean;
}

/**
 * Prompt id → its override file on this machine (`~/.magentra/prompts/<id>.txt`,
 * or `$MAGENTRA_PROMPTS_DIR`). The directory comes from the built protocol
 * package's own `promptsDir()`, so the editor and the engine can never disagree
 * about where overrides live. Undefined when the engine is not built yet.
 */
export async function localOverrides(): Promise<{ dir: string; byId: Map<string, LocalOverride> } | undefined> {
  const built = join(REPO, "engine", "protocol", "dist", "prompts.js");
  if (!existsSync(built)) return undefined;
  const { promptsDir } = (await import(pathToFileURL(built).href)) as { promptsDir(): string };
  const dir = promptsDir();
  const byId = new Map<string, LocalOverride>();
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return { dir, byId };
  }
  for (const name of names) {
    if (!name.endsWith(".txt")) continue;
    const file = join(dir, name);
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    byId.set(name.slice(0, -4), { file, blank: text.trim() === "" });
  }
  return { dir, byId };
}

/* ---- is the engine built from this brain? -------------------------------- */

export type EngineState =
  /** engine/protocol/src/brain.generated.ts is a fresh compile of brain/. */
  | "current"
  /** brain/ compiles, but the generated module is older: run the build. */
  | "needs-build"
  /** brain/ does not compile; the build would fail. */
  | "broken";

/** The same comparison `node tools/brain/compile.mjs --check` makes. */
export function engineState(): EngineState {
  const result = compiler.compileBrain(SHIPPED_BRAIN, { complete: true });
  if (result.problems.length > 0 || result.source === undefined) return "broken";
  const current = existsSync(GENERATED_MODULE) ? readFileSync(GENERATED_MODULE, "utf8") : undefined;
  return current === result.source ? "current" : "needs-build";
}

/* ---- the build ------------------------------------------------------------ */

export interface BuildRun {
  readonly running: boolean;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly exitCode?: number | null;
  readonly log: string;
}

/**
 * Runs the root `npm run build` — the package script itself, so the editor
 * never holds a second copy of what a build is. Under `npm run brain-editor`
 * npm exports `npm_execpath`, and node runs it directly (no shell, which also
 * avoids npm.cmd on Windows). Started any other way, it falls back to `npm` on
 * the PATH.
 */
export function startBuild(onChange: (run: BuildRun) => void): BuildRun {
  const startedAt = new Date().toISOString();
  let log = "";
  const npmCli = process.env.npm_execpath;
  const child: ChildProcess =
    npmCli && /\.c?js$/.test(npmCli)
      ? spawn(process.execPath, [npmCli, "run", "build"], { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] })
      : spawn("npm", ["run", "build"], { cwd: REPO, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
  const emit = (extra: Partial<BuildRun> = {}): void => onChange({ running: true, startedAt, log, ...extra });
  const take = (chunk: Buffer): void => {
    log = (log + chunk.toString("utf8")).slice(-200_000);
    emit();
  };
  child.stdout?.on("data", take);
  child.stderr?.on("data", take);
  child.on("error", (err) => {
    log += `\n${err.message}\n`;
    onChange({ running: false, startedAt, finishedAt: new Date().toISOString(), exitCode: null, log });
  });
  child.on("close", (code) => onChange({ running: false, startedAt, finishedAt: new Date().toISOString(), exitCode: code, log }));
  return { running: true, startedAt, log };
}
