import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { sha256 } from "../knowledge/backpack/index.js";
import { loadTeam } from "./team.js";
import { buildCrewPack, hireParsedCrewPack, type CrewPack, type ImportedLessonTrust } from "./pack.js";
import { redactText, scanForSecrets, type RedactionFinding } from "./redaction.js";

/**
 * The team pack: a whole crew serialized as one portable JSON file — every
 * member's crew pack (definition, knowledge, experience, service record) plus
 * the workspace's mission files. Hiring a team pack rehydrates the entire
 * team in one move, so a receiving workspace goes from empty to a working,
 * experienced crew without redesigning or rebuilding anything.
 *
 * Design rules (same discipline as the single-member pack):
 * - Fail-closed redaction: if ANY member or mission carries secret-shaped
 *   content, the whole export is refused with every finding listed — unless
 *   the caller opts into masking with `redact`.
 * - A pack is untrusted input: every member goes through the exact same
 *   validation as a standalone crew pack; mission paths that are absolute or
 *   try ".." traversal are refused; nothing existing is ever overwritten.
 * - Partial hire beats no hire: one member colliding (or arriving tampered)
 *   skips that member with its reasons and still hires the rest.
 */

export const TEAMPACK_VERSION = 1;

export interface TeamPackManifest {
  name: string;
  exportedAt: string;
  generator: string;
  /** Ids of the member crew packs inside, in pack order. */
  memberIds: string[];
  /** Advisory hints for the receiving orchestrator (the main session). Never enforced. */
  orchestrator?: { modelHint?: string };
  /** Reserved for key-based attestation; unimplemented in v1. */
  signature: null;
}

export interface TeamPack {
  teampack: typeof TEAMPACK_VERSION;
  manifest: TeamPackManifest;
  members: CrewPack[];
  /** Mission files from <cwd>/.magentra/missions, keyed by filename. */
  missions?: Array<{ path: string; contentBase64: string }>;
}

export interface TeamExportResult {
  ok: boolean;
  path?: string;
  /** Every finding is tagged with the member id (or "mission <file>") it was found in. */
  findings?: Array<RedactionFinding & { member?: string }>;
  warnings: string[];
}

export interface TeamHireResult {
  ok: boolean;
  teamName?: string;
  hired: Array<{ id: string; name?: string; warnings: string[] }>;
  skipped: Array<{ id: string; reasons: string[] }>;
  missionsAdded: string[];
  errors: string[];
  warnings: string[];
}

/** The workspace folder name as a safe team/file name: [a-z0-9_-], never empty. */
function sanitizeTeamName(raw: string): string {
  const name = raw
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "");
  return name === "" ? "team" : name;
}

function missionsDir(cwd: string): string {
  return join(cwd, ".magentra", "missions");
}

/**
 * Exports the whole crew into `<dest>/<name>.teampack.json` (dest defaults to
 * the workspace root; name defaults to the sanitized workspace folder name).
 * Each member is built through {@link buildCrewPack}, so every rule of the
 * single-member export holds per member. Fail-closed: any secret-shaped
 * finding in any member or mission refuses the whole export with every
 * finding tagged by member — unless `redact`, which masks and proceeds.
 */
export function exportTeamPack(
  cwd: string,
  opts?: { name?: string; dest?: string; redact?: boolean; modelHint?: string },
): TeamExportResult {
  const warnings: string[] = [];
  const name = sanitizeTeamName(opts?.name ?? basename(cwd));

  const { agents } = loadTeam(cwd);
  if (agents.length === 0) {
    return { ok: false, warnings: ["no crew to export — /build-crew designs one"] };
  }

  const findings: Array<RedactionFinding & { member?: string }> = [];
  const members: CrewPack[] = [];
  for (const agent of [...agents].sort((a, b) => a.id.localeCompare(b.id))) {
    const built = buildCrewPack(cwd, agent.id, opts?.redact ? { redact: true } : undefined);
    warnings.push(...built.warnings);
    if (!built.ok) {
      for (const f of built.findings ?? []) findings.push({ ...f, member: agent.id });
      continue;
    }
    members.push(built.pack);
  }

  // Missions travel with the team: they are the plans the crew was built to
  // execute. Scanned for secrets only — mission text legitimately mentions paths.
  const missions: Array<{ path: string; contentBase64: string }> = [];
  if (existsSync(missionsDir(cwd))) {
    const files = readdirSync(missionsDir(cwd))
      .filter((f) => f.endsWith(".md"))
      .sort();
    for (const file of files) {
      let text = readFileSync(join(missionsDir(cwd), file), "utf8");
      const secretFindings = scanForSecrets(file, text).filter((f) => f.kind === "secret");
      if (secretFindings.length > 0) {
        if (!opts?.redact) {
          for (const f of secretFindings) findings.push({ ...f, member: `mission ${file}` });
          continue;
        }
        text = redactText(text);
        warnings.push(`mission ${file}: ${secretFindings.length} secret-shaped finding(s) masked with [REDACTED]`);
      }
      missions.push({ path: file, contentBase64: Buffer.from(text, "utf8").toString("base64") });
    }
  }

  if (findings.length > 0) return { ok: false, findings, warnings };

  const pack: TeamPack = {
    teampack: TEAMPACK_VERSION,
    manifest: {
      name,
      exportedAt: new Date().toISOString(),
      generator: "magentra",
      memberIds: members.map((m) => m.manifest.id),
      ...(opts?.modelHint !== undefined ? { orchestrator: { modelHint: opts.modelHint } } : {}),
      signature: null,
    },
    members,
    ...(missions.length > 0 ? { missions } : {}),
  };

  const path = join(opts?.dest ?? cwd, `${name}.teampack.json`);
  writeFileSync(path, JSON.stringify(pack, null, 2));
  return { ok: true, path, warnings };
}

