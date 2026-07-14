import { z } from "zod";
import { AGENT_TYPES, type ToolDefinition } from "@magentra/core";

const agentTypeList = Object.values(AGENT_TYPES)
  .map((t) => `- ${t.name}: ${t.description}`)
  .join("\n");

const inputSchema = z.object({
  description: z.string().describe("A short (3-5 word) description of the task"),
  prompt: z
    .string()
    .describe(
      "The full task for the subagent. It runs autonomously and cannot ask you questions, so include every detail it needs and state exactly what to return.",
    ),
  subagent_type: z
    .string()
    .optional()
    .describe(`The type of subagent to use (default general-purpose). One of: ${Object.keys(AGENT_TYPES).join(", ")}.`),
  run_in_background: z
    .boolean()
    .optional()
    .describe(
      "Run the subagent in the background and return a task id immediately; its result lands in the task output file. Use TaskOutput to collect it.",
    ),
});

export const agentTool: ToolDefinition<z.infer<typeof inputSchema>> = {
  name: "Agent",
  description: `Delegates a task to a fresh subagent with its own context window and a restricted tool set, then returns the subagent's final report as the tool result.

Use it to fan out independent work (parallel Agent calls in one turn run concurrently), or to run a large search/investigation whose intermediate file contents you do not want in your own context. The subagent shares your working directory but starts with no memory of this conversation, so its prompt must be self-contained.

Subagents cannot spawn further subagents, and cannot ask the user questions. Available subagent types:
${agentTypeList}`,
  permissionClass: "read",
  parallelSafe: true,
  describeInput: (input) => `Agent (${input.subagent_type ?? "general-purpose"}): ${input.description}`,
  execute: async (input, ctx) => {
    const agentType = input.subagent_type ?? "general-purpose";
    try {
      const result = await ctx.session.spawnAgent({
        agentType,
        prompt: input.prompt,
        description: input.description,
        ...(input.run_in_background !== undefined ? { runInBackground: input.run_in_background } : {}),
      });
      if (input.run_in_background) {
        return {
          content: `Subagent (${agentType}) launched in background with task id: ${result}. Its final report will be written to the task output file; use TaskOutput(${result}) to collect it.`,
        };
      }
      return { content: result };
    } catch (err) {
      return { content: (err as Error).message, isError: true };
    }
  },
  inputSchema,
};
