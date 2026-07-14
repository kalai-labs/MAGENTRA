import { appendFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import type { SessionServices } from "../agent/tool.js";

const metaSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  whenToUse: z.string().optional(),
  phases: z
    .array(
      z.object({
        title: z.string(),
        detail: z.string().optional(),
        model: z.string().optional(),
      }),
    )
    .optional(),
});

export type ParsedMeta = z.infer<typeof metaSchema>;

export interface WorkflowMeta extends ParsedMeta {
  runId: string;
  /** Number of agent() calls made during the run. */
  agentCalls: number;
  /** Number of agent() calls that errored (and resolved to null). */
  failures: number;
}

export type WorkflowResult =
  | { ok: true; value: unknown; meta: WorkflowMeta }
  | { ok: false; error: string; meta?: WorkflowMeta };

export interface WorkflowRunOptions {
  script: string;
  args?: unknown;
  session: SessionServices;
  signal: AbortSignal;
  onLog?: (msg: string) => void;
}

/** Options accepted by the in-script agent() hook. */
interface AgentOpts {
  label?: string;
  phase?: string;
  agentType?: string;
  model?: string;
  schema?: Record<string, unknown>;
}

/** Hard backstop against runaway loops. */
const MAX_AGENT_CALLS = 100;
/** Concurrent spawnAgent cap (Session.MAX_CHILDREN is 8; stay well under). */
const CONCURRENCY = 4;

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as {
  new (...args: string[]): (...args: unknown[]) => Promise<unknown>;
};

/**
 * Runs a plain-JS workflow script that orchestrates subagents deterministically.
 * The script is executed via `new AsyncFunction` (NOT a real sandbox) — it is
 * trusted code authored by the model. Its `return` value becomes the result.
 */
export class WorkflowRunner {
  async run(opts: WorkflowRunOptions): Promise<WorkflowResult> {
    const { script, args, session, signal } = opts;
    const runId = `wf_${randomBytes(6).toString("hex")}`;

    const extracted = extractMeta(script);
    if (!extracted) {
      return { ok: false, error: "Workflow script must begin with `export const meta = { ... }`." };
    }

    let rawMeta: unknown;
    try {
      rawMeta = new Function(`return (${extracted.literal})`)();
    } catch (err) {
      return { ok: false, error: `Could not evaluate the meta literal: ${(err as Error).message}` };
    }
    const parsedMeta = metaSchema.safeParse(rawMeta);
    if (!parsedMeta.success) {
      const issues = parsedMeta.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      return { ok: false, error: `Invalid workflow meta: ${issues}` };
    }

    const meta: WorkflowMeta = { runId, ...parsedMeta.data, agentCalls: 0, failures: 0 };

    // Journal setup — best-effort, never fatal.
    const journalPath = join(session.stateDir, "workflows", `${runId}.jsonl`);
    try {
      mkdirSync(join(session.stateDir, "workflows"), { recursive: true });
    } catch {
      /* ignore */
    }
    const journal = (entry: unknown): void => {
      try {
        appendFileSync(journalPath, JSON.stringify(entry) + "\n");
      } catch {
        /* ignore */
      }
    };

    // Shared concurrency semaphore (guards every real spawnAgent call).
    let active = 0;
    const waiters: (() => void)[] = [];
    const acquire = async (): Promise<void> => {
      if (active < CONCURRENCY) {
        active++;
        return;
      }
      await new Promise<void>((resolve) => waiters.push(resolve));
    };
    const release = (): void => {
      const next = waiters.shift();
      if (next) next();
      else active--;
    };

    const guardedSpawn = async (spawnOpts: {
      agentType: string;
      prompt: string;
      description: string;
    }): Promise<string> => {
      await acquire();
      try {
        return await session.spawnAgent(spawnOpts);
      } finally {
        release();
      }
    };

    // --- Script hooks ---------------------------------------------------------

    const log = (msg: unknown): void => {
      const text = String(msg);
      opts.onLog?.(text);
      session.emit({ type: "command_output", text });
    };
    const phase = (title: unknown): void => {
      const text = `▶ ${String(title)}`;
      opts.onLog?.(text);
      session.emit({ type: "command_output", text });
    };

    const agent = async (prompt: string, agentOpts?: AgentOpts): Promise<unknown> => {
      if (signal.aborted) throw new Error("workflow aborted");
      if (meta.agentCalls >= MAX_AGENT_CALLS) {
        throw new Error(`workflow exceeded the ${MAX_AGENT_CALLS} agent-call cap`);
      }
      const i = ++meta.agentCalls;
      const agentType = agentOpts?.agentType ?? "general-purpose";
      const description = agentOpts?.label ?? prompt.slice(0, 60);
      try {
        let fullPrompt = prompt;
        if (agentOpts?.schema) fullPrompt = `${prompt}\n\n${schemaInstruction(agentOpts.schema)}`;

        let raw = await guardedSpawn({ agentType, prompt: fullPrompt, description });
        let value: unknown = raw;

        if (agentOpts?.schema) {
          value = parseJsonReply(raw);
          if (value === PARSE_FAIL) {
            // One error-correction retry.
            raw = await guardedSpawn({
              agentType,
              prompt: correctionPrompt(agentOpts.schema, raw),
              description,
            });
            value = parseJsonReply(raw);
            if (value === PARSE_FAIL) value = null;
          }
        }

        journal({ i, prompt: prompt.slice(0, 200), ok: true, resultPreview: previewOf(value) });
        return value;
      } catch (err) {
        meta.failures++;
        journal({ i, prompt: prompt.slice(0, 200), ok: false, resultPreview: String((err as Error).message).slice(0, 400) });
        return null;
      }
    };

    const parallel = async (thunks: unknown): Promise<unknown[]> => {
      if (!Array.isArray(thunks)) throw new Error("parallel() expects an array of thunks");
      return Promise.all(
        thunks.map(async (thunk) => {
          try {
            return await (thunk as () => Promise<unknown>)();
          } catch {
            return null;
          }
        }),
      );
    };

    const pipeline = async (items: unknown, ...stages: unknown[]): Promise<unknown[]> => {
      if (!Array.isArray(items)) throw new Error("pipeline() expects an array of items");
      const stageFns = stages as Array<(prev: unknown, item: unknown, index: number) => unknown>;
      return Promise.all(
        items.map(async (item, index) => {
          let prev: unknown = item;
          for (const stage of stageFns) {
            try {
              prev = await stage(prev, item, index);
            } catch {
              return null;
            }
          }
          return prev;
        }),
      );
    };

    const budget = { total: null, spent: () => 0, remaining: () => Infinity };

    // --- Execute --------------------------------------------------------------

    let fn: (...args: unknown[]) => Promise<unknown>;
    try {
      fn = new AsyncFunction("agent", "parallel", "pipeline", "phase", "log", "args", "budget", extracted.body);
    } catch (err) {
      return { ok: false, error: `Workflow script failed to compile: ${(err as Error).message}`, meta };
    }

    try {
      const value = await fn(agent, parallel, pipeline, phase, log, args, budget);
      return { ok: true, value, meta };
    } catch (err) {
      return { ok: false, error: (err as Error).message, meta };
    }
  }
}

