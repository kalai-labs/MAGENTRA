import { z } from "zod";
import { isPromptDisabled, toolDescription, toolParam } from "@magentra/protocol";
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
  description: z.string().describe(toolParam("Agent", "description")),
  prompt: z
    .string()
    .describe(toolParam("Agent", "prompt")),
  subagent_type: z
    .string()
    .optional()
    // Deliberately not a second copy of the type list: this string is built at
    // module load and would go stale, while `{{agentTypes}}` below is read live.
    .describe(toolParam("Agent", "subagent_type")),
  run_in_background: z
    .boolean()
    .optional()
    .describe(toolParam("Agent", "run_in_background")),
});

export const agentTool: ToolDefinition<z.infer<typeof inputSchema>> = {
  name: "Agent",
  description: toolDescription("Agent"),
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
