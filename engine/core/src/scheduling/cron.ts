import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * In-process scheduler for cron jobs and one-shot wakeups. A job fires only when
 * its cron matches the current minute (local time) AND the REPL is idle. Jobs
 * are session-only unless `durable`, in which case they persist to
 * <stateDir>/scheduled_tasks.json and reload on construction.
 *
 * Jitter: recurring jobs fire a stable, per-job number of minutes late (0..15),
 * derived from a hash of the job id, to avoid a thundering herd on round times.
 * This is a documented simplification of the "up to 10% of period, max 15 min"
 * rule (we cap at 15 without computing the exact period). Disable via
 * `jitter: false` (used by deterministic tests).
 */

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const TICK_MS = 30_000;
const MAX_JITTER_MIN = 15;
const WAKEUP_MIN_S = 60;
const WAKEUP_MAX_S = 3600;

// ---------------------------------------------------------------------------
// Cron parsing (standard 5-field: minute hour day-of-month month day-of-week)
// ---------------------------------------------------------------------------

export interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domStar: boolean;
  dowStar: boolean;
}

function parseField(field: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const partRaw of field.split(",")) {
    const part = partRaw.trim();
    if (part === "") throw new Error("empty element in cron field");
    let step = 1;
    let rangePart = part;
    const slash = part.indexOf("/");
    if (slash !== -1) {
      rangePart = part.slice(0, slash);
      step = Number(part.slice(slash + 1));
      if (!Number.isInteger(step) || step <= 0) throw new Error(`invalid step in "${part}"`);
    }
    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      lo = min;
      hi = max;
    } else if (rangePart.includes("-")) {
      const dash = rangePart.indexOf("-");
      lo = Number(rangePart.slice(0, dash));
      hi = Number(rangePart.slice(dash + 1));
    } else {
      lo = hi = Number(rangePart);
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) throw new Error(`invalid value in "${part}"`);
    if (lo < min || hi > max || lo > hi) throw new Error(`value out of range [${min},${max}] in "${part}"`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron expression must have 5 fields, got ${parts.length}: "${expr}"`);
  const [mi, ho, dm, mo, dw] = parts as [string, string, string, string, string];
  const dow = parseField(dw, 0, 7);
  if (dow.has(7)) {
    dow.add(0);
    dow.delete(7);
  }
  return {
    minute: parseField(mi, 0, 59),
    hour: parseField(ho, 0, 23),
    dom: parseField(dm, 1, 31),
    month: parseField(mo, 1, 12),
    dow,
    domStar: dm === "*",
    dowStar: dw === "*",
  };
}

export function matchesCron(fields: CronFields, date: Date): boolean {
  if (!fields.minute.has(date.getMinutes())) return false;
  if (!fields.hour.has(date.getHours())) return false;
  if (!fields.month.has(date.getMonth() + 1)) return false;
  const domMatch = fields.dom.has(date.getDate());
  const dowMatch = fields.dow.has(date.getDay());
  // Standard cron: if both DOM and DOW are restricted, match on either; if one
  // (or both) is "*", the "*" side always matches, so the effective rule is AND.
  if (fields.domStar || fields.dowStar) return domMatch && dowMatch;
  return domMatch || dowMatch;
}

/** Next minute strictly after `from` that matches `fields`, or null within a year. */
export function nextCronMatch(fields: CronFields, from: Date): Date | null {
  let d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d = new Date(d.getTime() + 60_000);
  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (matchesCron(fields, d)) return d;
    d = new Date(d.getTime() + 60_000);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export type CronJobSource = "cron" | "wakeup";

/** Serialized/public view of a scheduled job. */
export interface CronJob {
  id: string;
  cron: string; // "" for wakeups
  prompt: string;
  recurring: boolean;
  durable: boolean;
  source: CronJobSource;
  createdAt: number;
  fireAt?: number; // epoch ms, wakeups only
  reason?: string;
}

interface InternalJob extends CronJob {
  fields?: CronFields;
  jitterMin: number;
  lastFireKey?: number;
}

export interface CronSchedulerOptions {
  stateDir: string;
  isIdle: () => boolean;
  enqueue: (prompt: string, source: CronJobSource) => void;
  /** Injectable clock for tests. When provided, the 30s auto-tick timer is NOT started. */
  now?: () => Date;
  /** Disable jitter (deterministic firing). Defaults to true. */
  jitter?: boolean;
}

export class CronScheduler {
  private readonly jobs = new Map<string, InternalJob>();
  private readonly stateDir: string;
  private readonly isIdle: () => boolean;
  private readonly enqueue: (prompt: string, source: CronJobSource) => void;
  private readonly now: () => Date;
  private readonly jitter: boolean;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(opts: CronSchedulerOptions) {
    this.stateDir = opts.stateDir;
    this.isIdle = opts.isIdle;
    this.enqueue = opts.enqueue;
    this.now = opts.now ?? ((): Date => new Date());
    this.jitter = opts.jitter ?? true;
    this.load();
    if (!opts.now) {
      this.timer = setInterval(() => this.tick(), TICK_MS);
      if (typeof this.timer.unref === "function") this.timer.unref();
    }
  }

  create(opts: {
    cron: string;
    prompt: string;
    recurring?: boolean;
    durable?: boolean;
  }): { id: string; nextFire: Date | null } {
    const fields = parseCron(opts.cron); // throws on invalid cron
    const id = genId();
    const job: InternalJob = {
      id,
      cron: opts.cron,
      prompt: opts.prompt,
      recurring: opts.recurring ?? true,
      durable: opts.durable ?? false,
      source: "cron",
      createdAt: this.now().getTime(),
      fields,
      jitterMin: this.jitterFor(id),
    };
    this.jobs.set(id, job);
    if (job.durable) this.persist();
    return { id, nextFire: nextCronMatch(fields, this.now()) };
  }

  scheduleWakeup(opts: { delaySeconds: number; reason: string; prompt: string }): { id: string; fireAt: Date } {
    const delay = Math.min(Math.max(Math.round(opts.delaySeconds), WAKEUP_MIN_S), WAKEUP_MAX_S);
    const fireAt = this.now().getTime() + delay * 1000;
    const id = genId();
    const job: InternalJob = {
      id,
      cron: "",
      prompt: opts.prompt,
      recurring: false,
      durable: false,
      source: "wakeup",
      createdAt: this.now().getTime(),
      fireAt,
      reason: opts.reason,
      jitterMin: 0,
    };
    this.jobs.set(id, job);
    return { id, fireAt: new Date(fireAt) };
  }

  delete(id: string): boolean {
    const had = this.jobs.delete(id);
    if (had) this.persist();
    return had;
  }

  list(): CronJob[] {
    return [...this.jobs.values()].map((j) => strip(j));
  }

  /** Advances the scheduler. Fires every job that is due AND idle-eligible. */
  tick(): void {
    const now = this.now();
    const idle = this.isIdle();
    for (const job of [...this.jobs.values()]) {
      if (!this.isDue(job, now)) continue;
      if (!idle) continue; // defer: re-evaluated on the next tick
      this.enqueue(job.prompt, job.source);

      if (job.fireAt !== undefined || !job.recurring) {
        // one-shot (wakeup, or non-recurring cron) — remove after firing
        this.jobs.delete(job.id);
        if (job.durable) this.persist();
        continue;
      }

      job.lastFireKey = this.fireKey(job, now);
      // Ephemeral recurring jobs expire 7 days after creation (a forgotten
      // in-session cron must not fire forever). DURABLE jobs — scheduled
      // missions the user explicitly armed — never expire: a weekly mission
      // must survive week 2.
      if (!job.durable && now.getTime() >= job.createdAt + SEVEN_DAYS_MS) {
        this.jobs.delete(job.id);
      }
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  // -- internals ------------------------------------------------------------

  private isDue(job: InternalJob, now: Date): boolean {
    if (job.fireAt !== undefined) return now.getTime() >= job.fireAt;
    if (!job.fields) return false;
    const key = this.fireKey(job, now);
    if (job.lastFireKey === key) return false; // already fired this occurrence
    const offset = this.jitter ? job.jitterMin : 0;
    const nominal = new Date(now.getTime() - offset * 60_000);
    return matchesCron(job.fields, nominal);
  }

  private fireKey(job: InternalJob, now: Date): number {
    const offset = this.jitter ? job.jitterMin : 0;
    return Math.floor((now.getTime() - offset * 60_000) / 60_000);
  }

  private jitterFor(id: string): number {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) & 0xffffffff;
    return Math.abs(h) % (MAX_JITTER_MIN + 1);
  }

  private stateFile(): string {
    return join(this.stateDir, "scheduled_tasks.json");
  }

  private persist(): void {
    const durable = [...this.jobs.values()].filter((j) => j.durable).map((j) => strip(j));
    try {
      mkdirSync(dirname(this.stateFile()), { recursive: true });
      writeFileSync(this.stateFile(), JSON.stringify({ jobs: durable }, null, 2), "utf8");
    } catch {
      // best-effort persistence; never crash the scheduler
    }
  }

  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.stateFile(), "utf8");
    } catch {
      return;
    }
    let parsed: { jobs?: CronJob[] };
    try {
      parsed = JSON.parse(raw) as { jobs?: CronJob[] };
    } catch {
      return;
    }
    for (const j of parsed.jobs ?? []) {
      if (!j || typeof j.id !== "string") continue;
      let fields: CronFields | undefined;
      if (j.source === "cron") {
        try {
          fields = parseCron(j.cron);
        } catch {
          continue; // drop jobs whose cron no longer parses
        }
      }
      this.jobs.set(j.id, {
        ...j,
        recurring: j.recurring ?? true,
        durable: true,
        ...(fields ? { fields } : {}),
        jitterMin: this.jitterFor(j.id),
      });
    }
  }
}

function strip(job: InternalJob): CronJob {
  const out: CronJob = {
    id: job.id,
    cron: job.cron,
    prompt: job.prompt,
    recurring: job.recurring,
    durable: job.durable,
    source: job.source,
    createdAt: job.createdAt,
  };
  if (job.fireAt !== undefined) out.fireAt = job.fireAt;
  if (job.reason !== undefined) out.reason = job.reason;
  return out;
}

function genId(): string {
  return `sched_${randomBytes(4).toString("hex")}`;
}
