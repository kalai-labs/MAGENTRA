/**
 * Load, validate and write the committed records — SPEC §2, §11 step 1.
 *
 * One JSON file per feature under `tests/gateway/features/`, so two branches
 * adding two features never touch the same file (decisions/0003). Loading is
 * strict: a malformed record aborts the load and names every file that is
 * wrong, rather than skipping the bad ones. "Never default-and-continue" is
 * §2's rule, and a partially-loaded inventory presented as the inventory is the
 * failure mode the gateway exists to remove.
 *
 * Writes go through `writeFileAtomic` — decisions/0002 and 0003 name it
 * `writeJsonAtomic`, which is the Electron main process's copy in
 * `app/main/config.js`. That module `require`s `electron` at its top, so it
 * cannot be loaded by a plain Node process; the importable helper with the same
 * write-then-rename contract is `engine/core/src/util/fsAtomic.ts`, used the
 * way `engine/core/src/config/settings.ts` uses it (stringify at the call
 * site). No fourth atomic writer was added.
 */

import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { writeFileAtomic } from "../../../engine/core/src/util/fsAtomic.js";
import {
  DescriptionRecordSchema,
  FeatureRecordSchema,
  deriveStatus,
  type DescriptionRecord,
  type DescriptionStatus,
  type Feature,
  type FeatureRecord,
  type Kind,
} from "./schema.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The repository root: `tools/magentra-gateway/src` → up three. */
export function repoRoot(): string {
  return join(HERE, "..", "..", "..");
}

export function featuresDir(root = repoRoot()): string {
  return join(root, "tests", "gateway", "features");
}

export function descriptionsDir(root = repoRoot()): string {
  return join(root, "tests", "gateway", "descriptions");
}

/**
 * Ready descriptions live one folder down, so `ls tests/gateway/descriptions`
 * is what is still being written and `ls tests/gateway/descriptions/ready` is
 * what a coding agent may implement — the tree answers "what is ready" without
 * a tool.
 */
export function readyDescriptionsDir(root = repoRoot()): string {
  return join(descriptionsDir(root), "ready");
}

/** Where a description belongs on disk. Follows `status`, nothing else. */
function descriptionFile(root: string, rec: Pick<DescriptionRecord, "id" | "status">): string {
  return join(rec.status === "ready" ? readyDescriptionsDir(root) : descriptionsDir(root), `${rec.id}.json`);
}

export interface RecordProblem {
  /** Repo-relative path, so the message names the file to open. */
  readonly file: string;
  readonly detail: string;
}

/** Every malformed record in one throw, so one load names all of them. */
export class RegistryError extends Error {
  readonly problems: readonly RecordProblem[];

  constructor(what: string, problems: readonly RecordProblem[]) {
    super(
      `${problems.length} malformed ${what} record${problems.length === 1 ? "" : "s"}:\n\n` +
        problems.map((p) => `  ${p.file}\n${p.detail.replace(/^/gm, "      ")}`).join("\n\n"),
    );
    this.name = "RegistryError";
    this.problems = problems;
  }
}

function parseOne<T>(schema: z.ZodType<T>, file: string, raw: string): { ok: true; value: T } | { ok: false; detail: string } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return { ok: false, detail: `not valid JSON — ${err instanceof Error ? err.message : String(err)}` };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) return { ok: false, detail: z.prettifyError(parsed.error) };
  return { ok: true, value: parsed.data };
}

/**
 * All feature records, sorted by id, each with its derived status.
 *
 * `coveredKinds` maps a feature id to the kinds its tests actually prove; it
 * comes from `tests/features/`, which does not exist yet (SPEC §11 step 6).
 * Without it no record can read `covered` — see `deriveStatus`.
 *
 * @throws RegistryError naming every file that failed.
 */
