import { spawn, type ChildProcess } from "node:child_process";
import type { HookEvent, HookMatcherEntry } from "../config/settings.js";

/** A partial hooks map — only the events a project actually configures. */
export type HookConfig = Partial<Record<HookEvent, HookMatcherEntry[]>>;

export interface HookOutcome {
  /** Process exit code, or null when the hook was killed (e.g. timed out). */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface HookSummary {
  /** True if any hook exited 2 (the "block" convention). */
  blocked: boolean;
  /** Concatenated stderr of the blocking hooks. */
  blockReason: string;
  /** Concatenated (trimmed) stdout of the exit-0 hooks; may be "". */
  contextText: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Runs user-configured shell hooks around agent lifecycle events. Each matching
 * hook command is spawned through the shell with the JSON payload piped to its
 * stdin; stdout/stderr are captured. Hooks never throw — a spawn failure yields
 * exitCode 127. Exit code 2 is the "block" signal (Claude-Code convention).
 */
export class HookRunner {
  private readonly cwd: string;
  private readonly hooks: HookConfig;
  private readonly defaultTimeoutMs: number;

  constructor(opts: { cwd: string; hooks: HookConfig; defaultTimeoutMs?: number }) {
    this.cwd = opts.cwd;
    this.hooks = opts.hooks;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Whether any hook is configured for this event (cheap gate for callers). */
  has(event: HookEvent): boolean {
    return (this.hooks[event]?.length ?? 0) > 0;
  }

  async run(event: HookEvent, payload: Record<string, unknown>): Promise<HookOutcome[]> {
    const entries = this.hooks[event] ?? [];
    if (entries.length === 0) return [];

    const toolName = typeof payload.tool_name === "string" ? payload.tool_name : undefined;
    const commands: { command: string; timeoutMs: number }[] = [];
    for (const entry of entries) {
      if (!matcherMatches(entry.matcher, toolName)) continue;
      for (const h of entry.hooks) {
        commands.push({
          command: h.command,
          timeoutMs: h.timeout !== undefined ? h.timeout * 1000 : this.defaultTimeoutMs,
        });
      }
    }
    if (commands.length === 0) return [];

    const json = JSON.stringify(payload);
    return Promise.all(commands.map((c) => this.execOne(c.command, json, c.timeoutMs)));
  }

  summarize(outcomes: HookOutcome[]): HookSummary {
    const blocking = outcomes.filter((o) => o.exitCode === 2);
    const blockReason = blocking
      .map((o) => o.stderr.trim())
      .filter(Boolean)
      .join("\n");
    const contextText = outcomes
      .filter((o) => o.exitCode === 0)
      .map((o) => o.stdout.trim())
      .filter(Boolean)
      .join("\n");
    return { blocked: blocking.length > 0, blockReason, contextText };
  }

  private execOne(command: string, input: string, timeoutMs: number): Promise<HookOutcome> {
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(command, { shell: true, cwd: this.cwd });
      } catch (err) {
        resolve({ exitCode: 127, stdout: "", stderr: (err as Error).message, timedOut: false });
        return;
      }

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      const finish = (outcome: HookOutcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(outcome);
      };

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
        finish({ exitCode: null, stdout, stderr, timedOut: true });
      }, timeoutMs);

      child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("error", (err) => finish({ exitCode: 127, stdout, stderr: stderr || err.message, timedOut }));
      child.on("close", (code) => finish({ exitCode: code, stdout, stderr, timedOut }));

      const stdin = child.stdin;
      if (stdin) {
        stdin.on("error", () => {});
        stdin.end(input + "\n");
      }
    });
  }
}

function matcherMatches(matcher: string | undefined, toolName: string | undefined): boolean {
  if (matcher === undefined || matcher === "" || matcher === "*") return true;
  if (toolName === undefined) return false;
  try {
    return new RegExp(matcher).test(toolName);
  } catch {
    return matcher === toolName;
  }
}
