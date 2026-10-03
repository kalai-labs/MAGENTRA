import { createWriteStream } from "node:fs";
import { z } from "zod";
import type { ToolDefinition } from "@magentra/core";
import { assertToolParamStates, brainPrompt, renderPromptIfEnabled, toolDescription, toolParam } from "@magentra/protocol";
import { bashDeletionScope, bashDeletionSubject, bashProcessKillSubject, killTree, spawnShell } from "./bash.js";

const DEFAULT_TIMEOUT = 300_000;
const MIN_TIMEOUT = 1_000;
const MAX_TIMEOUT = 3_600_000;
const BATCH_WINDOW_MS = 200;
// High enough that a busy build log (hundreds of lines/min) survives; the
// auto-stop only catches genuine floods (a stray `yes`, a tight print loop).
const NOISE_LIMIT = 600;
const NOISE_WINDOW_MS = 60_000;
/** A batch larger than this is summarized in the reminder instead of pasted whole. */
const BATCH_REMINDER_CAP = 20;

// Only {{id}} is filled: the text has always reached the model with a literal
// {{noiseLimit}} and {{noiseWindowSec}} (a known residual, see brain/README.md).
// Filling them changes what the model receives, so it is a separate approved change.
const MONITOR_NOISE_STOP = brainPrompt("reminder.monitor-noise-stop");

// timeout_ms's text in brain states DEFAULT_TIMEOUT; the import fails if the two drift apart.
assertToolParamStates("Monitor", "timeout_ms", `(default ${DEFAULT_TIMEOUT})`);

const inputSchema = z.object({
  command: z.string().describe(toolParam("Monitor", "command")),
  description: z.string().describe(toolParam("Monitor", "description")),
  timeout_ms: z
    .number()
    .int()
    .min(MIN_TIMEOUT)
    .max(MAX_TIMEOUT)
    .default(DEFAULT_TIMEOUT)
    .describe(toolParam("Monitor", "timeout_ms")),
  persistent: z
    .boolean()
    .default(false)
    .describe(toolParam("Monitor", "persistent")),
});

export const monitorTool: ToolDefinition<z.infer<typeof inputSchema>> = {
  name: "Monitor",
  description: toolDescription("Monitor"),
  descriptionVars: { noiseWindowSec: NOISE_WINDOW_MS / 1000, noiseLimit: NOISE_LIMIT },
  permissionClass: "execute",
  permissionSubject: (input) => input.command,
  describeInput: (input) => input.description,
  // Monitor runs its command in the same shell Bash does, so neither a kill by
  // name nor a deletion may get past its guard by switching tools. The shell
  // starts in the session cwd (Bash's tracked `cd` does not apply here).
  processKillSubject: (input) => bashProcessKillSubject(input.command),
  deletionSubject: (input) => bashDeletionSubject(input.command),
  deletionScope: (input, ctx) => bashDeletionScope(input.command, ctx.cwd, ctx.cwd),
  execute: async (input, ctx) => {
    const info = ctx.session.background.launch({
      kind: "monitor",
      description: input.description,
      start: (outputFile, onExit) => {
        const out = createWriteStream(outputFile);
        const child = spawnShell(input.command, ctx.cwd, false);
        const kill = (): void => killTree(child.pid);

        let batch: string[] = [];
        let flushTimer: ReturnType<typeof setTimeout> | undefined;
        let lineBuf = "";
        const eventTimes: number[] = [];
        let stopped = false;

        const flush = (): void => {
          flushTimer = undefined;
          if (batch.length === 0) return;
          const lines = batch;
          batch = [];
          ctx.session.emit({
            type: "background_notification",
            taskId: info.id,
            kind: "monitor_events",
            payload: { lines },
          });
          // A build log can flush hundreds of lines — summarize big batches
          // in the context reminder (head + tail); the full stream is in the
          // task output file.
          const body =
            lines.length > BATCH_REMINDER_CAP
              ? [...lines.slice(0, 5), `… ${lines.length - 15} more lines …`, ...lines.slice(-10)].join("\n")
              : lines.join("\n");
          ctx.session.remind(
            `<task-notification>Monitor ${info.id} ("${input.description}") reported ${lines.length} event line(s):\n${body}</task-notification>`,
          );
        };

        const onLine = (line: string): void => {
          const now = Date.now();
          eventTimes.push(now);
          while (eventTimes.length > 0 && now - eventTimes[0]! > NOISE_WINDOW_MS) eventTimes.shift();
          batch.push(line);
          if (!flushTimer) flushTimer = setTimeout(flush, BATCH_WINDOW_MS);

          if (eventTimes.length > NOISE_LIMIT && !stopped) {
            stopped = true;
            if (flushTimer) clearTimeout(flushTimer);
            flush();
            ctx.session.emit({
              type: "background_notification",
              taskId: info.id,
              kind: "monitor_stopped",
              payload: { reason: "noise" },
            });
            // Switched off, the bare fact still goes out: the model must learn the monitor stopped.
            ctx.session.remind(
              renderPromptIfEnabled(MONITOR_NOISE_STOP, { id: info.id }) ??
                `<task-notification>Monitor ${info.id} was stopped automatically (too noisy).</task-notification>`,
            );
            ctx.session.background.stop(info.id);
          }
        };

        child.stdout.on("data", (chunk: Buffer) => {
          lineBuf += chunk.toString("utf8");
          let nl: number;
          while ((nl = lineBuf.indexOf("\n")) !== -1) {
            const line = lineBuf.slice(0, nl).replace(/\r$/, "");
            lineBuf = lineBuf.slice(nl + 1);
            if (line.length > 0) onLine(line);
          }
        });
        child.stderr.on("data", (chunk: Buffer) => out.write(chunk));

        const timer = input.persistent ? undefined : setTimeout(kill, input.timeout_ms);

        child.on("close", (code) => {
          if (timer) clearTimeout(timer);
          if (flushTimer) clearTimeout(flushTimer);
          flush();
          out.end();
          onExit(code);
        });

        return {
          stop: () => {
            if (timer) clearTimeout(timer);
            kill();
          },
        };
      },
    });

    return {
      content: `Monitor started with task id: ${info.id}. Each stdout line becomes an event and you are notified in batches on your next turn. Stop it with TaskStop(${info.id}); read stderr/full output with TaskOutput(${info.id}).`,
    };
  },
  inputSchema,
};
