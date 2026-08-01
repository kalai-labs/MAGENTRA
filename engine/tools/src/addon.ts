import { z } from "zod";
import { addonInvocationHeader, type ToolDefinition, type ToolResult } from "@magentra/core";

const inputSchema = z.object({
  addon: z.string().min(1).describe("The exact name of an addon from the Available addons list."),
  args: z
    .string()
    .optional()
    .describe("Optional arguments for the addon; substituted for $ARGUMENTS in the addon body when present."),
});

/**
 * Loads a named addon's instructions into the conversation so the model follows
 * them for the current task.
 *
 * Only names and descriptions ride in the system prompt, so the body is paid for
 * exactly once, when the model decides the addon applies. When the addon owns a
 * directory, its sibling files are listed alongside the body: reference notes to
 * Read and scripts to run with Bash, fetched on demand rather than inlined here.
 */
export const addonTool: ToolDefinition<z.infer<typeof inputSchema>> = {
  name: "Addon",
  // Phrased as the target behaviour rather than a prohibition: the old wording
  // ("never invent names") spends its most-read clause naming the failure, which
  // makes it more available, not less. Copying a name from the list is the whole
  // instruction, and an unknown name already returns the list as an error.
  description: `Loads an addon's instructions into the conversation and follows them for the current task. Copy the addon name exactly as it appears in the "Available addons" list. Optional args are substituted into the addon or appended as ARGUMENTS.`,
  permissionClass: "read",
  parallelSafe: true,
  describeInput: (input) => `addon: ${input.addon}`,
  execute: async (input, ctx): Promise<ToolResult> => {
    const addons = ctx.session.addons ?? [];
    const addon = addons.find((a) => a.name === input.addon);
    if (!addon) {
      const names = addons.map((a) => a.name).join(", ") || "(none installed)";
      return {
        content: `Unknown addon "${input.addon}". Available addons: ${names}.`,
        isError: true,
      };
    }

    const args = input.args ?? "";
    let body = addon.body;
    let argsLine = "";
    if (body.includes("$ARGUMENTS")) {
      body = body.replaceAll("$ARGUMENTS", args);
    } else if (args) {
      argsLine = `\nARGUMENTS: ${args}`;
    }

    // Sibling files are named, never inlined: the addon body says which ones
    // matter, and the model spends a Read or a Bash call only on those.
    const resourceLines =
      addon.resources.length > 0
        ? `\n\n<system-reminder>Files bundled with this addon — read the ones its instructions point at, and run its scripts with Bash:\n${addon.resources
            .map((r) => `- ${r}`)
            .join("\n")}</system-reminder>`
        : "";

    const content = addonInvocationHeader(addon.name) + body + argsLine + resourceLines;
    return { content };
  },
  inputSchema,
};
