import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { loadBackpackIndex, saveBackpackIndex, sha256, type BackpackIndex } from "../knowledge/backpack/index.js";
import { loadTeam } from "./team.js";
import { loadExperience, saveExperience, type ExperienceFile, type Lesson } from "./experience.js";
import { redactText, scanForSecrets, type RedactionFinding } from "./redaction.js";
import {
  appendRecord,
  canonicalJson,
  parseRecordText,
  recordPath,
  summarizeRecord,
  verifyRecordChain,
  type ServiceRecordSummary,
} from "./serviceRecord.js";

/**
 * The crew pack: one crew member serialized as a single portable JSON file —
 * definition, knowledge (docs + built backpack), experience (lessons that
 * survived probation), and the hash-chained service record. The receiving
 * side ("hiring") rehydrates all of it so the member arrives READY: no
 * backpack rebuild, no re-paid notes/embeddings, no lost lessons.
 *
 * Design rules:
 * - Fail-closed redaction: nothing secret-shaped leaves the machine silently.
 * - Everything advisory (model, tools) is validated or dropped on import,
 *   never trusted blind — a pack is untrusted input.
 * - Doc paths inside a pack are workspace-relative; a pack that tries path
 *   traversal is refused outright.
 */

export const CREWPACK_VERSION = 1;

export interface CrewPackManifest {
  id: string;
  name: string;
  role: string;
  exportedAt: string;
  generator: string;
  /** Advisory: the model the member ran on at the source. Never enforced on import. */
  modelHint?: string;
  /** Advisory: tools the member used at the source; validated against the recipient registry. */
  toolNames?: string[];
  /** The embedding model that produced backpack.embeddings, when present. */
  embeddingModel?: string;
  sha256: { definition: string; record?: string; docs: Record<string, string> };
  /** Reserved for key-based attestation; unimplemented in v1. */
  signature: null;
}

export interface CrewPack {
  crewpack: typeof CREWPACK_VERSION;
  manifest: CrewPackManifest;
  definition: string;
  docs: Array<{ path: string; contentBase64: string }>;
  backpack?: BackpackIndex;
  experience?: ExperienceFile;
  record?: string;
}

export interface ExportResult {
  ok: boolean;
  path?: string;
  findings?: RedactionFinding[];
  warnings: string[];
}

const ID_RE = /^[a-z0-9_-]+$/;

/** Normalizes a declared doc path to posix-relative form for pack keys. */
function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/** The in-memory result of assembling one member's pack, before any file is written. */
export type BuildCrewPackResult =
  | { ok: true; pack: CrewPack; warnings: string[] }
  | { ok: false; findings?: RedactionFinding[]; warnings: string[] };

/**
 * Assembles one crew member's pack in memory: docs packing, lesson filtering,
 * backpack re-keying, the fail-closed redaction gate, and the "exported"
 * service-record append — everything {@link exportCrewPack} does except
 * writing the file. Shared by the single-member exporter and the team-pack
 * exporter so both enforce the exact same rules.
 */