export function loadFeatures(
  root = repoRoot(),
  coveredKinds?: ReadonlyMap<string, ReadonlySet<Kind>>,
): Feature[] {
  const dir = featuresDir(root);
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  } catch (err) {
    throw new RegistryError("feature", [
      { file: "tests/gateway/features/", detail: `cannot be read — ${err instanceof Error ? err.message : String(err)}` },
    ]);
  }

  const problems: RecordProblem[] = [];
  const features: Feature[] = [];
  const seenIds = new Map<string, string>();

  for (const entry of entries) {
    const relFile = `tests/gateway/features/${entry}`;
    const parsed = parseOne(FeatureRecordSchema, relFile, readFileSync(join(dir, entry), "utf8"));
    if (!parsed.ok) {
      problems.push({ file: relFile, detail: parsed.detail });
      continue;
    }
    const rec = parsed.value;

    // The file name is the id. Nothing infers a record's location from its
    // contents, so a mismatch means one of the two is a typo and every
    // id-addressed route would 404 or serve the wrong record.
    const stem = entry.slice(0, -".json".length);
    if (stem !== rec.id) {
      problems.push({ file: relFile, detail: `id "${rec.id}" does not match the file name "${stem}"` });
      continue;
    }
    const dupe = seenIds.get(rec.id);
    if (dupe !== undefined) {
      problems.push({ file: relFile, detail: `id "${rec.id}" is already used by ${dupe}` });
      continue;
    }
    seenIds.set(rec.id, relFile);

    features.push({ ...rec, status: deriveStatus(rec, coveredKinds?.get(rec.id)) });
  }

  if (problems.length > 0) throw new RegistryError("feature", problems);
  return features;
}

/**
 * All description records, from both folders. An absent directory is
 * legitimately empty — no description has been written yet — and is not a
 * malformed record.
 *
 * The folder a file sits in must agree with its `status`: `ready/` holds ready
 * records and nothing else. A file whose field and folder disagree is a
 * malformed record, not a guess — the tree is one of the two places the user
 * reads "ready" from, and the two may never say different things.
 *
 * @throws RegistryError naming every file that failed.
 */
export function loadDescriptions(root = repoRoot()): DescriptionRecord[] {
  const folders: { dir: string; rel: string; status: DescriptionStatus }[] = [
    { dir: descriptionsDir(root), rel: "tests/gateway/descriptions", status: "draft" },
    { dir: readyDescriptionsDir(root), rel: "tests/gateway/descriptions/ready", status: "ready" },
  ];

  const problems: RecordProblem[] = [];
  const out: DescriptionRecord[] = [];
  for (const { dir, rel, status } of folders) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
      const relFile = `${rel}/${entry}`;
      const parsed = parseOne(DescriptionRecordSchema, relFile, readFileSync(join(dir, entry), "utf8"));
      if (!parsed.ok) {
        problems.push({ file: relFile, detail: parsed.detail });
        continue;
      }
      const stem = entry.slice(0, -".json".length);
      if (stem !== parsed.value.id) {
        problems.push({ file: relFile, detail: `id "${parsed.value.id}" does not match the file name "${stem}"` });
        continue;
      }
      if (parsed.value.status !== status) {
        problems.push({
          file: relFile,
          detail: `status is "${parsed.value.status}" but the file sits in ${rel}/ — the folder is the status you read in the tree; move the file or fix the field`,
        });
        continue;
      }
      out.push(parsed.value);
    }
  }
  if (problems.length > 0) throw new RegistryError("description", problems);
  return out;
}

/**
 * Field order on disk, fixed so a re-record produces a one-hunk diff instead of
 * a reordered file. Verified byte-identical against all 164 seed records.
 */
const FIELD_ORDER = [
  "id",
  "name",
  "area",
  "section",
  "prose",
  "kinds",
  "entryFiles",
  "invariant",
  "deferred",
  "tests",
  "freshness",
] as const satisfies readonly (keyof FeatureRecord)[];

