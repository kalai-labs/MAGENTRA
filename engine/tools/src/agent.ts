import { z } from "zod";
import { isPromptDisabled } from "@magentra/protocol";
import { AGENT_TYPES, agentDescriptionText, type ToolDefinition } from "@magentra/core";

/** The types a subagent can actually be spawned as: those whose blurb is not empty. */
function offeredAgentTypes(): typeof AGENT_TYPES[keyof typeof AGENT_TYPES][] {
  return Object.values(AGENT_TYPES).filter((t) => !isPromptDisabled(t.description));
}

/**
 * The picker list, built on every read rather than captured in a module constant.
 *
 * A constant would freeze the blurbs at import: an edit in the registry would
 * never reach the model, and emptying one would leave a dangling `- name:` line
 * advertising a type with nothing said about it. Reading here also lets a
 * disabled blurb drop its type from the list entirely, which is what switching a
 * prompt off means everywhere else.
 */
function agentTypeList(): string {
  return offeredAgentTypes()
    .map((t) => `- ${t.name}: ${agentDescriptionText(t)}`)
    .join("\n");
}

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
    // Deliberately not a second copy of the type list: this string is built at
    // module load and would go stale, while `{{agentTypes}}` below is read live.
    .describe("The type of subagent to use, named exactly as listed in this tool's description (default general-purpose)."),
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

Use it to fan out independent work (parallel Agent calls in one turn run concurrently), or to run a large search whose intermediate file contents you do not want in your own context. The subagent shares your working directory but starts with no memory of this conversation, so its prompt must be self-contained.

Once you delegate a search, do not also run it yourself — wait for the result. For a single-fact lookup where you already know the file or symbol, search directly instead.

The subagent's report is never shown to the user, so relay what matters. Subagents cannot spawn further subagents and cannot ask the user questions.

Available subagent types:
{{agentTypes}}`,
  // A getter, so the list is resolved when the description is rendered rather
  // than when this module is imported.
  descriptionVars: {
    get agentTypes() {
      return agentTypeList();
    },
  },
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