// --- helpers ----------------------------------------------------------------

const PARSE_FAIL = Symbol("parse-fail");

/** Locate `export const meta = { ... }`; return the literal and the body after it. */
function extractMeta(script: string): { literal: string; body: string } | null {
  const m = /export\s+const\s+meta\s*=\s*/.exec(script);
  if (!m) return null;
  const braceStart = script.indexOf("{", m.index + m[0].length);
  if (braceStart === -1) return null;
  const end = scanBalanced(script, braceStart);
  if (end === -1) return null;
  return { literal: script.slice(braceStart, end + 1), body: script.slice(end + 1) };
}

/** Index of the `}` closing the `{` at `start`, skipping string literals. */
function scanBalanced(src: string, start: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function schemaInstruction(schema: Record<string, unknown>): string {
  return `Reply with ONLY a single JSON object that matches this JSON Schema — no prose, no markdown code fences:\n${JSON.stringify(schema)}`;
}

function correctionPrompt(schema: Record<string, unknown>, previous: string): string {
  return `Your previous reply could not be parsed as JSON. It was:\n${previous.slice(0, 500)}\n\nReply with ONLY a single valid JSON object matching this JSON Schema — no prose, no code fences:\n${JSON.stringify(schema)}`;
}

/** Parse a model reply as JSON, stripping markdown fences and surrounding prose. */
function parseJsonReply(text: string): unknown {
  const stripped = stripFences(text);
  try {
    return JSON.parse(stripped);
  } catch {
    /* fall through */
  }
  const s = stripped.indexOf("{");
  const e = stripped.lastIndexOf("}");
  if (s !== -1 && e > s) {
    try {
      return JSON.parse(stripped.slice(s, e + 1));
    } catch {
      /* fall through */
    }
  }
  return PARSE_FAIL;
}

function stripFences(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json|javascript|js)?\s*\n?([\s\S]*?)\n?```$/.exec(trimmed);
  return fenced ? fenced[1]!.trim() : trimmed;
}

function previewOf(value: unknown): string {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return (s ?? "null").slice(0, 400);
}