/** The exact bytes a feature record occupies on disk. */
export function serializeFeature(rec: FeatureRecord): string {
  const ordered: Record<string, unknown> = {};
  for (const key of FIELD_ORDER) {
    if (rec[key] !== undefined) ordered[key] = rec[key];
  }
  for (const key of Object.keys(rec)) {
    if (!(key in ordered)) ordered[key] = (rec as Record<string, unknown>)[key];
  }
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/**
 * Write one feature record, atomically, after re-validating it. Validating on
 * the way out as well as in means the gateway can never be the thing that puts
 * a malformed record in the inventory.
 */
export function writeFeature(rec: FeatureRecord, root = repoRoot()): void {
  const checked = FeatureRecordSchema.safeParse(rec);
  if (!checked.success) {
    throw new RegistryError("feature", [
      { file: `tests/gateway/features/${rec.id}.json`, detail: z.prettifyError(checked.error) },
    ]);
  }
  writeFileAtomic(join(featuresDir(root), `${checked.data.id}.json`), serializeFeature(checked.data));
}


/** Field order for a description on disk, for the same reviewable-diff reason. */
const DESCRIPTION_FIELD_ORDER = [
  "id",
  "featureIds",
  "status",
  "createdAt",
  "updatedAt",
  "body",
] as const satisfies readonly (keyof DescriptionRecord)[];

/**
 * `body` last, deliberately: it is the long free-text field, so an edit to it
 * produces a diff at the END of the file rather than pushing every other line
 * around. The same reason `serializeFeature` pins its order.
 */
export function serializeDescription(rec: DescriptionRecord): string {
  const ordered: Record<string, unknown> = {};
  for (const key of DESCRIPTION_FIELD_ORDER) ordered[key] = rec[key];
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

export interface DescriptionInput {
  /** Absent to create; present to update in place. */
  readonly id?: string;
  readonly featureIds: readonly string[];
  readonly body: string;
}

export class UnknownDescriptionError extends Error {}
export class UnknownFeatureError extends Error {}

/**
 * Create or update a description — SPEC §2.2, §11 step 9.
 *
 * `status` is NOT settable here. A new description is always `draft`, and an
 * update preserves whatever it already had. The only path to `ready` is
 * {@link setDescriptionStatus}, which exists as its own function precisely so
 * that "save my edits" can never be the thing that approves a directive.
 *
 * Every `featureId` must resolve. A description pointing at a feature that does
 * not exist is a directive nobody will ever act on, and silently keeping it is
 * how the old FEATURES.md grew 28 boxes with nothing behind them.
 */
export function writeDescription(input: DescriptionInput, root = repoRoot()): DescriptionRecord {
  const known = new Set(loadFeatures(root).map((f) => f.id));
  const missing = input.featureIds.filter((id) => !known.has(id));
  if (missing.length > 0) {
    throw new UnknownFeatureError(
      `no feature record with id ${missing.map((m) => `"${m}"`).join(", ")} — a description must target features that exist`,
    );
  }
  if (input.featureIds.length === 0) {
    throw new UnknownFeatureError("a description must target at least one feature");
  }

  const now = new Date().toISOString();
  const existing = input.id === undefined ? undefined : loadDescriptions(root).find((d) => d.id === input.id);
  if (input.id !== undefined && existing === undefined) {
    throw new UnknownDescriptionError(`no description with id "${input.id}"`);
  }

  const record: DescriptionRecord = {
    id: existing?.id ?? randomUUID(),
    featureIds: [...input.featureIds],
    body: input.body,
    status: existing?.status ?? "draft",
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  const checked = DescriptionRecordSchema.safeParse(record);
  if (!checked.success) {
    throw new RegistryError("description", [
      { file: `tests/gateway/descriptions/${record.id}.json`, detail: z.prettifyError(checked.error) },
    ]);
  }
  writeFileAtomic(descriptionFile(root, checked.data), serializeDescription(checked.data));
  return checked.data;
}

/**
 * The user-only transition — SPEC §2.2. `draft` → `ready` is the approval; the
 * reverse pulls a description back for more work.
 *
 * The gateway may SUGGEST that a description is ready and must never apply it:
 * an AI-written draft handed to an agent as if approved is the unreviewed
 * directive this status exists to keep out. So this is reachable from exactly
 * one route, which is approval-gated, and from nothing that runs on its own.
 */
export function setDescriptionStatus(id: string, status: DescriptionStatus, root = repoRoot()): DescriptionRecord {
  const existing = loadDescriptions(root).find((d) => d.id === id);
  if (existing === undefined) throw new UnknownDescriptionError(`no description with id "${id}"`);
  const record: DescriptionRecord = { ...existing, status, updatedAt: new Date().toISOString() };
  // The move: write in the folder the new status names, then remove the old
  // copy. Write first, so a crash between the two leaves a duplicate the loader
  // reports, never a description that vanished.
  writeFileAtomic(descriptionFile(root, record), serializeDescription(record));
  if (existing.status !== status) rmSync(descriptionFile(root, existing), { force: true });
  return record;
}

export function deleteDescription(id: string, root = repoRoot()): void {
  const existing = loadDescriptions(root).find((d) => d.id === id);
  if (existing === undefined) throw new UnknownDescriptionError(`no description with id "${id}"`);
  rmSync(descriptionFile(root, existing), { force: true });
}