/**
 * Hires (imports) a team pack into this workspace. Every member goes through
 * {@link hireParsedCrewPack} — the same validation as a standalone crew pack —
 * anchored to the sha256 of that member's own JSON bytes. A member that fails
 * (id collision, tampered hashes, broken record chain) is skipped with its
 * reasons; the rest still hire. Missions are materialized under
 * .magentra/missions; absolute or ".."-traversing paths are refused and an
 * existing file is never overwritten (skip with a warning instead).
 */
export function hireTeamPack(
  cwd: string,
  packPath: string,
  opts?: {
    trust?: ImportedLessonTrust;
    /** Tool names valid in the recipient registry; unknown advisory tools are dropped with a warning. */
    validToolNames?: string[];
    /** The recipient's embedding model; a mismatch drops embeddings (BM25 keeps working). */
    currentEmbeddingModel?: string;
  },
): TeamHireResult {
  const hired: TeamHireResult["hired"] = [];
  const skipped: TeamHireResult["skipped"] = [];
  const missionsAdded: string[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const refuse = (error: string): TeamHireResult => ({ ok: false, hired, skipped, missionsAdded, errors: [error], warnings });

  let raw: Buffer;
  try {
    raw = readFileSync(packPath);
  } catch (err) {
    return refuse(`cannot read team pack: ${(err as Error).message}`);
  }
  let pack: TeamPack;
  try {
    pack = JSON.parse(raw.toString("utf8")) as TeamPack;
  } catch {
    return refuse("not a team pack: file is not valid JSON");
  }
  if (pack.teampack !== TEAMPACK_VERSION || !Array.isArray(pack.members)) {
    return refuse(`not a team pack (expected {"teampack": ${TEAMPACK_VERSION}, ...})`);
  }
  const teamName = typeof pack.manifest?.name === "string" ? pack.manifest.name : undefined;

  // Hire member by member. Each member's "hired" record event is anchored to
  // the hash of its own JSON bytes (the artifact it actually traveled as).
  for (const member of pack.members) {
    const memberSha = sha256(Buffer.from(JSON.stringify(member)));
    const result = hireParsedCrewPack(cwd, member, memberSha, opts);
    if (result.ok && result.id !== undefined) {
      hired.push({ id: result.id, ...(result.name !== undefined ? { name: result.name } : {}), warnings: result.warnings });
    } else {
      const id = typeof member?.manifest?.id === "string" ? member.manifest.id : "(unknown member)";
      skipped.push({ id, reasons: result.errors.length > 0 ? result.errors : ["member failed to hire"] });
    }
  }

  // Materialize missions. Paths are untrusted: refuse absolute paths and any
  // ".." segment outright, and never overwrite a file the workspace already has.
  if (Array.isArray(pack.missions)) {
    const dir = missionsDir(cwd);
    for (const entry of pack.missions) {
      if (typeof entry?.path !== "string" || typeof entry?.contentBase64 !== "string") {
        warnings.push("malformed mission entry in pack — skipped");
        continue;
      }
      const posix = entry.path.replace(/\\/g, "/");
      if (isAbsolute(entry.path) || posix.split("/").includes("..")) {
        warnings.push(`mission path escapes .magentra/missions, skipped: ${entry.path}`);
        continue;
      }
      const abs = resolve(dir, posix);
      if (!abs.startsWith(resolve(dir))) {
        warnings.push(`mission path escapes .magentra/missions, skipped: ${entry.path}`);
        continue;
      }
      if (existsSync(abs)) {
        warnings.push(`mission already exists, not overwritten: ${posix}`);
        continue;
      }
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, Buffer.from(entry.contentBase64, "base64"));
      missionsAdded.push(posix);
    }
  }

  const ok = hired.length > 0 || (pack.members.length === 0 && missionsAdded.length > 0);
  return { ok, ...(teamName !== undefined ? { teamName } : {}), hired, skipped, missionsAdded, errors, warnings };
}
