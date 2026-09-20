/**
 * The ONLY definition of a gateway record's shape — SPEC §2.
 *
 * Every record is validated here on load. A malformed record is a loud failure
 * that names its file; it is never defaulted-and-continued, because an
 * inventory that can quietly disagree with the code is worse than no inventory
 * (decisions/0001).
 *
 * Two things the schema deliberately refuses, both from §2.1:
 *
 *   `status` is DERIVED, never authored. The object is strict, so a record that
 *   carries a `status` key fails to load rather than having it silently ignored
 *   — an authored status is exactly the drift this tool exists to catch.
 *
 *   `deferred` is set BY RULE, not by opinion: true exactly when every entry
 *   file sits under `app/renderer/`. The rule is checked here, so the flag
 *   cannot be hand-set to excuse a feature from coverage, and cannot be
 *   silently dropped from one that qualifies.
 */

import { z } from "zod";

/**
 * SPEC §2.1 declares five areas; `engine/providers` is a sixth workspace
 * package and three seed records name it (`provider-usage-normalization` and
 * the two openai-compat records). Added to the enum on 2026-09-09 rather than
 * retagging those records to "engine": providers is its own compilation unit
 * beside `engine/core` and `engine/protocol`, and the area field exists to be
 * a useful filter.
 */
export const AREAS = ["engine", "app", "tui", "protocol", "providers", "tooling"] as const;

/** The axis tests inherit on (decisions/0004). Kind decides setup, teardown, and whether a test can run at all. */
export const KINDS = ["pure", "fs", "proc", "net", "llm", "ui"] as const;

/** Derived on load, never stored. See {@link deriveStatus}. */
export const STATUSES = ["untested", "partial", "covered"] as const;

export type Area = (typeof AREAS)[number];
export type Kind = (typeof KINDS)[number];
export type Status = (typeof STATUSES)[number];

/**
 * Entry files under this prefix are out of scope at this stage (2026-09-09
 * decision), and are the sole basis of the `deferred` rule.
 */
export const DEFERRED_PREFIX = "app/renderer/";

/**
 * `hashFiles()` truncates its SHA-256 to 16 hex characters — see freshness.ts,
 * which copies the function from bigpicture.mjs. Pinned here so a record
 * carrying a full 64-character digest, or a truncated-differently one, fails
 * loudly instead of comparing unequal forever with no explanation.
 */
const HASH16 = /^[0-9a-f]{16}$/;

/** kebab-case, stable, never reused. */
const FEATURE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** An ISO date, as `hashFiles`-based re-recording stamps it (`YYYY-MM-DD`); a full timestamp is accepted. */
const ISO_DATE_PREFIX = /^\d{4}-\d{2}-\d{2}(?:[T ].*)?$/;

export const FreshnessStampSchema = z.strictObject({
  /** Rollup over `entryFiles`, in the order the record lists them. */
  hash: z.string().regex(HASH16, "must be 16 lowercase hex characters (hashFiles' truncated sha256)"),
  /** Per file, so drift can name WHICH file moved rather than only which feature. */
  fileHashes: z.record(z.string(), z.string().regex(HASH16, "must be 16 lowercase hex characters")),
  recordedAt: z.string().regex(ISO_DATE_PREFIX, "must be an ISO date (YYYY-MM-DD)"),
});

export type FreshnessStamp = z.infer<typeof FreshnessStampSchema>;

const FeatureShape = z.strictObject({
  id: z.string().regex(FEATURE_ID, "must be kebab-case"),
  name: z.string().min(1),
  area: z.enum(AREAS),
  /** The `FEATURES.md` grouping this feature belongs to. */
  section: z.string().min(1),
  /** Verbatim from `FEATURES.md`. Preserved so nothing that made that document worth reading is lost. */
  prose: z.string(),
  kinds: z.array(z.enum(KINDS)).min(1, "a feature declares at least one kind"),
  /** Repo-relative. Hashed for freshness, so an empty list would mean "nothing can make this record stale". */
  entryFiles: z.array(z.string().min(1)).min(1, "a feature names at least one entry file"),
  invariant: z.string().min(1),
  deferred: z.boolean().optional(),
  /** Test ids present in `tests/features/<id>.test.ts`. Empty until the test exists. */
  tests: z.array(z.string().min(1)),
  freshness: FreshnessStampSchema,
});

