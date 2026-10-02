import { readFileSync } from "node:fs";
import { z } from "zod";
import type { ToolDefinition } from "@magentra/core";
import { toolDescription, toolParam } from "@magentra/protocol";

const stopSchema = z.object({
  task_id: z.string().describe(toolParam("TaskStop", "task_id")),
});

export const taskStopTool: ToolDefinition<z.infer<typeof stopSchema>> = {
  name: "TaskStop",
  description: toolDescription("TaskStop"),
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
  task_id: z.string().describe(toolParam("TaskOutput", "task_id")),
  block: z
    .boolean()
    .default(true)
    .describe(toolParam("TaskOutput", "block")),
  timeout: z
    .number()
    .int()
    .positive()
    .default(30_000)
    .describe(toolParam("TaskOutput", "timeout")),
});

export const taskOutputTool: ToolDefinition<z.infer<typeof outputSchema>> = {
  name: "TaskOutput",
  description: toolDescription("TaskOutput"),
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
