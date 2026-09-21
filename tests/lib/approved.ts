/**
 * Approved artifacts: the printer, the reader, and the comparison.
 *
 * An approved artifact is a committed file holding the exact bytes some part of
 * the product produces. The test renders the same thing and compares; a
 * mismatch is a diff a person reads in the commit, not a number a person
 * guesses at. See `decisions/0015-approved-artifacts-live-in-tests-approved.md`.
 *
 * THE PRINTERS LIVE HERE AND NOWHERE ELSE. `tools/approvals/regenerate.mjs`
 * imports these same functions rather than carrying its own copy. A generator
 * that renders the artifact one way and a test that renders it another is a
 * mirrored pair, and this repository already knows what those cost: the pair
 * agrees on the day it is written and silently stops agreeing later, at which
 * point the artifact pins nothing and the test still passes.
 *
 * NOTHING HERE WRITES. The only way to move an approved artifact is to run the
 * regeneration command by hand and commit the diff. There is deliberately no
 * environment variable that makes a test rewrite its own expectation: a coding
 * agent that broke the prompt would set it, go green, and the guard would be a
 * file that costs disk and proves nothing.
 *
 * Line endings are normalised to LF on BOTH sides before comparing. The
 * artifacts are committed text in a repository with `autocrlf` in play, so the
 * bytes on disk depend on who checked them out; the bytes that matter are the
 * ones the product produced.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { buildSystemPrompt, type PromptEnvironment } from "@magentra/core";
import { promptCatalog } from "@magentra/protocol";
import { createDefaultRegistry } from "@magentra/tools";
import { z } from "zod";

import { repoRoot } from "./inventory.ts";

/**
 * The environment the pinned prompt is rendered for. Every field of
 * `PromptEnvironment` is injected, so this constant is the whole of the
 * prompt's input and the render needs no scrubbing to be reproducible.
 *
 * The values are deliberately unlike anything real — a one-character model
 * name, a date in the past — so that a value leaking in from the machine
 * running the test is obvious in the diff rather than plausible.
 */
export const CANONICAL_ENV: PromptEnvironment = {
  cwd: "/w",
  isGitRepo: false,
  platform: "win32",
  model: "m",
  date: "2026-01-01",
};

/** Where a feature's approved artifact lives. */
export function approvedPath(featureId: string, name: string): string {
  return join(repoRoot(), "tests", "approved", featureId, name);
}

/** The approved bytes, normalised to LF. Throws if the artifact is missing. */
export function readApproved(featureId: string, name: string): string {
  return normalise(readFileSync(approvedPath(featureId, name), "utf8"));
}

function normalise(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/**
 * The ids of every prompt currently carrying an override.
 *
 * `promptsDir()` is `MAGENTRA_PROMPTS_DIR` when set and `~/.magentra/prompts`
 * otherwise — so overrides are GLOBAL TO THE USER and need no environment
 * variable to be in effect. A developer who has tuned a prompt on their own
 * machine would otherwise have that tuning rendered into the artifact and
 * committed as though it were the product's default.
 */
export function overriddenPromptIds(): string[] {
  return promptCatalog()
    .filter((p) => p.overridden)
    .map((p) => p.id)
    .sort();
}

/** The standing system prompt for {@link CANONICAL_ENV}. */
export function renderSystemPrompt(): string {
  return normalise(buildSystemPrompt({ env: CANONICAL_ENV })).trimEnd() + "\n";
}

/** Recursively sorts object keys so serialisation cannot depend on insertion order. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = sortKeys((value as Record<string, unknown>)[key]);
  }
  return out;
}

/**
 * Every registered tool's wire contract.
 *
 * `description` is the TEMPLATE, with its `{{slots}}` left unfilled. The
 * resolved text is what the model receives, but resolving it here would drag a
 * runtime value into a committed file and make the artifact machine-specific.
 * The template is also what Prompt Lab edits, so it is the thing a person
 * changes on purpose.
 */
export function renderToolContract(): string {
  const tools = createDefaultRegistry()
    .list()
    .slice()
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((t) => ({
      name: t.name,
      permissionClass: t.permissionClass,
      description: normalise(t.description),
      descriptionVars: Object.keys(t.descriptionVars ?? {}).sort(),
      inputSchema: sortKeys(z.toJSONSchema(t.inputSchema)),
    }));
  return JSON.stringify(tools, null, 2) + "\n";
}

/**
 * The first line where two renderings part, as a message naming it and showing
 * both sides. The whole file is useless in a test failure — a 400-line prompt
 * printed twice tells you only that something moved.
 */
export function firstDifference(actual: string, approved: string): string | undefined {
  const a = actual.split("\n");
  const b = approved.split("\n");
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      return [
        `line ${i + 1} differs`,
        `  approved: ${JSON.stringify(b[i] ?? "<end of file>")}`,
        `  rendered: ${JSON.stringify(a[i] ?? "<end of file>")}`,
        "",
        "If the change was intended, regenerate with `npm run approve` and",
        "commit the diff — that diff is the review this artifact exists for.",
      ].join("\n");
    }
  }
  return undefined;
}
