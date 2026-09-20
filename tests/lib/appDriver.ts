/**
 * Driving the desktop app in a `UiTest` — the MAGENTRA-specific half.
 *
 * WHY THIS IS NOT ON `UiTest`. The kind class knows how to run Electron and
 * nothing about this product: the same reason `ProcTest` does not parse a
 * protocol frame. What a workspace looks like, where the black-box log lives,
 * and which preload call saves a profile are facts about MAGENTRA, so they live
 * beside the tests that use them and out of the class every UI test inherits.
 *
 * Everything here drives the product's OWN surface — `window.magentra`, the
 * real ipcMain handlers — and reads the product's own record of what it did.
 * Nothing is stubbed; see `appHarness.cjs` for why that matters here.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { AppHandle } from "./uiTest.ts";

/** One line of `<workspace>/.magentra/logs/desktop-*.log`, as `logEvent` writes it. */
export interface LogLine {
  readonly ts?: string;
  readonly ch?: string;
  readonly data?: Record<string, unknown>;
}

/** What `applyValidatedConnection` hands back through `profiles:apply`. */
export interface ApplyResult {
  readonly ok?: boolean;
  readonly live?: boolean;
  readonly error?: string;
}

/** The log is buffered and flushed every 500ms, so anything read from it is polled for. */
const LOG_POLL_MS = 200;
const LOG_TIMEOUT_MS = 30_000;

/** The app's own account of what it did, as it stands right now. */
export function logLines(workspace: string): LogLine[] {
  const dir = join(workspace, ".magentra", "logs");
  if (!existsSync(dir)) return [];
  const out: LogLine[] = [];
  for (const name of readdirSync(dir)) {
    for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        out.push(JSON.parse(line) as LogLine);
      } catch {
        /* the tail of a line the flush split */
      }
    }
  }
  return out;
}

/** Wait for the log to show something, or say what it was waiting for. */
export async function waitForLog(
  workspace: string,
  predicate: (line: LogLine) => boolean,
  what: string,
  timeoutMs = LOG_TIMEOUT_MS,
): Promise<LogLine> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = logLines(workspace).find(predicate);
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`waited ${timeoutMs}ms for ${what} in ${workspace}/.magentra/logs`);
    await new Promise((resolve) => setTimeout(resolve, LOG_POLL_MS));
  }
}

/** The pid of the engine the app spawned for this workspace. */
export async function waitForSpawn(workspace: string, timeoutMs = LOG_TIMEOUT_MS): Promise<number> {
  const line = await waitForLog(workspace, (l) => l.ch === "sys" && l.data?.["ev"] === "spawn", "the engine to spawn", timeoutMs);
  const pid = line.data?.["pid"];
  if (typeof pid !== "number") throw new Error(`the spawn was logged without a pid: ${JSON.stringify(line)}`);
  return pid;
}

/** Every engine frame the app recorded writing, in order. */
export function framesWritten(workspace: string, type: string): LogLine[] {
  return logLines(workspace).filter((l) => l.ch === "ui" && l.data?.["type"] === type);
}

export async function openWorkspace(app: AppHandle, workspace: string): Promise<void> {
  await app.evaluate(`window.magentra.openWorkspace(${JSON.stringify(workspace)}).then(() => true)`);
}

/** Save a connection profile through the real IPC and return its id. */
export async function saveProfile(app: AppHandle, profile: Record<string, unknown>): Promise<string> {
  const saved = await app.evaluate<{ ok?: boolean; error?: string; profiles?: { id: string; name: string }[] }>(
    `window.magentra.saveProfile(${JSON.stringify(profile)})`,
  );
  const name = profile["name"];
  const found = (saved.profiles ?? []).find((p) => p.name === name);
  if (found === undefined) throw new Error(`the app did not save a profile named ${String(name)}: ${JSON.stringify(saved)}`);
  return found.id;
}

/** Apply a saved profile to the open workspace — the one path into `applyValidatedConnection`. */
export async function applyProfile(app: AppHandle, id: string): Promise<ApplyResult> {
  return app.evaluate<ApplyResult>(`window.magentra.applyProfile(${JSON.stringify(id)})`);
}
