import { createWriteStream } from "node:fs";
import { z } from "zod";
import type { ToolDefinition } from "@magentra/core";
import { killTree, spawnShell } from "./bash.js";

const DEFAULT_TIMEOUT = 300_000;
const MIN_TIMEOUT = 1_000;
const MAX_TIMEOUT = 3_600_000;
const BATCH_WINDOW_MS = 200;
const NOISE_LIMIT = 60;
const NOISE_WINDOW_MS = 60_000;

const inputSchema = z.object({
  command: z.string().describe("The shell command to run and watch; each line it prints to stdout becomes an event."),
  description: z.string().describe("Clear, concise description of what is being monitored, shown to the user."),
  timeout_ms: z
    .number()
    .int()
    .min(MIN_TIMEOUT)
    .max(MAX_TIMEOUT)
    .default(DEFAULT_TIMEOUT)
    .describe(`Kill the monitor after this many ms unless persistent (default ${DEFAULT_TIMEOUT}).`),
  persistent: z
    .boolean()
    .default(false)
    .describe("If true, ignore timeout_ms and keep monitoring until stopped with TaskStop."),
});

export const monitorTool: ToolDefinition<z.infer<typeof inputSchema>> = {
  name: "Monitor",
  description: `Runs a long-lived command and turns each stdout line into an event you are notified about, in batches, on your next turn. Use it to watch logs, a dev server, a file tail, or a test watcher for specific output.

- Returns a task id immediately; stop it with TaskStop(task_id).
- Lines arriving close together are batched into one notification. stderr is written to the task output file only (read it with TaskOutput).
- If the command floods more than ${NOISE_LIMIT} lines within ${NOISE_WINDOW_MS / 1000}s it is auto-stopped for noise; narrow the command (grep/filter) and try again.
- Unless persistent, it is killed after timeout_ms.`,
  permissionClass: "execute",
  permissionSubject: (input) => input.command,
  describeInput: (input) => input.description,
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
          ctx.session.remind(
            `<task-notification>Monitor ${info.id} ("${input.description}") reported ${lines.length} event line(s):\n${lines.join("\n")}</task-notification>`,
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
            ctx.session.remind(
              `<task-notification>Monitor ${info.id} was stopped automatically: more than ${NOISE_LIMIT} events within ${NOISE_WINDOW_MS / 1000}s (too noisy). Narrow the command and restart if you still need it.</task-notification>`,
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