export function buildCrewPack(
  cwd: string,
  agentId: string,
  opts?: { redact?: boolean },
): BuildCrewPackResult {
  const warnings: string[] = [];
  const { agents } = loadTeam(cwd);
  const agent = agents.find((a) => a.id === agentId);
  if (!agent) {
    return { ok: false, warnings: [`no crew member "${agentId}" — /crew lists the roster`] };
  }

  let definition = readFileSync(agent.sourcePath, "utf8");

  const docs: Array<{ path: string; contentBase64: string }> = [];
  const docHashes: Record<string, string> = {};
  for (const rel of agent.docs) {
    const abs = join(cwd, rel);
    if (!existsSync(abs)) {
      warnings.push(`doc not found, not packed: ${rel}`);
      continue;
    }
    let buf = readFileSync(abs);
    if (opts?.redact) buf = Buffer.from(redactText(buf.toString("utf8")), "utf8");
    const key = toPosix(rel);
    docs.push({ path: key, contentBase64: buf.toString("base64") });
    docHashes[key] = sha256(buf);
  }

  const experienceAll = loadExperience(cwd, agentId);
  // Retired lessons are dead weight for a recipient; history stays in the record.
  let lessons = experienceAll.lessons.filter((l) => l.status !== "retired");

  let backpack = loadBackpackIndex(cwd, agentId);
  if (backpack) backpack = rekeyBackpack(backpack, (key) => matchDocKey(key, Object.keys(docHashes)));

  // Redaction gate — fail closed. Docs are scanned for secrets only (they
  // legitimately mention paths); definition and lessons must be clean of both.
  const findings: RedactionFinding[] = [
    ...scanForSecrets("definition", definition),
    ...lessons.flatMap((l) => scanForSecrets(`lesson ${l.id}`, l.text)),
    ...(backpack?.brief ? scanForSecrets("backpack brief", backpack.brief) : []),
    ...docs.flatMap((d) => scanForSecrets(d.path, Buffer.from(d.contentBase64, "base64").toString("utf8")).filter((f) => f.kind === "secret")),
  ];
  if (findings.length > 0) {
    if (!opts?.redact) return { ok: false, findings, warnings };
    definition = redactText(definition);
    lessons = lessons.map((l) => ({ ...l, text: redactText(l.text) }));
    if (backpack?.brief) backpack = { ...backpack, brief: redactText(backpack.brief) };
    warnings.push(`${findings.length} secret-shaped finding(s) masked with [REDACTED]`);
  }

  // The exported event rides inside the pack's own record: append it first,
  // anchored to a content hash that is stable before the pack file exists.
  const contentSha = sha256(Buffer.from(canonicalJson({ definition, docs: docHashes })));
  try {
    appendRecord(cwd, agentId, "exported", { contentSha });
  } catch {
    warnings.push("could not append the exported event to the service record");
  }
  const record = existsSync(recordPath(cwd, agentId)) ? readFileSync(recordPath(cwd, agentId), "utf8") : undefined;

  const embeddingModel = (backpack as { embeddingModel?: string } | undefined)?.embeddingModel;
  const pack: CrewPack = {
    crewpack: CREWPACK_VERSION,
    manifest: {
      id: agent.id,
      name: agent.name,
      role: agent.role,
      exportedAt: new Date().toISOString(),
      generator: "magentra",
      ...(agent.model !== undefined ? { modelHint: agent.model } : {}),
      ...(agent.tools !== undefined ? { toolNames: agent.tools } : {}),
      ...(embeddingModel !== undefined ? { embeddingModel } : {}),
      sha256: {
        definition: sha256(Buffer.from(definition, "utf8")),
        ...(record !== undefined ? { record: sha256(Buffer.from(record, "utf8")) } : {}),
        docs: docHashes,
      },
      signature: null,
    },
    definition,
    docs,
    ...(backpack !== undefined ? { backpack } : {}),
    ...(lessons.length > 0 ? { experience: { version: 1, lessons } } : {}),
    ...(record !== undefined ? { record } : {}),
  };

  return { ok: true, pack, warnings };
}

/**
 * Exports one crew member into `<dest>/<id>.crewpack.json` (dest defaults to
 * the workspace root). Refuses, listing every finding, when any exported
 * surface contains secret-shaped content — unless `redact` is set, which
 * masks secrets and proceeds (absolute paths are reported but only refuse
 * when found in the definition or lessons; docs legitimately mention paths).
 */
export function exportCrewPack(
  cwd: string,
  agentId: string,
  opts?: { dest?: string; redact?: boolean },
): ExportResult {
  const built = buildCrewPack(cwd, agentId, opts?.redact !== undefined ? { redact: opts.redact } : undefined);
  if (!built.ok) {
    return { ok: false, ...(built.findings !== undefined ? { findings: built.findings } : {}), warnings: built.warnings };
  }
  const path = join(opts?.dest ?? cwd, `${built.pack.manifest.id}.crewpack.json`);
  writeFileSync(path, JSON.stringify(built.pack, null, 2));
  return { ok: true, path, warnings: built.warnings };
}

