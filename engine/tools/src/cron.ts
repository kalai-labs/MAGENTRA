import { z } from "zod";
import type { SessionServices, ToolDefinition } from "@magentra/core";

/**
 * Structural view of the CronScheduler the session exposes as `session.cron`.
 * Kept structural so this package needs no runtime import of the class.
 */
interface CronSchedulerLike {
  create(opts: {
    cron: string;
    prompt: string;
    recurring?: boolean;
    durable?: boolean;
  }): { id: string; nextFire: Date | null };
  delete(id: string): boolean;
  list(): Array<{
    id: string;
    cron: string;
    prompt: string;
    recurring: boolean;
    durable: boolean;
    source: "cron" | "wakeup";
    createdAt: number;
    fireAt?: number;
    reason?: string;
  }>;
  scheduleWakeup(opts: { delaySeconds: number; reason: string; prompt: string }): { id: string; fireAt: Date };
}

const NO_CRON =
  "The cron scheduler is not wired into this session (session.cron is undefined).";

function getCron(session: SessionServices): CronSchedulerLike | undefined {
  return session.cron;
}

// -- CronCreate --------------------------------------------------------------

const createSchema = z.object({
  cron: z
    .string()
    .describe(
      'Standard 5-field cron (minute hour day-of-month month day-of-week), local time. Supports *, */N, N, N-M, and comma lists. For one-shot "remind me at X" jobs, pin the exact fields; avoid round times like :00/:30 when the time is only approximate.',
    ),
  prompt: z
    .string()
    .min(1)
    .describe("The instruction to inject as a user message when the job fires while the REPL is idle."),
  recurring: z
    .boolean()
    .optional()
    .default(true)
    .describe("If false, the job fires once at the next matching minute and is then removed."),
  durable: z
    .boolean()
    .optional()
    .default(false)
    .describe("If true, the job persists to disk and survives restarts. Otherwise it is session-only."),
});

export const cronCreateTool: ToolDefinition<z.infer<typeof createSchema>> = {
  name: "CronCreate",
  description: `Schedules a recurring or one-shot cron job that fires a prompt while the REPL is idle.

Jobs fire only when the current minute matches the cron expression AND the session is idle (never mid-turn). Recurring jobs auto-expire 7 days after creation — tell the user this when you schedule one. Jobs are session-only unless durable is set. Use recurring:false for one-time reminders.`,
  permissionClass: "interact",
  describeInput: (input) => `cron ${input.cron}`,
  execute: async (input, ctx) => {
    const cron = getCron(ctx.session);
    if (!cron) return { content: NO_CRON, isError: true };
    try {
      const { id, nextFire } = cron.create({
        cron: input.cron,
        prompt: input.prompt,
        recurring: input.recurring,
        durable: input.durable,
      });
      const next = nextFire ? nextFire.toISOString() : "unknown (no match within a year)";
      const expiry = input.recurring ? " Recurring jobs auto-expire 7 days after creation." : "";
      return {
        content: `Scheduled job ${id} (${input.recurring ? "recurring" : "one-shot"}${input.durable ? ", durable" : ""}). Next fire: ${next}. Jobs only fire while the REPL is idle.${expiry}`,
      };
    } catch (err) {
      return { content: `Invalid cron expression: ${(err as Error).message}`, isError: true };
    }
  },
  inputSchema: createSchema,
};

// -- CronDelete --------------------------------------------------------------

const deleteSchema = z.object({
  id: z.string().describe("The id of the scheduled job to delete."),
});

export const cronDeleteTool: ToolDefinition<z.infer<typeof deleteSchema>> = {
  name: "CronDelete",
  description: "Deletes a scheduled cron job or wakeup by its id.",
  permissionClass: "interact",
  describeInput: (input) => `delete ${input.id}`,
  execute: async (input, ctx) => {
    const cron = getCron(ctx.session);
    if (!cron) return { content: NO_CRON, isError: true };
    const removed = cron.delete(input.id);
    return removed
      ? { content: `Deleted scheduled job ${input.id}.` }
      : { content: `No scheduled job with id ${input.id}.`, isError: true };
  },
  inputSchema: deleteSchema,
};

// -- CronList ----------------------------------------------------------------

const listSchema = z.object({});

export const cronListTool: ToolDefinition<z.infer<typeof listSchema>> = {
  name: "CronList",
  description: "Lists all scheduled cron jobs and wakeups for this session.",
  permissionClass: "interact",
  execute: async (_input, ctx) => {
    const cron = getCron(ctx.session);
    if (!cron) return { content: NO_CRON, isError: true };
    const jobs = cron.list();
    if (jobs.length === 0) return { content: "No scheduled jobs." };
    return {
      content: jobs
        .map((j) => {
          const when = j.source === "wakeup" && j.fireAt ? `at ${new Date(j.fireAt).toISOString()}` : `cron "${j.cron}"`;
          const flags = [j.recurring ? "recurring" : "one-shot", j.durable ? "durable" : "session"].join(", ");
          return `${j.id} [${flags}] ${when} -> ${j.prompt}`;
        })
        .join("\n"),
    };
  },
  inputSchema: listSchema,
};

// -- ScheduleWakeup ----------------------------------------------------------

const wakeupSchema = z.object({
  delaySeconds: z
    .number()
    .describe("Delay before the wakeup fires, in seconds. Clamped to [60, 3600]."),
  reason: z.string().min(1).describe("Short human-readable reason for the wakeup."),
  prompt: z.string().min(1).describe("The instruction injected when the wakeup fires (only while idle)."),
});

export const scheduleWakeupTool: ToolDefinition<z.infer<typeof wakeupSchema>> = {
  name: "ScheduleWakeup",
  description: `Schedules a single delayed wakeup (60s–1h) that injects a prompt once the REPL is next idle.

Use this to revisit something after a short wait (e.g. "check the build in 5 minutes"). The delay is clamped to [60, 3600] seconds. It fires once and is then removed; it never interrupts a running turn.`,
  permissionClass: "interact",
  describeInput: (input) => `wakeup in ${input.delaySeconds}s`,
  execute: async (input, ctx) => {
    const cron = getCron(ctx.session);
    if (!cron) return { content: NO_CRON, isError: true };
    const { id, fireAt } = cron.scheduleWakeup({
      delaySeconds: input.delaySeconds,
      reason: input.reason,
      prompt: input.prompt,
    });
    return { content: `Scheduled wakeup ${id} for ${fireAt.toISOString()} (fires once, while idle).` };
  },
  inputSchema: wakeupSchema,
};
