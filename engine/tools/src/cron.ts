import { z } from "zod";
import type { SessionServices, ToolDefinition } from "@magentra/core";
import { toolDescription, toolParam } from "@magentra/protocol";

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
    .describe(toolParam("CronCreate", "cron")),
  prompt: z
    .string()
    .min(1)
    .describe(toolParam("CronCreate", "prompt")),
  recurring: z
    .boolean()
    .optional()
    .default(true)
    .describe(toolParam("CronCreate", "recurring")),
  durable: z
    .boolean()
    .optional()
    .default(false)
    .describe(toolParam("CronCreate", "durable")),
});

export const cronCreateTool: ToolDefinition<z.infer<typeof createSchema>> = {
  name: "CronCreate",
  description: toolDescription("CronCreate"),
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
  id: z.string().describe(toolParam("CronDelete", "id")),
});

export const cronDeleteTool: ToolDefinition<z.infer<typeof deleteSchema>> = {
  name: "CronDelete",
  description: toolDescription("CronDelete"),
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
  description: toolDescription("CronList"),
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
    .describe(toolParam("ScheduleWakeup", "delaySeconds")),
  reason: z.string().min(1).describe(toolParam("ScheduleWakeup", "reason")),
  prompt: z.string().min(1).describe(toolParam("ScheduleWakeup", "prompt")),
});

export const scheduleWakeupTool: ToolDefinition<z.infer<typeof wakeupSchema>> = {
  name: "ScheduleWakeup",
  description: toolDescription("ScheduleWakeup"),
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
