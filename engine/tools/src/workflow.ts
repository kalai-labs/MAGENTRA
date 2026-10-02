import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { toolDescription, toolParam } from "@magentra/protocol";
import { WorkflowRunner, type ToolDefinition } from "@magentra/core";

const inputSchema = z
  .object({
    script: z
      .string()
      .optional()
      .describe(toolParam("Workflow", "script")),
    scriptPath: z
      .string()
      .optional()
      .describe(toolParam("Workflow", "scriptPath")),
    args: z.unknown().optional().describe(toolParam("Workflow", "args")),
  })
  .describe(toolParam("Workflow", "(root)"));

type WorkflowInput = z.infer<typeof inputSchema>;

const description = toolDescription("Workflow");

export const workflowTool: ToolDefinition<WorkflowInput> = {
  name: "Workflow",
  description,
  permissionClass: "execute",
  describeInput: (input) => `Workflow${input.scriptPath ? `: ${input.scriptPath}` : ""}`,
  execute: async (input, ctx, signal) => {
    let script = input.script;
    if (input.scriptPath) {
      const path = isAbsolute(input.scriptPath) ? input.scriptPath : resolve(ctx.cwd, input.scriptPath);
      try {
        script = readFileSync(path, "utf8");
      } catch (err) {
        return { content: `Could not read scriptPath "${path}": ${(err as Error).message}`, isError: true };
      }
    }
    if (!script) {
      return { content: "Workflow requires either `script` or `scriptPath`.", isError: true };
    }

    const logs: string[] = [];
    const result = await new WorkflowRunner().run({
      script,
      args: input.args,
      session: ctx.session,
      signal,
      onLog: (msg) => {
        logs.push(msg);
        // Live progress: phase()/log() lines tail into the tool row as they
        // happen instead of only appearing in the final result.
        if (ctx.callId) ctx.session.emit({ type: "tool_output_delta", id: ctx.callId, text: `${msg}\n` });
      },
    });

    const logSection = logs.length > 0 ? `\n\nlog:\n${logs.join("\n")}` : "";

    if (result.ok) {
      const body = JSON.stringify(
        {
          runId: result.meta.runId,
          meta: { name: result.meta.name, description: result.meta.description },
          agentCalls: result.meta.agentCalls,
          failures: result.meta.failures,
          value: result.value,
        },
        null,
        2,
      );
      return { content: body + logSection };
    }

    const body = JSON.stringify(
      {
        ...(result.meta ? { runId: result.meta.runId, meta: { name: result.meta.name, description: result.meta.description } } : {}),
        error: result.error,
      },
      null,
      2,
    );
    return { content: body + logSection, isError: true };
  },
  inputSchema,
};
