import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * The service record: one crew member's verifiable work history — its CV.
 *
 * An append-only JSONL file at .magentra/team/experience/<id>.record.jsonl.
 * Entries form a hash chain (each entry's `hash` covers its own content and
 * `prev` names the hash before it), so a record that traveled inside a crew
 * pack can be checked for internal consistency by anyone who receives it.
 *
 * Honest scope: the chain is TAMPER-EVIDENT, not forge-proof. It proves the
 * history was not edited after the fact; it cannot prove the original author
 * didn't fabricate it. Key-based signing is a reserved future seam (the pack
 * manifest carries a `signature` field), deliberately unimplemented in v1.
 *
 * Privacy: entries carry the workspace folder's basename as `project`, never
 * a full path, and never file contents.
 */

export type ServiceEventType =
  | "created"
  | "task_completed"
  | "task_bounced"
  | "lesson_promoted"
  | "lesson_retired"
  | "exported"
  | "hired";

export interface ServiceRecordEntry {
  seq: number;
  ts: string;
  event: ServiceEventType;
  data: Record<string, unknown>;
  prev: string | null;
  hash: string;
}

export function experienceDir(cwd: string): string {
  return join(cwd, ".magentra", "team", "experience");
}

export function recordPath(cwd: string, agentId: string): string {
  return join(experienceDir(cwd), `${agentId}.record.jsonl`);
}

/**
 * JSON with lexicographically sorted object keys at every level, so the same
 * logical entry always hashes to the same string regardless of insertion order.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
  return `{${parts.join(",")}}`;
}

function entryHash(entry: Omit<ServiceRecordEntry, "hash">): string {
  return createHash("sha256").update(canonicalJson(entry)).digest("hex");
}

/** Reads a record file into entries; unparseable lines end the read (the chain is broken there anyway). */
export function readRecord(cwd: string, agentId: string): ServiceRecordEntry[] {
  const file = recordPath(cwd, agentId);
  if (!existsSync(file)) return [];
  const entries: ServiceRecordEntry[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      entries.push(JSON.parse(line) as ServiceRecordEntry);
    } catch {
      break;
    }
  }
  return entries;
}

/**
 * Appends one event to the member's record, continuing the hash chain.
 * `project` defaults to the workspace basename; pass an explicit value when
 * importing a record that must name its origin instead.
 */
export function appendRecord(
  cwd: string,
  agentId: string,
  event: ServiceEventType,
  data: Record<string, unknown>,
  opts?: { project?: string },
): ServiceRecordEntry {
  const entries = readRecord(cwd, agentId);
  const last = entries[entries.length - 1];
  const bare: Omit<ServiceRecordEntry, "hash"> = {
    seq: (last?.seq ?? 0) + 1,
    ts: new Date().toISOString(),
    event,
    data: { project: opts?.project ?? basename(cwd), ...data },
    prev: last?.hash ?? null,
  };
  const entry: ServiceRecordEntry = { ...bare, hash: entryHash(bare) };
  mkdirSync(experienceDir(cwd), { recursive: true });
  appendFileSync(recordPath(cwd, agentId), `${JSON.stringify(entry)}\n`);
  return entry;
}

/** Walks the chain; reports the first entry whose hash or prev-link does not hold. */
export function verifyRecordChain(entries: ServiceRecordEntry[]): { ok: boolean; brokenAt?: number } {
  let prev: string | null = null;
  for (const entry of entries) {
    const { hash, ...bare } = entry;
    if (entry.prev !== prev || entryHash(bare) !== hash) {
      return { ok: false, brokenAt: entry.seq };
    }
    prev = hash;
  }
  return { ok: true };
}

/** Verifies a record shipped as raw JSONL text (inside a crew pack). */
export function parseRecordText(text: string): ServiceRecordEntry[] {
  const entries: ServiceRecordEntry[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    entries.push(JSON.parse(line) as ServiceRecordEntry);
  }
  return entries;
}

export interface ServiceRecordSummary {
  tasksCompleted: number;
  tasksBounced: number;
  lessonsPromoted: number;
  projects: string[];
  hires: number;
  firstEntry?: string;
  lastEntry?: string;
  chainOk: boolean;
}

/** The one-glance CV: counts a frontend or /crew can print. */
export function summarizeRecord(entries: ServiceRecordEntry[]): ServiceRecordSummary {
  const projects = new Set<string>();
  let tasksCompleted = 0;
  let tasksBounced = 0;
  let lessonsPromoted = 0;
  let hires = 0;
  for (const e of entries) {
    const project = e.data.project;
    if (typeof project === "string" && project) projects.add(project);
    if (e.event === "task_completed") tasksCompleted++;
    else if (e.event === "task_bounced") tasksBounced++;
    else if (e.event === "lesson_promoted") lessonsPromoted++;
    else if (e.event === "hired") hires++;
  }
  const first = entries[0];
  const last = entries[entries.length - 1];
  return {
    tasksCompleted,
    tasksBounced,
    lessonsPromoted,
    projects: [...projects],
    hires,
    ...(first ? { firstEntry: first.ts } : {}),
    ...(last ? { lastEntry: last.ts } : {}),
    chainOk: verifyRecordChain(entries).ok,
  };
}
