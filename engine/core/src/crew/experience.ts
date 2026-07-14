import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TaskItem } from "@magentra/protocol";
import { writeFileAtomic } from "../util/fsAtomic.js";
import { hasAbsolutePath, looksSecret } from "./redaction.js";
import { appendRecord, experienceDir } from "./serviceRecord.js";

/**
 * The experience ledger: how a crew member learns from real work, on
 * probation. This is the substance of the "hirable crew" feature — a member
 * is more than its role prompt because it carries lessons that survived
 * contact with verified tasks.
 *
 * The failure mode this design guards against: a weak model writing wrong
 * lessons into its own durable memory and compounding instead of improving.
 * So nothing is durable by default —
 *
 *   captured lesson  →  candidate (probation)  →  promoted (durable)
 *                                     ↘  retired (contradicted)
 *
 * - CAPTURE happens only when the orchestrator marks an owned task completed
 *   (the harness's "verified" moment), at most {@link MAX_LESSONS_PER_CAPTURE}
 *   per task, each gated by structural validators (length, no secrets, no
 *   machine paths, not a near-duplicate). A dropped lesson costs nothing; a
 *   wrong durable lesson compounds.
 * - PROBATION: candidates ride along on the member's later runs. A run whose
 *   task completes confirms every lesson injected into it; a bounce (the same
 *   task re-dispatched to the member after a failed verification) contradicts
 *   them.
 * - PROMOTION: {@link PROMOTE_CONFIRMATIONS} confirmations across
 *   {@link PROMOTE_DISTINCT_TASKS} distinct tasks with zero contradictions.
 * - RETIREMENT: {@link RETIRE_CONTRADICTIONS} contradictions retire a lesson,
 *   promoted or not — wrong knowledge must be evictable.
 *
 * Everything is plain JSON under .magentra/team/experience/ — readable,
 * diffable, and portable inside a crew pack.
 */

export type LessonStatus = "candidate" | "promoted" | "retired";

export interface Lesson {
  id: string;
  text: string;
  /** "general" (true anywhere), "project" (this repo only), or "stack:<tag>" (e.g. stack:typescript). */
  scope: string;
  status: LessonStatus;
  confirmations: number;
  contradictions: number;
  injections: number;
  /** Task ids whose completion confirmed this lesson (distinct-task evidence for promotion). */
  distinctTasks: string[];
  createdAt: string;
  promotedAt?: string;
  source: { taskId: string; taskSubject: string };
  /** Write-path provenance: self-captured (absent = "self") or arrived inside a crew pack. */
  origin?: "self" | "imported";
}

export interface ExperienceFile {
  version: 1;
  lessons: Lesson[];
}

export const MAX_LESSON_CHARS = 300;
export const MAX_LESSONS_PER_CAPTURE = 2;
export const PROMOTE_CONFIRMATIONS = 3;
export const PROMOTE_DISTINCT_TASKS = 2;
export const RETIRE_CONTRADICTIONS = 2;
export const INJECT_MAX_PROMOTED = 12;
export const INJECT_MAX_CANDIDATES = 4;
export const LESSONS_SECTION_CHAR_CAP = 1500;
const SCOPE_RE = /^(general|project|stack:[a-z0-9.+#-]{1,24})$/;

export function experiencePath(cwd: string, agentId: string): string {
  return join(experienceDir(cwd), `${agentId}.json`);
}

export function loadExperience(cwd: string, agentId: string): ExperienceFile {
  try {
    const raw = JSON.parse(readFileSync(experiencePath(cwd, agentId), "utf8")) as unknown;
    if (isExperienceFile(raw)) return raw;
  } catch {
    /* missing or corrupt — start empty; the record is the durable history */
  }
  return { version: 1, lessons: [] };
}

export function saveExperience(cwd: string, agentId: string, file: ExperienceFile): void {
  writeFileAtomic(experiencePath(cwd, agentId), JSON.stringify(file, null, 2));
}

function isExperienceFile(v: unknown): v is ExperienceFile {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return o.version === 1 && Array.isArray(o.lessons);
}

/** Unicode-tolerant tokens for near-duplicate detection. */
function lessonTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length >= 3),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Structural gate every captured lesson must pass. Returns the normalized
 * text, or a reason string when the lesson must be dropped.
 */
export function validateLessonText(text: string, existing: Lesson[]): { ok: true; text: string } | { ok: false; reason: string } {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length < 15) return { ok: false, reason: "too short to be a lesson" };
  if (normalized.length > MAX_LESSON_CHARS) return { ok: false, reason: `over ${MAX_LESSON_CHARS} chars` };
  if (/^i\b/i.test(normalized)) return { ok: false, reason: "narration, not a lesson (starts with 'I')" };
  if (looksSecret(normalized)) return { ok: false, reason: "secret-shaped content" };
  if (hasAbsolutePath(normalized)) return { ok: false, reason: "machine-absolute path" };
  const tokens = lessonTokens(normalized);
  for (const lesson of existing) {
    if (lesson.status !== "retired" && jaccard(tokens, lessonTokens(lesson.text)) >= 0.4) {
      return { ok: false, reason: `near-duplicate of ${lesson.id}` };
    }
  }
  return { ok: true, text: normalized };
}

