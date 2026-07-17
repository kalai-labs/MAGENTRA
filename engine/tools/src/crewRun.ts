import { z } from "zod";
import { loadBackpackIndex, type ToolDefinition } from "@magentra/core";
import type { TaskItem } from "@magentra/protocol";
import { resolveTaskId } from "./tasks.js";

const inputSchema = z.object({
  taskId: z.string().describe("The id of an owned task to run its crew specialist on."),
  instructions: z
    .string()
    .optional()
    .describe("Optional extra instructions for the specialist, on top of the task's own issue text."),
});

export const crewRunTool: ToolDefinition<z.infer<typeof inputSchema>> = {
  name: "CrewRun",
  description: `Runs the crew specialist that owns a task on that task, and returns their report.

Assign the task an owner (a crew agent id) with TaskUpdate first, then call CrewRun with the taskId. The specialist runs as a subagent with its own role, model, and tools — it starts with no memory of this conversation, so the task's description must be self-contained. When it returns, verify its report against the task's acceptance check before marking the task completed; a failed check goes back to the owner with the evidence. Tasks you own yourself (owner "orchestrator") are done directly, not through CrewRun.

INDEPENDENT tasks (no blocked-by between them, different owners or different files) should be dispatched TOGETHER: call CrewRun once per task in the SAME message and the specialists run concurrently. Dispatch dependent tasks one at a time in order.`,
  // Delegation itself mutates nothing — every tool call the specialist makes
  // goes through the same permission engine as the orchestrator's own calls.
  // Gating CrewRun would double-gate (and stall parallel dispatch behind
  // simultaneous prompts). Same reasoning as the built-in Agent tool.
  permissionClass: "read",
  parallelSafe: true,
  describeInput: (input) => `CrewRun task #${input.taskId}`,
  execute: async (input, ctx) => {
    const team = ctx.session.team ?? [];
    // Same tolerant id forms TaskUpdate accepts ("3", "#3", "task 3") — a
    // weak model that echoes the display form must not be bounced here.
    const taskId = resolveTaskId(ctx.session.tasks.list(), input.taskId);
    const task = taskId !== undefined ? ctx.session.tasks.get(taskId) : undefined;
    if (!task) {
      return { content: `No task with id ${input.taskId}.`, isError: true };
    }
    if (!task.owner) {
      return {
        content: `Task #${task.id} has no owner. Assign an owner from your crew roster (a crew agent id, or "orchestrator") with TaskUpdate before running it.`,
        isError: true,
      };
    }
    if (task.owner === "orchestrator") {
      return {
        content: `Task #${task.id} is owned by "orchestrator" — own tasks are executed directly, not via CrewRun.`,
        isError: true,
      };
    }
    const agent = team.find((a) => a.id === task.owner);
    if (!agent) {
      return {
        content: `Task #${task.id} owner "${task.owner}" is not a crew member. Assign a valid owner from the roster (a crew agent id) with TaskUpdate first.`,
        isError: true,
      };
    }

    const brief = loadBackpackIndex(ctx.cwd, agent.id)?.brief;
    // Experience: assemble the member's learned-lessons section for this run
    // (and let the manager see a bounce — the same task re-dispatched).
    const begin = ctx.session.experience?.beginRun(agent.id, task.id, {
      model: agent.model ?? ctx.session.settings.model,
    });
    try {
      const result = await ctx.session.spawnAgent({
        agentType: "general-purpose",
        prompt: buildDelegationPrompt(task, input.instructions),
        description: `${task.owner}: ${task.subject}`,
        crew: {
          agent,
          ...(brief !== undefined ? { backpackBrief: brief } : {}),
          ...(begin?.lessonsSection !== undefined ? { lessons: begin.lessonsSection } : {}),
        },
      });
      ctx.session.experience?.recordReport(agent.id, task.id, result);
      return {
        content: `${result}\n\n<system-reminder>Verify this report against task #${task.id}'s acceptance check before marking it completed.</system-reminder>`,
      };
    } catch (err) {
      return { content: (err as Error).message, isError: true };
    }
  },
  inputSchema,
};

/** Builds the self-contained brief handed to the owning specialist. */
function buildDelegationPrompt(task: TaskItem, instructions?: string): string {
  const parts = [`Task #${task.id}: ${task.subject}`, task.description];
  if (instructions && instructions.trim()) parts.push(`Additional instructions:\n${instructions.trim()}`);
  parts.push("Report: what you did, what you verified, and the exact evidence for the acceptance check.");
  return parts.join("\n\n");
}
