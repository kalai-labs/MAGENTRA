import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { WorkflowRunner, type ToolDefinition } from "@magentra/core";

const inputSchema = z
  .object({
    script: z
      .string()
      .optional()
      .describe(
        "Self-contained JS workflow script. Must begin with `export const meta = { name, description }` (a pure literal) followed by a body that uses agent/parallel/pipeline/phase/log.",
      ),
    scriptPath: z
      .string()
      .optional()
      .describe("Path to a workflow script file (relative to cwd or absolute). Takes precedence over `script`."),
    args: z.unknown().optional().describe("Value exposed to the script as the global `args`, verbatim."),
  })
  .describe("Provide at least one of `script` or `scriptPath`.");

type WorkflowInput = z.infer<typeof inputSchema>;

const description = `Run a workflow script that orchestrates multiple subagents deterministically. Use it only when the user has explicitly asked for multi-agent orchestration ("use a workflow", "fan out agents") — a task that would merely benefit from parallelism does NOT qualify; use the Agent tool for one-off subagents.

The script is plain JavaScript (NOT TypeScript — no type annotations). It MUST begin with a pure object literal:
  export const meta = { name: 'my-flow', description: 'one-liner', phases: [{ title: 'Scan' }] }
Required meta fields: name, description. Optional: whenToUse, phases. The rest of the file is the async body (use await directly) and its \`return\` value is the workflow result.

Body hooks:
- agent(prompt, opts?): Promise — spawn a subagent, returns its final text. opts: { label, phase, agentType, model, schema }. With schema (a JSON Schema object) the reply is parsed into a validated object (markdown fences stripped, one retry on failure); returns null if it still can't parse or the agent errors. Filter with .filter(Boolean).
- pipeline(items, stage1, stage2, ...): Promise<any[]> — run each item through all stages independently, NO barrier between stages. Each stage callback gets (prevResult, originalItem, index). A throwing stage drops that item to null. This is the DEFAULT for multi-stage work.
- parallel(thunks): Promise<any[]> — run thunks concurrently and await all (a BARRIER). A thunk that throws resolves to null. Use ONLY when you need every result together (dedup/merge across the full set).
- phase(title) / log(msg): emit progress lines to the user.
- args: the tool's \`args\` input, verbatim.
- budget: { total, spent(), remaining() } — output tokens, ENFORCED: total is the turn's token ceiling; agent() throws once remaining() hits 0. Guard long loops with e.g. \`while (budget.remaining() > 20000) { ... }\`.

DEFAULT TO pipeline; reach for a barrier only when a stage genuinely needs all prior-stage results at once. Concurrent agents are capped at 4; total agent calls per run are capped at 100. Date/Math.random are available but discouraged (no resume in this build).`;

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