/** Matches a backpack doc key (legacy absolute or relative) to a packed doc key, else undefined. */
function matchDocKey(key: string, packedKeys: string[]): string | undefined {
  const norm = toPosix(key).toLowerCase();
  return packedKeys.find((p) => norm === p.toLowerCase() || norm.endsWith(`/${p.toLowerCase()}`));
}

/** Re-keys index.docs via `map`; entries mapping to undefined are dropped (they cannot travel). */
function rekeyBackpack(index: BackpackIndex, map: (key: string) => string | undefined): BackpackIndex {
  const docs: BackpackIndex["docs"] = {};
  for (const [key, meta] of Object.entries(index.docs)) {
    const mapped = map(key);
    if (mapped !== undefined) docs[mapped] = meta;
  }
  return { ...index, docs };
}

export type ImportedLessonTrust = "verbatim" | "reprobation";

export interface HireResult {
  ok: boolean;
  id?: string;
  name?: string;
  errors: string[];
  warnings: string[];
  summary?: ServiceRecordSummary;
  lessonsImported?: { promoted: number; candidates: number };
  backpackState?: "ready" | "bm25-only" | "absent";
}

/**
 * Hires (imports) a crew pack into this workspace. Validates schema, hashes,
 * and the record chain; refuses id collisions and path traversal. Docs are
 * materialized under .magentra/team/docs/<id>/ and the definition's docs list
 * is rewritten to point at them, so the member is fully self-contained here.
 */
export function hireCrewPack(
  cwd: string,
  packPath: string,
  opts?: {
    asId?: string;
    trust?: ImportedLessonTrust;
    /** Tool names valid in the recipient registry; unknown advisory tools are dropped with a warning. */
    validToolNames?: string[];
    /** The recipient's embedding model; a mismatch drops embeddings (BM25 keeps working). */
    currentEmbeddingModel?: string;
  },
): HireResult {
  let raw: Buffer;
  try {
    raw = readFileSync(packPath);
  } catch (err) {
    return { ok: false, errors: [`cannot read pack: ${(err as Error).message}`], warnings: [] };
  }
  let pack: CrewPack;
  try {
    pack = JSON.parse(raw.toString("utf8")) as CrewPack;
  } catch {
    return { ok: false, errors: ["not a crew pack: file is not valid JSON"], warnings: [] };
  }
  return hireParsedCrewPack(cwd, pack, sha256(raw), opts);
}

/**
 * Hires an already-parsed crew pack. All shape/version validation lives here
 * (not in the file reader), so a member arriving inside a team pack gets the
 * exact same untrusted-input treatment as a standalone .crewpack.json file.
 * `packSha256` is the hash of the bytes the pack traveled as — it anchors the
 * "hired" record event to the exact artifact that was imported.
 */
