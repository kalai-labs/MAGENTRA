/**
 * Asking the built engine about a brain — the check the compiler cannot make.
 *
 * The compiler proves a brain is well formed. Only the engine knows what it
 * reads at load: every `toolParam("Read", "limit")` must find its section,
 * every `assertToolParamStates` must find the value the code uses, every
 * `brainPrompt` id must exist. probe.mjs loads the last build of the engine
 * with a brain swapped in and reports that, plus the two pinned artifacts
 * rendered by the tests' own printers.
 *
 * Needs a built engine (engine/*\/dist) and Node 22.18 or newer (module hooks
 * and TypeScript type stripping, which the test suite needs as well). Without
 * them the probe reports itself unavailable and the editor falls back to the
 * compiler alone, saying so.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as nodeModule from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { REPO } from "./compiler.ts";

export interface PinCheck {
  readonly holds: boolean;
  /** The first line that differs, when it does not hold. */
  readonly difference?: string;
}

export type ProbeResult =
  | {
      readonly available: true;
      /** The engine loaded with this brain. False means a build from it would start an engine that throws on load. */
      readonly ok: boolean;
      readonly error?: string;
      /** The standing system prompt, as the pin renders it. */
      readonly systemPrompt?: string;
      readonly toolContractHash?: string;
      readonly pins?: Readonly<Record<"system-prompt-is-pinned" | "tool-wire-contract-is-pinned", PinCheck>>;
      /** Parameter texts no tool reads: they are never sent. */
      readonly unreadParams?: readonly string[];
    }
  | { readonly available: false; readonly reason: string };

const PROBE = join(dirname(fileURLToPath(import.meta.url)), "probe.mjs");

/** Why the probe cannot run here, or undefined when it can. */
export function probeUnavailable(): string | undefined {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  const stripper = (nodeModule as { stripTypeScriptTypes?: unknown }).stripTypeScriptTypes;
  if (major < 22 || (major === 22 && minor < 18) || typeof stripper !== "function") {
    return `the engine check needs Node 22.18 or newer (this is ${process.versions.node})`;
  }
  for (const pkg of ["protocol", "tools", "core"]) {
    if (!existsSync(join(REPO, "engine", pkg, "dist", "index.js"))) return "the engine is not built yet: run the build once";
  }
  return undefined;
}

const cache = new Map<string, Promise<ProbeResult>>();

/**
 * What the built engine makes of a compiled brain (`source`, the generated
 * module text compileBrain returns). Cached by that text: a probe is a child
 * process, and the same brain gives the same answer until the engine is rebuilt
 * ({@link forgetProbes}).
 */
export function probeBrain(source: string): Promise<ProbeResult> {
  const unavailable = probeUnavailable();
  if (unavailable !== undefined) return Promise.resolve({ available: false, reason: unavailable });
  const hit = cache.get(source);
  if (hit) return hit;
  const run = runProbe(source);
  cache.set(source, run);
  if (cache.size > 16) cache.delete(cache.keys().next().value!);
  return run;
}

/** Drops every cached answer; the engine they describe was just rebuilt. */
export function forgetProbes(): void {
  cache.clear();
}

async function runProbe(source: string): Promise<ProbeResult> {
  const work = mkdtempSync(join(tmpdir(), "magentra-brain-probe-"));
  try {
    const generated = join(work, "brain.generated.ts");
    writeFileSync(generated, source, "utf8");
    const noOverrides = join(work, "no-overrides");
    mkdirSync(noOverrides);
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        process.execPath,
        ["--no-warnings", PROBE],
        {
          cwd: REPO,
          env: { ...process.env, BRAIN_PROBE_GENERATED: generated, MAGENTRA_PROMPTS_DIR: noOverrides },
          maxBuffer: 32 * 1024 * 1024,
          timeout: 60_000,
          windowsHide: true,
        },
        (err, out, errText) => {
          if (out.trim()) resolve(out);
          else reject(new Error(err ? `${err.message}\n${errText}` : `no answer\n${errText}`));
        },
      );
    });
    const line = stdout.trim().split("\n").pop()!;
    return { available: true, ...(JSON.parse(line) as Omit<Extract<ProbeResult, { available: true }>, "available">) };
  } catch (err) {
    return { available: true, ok: false, error: `the engine check did not run: ${(err as Error).message}` };
  } finally {
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}
