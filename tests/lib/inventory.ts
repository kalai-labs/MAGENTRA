/**
 * Reading the committed inventory — the half of SPEC §11 step 6 that ties a
 * test back to the record it proves.
 *
 * WHY THIS IS NOT AN IMPORT OF THE GATEWAY. `tools/magentra-gateway/src/registry.ts`
 * already loads and validates these records, and reusing it here would be the
 * obvious move. It is forbidden by tests/README rule 5 — `node --test tests/`
 * must work without the gateway, because a broken tool must never mean no
 * tests — and it would not work anyway: registry.ts pulls in `zod` and writes
 * its relative imports with `.js` specifiers, and Node's native type stripping
 * (the thing that lets `node --test` run a `.ts` file with no build step)
 * resolves `./x.js` literally and finds nothing.
 *
 * So this file reads the JSON and nothing more: no schema, no zod, no write
 * path. It is deliberately a SUBSET reader — it asks only for the fields a test
 * is checked against, so a record growing a field never touches this file. What
 * it keeps from registry.ts is the rule that matters: never
 * default-and-continue. A record that is missing or malformed throws, naming
 * the file to open.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The repository root. `tests/lib/` → up two.
 *
 * Every path in a record is repo-relative (SPEC §2.1), so this is also what
 * resolves `entryFiles` for a test that wants to read one.
 */
export function repoRoot(): string {
  return join(import.meta.dirname, "..", "..");
}

/**
 * The six kinds, mirrored from `tools/magentra-gateway/src/schema.ts`'s `KINDS`.
 *
 * A MIRRORED PAIR, in the sense BIG-PICTURE §16 uses — and a deliberate one,
 * for the reason in this file's header: the authoritative list cannot be
 * imported here. It is a type and not a runtime array, so nothing in the suite
 * decides anything from this copy; the record's own `kinds` field is the
 * runtime authority, checked in featureTest.ts. A seventh kind added to the
 * schema and not here therefore surfaces as "no base class for kind x" when
 * someone tries to write that test, never as a test that quietly passes.
 */
export type Kind = "pure" | "fs" | "proc" | "net" | "llm" | "ui";

/** The fields of a feature record a test is checked against. Not the whole record. */
export interface FeatureRecordSubset {
  readonly id: string;
  readonly name: string;
  readonly kinds: readonly string[];
  readonly entryFiles: readonly string[];
  readonly invariant: string;
  readonly deferred?: boolean;
  readonly tests: readonly string[];
}

/** Repo-relative, so a thrown message names the file to open. */
export function featureRecordPath(featureId: string): string {
  return `tests/gateway/features/${featureId}.json`;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/**
 * One feature record, straight off disk.
 *
 * @throws Error naming the repo-relative file, for an absent record, invalid
 * JSON, or any checked field of the wrong type. A test whose record cannot be
 * read is not a test that runs anyway — it is a test that cannot say what it
 * proves, which is the thing this suite was reset to remove.
 */
export function readFeatureRecord(featureId: string, root = repoRoot()): FeatureRecordSubset {
  const rel = featureRecordPath(featureId);
  let raw: string;
  try {
    raw = readFileSync(join(root, rel), "utf8");
  } catch (err) {
    const why = (err as { code?: string }).code === "ENOENT" ? "does not exist" : `cannot be read — ${String(err)}`;
    throw new Error(
      `${rel} ${why}. A test names the inventory record it proves, and that record comes first ` +
        `(tests/README rule 1): register the feature in the gateway before writing its test.`,
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${rel} is not valid JSON — ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof json !== "object" || json === null) throw new Error(`${rel} is not a JSON object`);

  const rec = json as Record<string, unknown>;
  const bad = (field: string, wanted: string): Error =>
    new Error(`${rel} has no usable "${field}" — ${wanted}. The record is malformed; fix it in the gateway.`);

  if (typeof rec["id"] !== "string") throw bad("id", "a string is required");
  if (rec["id"] !== featureId) throw new Error(`${rel} carries id "${String(rec["id"])}", which is not the file name "${featureId}"`);
  if (typeof rec["name"] !== "string") throw bad("name", "a string is required");
  if (!isStringArray(rec["kinds"]) || rec["kinds"].length === 0) throw bad("kinds", "a non-empty array of strings is required");
  if (!isStringArray(rec["entryFiles"]) || rec["entryFiles"].length === 0) throw bad("entryFiles", "a non-empty array of strings is required");
  if (typeof rec["invariant"] !== "string" || rec["invariant"].trim() === "") throw bad("invariant", "a non-empty string is required");
  if (!isStringArray(rec["tests"])) throw bad("tests", "an array of strings is required");
  if (rec["deferred"] !== undefined && typeof rec["deferred"] !== "boolean") throw bad("deferred", "a boolean is required when present");

  return {
    id: rec["id"],
    name: rec["name"],
    kinds: rec["kinds"],
    entryFiles: rec["entryFiles"],
    invariant: rec["invariant"],
    deferred: rec["deferred"] as boolean | undefined,
    tests: rec["tests"],
  };
}