export const FeatureRecordSchema = FeatureShape.superRefine((rec, ctx) => {
  // A record whose per-file hashes do not cover its entry files cannot name the
  // drifted file, which is the whole reason fileHashes exists (§4.1).
  const hashed = new Set(Object.keys(rec.freshness.fileHashes));
  for (const f of rec.entryFiles) {
    if (!hashed.has(f)) {
      ctx.addIssue({
        code: "custom",
        path: ["freshness", "fileHashes", f],
        message: `entry file "${f}" has no recorded per-file hash — drift in it could not be named`,
      });
    }
  }
  for (const f of hashed) {
    if (!rec.entryFiles.includes(f)) {
      ctx.addIssue({
        code: "custom",
        path: ["freshness", "fileHashes", f],
        message: `per-file hash for "${f}", which is not an entry file`,
      });
    }
  }

  // §2.1's rule, enforced rather than trusted.
  const byRule = rec.entryFiles.every((f) => f.startsWith(DEFERRED_PREFIX));
  if (byRule !== (rec.deferred === true)) {
    ctx.addIssue({
      code: "custom",
      path: ["deferred"],
      message: byRule
        ? `every entry file is under ${DEFERRED_PREFIX}, so deferred must be true (§2.1's rule is not an opinion)`
        : `not every entry file is under ${DEFERRED_PREFIX}, so deferred must not be true — removing the flag is a decision, setting it is not`,
    });
  }

  const seen = new Set<string>();
  for (const t of rec.tests) {
    if (seen.has(t)) {
      ctx.addIssue({ code: "custom", path: ["tests"], message: `duplicate test id "${t}"` });
    }
    seen.add(t);
  }
});

export type FeatureRecord = z.infer<typeof FeatureShape>;

/** A loaded record: what is on disk, plus the status derived from it. */
export interface Feature extends FeatureRecord {
  readonly status: Status;
}

/** SPEC §2.2 — the user-authored specification an agent acts on. */
export const DescriptionRecordSchema = z.strictObject({
  id: z.string().min(1),
  featureIds: z.array(z.string().regex(FEATURE_ID)).min(1),
  body: z.string(),
  /**
   * `draft`: being written — an AI suggestion, or the user's own text not yet
   * approved. `ready`: the user has approved it as the specification a coding
   * agent implements. It says nothing about whether a test exists yet; that is
   * the feature's derived `status`, not the description's.
   *
   * Moves to `ready` only by explicit user action. The gateway must never apply
   * it — a suggestion handed to an agent as if approved is exactly the
   * unreviewed directive this field exists to keep out.
   */
  status: z.enum(["draft", "ready"]),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export type DescriptionRecord = z.infer<typeof DescriptionRecordSchema>;
export type DescriptionStatus = DescriptionRecord["status"];

/**
 * What the test FILES hold for one feature — the evidence `status` is derived
 * from. Produced by `tests.ts`'s `proofByFeature()`; only tests that exist AND
 * are registered to run appear in it.
 *
 * It is a set of ids and a set of kinds rather than the record's array because
 * the kind a test proves lives in the file, as the class it extends
 * (decisions/0004) — an id carries no kind, so the record alone could never
 * answer whether every declared kind is covered.
 */
export interface FeatureProof {
  readonly ids: ReadonlySet<string>;
  readonly kinds: ReadonlySet<Kind>;
}

/**
 * §2.1's derivation: `untested` = no tests; `partial` = tests exist but not for
 * every declared kind; `covered` = one per kind.
 *
 * DERIVED FROM THE FILES, NOT FROM THE RECORD (fixed 2026-09-10, decisions/0007).
 * §2.1 defines `tests` as "test ids present in `tests/features/<id>.test.ts`",
 * so the file is the referent and the array is a stored copy of it. Deriving
 * status from the copy meant a hand-typed id read as coverage and a real test
 * read as nothing: every record stayed `untested` while `covered` was
 * unreachable by construction. `proof` comes from parsing those files;
 * `tests.ts`'s `driftOf()` is what reports the array disagreeing with them.
 *
 * `proof === undefined` means the caller has not scanned the files at all — not
 * that there are no tests. It falls back to the record's array and can never
 * reach `covered`, because claiming `covered` from a count of ids is precisely
 * the ticked-box-with-no-assertion failure of the deleted suite.
 */
export function deriveStatus(rec: FeatureRecord, proof?: FeatureProof): Status {
  if (proof === undefined) return rec.tests.length === 0 ? "untested" : "partial";
  if (proof.ids.size === 0) return "untested";
  return rec.kinds.every((k) => proof.kinds.has(k)) ? "covered" : "partial";
}
