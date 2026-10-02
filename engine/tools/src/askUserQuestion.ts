import { z } from "zod";
import { toolDescription, toolParam } from "@magentra/protocol";
import type { ToolDefinition } from "@magentra/core";

const optionSchema = z.object({
  label: z.string().describe(toolParam("AskUserQuestion", "questions.options.label")),
  description: z.string().describe(toolParam("AskUserQuestion", "questions.options.description")),
  preview: z.string().optional().describe(toolParam("AskUserQuestion", "questions.options.preview")),
});

const questionSchema = z.object({
  question: z.string().describe(toolParam("AskUserQuestion", "questions.question")),
  header: z.string().max(12).describe(toolParam("AskUserQuestion", "questions.header")),
  options: z
    .array(optionSchema)
    .min(2)
    .max(4)
    .describe(toolParam("AskUserQuestion", "questions.options")),
  multiSelect: z.boolean().default(false).describe(toolParam("AskUserQuestion", "questions.multiSelect")),
});

const inputSchema = z.object({
  questions: z.array(questionSchema).min(1).max(5).describe(toolParam("AskUserQuestion", "questions")),
});

export const askUserQuestionTool: ToolDefinition<z.infer<typeof inputSchema>> = {
  name: "AskUserQuestion",
  description: toolDescription("AskUserQuestion"),
  permissionClass: "interact",
  execute: async (input, ctx) => {
    const answers = await ctx.session.askUser(input.questions);
    // Frontends key answers positionally ("q:<idx>") so duplicate question
    // texts can't collide; the question-text key remains as a fallback for
    // older frontends.
    const lines = input.questions.map((q, idx) => {
      const selected = answers[`q:${idx}`] ?? answers[q.question] ?? [];
      return `${q.question}\n-> ${selected.length > 0 ? selected.join(", ") : "(no answer)"}`;
    });
    return { content: `The user answered:\n${lines.join("\n\n")}` };
  },
  inputSchema,
};