/**
 * Parses the extraction model's reply: up to {@link MAX_LESSONS_PER_CAPTURE}
 * lines of "scope | lesson text", or NONE. Anything unparseable is skipped —
 * the format is taught in the prompt, and a weak model that drifts simply
 * teaches nothing this round.
 */
export function parseExtraction(reply: string): Array<{ scope: string; text: string }> {
  const out: Array<{ scope: string; text: string }> = [];
  for (const rawLine of reply.split("\n")) {
    const line = rawLine.replace(/^[-*\d.)\s]+/, "").trim();
    if (line === "" || /^none\b/i.test(line)) continue;
    const bar = line.indexOf("|");
    if (bar === -1) continue;
    const scope = line.slice(0, bar).trim().toLowerCase();
    const text = line.slice(bar + 1).trim();
    if (!SCOPE_RE.test(scope) || text === "") continue;
    out.push({ scope, text });
    if (out.length >= MAX_LESSONS_PER_CAPTURE) break;
  }
  return out;
}

export const EXTRACTION_SYSTEM_PROMPT = `You distill durable lessons for an AI specialist from its completed work report. A lesson is a rule the specialist should carry into FUTURE tasks — a technique that worked, a pitfall to avoid, a project fact it had to discover. Not narration of what happened, not praise, not anything containing credentials or machine-specific paths.

Reply with AT MOST ${MAX_LESSONS_PER_CAPTURE} lines, each exactly:
<scope> | <lesson in one sentence, under ${MAX_LESSON_CHARS} characters>

where <scope> is one of:
general          — true for this kind of work anywhere
project          — true only in this repository
stack:<tag>      — true for a technology, e.g. stack:typescript

If the report contains nothing worth carrying forward, reply exactly: NONE`;

interface PendingRun {
  injected: string[];
  report?: string;
  /** The model the specialist ran on — outcomes are model-bound in the service record. */
  model?: string;
}

/** Dependency surface {@link CrewExperience.onTaskCompleted} needs from the session. */
export interface ExperienceInference {
  (opts: { system: string; user: string; maxTokens: number }): Promise<string>;
}

/**
 * Per-workspace experience manager. The main session owns one; CrewRun calls
 * beginRun/recordReport around each specialist dispatch, and the session's
 * task-transition hook calls onTaskCompleted when an owned task is verified.
 * Pending-run state is in-memory by design: probation evidence only counts
 * within the session that observed it end-to-end.
 */
export class CrewExperience {
  private pending = new Map<string, PendingRun>();

  constructor(private readonly cwd: string) {}

  private key(agentId: string, taskId: string): string {
    return `${agentId} ${taskId}`;
  }

  /**
   * Called by CrewRun before dispatching the specialist. Detects a bounce
   * (this member already ran this task this session — the orchestrator is
   * re-dispatching after a failed verification), applies contradictions, and
   * assembles the lessons prompt section for the new run.
   */
  beginRun(agentId: string, taskId: string, opts?: { model?: string }): { lessonsSection?: string; bounced: boolean } {
    const file = loadExperience(this.cwd, agentId);
    const prior = this.pending.get(this.key(agentId, taskId));
    let bounced = false;
    if (prior) {
      bounced = true;
      for (const id of prior.injected) {
        const lesson = file.lessons.find((l) => l.id === id);
        if (!lesson || lesson.status === "retired") continue;
        lesson.contradictions++;
        if (lesson.contradictions >= RETIRE_CONTRADICTIONS) {
          lesson.status = "retired";
          this.safeRecord(agentId, "lesson_retired", { lessonId: lesson.id });
        }
      }
      this.safeRecord(agentId, "task_bounced", { taskId });
    }

    const promoted = file.lessons
      .filter((l) => l.status === "promoted")
      .sort((a, b) => b.confirmations - a.confirmations)
      .slice(0, INJECT_MAX_PROMOTED);
    const candidates = file.lessons
      .filter((l) => l.status === "candidate")
      .sort((a, b) => a.injections - b.injections)
      .slice(0, INJECT_MAX_CANDIDATES);

    const lines: string[] = [];
    const injected: string[] = [];
    let budget = LESSONS_SECTION_CHAR_CAP;
    for (const lesson of [...promoted, ...candidates]) {
      const line = lesson.status === "candidate" ? `- (unproven) ${lesson.text}` : `- ${lesson.text}`;
      if (line.length + 1 > budget) break;
      budget -= line.length + 1;
      lines.push(line);
      injected.push(lesson.id);
      lesson.injections++;
    }

    this.pending.set(this.key(agentId, taskId), { injected, ...(opts?.model !== undefined ? { model: opts.model } : {}) });
    if (prior || injected.length > 0) saveExperience(this.cwd, agentId, file);

    if (lines.length === 0) return { bounced };
    return {
      bounced,
      lessonsSection: `# What you have learned\nLessons from your own past verified work. Trust the plain ones; treat (unproven) ones as hypotheses to test against reality.\n${lines.join("\n")}`,
    };
  }

