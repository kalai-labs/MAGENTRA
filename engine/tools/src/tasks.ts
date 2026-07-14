import { z } from "zod";
import type { ToolDefinition } from "@magentra/core";
import type { TaskItem } from "@magentra/protocol";

/**
 * Resolve a model-supplied task reference to a real task id. Models routinely
 * echo the display form ("#3"), invent prefixes ("task-3", "Task 3"), or pass
 * the task's subject instead of its id — accept every unambiguous form rather
 * than failing the call. Returns undefined when nothing matches (or a subject
 * substring matches more than one task).
 */
export function resolveTaskId(tasks: TaskItem[], ref: string): string | undefined {
  const trimmed = ref.trim();
  if (trimmed === "") return undefined;

  // "#3", "task-3", "task 3", "Task #3" → "3"
  const normalized = trimmed.replace(/^task[\s\-_#]*/i, "").replace(/^#/, "").trim();
  for (const candidate of [trimmed, normalized]) {
    if (tasks.some((t) => t.id === candidate)) return candidate;
  }

  // Fall back to the subject: exact (case-insensitive) first, then a unique
  // substring match.
  const lower = trimmed.toLowerCase();
  const exact = tasks.filter((t) => t.subject.toLowerCase() === lower);
  if (exact.length === 1) return exact[0]!.id;
  if (exact.length > 1) return undefined;
  const partial = tasks.filter((t) => t.subject.toLowerCase().includes(lower));
  return partial.length === 1 ? partial[0]!.id : undefined;
}

/** Build a not-found error that teaches the model the current valid ids. */
function taskNotFound(tasks: TaskItem[], ref: string): string {
  if (tasks.length === 0) {
    return `No task matches "${ref}" — the task list is empty. Create tasks with TaskCreate before updating or reading them.`;
  }
  const listing = tasks.map((t) => `#${t.id} [${t.status}] ${t.subject}`).join("\n");
  return `No task matches "${ref}". Task ids are the numbers shown by TaskCreate/TaskList (pass "3" or "#3"). Current tasks:\n${listing}`;
}

const createSchema = z.object({
  subject: z.string().describe("A brief, actionable title in imperative form"),
  description: z.string().describe("What needs to be done"),
  activeForm: z
    .string()
    .optional()
    .describe('Present continuous form shown in the spinner when in_progress (e.g. "Running tests")'),
  metadata: z.record(z.string(), z.unknown()).optional().describe("Arbitrary metadata to attach to the task"),
});

export const taskCreateTool: ToolDefinition<z.infer<typeof createSchema>> = {
  name: "TaskCreate",
  description: `Adds a task to the session task list so the user can follow progress.

Use it for multi-step work (3+ distinct steps), when the user lists several things to do, or when new requirements arrive mid-task. Skip it for a single trivial action — just do the work. Tasks start as pending; use TaskUpdate to move them through in_progress to completed, and check TaskList first to avoid duplicates.`,
  permissionClass: "interact",
  parallelSafe: true,
  execute: async (input, ctx) => {
    const task = ctx.session.tasks.create(input);
    return { content: `Task #${task.id} created: ${task.subject}` };
  },
  inputSchema: createSchema,
};

const updateSchema = z.object({
  taskId: z.string().describe('The task id as reported by TaskCreate/TaskList — a number string like "3" ("#3" is also accepted)'),
  subject: z.string().optional().describe("New subject for the task"),
  description: z.string().optional().describe("New description for the task"),
  activeForm: z.string().optional().describe("Present continuous form shown in spinner when in_progress"),
  status: z
    .enum(["pending", "in_progress", "completed", "deleted"])
    .optional()
    .describe("New status. Workflow: pending -> in_progress -> completed; deleted removes the task permanently."),
  owner: z.string().optional().describe("New owner for the task"),
  metadata: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Metadata keys to merge into the task. Set a key to null to delete it."),
  addBlocks: z.array(z.string()).optional().describe("Task IDs that this task blocks"),
  addBlockedBy: z.array(z.string()).optional().describe("Task IDs that block this task"),
});

export const taskUpdateTool: ToolDefinition<z.infer<typeof updateSchema>> = {
  name: "TaskUpdate",
  description: `Updates a task in the session task list.

Mark a task in_progress before starting it and completed the moment it is fully done. Never mark completed while tests fail, the implementation is partial, or errors are unresolved — keep it in_progress and create a new task for the blocker. Read the task's current state (TaskGet) before updating it.`,
  permissionClass: "interact",
  parallelSafe: true,
  execute: async (input, ctx) => {
    const { taskId: rawId, ...patch } = input;
    const all = ctx.session.tasks.list();
    const taskId = resolveTaskId(all, rawId);
    if (taskId === undefined) {
      return { content: taskNotFound(all, rawId), isError: true };
    }
    // Resolve dependency references with the same leniency as taskId.
    for (const key of ["addBlocks", "addBlockedBy"] as const) {
      const refs = patch[key];
      if (!refs) continue;
      const resolved: string[] = [];
      for (const ref of refs) {
        const id = resolveTaskId(all, ref);
        if (id === undefined) return { content: taskNotFound(all, ref), isError: true };
        resolved.push(id);
      }
      patch[key] = resolved;
    }
    try {
      const task = ctx.session.tasks.update(taskId, patch);
      if (patch.status === "deleted") {
        return { content: `Task #${taskId} deleted.` };
      }

      let content = `Task #${task.id} updated: [${task.status}] ${task.subject}`;

      if (patch.status === "in_progress") {
        const blockers = task.blockedBy
          .map((id) => ctx.session.tasks.get(id))
          .filter((t): t is TaskItem => t !== undefined && t.status !== "completed");
        if (blockers.length > 0) {
          const list = blockers.map((b) => `#${b.id} ${b.subject} [${b.status}]`).join(", ");
          content += `\nadvisory: this task is blocked by ${list} — finish blockers first, or state why proceeding is safe.`;
        }

        const others = ctx.session.tasks.list().filter((t) => t.id !== task.id && t.status === "in_progress");
        if (others.length > 0) {
          const ids = others.map((t) => `#${t.id}`).join(", ");
          content += `\nadvisory: task(s) ${ids} are also in_progress — one active task at a time keeps the mission honest; finish or pause them.`;
        }
      }

      if (patch.status === "completed") {
        const remaining = ctx.session.tasks.list().filter((t) => t.status === "pending" || t.status === "in_progress");
        if (remaining.length === 0) {
          content +=
            "\nfinal task completed — your wrap-up must state the verification command you ran and its observed output: expected vs observed, verdict.";
        }
      }

      return { content };
    } catch (err) {
      return { content: (err as Error).message, isError: true };
    }
  },
  inputSchema: updateSchema,
};

const listSchema = z.object({});

export const taskListTool: ToolDefinition<z.infer<typeof listSchema>> = {
  name: "TaskList",
  description: `Lists all tasks in the session task list with id, subject, status, owner, and blockedBy. Pending tasks are tagged [pending READY] or [pending BLOCKED by #ids] based on whether their blockers are done. Use it to find available work, check progress, or spot blocked tasks. Prefer working on tasks in id order.`,
  permissionClass: "read",
  execute: async (_input, ctx) => {
    const tasks = ctx.session.tasks.list();
    if (tasks.length === 0) return { content: "The task list is empty." };
    const byId = new Map(tasks.map((t) => [t.id, t]));
    return {
      content: tasks
        .map((t) => {
          let statusTag = t.status as string;
          if (t.status === "pending") {
            const openBlockers = t.blockedBy.filter((id) => byId.get(id)?.status !== "completed");
            statusTag =
              openBlockers.length > 0 ? `pending BLOCKED by ${openBlockers.map((id) => `#${id}`).join(", ")}` : "pending READY";
          }
          return `#${t.id} [${statusTag}]${t.owner ? ` (owner: ${t.owner})` : ""} ${t.subject}${
            t.blockedBy.length > 0 ? ` (blocked by: ${t.blockedBy.join(", ")})` : ""
          }`;
        })
        .join("\n"),
    };
  },
  inputSchema: listSchema,
};

const getSchema = z.object({
  taskId: z.string().describe('The task id as reported by TaskCreate/TaskList — a number string like "3" ("#3" is also accepted)'),
});

export const taskGetTool: ToolDefinition<z.infer<typeof getSchema>> = {
  name: "TaskGet",
  description: `Retrieves one task with its full description, status, owner, and dependency lists (blocks / blockedBy). Check that blockedBy is empty before starting the task.`,
  permissionClass: "read",
  execute: async (input, ctx) => {
    const all = ctx.session.tasks.list();
    const taskId = resolveTaskId(all, input.taskId);
    const task = taskId !== undefined ? ctx.session.tasks.get(taskId) : undefined;
    if (!task) return { content: taskNotFound(all, input.taskId), isError: true };
    return { content: JSON.stringify(task, null, 2) };
  },
  inputSchema: getSchema,
};