export function hireParsedCrewPack(
  cwd: string,
  pack: CrewPack,
  packSha256: string,
  opts?: {
    asId?: string;
    trust?: ImportedLessonTrust;
    /** Tool names valid in the recipient registry; unknown advisory tools are dropped with a warning. */
    validToolNames?: string[];
    /** The recipient's embedding model; a mismatch drops embeddings (BM25 keeps working). */
    currentEmbeddingModel?: string;
  },
): HireResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (pack.crewpack !== CREWPACK_VERSION || typeof pack.definition !== "string" || typeof pack.manifest !== "object" || pack.manifest === null) {
    return { ok: false, errors: [`not a crew pack (expected {"crewpack": ${CREWPACK_VERSION}, ...})`], warnings };
  }

  const id = opts?.asId ?? pack.manifest.id;
  if (typeof id !== "string" || !ID_RE.test(id) || id === "orchestrator") {
    return { ok: false, errors: [`invalid member id "${id}" — ids are [a-z0-9_-] and "orchestrator" is reserved`], warnings };
  }
  const teamFile = join(cwd, ".magentra", "team", `${id}.md`);
  if (existsSync(teamFile)) {
    return { ok: false, errors: [`a crew member "${id}" already exists here — hire with a different id (as <new-id>)`], warnings };
  }

  // Integrity: every declared hash must hold before anything is written.
  if (sha256(Buffer.from(pack.definition, "utf8")) !== pack.manifest.sha256?.definition) {
    errors.push("definition hash mismatch — the pack was modified after export");
  }
  const docsIn = Array.isArray(pack.docs) ? pack.docs : [];
  for (const doc of docsIn) {
    if (typeof doc.path !== "string" || typeof doc.contentBase64 !== "string") {
      errors.push("malformed doc entry in pack");
      continue;
    }
    const posix = toPosix(doc.path);
    if (isAbsolute(doc.path) || posix.split("/").includes("..")) {
      errors.push(`doc path escapes the workspace: ${doc.path}`);
      continue;
    }
    const expected = pack.manifest.sha256?.docs?.[posix];
    if (expected !== undefined && sha256(Buffer.from(doc.contentBase64, "base64")) !== expected) {
      errors.push(`doc hash mismatch: ${posix}`);
    }
  }
  if (pack.record !== undefined) {
    if (pack.manifest.sha256?.record !== undefined && sha256(Buffer.from(pack.record, "utf8")) !== pack.manifest.sha256.record) {
      errors.push("service record hash mismatch — the pack was modified after export");
    } else {
      try {
        const chain = verifyRecordChain(parseRecordText(pack.record));
        if (!chain.ok) errors.push(`service record chain broken at entry ${chain.brokenAt} — history was edited`);
      } catch {
        errors.push("service record is unparseable");
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors, warnings };

  // Materialize docs under the member's own folder; rewrite the docs: list.
  const docsDirRel = toPosix(join(".magentra", "team", "docs", id));
  const newDocPaths: string[] = [];
  const docKeyMap = new Map<string, string>();
  for (const doc of docsIn) {
    const posix = toPosix(doc.path);
    const newRel = `${docsDirRel}/${posix}`;
    const abs = resolve(cwd, newRel);
    if (!abs.startsWith(resolve(cwd))) {
      return { ok: false, errors: [`doc path escapes the workspace: ${doc.path}`], warnings };
    }
    writeFileSyncMkdir(abs, Buffer.from(doc.contentBase64, "base64"));
    newDocPaths.push(newRel);
    docKeyMap.set(posix, newRel);
  }

  let definition = rewriteFrontmatterList(pack.definition, "docs", newDocPaths);
  if (opts?.validToolNames && Array.isArray(pack.manifest.toolNames)) {
    const valid = pack.manifest.toolNames.filter((t) => opts.validToolNames!.includes(t));
    const dropped = pack.manifest.toolNames.filter((t) => !opts.validToolNames!.includes(t));
    if (dropped.length > 0) {
      warnings.push(`tools not available here, dropped: ${dropped.join(", ")}`);
      definition = rewriteFrontmatterList(definition, "tools", valid);
    }
  }
  // A workspace hiring its first member has no .magentra/team yet.
  writeFileSyncMkdir(teamFile, Buffer.from(definition, "utf8"));

  // Backpack: re-key doc entries to the materialized paths; hashes still hold
  // (content unchanged), so the member arrives ready — nothing is re-paid.
  let backpackState: HireResult["backpackState"] = "absent";
  if (pack.backpack && typeof pack.backpack === "object" && Array.isArray(pack.backpack.chunks)) {
    let index = rekeyBackpack(pack.backpack, (key) => docKeyMap.get(toPosix(key)) ?? undefined);
    const packModel = pack.manifest.embeddingModel;
    if (index.embeddings !== undefined && packModel !== undefined && opts?.currentEmbeddingModel !== undefined && packModel !== opts.currentEmbeddingModel) {
      const { embeddings: _dropped, ...rest } = index;
      index = rest as BackpackIndex;
      warnings.push(`embeddings built on ${packModel} ≠ your ${opts.currentEmbeddingModel} — dropped, BM25 search still works`);
      backpackState = "bm25-only";
    } else {
      backpackState = index.embeddings !== undefined ? "ready" : "bm25-only";
    }
    saveBackpackIndex(cwd, id, index);
  }

  // Experience transfer scoping — imported knowledge must not arrive with
  // unearned trust. Default "reprobation": everything re-enters probation.
  // "verbatim": general/stack lessons keep their status; project-scoped
  // lessons ALWAYS re-earn (what was true in project A may be false here).
  const trust = opts?.trust ?? "reprobation";
  let promotedCount = 0;
  let candidateCount = 0;
  if (pack.experience && Array.isArray(pack.experience.lessons)) {
    const lessons: Lesson[] = [];
    for (const lesson of pack.experience.lessons) {
      if (typeof lesson.text !== "string" || lesson.status === "retired") continue;
      const keepStatus = trust === "verbatim" && lesson.scope !== "project" && lesson.status === "promoted";
      lessons.push({
        ...lesson,
        status: keepStatus ? "promoted" : "candidate",
        origin: "imported",
        ...(keepStatus ? {} : { confirmations: 0, contradictions: 0, injections: 0, distinctTasks: [] }),
      });
      if (keepStatus) promotedCount++;
      else candidateCount++;
    }
    saveExperience(cwd, id, { version: 1, lessons });
  }

  // Continue the service record chain across owners.
  let summary: ServiceRecordSummary | undefined;
  if (pack.record !== undefined) {
    writeFileSyncMkdir(recordPath(cwd, id), Buffer.from(pack.record, "utf8"));
  }
  try {
    appendRecord(cwd, id, "hired", { fromPackSha256: packSha256, sourceProject: lastProjectIn(pack.record) });
    summary = summarizeRecord(parseRecordText(readFileSync(recordPath(cwd, id), "utf8")));
  } catch {
    warnings.push("could not append the hired event to the service record");
  }

  return {
    ok: true,
    id,
    name: pack.manifest.name,
    errors,
    warnings,
    ...(summary !== undefined ? { summary } : {}),
    lessonsImported: { promoted: promotedCount, candidates: candidateCount },
    backpackState,
  };
}

/** The last project named in a record text, for the hired event's provenance line. */
function lastProjectIn(recordText: string | undefined): string | undefined {
  if (!recordText) return undefined;
  try {
    const entries = parseRecordText(recordText);
    for (let i = entries.length - 1; i >= 0; i--) {
      const p = entries[i]!.data.project;
      if (typeof p === "string" && p) return p;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

/**
 * Replaces (or removes, when `values` is empty) one frontmatter key in a team
 * file, handling both inline "key: a, b" and block-list forms. The body is
 * untouched.
 */
export function rewriteFrontmatterList(definition: string, key: string, values: string[]): string {
  const lines = definition.replace(/\r/g, "").split("\n");
  let start = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() === "---") {
      if (start === -1) start = i;
      else {
        end = i;
        break;
      }
    }
  }
  if (start === -1 || end === -1) return definition;

  const out: string[] = [];
  let inKeyBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (i > start && i < end) {
      const trimmed = line.trim();
      if (inKeyBlock && trimmed.startsWith("- ")) continue;
      inKeyBlock = false;
      const colon = line.indexOf(":");
      if (colon !== -1 && line.slice(0, colon).trim().toLowerCase() === key) {
        inKeyBlock = line.slice(colon + 1).trim() === "";
        continue;
      }
    }
    if (i === end && values.length > 0) out.push(`${key}: ${values.join(", ")}`);
    out.push(line);
  }
  return out.join("\n");
}

function writeFileSyncMkdir(abs: string, data: Buffer): void {
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, data);
}