  /** Called by CrewRun when the specialist returns, so capture has the report at completion time. */
  recordReport(agentId: string, taskId: string, report: string): void {
    const run = this.pending.get(this.key(agentId, taskId));
    if (run) run.report = report;
  }

  /**
   * Called when a crew-owned task transitions to completed — the harness's
   * "verified" moment. Confirms injected lessons (promoting those that earn
   * it), captures up to {@link MAX_LESSONS_PER_CAPTURE} new candidates from
   * the stored report, and appends task_completed to the service record.
   * Never throws: experience is an enhancement, not a turn dependency.
   */
  async onTaskCompleted(task: TaskItem, runInference: ExperienceInference): Promise<void> {
    const agentId = task.owner;
    if (!agentId || agentId === "orchestrator") return;
    try {
      const file = loadExperience(this.cwd, agentId);
      const run = this.pending.get(this.key(agentId, task.id));

      for (const id of run?.injected ?? []) {
        const lesson = file.lessons.find((l) => l.id === id);
        if (!lesson || lesson.status === "retired") continue;
        lesson.confirmations++;
        if (!lesson.distinctTasks.includes(task.id)) lesson.distinctTasks.push(task.id);
        if (
          lesson.status === "candidate" &&
          lesson.confirmations >= PROMOTE_CONFIRMATIONS &&
          lesson.distinctTasks.length >= PROMOTE_DISTINCT_TASKS &&
          lesson.contradictions === 0
        ) {
          lesson.status = "promoted";
          lesson.promotedAt = new Date().toISOString();
          this.safeRecord(agentId, "lesson_promoted", { lessonId: lesson.id, text: lesson.text });
        }
      }

      if (run?.report) {
        const reply = await runInference({
          system: EXTRACTION_SYSTEM_PROMPT,
          user: `Task: ${task.subject}\n\nThe specialist's report:\n${run.report.slice(0, 8000)}`,
          maxTokens: 300,
        });
        for (const { scope, text } of parseExtraction(reply)) {
          const check = validateLessonText(text, file.lessons);
          if (!check.ok) continue;
          file.lessons.push({
            id: `l_${randomBytes(3).toString("hex")}`,
            text: check.text,
            scope,
            status: "candidate",
            confirmations: 0,
            contradictions: 0,
            injections: 0,
            distinctTasks: [],
            createdAt: new Date().toISOString(),
            source: { taskId: task.id, taskSubject: task.subject },
          });
        }
      }

      // Model-bound outcome: a track record is only meaningful when each entry
      // names the model that earned it (history does not survive model swaps).
      this.safeRecord(agentId, "task_completed", {
        taskId: task.id,
        subject: task.subject,
        ...(run?.model !== undefined ? { model: run.model } : {}),
      });
      this.pending.delete(this.key(agentId, task.id));
      saveExperience(this.cwd, agentId, file);
    } catch {
      /* silent degrade — a lost capture is cheap, a broken turn is not */
    }
  }

  /** Record appends must never break a run. */
  private safeRecord(agentId: string, event: Parameters<typeof appendRecord>[2], data: Record<string, unknown>): void {
    try {
      appendRecord(this.cwd, agentId, event, data);
    } catch {
      /* ignore */
    }
  }
}

/** True when the workspace has any experience state for this member (export includes it). */
export function hasExperience(cwd: string, agentId: string): boolean {
  return existsSync(experiencePath(cwd, agentId));
}
