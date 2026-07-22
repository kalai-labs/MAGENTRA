import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ContentBlock, Msg } from "@magentra/providers";

/**
 * Strip `<system-reminder>…</system-reminder>` blocks — engine-injected model
 * scaffolding — out of text bound for the USER's eyes. The reminders stay in the
 * stored history (the model still needs them); they are only removed from what a
 * transcript view or session preview shows, so a user never sees their own
 * message with harness text stuck on. Returns "" when nothing but reminders is
 * left.
 */
export function stripSystemReminders(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * tool_use ids in `msg` that `next` does not answer with a matching
 * tool_result. Providers reject a history where an assistant tool_use has no
 * result in the immediately following message, so an interrupt, a provider
 * error, or a crash mid-tool-batch must be repaired before the next request.
 */
export function unansweredToolUseIds(msg: Msg | undefined, next?: Msg): string[] {
  if (!msg || msg.role !== "assistant") return [];
  const ids = msg.content.filter((b) => b.type === "tool_use").map((b) => b.id);
  if (ids.length === 0) return [];
  const answered = new Set(
    (next?.content ?? []).filter((b) => b.type === "tool_result").map((b) => b.toolUseId),
  );
  return ids.filter((id) => !answered.has(id));
}

/** Placeholder results for tool calls that never completed. */
export function syntheticToolResults(ids: string[]): ContentBlock[] {
  return ids.map((id) => ({
    type: "tool_result",
    toolUseId: id,
    content: "(interrupted — this tool call never completed)",
    isError: true,
  }));
}

/**
 * Walks a replayed history and inserts synthetic tool_results wherever an
 * assistant tool_use was left unanswered (crash or interrupt mid-turn), so a
 * resumed session never replays a request the provider would reject.
 */
export function repairToolPairing(messages: Msg[]): Msg[] {
  const repaired: Msg[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    repaired.push(msg);
    const dangling = unansweredToolUseIds(msg, messages[i + 1]);
    if (dangling.length === 0) continue;
    const next = messages[i + 1];
    if (next && next.role === "user" && next.content.some((b) => b.type === "tool_result")) {
      // Partial batch: results must all sit in the following user message.
      repaired.push({ ...next, content: [...syntheticToolResults(dangling), ...next.content] });
      i++;
    } else {
      repaired.push({ role: "user", content: syntheticToolResults(dangling) });
    }
  }
  return repaired;
}

export type TranscriptRecord =
  | { kind: "message"; ts: string; message: Msg }
  | { kind: "system_prompt"; ts: string; text: string }
  | {
      kind: "permission";
      ts: string;
      tool: string;
      subject?: string;
      decision: string;
      source: "mode" | "rule" | "user" | "deletion-guard";
    }
  | { kind: "compaction"; ts: string; replacedCount: number; summary: string }
  | { kind: "meta"; ts: string; data: Record<string, unknown> };

/**
 * Append-only JSONL transcript, one record per line. The full history is never
 * rewritten — compaction is recorded as its own event and applied as a view.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export class Transcript {
  readonly file: string;

  constructor(stateDir: string, readonly sessionId: string, opts?: { child?: boolean }) {
    // Subagent/crew children live in a subdirectory so the resumable session
    // listing (a non-recursive readdir of sessions/) never shows them.
    const dir = opts?.child ? join(stateDir, "sessions", "subagents") : join(stateDir, "sessions");
    this.file = join(dir, `${sessionId}.jsonl`);
    mkdirSync(dirname(this.file), { recursive: true });
  }

  append(record: DistributiveOmit<TranscriptRecord, "ts">): void {
    const full = { ...record, ts: new Date().toISOString() };
    appendFileSync(this.file, JSON.stringify(full) + "\n");
  }

  static read(file: string): TranscriptRecord[] {
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    return lines.map((l) => JSON.parse(l) as TranscriptRecord);
  }

  /**
   * The first real user text in a transcript, single-line and truncated to
   * `maxChars` — the human-readable label a session picker shows next to the
   * id. Reads only the file head (bounded, complete lines only), so listing
   * many/large sessions stays cheap. Skips harness-injected user messages
   * (system-reminder context) and returns undefined when no user text lies in
   * the head window or the file is unreadable/corrupt — a label is best-effort,
   * never a reason for a listing to fail.
   */
  static firstUserText(file: string, maxChars = 100): string | undefined {
    const HEAD_BYTES = 64 * 1024;
    let head: string;
    try {
      const fd = openSync(file, "r");
      try {
        const buf = Buffer.alloc(HEAD_BYTES);
        const bytes = readSync(fd, buf, 0, HEAD_BYTES, 0);
        head = buf.toString("utf8", 0, bytes);
      } finally {
        closeSync(fd);
      }
    } catch {
      return undefined;
    }
    const lines = head.split("\n");
    // A truncated read may end mid-line; only complete lines parse reliably.
    if (!head.endsWith("\n")) lines.pop();
    for (const line of lines) {
      if (!line) continue;
      let record: TranscriptRecord;
      try {
        record = JSON.parse(line) as TranscriptRecord;
      } catch {
        continue;
      }
      if (record.kind !== "message" || record.message.role !== "user") continue;
      for (const block of record.message.content) {
        if (block.type !== "text" || typeof block.text !== "string") continue;
        // Strip (not just skip) reminders: a block can carry the user's real
        // text with a reminder appended, and only the user's words should show.
        const text = stripSystemReminders(block.text);
        if (text === "") continue;
        const oneLine = text.replace(/\s+/g, " ");
        return oneLine.length > maxChars ? `${oneLine.slice(0, maxChars - 1)}…` : oneLine;
      }
    }
    return undefined;
  }

  /**
   * Latest metadata snapshot from the tail of a transcript. Session listings
   * need the last-used model, but must not parse every line of every potentially
   * large transcript merely to paint a drawer.
   */
  static latestMeta(file: string): Record<string, unknown> | undefined {
    const TAIL_BYTES = 64 * 1024;
    let tail: string;
    try {
      const fd = openSync(file, "r");
      try {
        const size = fstatSync(fd).size;
        const start = Math.max(0, size - TAIL_BYTES);
        const buf = Buffer.alloc(size - start);
        const bytes = readSync(fd, buf, 0, buf.length, start);
        tail = buf.toString("utf8", 0, bytes);
        if (start > 0) tail = tail.slice(tail.indexOf("\n") + 1);
      } finally {
        closeSync(fd);
      }
    } catch {
      return undefined;
    }
    const lines = tail.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line) continue;
      try {
        const record = JSON.parse(line) as TranscriptRecord;
        if (record.kind === "meta") return record.data;
      } catch {
        // A damaged line does not make older intact metadata unusable.
      }
    }
    return undefined;
  }

  /**
   * Reconstructs message history (with compactions applied) plus the latest
   * meta snapshot (session stats + permission mode), for resume. `meta` is the
   * raw record data — the caller interprets it; absent in transcripts written
   * before meta records existed.
   */
  static replay(file: string): { messages: Msg[]; meta?: Record<string, unknown> } {
    let messages: Msg[] = [];
    let meta: Record<string, unknown> | undefined;
    for (const record of Transcript.read(file)) {
      if (record.kind === "message") {
        messages.push(record.message);
      } else if (record.kind === "meta") {
        meta = record.data;
      } else if (record.kind === "compaction") {
        const tail = messages.slice(record.replacedCount);
        messages = [
          { role: "user", content: [{ type: "text", text: record.summary }] },
          ...tail,
        ];
      }
    }
    // A crash mid-tool-batch leaves the last assistant tool_use unanswered on
    // disk; older transcripts may carry the same wound mid-history from resumes
    // that predate this repair.
    return { messages: repairToolPairing(messages), ...(meta !== undefined ? { meta } : {}) };
  }
}
