import { z } from "zod";
import type { ToolDefinition, ToolResult } from "@magentra/core";

const inputSchema = z.object({
  skill: z.string().min(1).describe("The exact name of a skill from the Available skills list."),
  args: z
    .string()
    .optional()
    .describe("Optional arguments for the skill; substituted for $ARGUMENTS in the skill body when present."),
});

/**
 * Loads a named skill's instructions into the conversation so the model follows
 * them for the current task. Skills are project-defined prompt fragments
 * discovered from `.magentra/skills`; this tool just surfaces the chosen one.
 */
export const skillTool: ToolDefinition<z.infer<typeof inputSchema>> = {
  name: "Skill",
  description: `Loads a project skill's instructions into the conversation and follows them for the current task. Pass the exact skill name from the "Available skills" list; never invent names. Optional args are substituted into the skill or appended as ARGUMENTS.`,
  permissionClass: "read",
  parallelSafe: true,
  describeInput: (input) => `skill: ${input.skill}`,
  execute: async (input, ctx): Promise<ToolResult> => {
    const skills = ctx.session.skills ?? [];
    const skill = skills.find((s) => s.name === input.skill);
    if (!skill) {
      const names = skills.map((s) => s.name).join(", ") || "(none configured)";
      return {
        content: `Unknown skill "${input.skill}". Available skills: ${names}.`,
        isError: true,
      };
    }

    const args = input.args ?? "";
    let body = skill.body;
    let argsLine = "";
    if (body.includes("$ARGUMENTS")) {
      body = body.replaceAll("$ARGUMENTS", args);
    } else if (args) {
      argsLine = `\nARGUMENTS: ${args}`;
    }

    const content =
      `<system-reminder>The "${skill.name}" skill was invoked. Follow its instructions below now; they take priority over general guidance for this task.</system-reminder>\n` +
      `<command-name>/${skill.name}</command-name>\n` +
      body +
      argsLine;
    return { content };
  },
  inputSchema,
};
