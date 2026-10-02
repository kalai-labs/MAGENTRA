import { z } from "zod";
import { addonInvocationHeader, type ToolDefinition, type ToolResult } from "@magentra/core";
import { brainPrompt, isPromptDisabled, renderPrompt, toolDescription, toolParam } from "@magentra/protocol";

/** Lists an addon's bundled files after its body. */
const ADDON_RESOURCES = brainPrompt("reminder.addon-resources");

const inputSchema = z.object({
  addon: z.string().min(1).describe(toolParam("Addon", "addon")),
  args: z
    .string()
    .optional()
    .describe(toolParam("Addon", "args")),
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
  description: toolDescription("Addon"),
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
    // Switched off, the prose goes and the list is sent alone.
    let resourceLines = "";
    if (addon.resources.length > 0) {
      const files = addon.resources.map((r) => `- ${r}`).join("\n");
      resourceLines = `\n\n${isPromptDisabled(ADDON_RESOURCES) ? files : renderPrompt(ADDON_RESOURCES, { files })}`;
    }

    const content = addonInvocationHeader(addon.name) + body + argsLine + resourceLines;
    return { content };
  },
  inputSchema,
};
