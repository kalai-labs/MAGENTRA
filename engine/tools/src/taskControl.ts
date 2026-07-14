import { readFileSync } from "node:fs";
import { z } from "zod";
import type { ToolDefinition } from "@magentra/core";

const stopSchema = z.object({
  task_id: z.string().describe("The id of the background task (bash, monitor, or agent) to stop"),
});

export const taskStopTool: ToolDefinition<z.infer<typeof stopSchema>> = {
  name: "TaskStop",
  description: `Stops a running background task (a backgrounded Bash command, a Monitor, or a background Agent) by its task id. Returns whether it was running. Already-finished or unknown ids are reported, not an error you need to retry.`,
  permissionClass: "execute",
  permissionSubject: (input) => input.task_id,
  describeInput: (input) => `Stop task ${input.task_id}`,
  execute: async (input, ctx) => {
    const stopped = ctx.session.background.stop(input.task_id);
    if (stopped) return { content: `Stopped task ${input.task_id}.` };
    const info = ctx.session.background.get(input.task_id);
    return {
      content: info
        ? `Task ${input.task_id} was not running (status: ${info.status}).`
        : `No background task with id ${input.task_id}.`,
      isError: true,
    };
  },
  inputSchema: stopSchema,
};

const outputSchema = z.object({
  task_id: z.string().describe("The id of the background task to read output from"),
  block: z
    .boolean()
    .default(true)
    .describe("If true, wait for the task to finish (up to timeout) before returning its output."),
  timeout: z
    .number()
    .int()
    .positive()
    .default(30_000)
    .describe("Max milliseconds to block waiting for the task to finish (default 30000)."),
});

export const taskOutputTool: ToolDefinition<z.infer<typeof outputSchema>> = {
  name: "TaskOutput",
  description: `Reads the accumulated output of a background task (backgrounded Bash, Monitor, or Agent). With block:true (the default) it waits until the task finishes or the timeout elapses, then returns the output; with block:false it returns whatever output exists right now. Use it to collect a background Agent's report or check on a long-running command.`,
  permissionClass: "read",
  permissionSubject: (input) => input.task_id,
  execute: async (input, ctx, signal) => {
    const info = ctx.session.background.get(input.task_id);
    if (!info) return { content: `No background task with id ${input.task_id}.`, isError: true };

    if (input.block) {
      const deadline = Date.now() + input.timeout;
      while (info.status === "running" && Date.now() < deadline && !signal.aborted) {
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    let output = "";
    try {
      output = readFileSync(info.outputFile, "utf8");
    } catch {
      output = "";
    }
    const header = `Task ${info.id} [${info.status}${info.exitCode !== undefined ? `, exit ${info.exitCode}` : ""}]:`;
    return { content: `${header}\n${output.length > 0 ? output : "(no output yet)"}` };
  },
  inputSchema: outputSchema,
};
