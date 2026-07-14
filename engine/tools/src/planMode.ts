import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "@magentra/core";

const PLAN_SECTION_KEY = "plan-mode";
const PREAUTH_SECTION_KEY = "plan-preauth";

function planSection(planFile: string): string {
  return `Plan mode is active. The permission engine is enforcing read-only operation, with one exception: you may Write and Edit the plan file at ${planFile}. Do not attempt other mutating or executing tools — they will be denied.

Explore the codebase freely with the read-only tools, then write your COMPLETE implementation plan into ${planFile} using Write/Edit. When the plan is finished, call ExitPlanMode to submit it for approval. Do not ask "is the plan okay?" in prose — ExitPlanMode is that question.`;
}

const enterSchema = z.object({});

export const enterPlanModeTool: ToolDefinition<z.infer<typeof enterSchema>> = {
  name: "EnterPlanMode",
  description: `Enters plan mode: a read-only mode for researching and drafting an implementation plan before touching anything. The harness creates an empty plan file and tells you its path; write the plan there, then call ExitPlanMode. Approving this call is the user's consent to plan, so it prompts for permission.`,
  permissionClass: "execute",
  describeInput: () => "Enter plan mode (read-only)",
  execute: async (_input, ctx) => {
    const dir = join(ctx.session.stateDir, "plans");
    mkdirSync(dir, { recursive: true });
    const planFile = join(dir, `plan-${Date.now().toString(36)}.md`);
    writeFileSync(planFile, "");

    ctx.session.setMode("plan");
    ctx.session.setPlanFile(planFile);
    ctx.session.setPromptSection(PLAN_SECTION_KEY, planSection(planFile));

    return {
      content: `Entered plan mode. Explore read-only, then write your full implementation plan into ${planFile} with Write/Edit and call ExitPlanMode when it is complete.`,
    };
  },
  inputSchema: enterSchema,
};

const exitSchema = z.object({
  allowedPrompts: z
    .array(
      z.object({
        tool: z.string().describe('The tool to pre-authorize (currently "Bash").'),
        prompt: z.string().describe("Description of the command that will be run, for the approval UI."),
      }),
    )
    .optional()
    .describe("Commands to pre-authorize when the plan is approved, so implementation is not interrupted for each one."),
});

export const exitPlanModeTool: ToolDefinition<z.infer<typeof exitSchema>> = {
  name: "ExitPlanMode",
  description: `Submits the plan you wrote to the plan file for the user's approval and blocks until they decide. Call it only after the plan file contains the complete implementation plan. On approval you return to an editing mode and may proceed; on rejection you stay in plan mode and revise the plan per the user's feedback. Optionally pass allowedPrompts to pre-authorize specific commands for the implementation phase.`,
  permissionClass: "read",
  execute: async (input, ctx) => {
    const planFile = ctx.session.getPlanFile();
    if (!planFile) {
      return { content: "Not in plan mode — there is no plan to submit. Call EnterPlanMode first.", isError: true };
    }

    let plan = "";
    try {
      plan = readFileSync(planFile, "utf8");
    } catch {
      plan = "";
    }
    if (!plan.trim()) {
      return {
        content: `The plan file ${planFile} is empty. Write your full implementation plan into it with Write/Edit before calling ExitPlanMode.`,
        isError: true,
      };
    }

    const allowedPrompts = input.allowedPrompts ?? [];
    ctx.session.emit({ type: "plan_ready", planPath: planFile, plan, allowedPrompts });

    const decision = await ctx.session.requestPlanDecision();

    if (decision.approve) {
      if (decision.editedPlan !== undefined) writeFileSync(planFile, decision.editedPlan);
      ctx.session.setPlanFile(undefined);
      // Deliberately "default", NOT the mode active before EnterPlanMode: plan
      // approval consents to the PLAN, not to unattended execution — each
      // mutating step still asks unless the plan pre-authorized it via
      // allowedPrompts below. A prior acceptEdits/bypass does not survive the
      // plan round-trip by design.
      ctx.session.setMode("default");
      ctx.session.setPromptSection(PLAN_SECTION_KEY, undefined);
      if (allowedPrompts.length > 0) {
        // Approximation: a plan-approved allowedPrompt authorizes the whole tool for
        // the session (subject "*"); the prompt string is advisory context only.
        for (const ap of allowedPrompts) ctx.session.addSessionAllow(ap.tool, "*");
        ctx.session.setPromptSection(
          PREAUTH_SECTION_KEY,
          `Pre-authorized by plan approval (run without asking): ${allowedPrompts
            .map((ap) => `${ap.tool} — ${ap.prompt}`)
            .join("; ")}`,
        );
      }
      return { content: "Plan approved — proceed with implementation." };
    }

    const extra = [
      decision.message ? `\nUser feedback: ${decision.message}` : "",
      decision.editedPlan !== undefined ? `\nThe user edited the plan; re-read ${planFile} before revising.` : "",
    ].join("");
    if (decision.editedPlan !== undefined) writeFileSync(planFile, decision.editedPlan);
    return { content: `The user rejected the plan. Revise it per their feedback.${extra}` };
  },
  inputSchema: exitSchema,
};
