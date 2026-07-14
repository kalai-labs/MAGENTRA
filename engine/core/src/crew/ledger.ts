import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Usage } from "@magentra/protocol";
import { writeFileAtomic } from "../util/fsAtomic.js";

/**
 * The crew cost ledger: token usage per member, accumulated across every
 * CrewRun. With each member potentially on a different (paid) API, "what did
 * this member cost me?" needs an answer — /crew shows these totals per line.
 * Token counts, not currency: prices change and differ per endpoint; the raw
 * counts stay true. Best-effort accounting — a ledger write must never fail a
 * run (callers wrap in try/catch).
 */

export interface MemberLedgerEntry {
  runs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  lastRunAt?: string;
}

export interface CrewLedger {
  version: 1;
  members: Record<string, MemberLedgerEntry>;
}

function ledgerPath(cwd: string): string {
  return join(cwd, ".magentra", "team", "ledger.json");
}

export function loadLedger(cwd: string): CrewLedger {
  try {
    const raw = JSON.parse(readFileSync(ledgerPath(cwd), "utf8")) as CrewLedger;
    if (raw !== null && typeof raw === "object" && raw.members !== null && typeof raw.members === "object") return raw;
  } catch {
    /* absent or unreadable → empty ledger */
  }
  return { version: 1, members: {} };
}

/** Accumulates one run's usage onto a member's totals (atomic read-merge-write). */
export function recordCrewRun(cwd: string, memberId: string, usage: Usage): void {
  const ledger = loadLedger(cwd);
  const entry: MemberLedgerEntry = ledger.members[memberId] ?? {
    runs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  entry.runs += 1;
  entry.inputTokens += usage.inputTokens;
  entry.outputTokens += usage.outputTokens;
  entry.cacheReadTokens += usage.cacheReadTokens;
  entry.cacheWriteTokens += usage.cacheWriteTokens;
  entry.lastRunAt = new Date().toISOString();
  ledger.members[memberId] = entry;
  writeFileAtomic(ledgerPath(cwd), `${JSON.stringify(ledger, null, 2)}\n`);
}

/** "12.3k in / 4.1k out over 7 runs" — the /crew roster's cost suffix. */
export function formatLedgerEntry(entry: MemberLedgerEntry): string {
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  return `${k(entry.inputTokens)} in / ${k(entry.outputTokens)} out over ${entry.runs} run${entry.runs === 1 ? "" : "s"}`;
}
