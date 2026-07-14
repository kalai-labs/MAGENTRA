import { z } from "zod";
import type { ToolDefinition } from "@magentra/core";

const optionSchema = z.object({
  label: z.string().describe("Concise display text for this option (1-5 words)"),
  description: z.string().describe("What choosing this option means, including trade-offs"),
  preview: z.string().optional().describe("Optional preview content (mockup, code snippet) rendered when focused"),
});

const questionSchema = z.object({
  question: z.string().describe("The complete question, clear and specific, ending with a question mark"),
  header: z.string().max(12).describe("Very short chip label (max 12 chars), e.g. \"Approach\""),
  options: z
    .array(optionSchema)
    .min(2)
    .max(4)
    .describe("2-4 distinct choices. Do not add an 'Other' option — the UI adds one automatically."),
  multiSelect: z.boolean().default(false).describe("true allows selecting multiple options"),
});

const inputSchema = z.object({
  questions: z.array(questionSchema).min(1).max(4).describe("Questions to ask the user (1-4)"),
});

export const askUserQuestionTool: ToolDefinition<z.infer<typeof inputSchema>> = {
  name: "AskUserQuestion",
  description: `Asks the user up to 4 multiple-choice questions and blocks until they answer.

Use it only when you are stuck on a decision that genuinely belongs to the user — one the request, the code, and sensible defaults cannot settle. For choices with a conventional default, pick it, mention it, and move on. If you recommend an option, put it first and append "(Recommended)" to its label. The UI always adds an "Other" free-text option.`,
  permissionClass: "interact",
  execute: async (input, ctx) => {
    const answers = await ctx.session.askUser(input.questions);
    const lines = Object.entries(answers).map(
      ([question, selected]) => `${question}\n-> ${selected.join(", ")}`,
    );
    return { content: `The user answered:\n${lines.join("\n\n")}` };
  },
  inputSchema,
};
