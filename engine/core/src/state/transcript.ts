import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Msg } from "@magentra/providers";

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

  constructor(stateDir: string, readonly sessionId: string) {
    this.file = join(stateDir, "sessions", `${sessionId}.jsonl`);
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
        const text = block.text.trim();
        if (text === "" || text.startsWith("<system-reminder>")) continue;
        const oneLine = text.replace(/\s+/g, " ");
        return oneLine.length > maxChars ? `${oneLine.slice(0, maxChars - 1)}…` : oneLine;
      }
    }
    return undefined;
  }

  /** Reconstructs message history (with compactions applied) for resume. */
  static replayMessages(file: string): Msg[] {
    let messages: Msg[] = [];
    for (const record of Transcript.read(file)) {
      if (record.kind === "message") {
        messages.push(record.message);
      } else if (record.kind === "compaction") {
        const tail = messages.slice(record.replacedCount);
        messages = [
          { role: "user", content: [{ type: "text", text: record.summary }] },
          ...tail,
        ];
      }
    }
    return messages;
  }
}
