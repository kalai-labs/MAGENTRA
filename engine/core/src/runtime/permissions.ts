import type { PermissionDecision } from "@magentra/protocol";
import type { AnyToolDefinition } from "../agent/tool.js";

export interface PermissionRequestPayload {
  tool: string;
  input: unknown;
  description?: string;
  /**
   * The tool's permission subject for this call. Present only when the tool
   * defines one, which is exactly when an "always allow" grant can be scoped —
   * frontends use its presence to decide whether to offer that choice.
   */
  subject?: string;
  /**
   * What "always allow" would remember, when broader than the exact subject —
   * the command's shape (e.g. "mkdir", "git push"). Frontends show it so the
   * grant's scope is never a surprise. Absent = the grant is the exact subject.
   */
  grant?: string;
}

export interface PermissionOutcome {
  allowed: boolean;
  /** Shown to the model when denied. */
  message?: string;
  /** A note the user attached while APPROVING — must reach the model. */
  note?: string;
  source: "mode" | "rule" | "user";
}

/** Why requestApproval was invoked, surfaced to the transcript log. */
export type ApprovalSource = "ask" | "deletion-guard";

interface ParsedRule {
  tool: string;
  pattern?: RegExp;
  raw: string;
}

/** One "always allow" grant. Literal by default — never a glob. With
 *  `prefix: true` it covers every subject equal to `subject` or starting with
 *  `subject + " "` (the command-shape grants derived below). */
export interface ExactGrant {
  tool: string;
  subject: string;
  prefix?: boolean;
}

/** CLIs whose first argument is a subcommand — the grant keeps both tokens
 *  ("git push", not all of "git"). */
const MULTI_COMMAND_CLIS = new Set([
  "git", "gh", "npm", "npx", "pnpm", "yarn", "docker", "kubectl", "cargo",
  "go", "dotnet", "pip", "pip3", "apt", "apt-get", "brew", "systemctl",
  "terraform", "gcloud", "aws", "az",
]);

/**
 * The subject an "always allow" click should remember for an execute-class
 * call: the command's shape rather than its exact text — `mkdir -p a/b`
 * grants all `mkdir` commands, `git push origin main` grants all `git push`.
 * Returns undefined (grant stays exact) for compound/substituted commands
 * and anything whose head token does not look like a plain program name.
 * Deletion-guard approvals never come through here — those stay literal.
 */
export function deriveAlwaysGrant(subject: string): string | undefined {
  if (/[|;&`$><\\'"]/.test(subject)) return undefined;
  const tokens = subject.trim().split(/\s+/);
  const head = tokens[0];
  if (!head || !/^[\w./-]+$/.test(head)) return undefined;
  if (MULTI_COMMAND_CLIS.has(head.toLowerCase())) {
    const sub = tokens[1];
    if (!sub || sub.startsWith("-") || !/^[\w./:-]+$/.test(sub)) return undefined;
    // Script runners: "npm run" alone would cover every script — keep the
    // script name in the shape ("npm run build", not all of "npm run").
    if (sub.toLowerCase() === "run" && /^(npm|pnpm|yarn)$/i.test(head)) {
      const script = tokens[2];
      if (!script || script.startsWith("-") || !/^[\w./:-]+$/.test(script)) return undefined;
      return `${head} ${sub} ${script}`;
    }
    return `${head} ${sub}`;
  }
  return head;
}

/**
 * Resolution order: deny rules > allow rules > stance default. There are
 * exactly two stances: OVERDRIVE (allow everything the rules don't deny) and
 * normal (reads, interactions, and file edits are allowed; commands and other
 * execute-class calls ask, which round-trips via requestApproval).
 */
export class PermissionEngine {
  /** When true (default), destructive calls always ask the user, in both
   *  stances. The desktop's "Allow deletions" setting turns this off, after
   *  which deletions resolve through the ordinary rules/stance path. */
  private deletionGuard = true;
  /** OVERDRIVE: every call is allowed unless denied by rule, and deletions
   *  provably scoped inside the workspace skip the guard (the flow must not
   *  block); everything unprovable still asks. */
  private overdrive = false;
  private readonly deny: ParsedRule[];
  private readonly allow: ParsedRule[];
  private readonly sessionAllow: ParsedRule[] = [];
  /** Exact-subject grants: those loaded from settings plus any added this run. */
  private readonly allowExact: ExactGrant[];

  constructor(
    rules: { allow: string[]; deny: string[]; allowExact?: ExactGrant[] },
    private readonly requestApproval: (
      req: PermissionRequestPayload,
      source: ApprovalSource,
    ) => Promise<{ decision: PermissionDecision; message?: string }>,
    /** Persists an "always allow" grant. Absent in contexts with nowhere to write. */
    private readonly persistExact?: (tool: string, subject: string, prefix?: boolean) => void,
  ) {
    this.allow = rules.allow.map(parseRule);
    this.deny = rules.deny.map(parseRule);
    this.allowExact = [...(rules.allowExact ?? [])];
  }

  getDeletionGuard(): boolean {
    return this.deletionGuard;
  }

  setDeletionGuard(enabled: boolean): void {
    this.deletionGuard = enabled;
  }

  setOverdrive(enabled: boolean): void {
    this.overdrive = enabled;
  }

  /** Adds a session-scoped allow rule. Subject "*" or undefined matches any subject. */
  addSessionAllow(tool: string, subject?: string): void {
    this.sessionAllow.push(
      subject !== undefined && subject !== "*"
        ? { tool, pattern: exactPattern(subject), raw: `${tool}(${subject})` }
        : { tool, raw: subject === "*" ? `${tool}(*)` : tool },
    );
  }

  /** Removes any session allow rule whose raw form equals `raw`. */
  removeSessionAllow(raw: string): void {
    for (let i = this.sessionAllow.length - 1; i >= 0; i--) {
      if (this.sessionAllow[i]!.raw === raw) this.sessionAllow.splice(i, 1);
    }
  }

  async check(
    tool: AnyToolDefinition,
    input: unknown,
    subject: string | undefined,
    description: string | undefined,
    /** The tool's deletion-scope verdict for this call, when computed. */
    deletionScope?: "workspace" | "unknown" | "protected",
    /** True when a file-edit call targets a path OUTSIDE the workspace — such an
     *  edit is not auto-safe and must ask (in-workspace edits still auto-run). */
    editOutsideWorkspace?: boolean,
  ): Promise<PermissionOutcome> {
    if (matches(this.deny, tool.name, subject)) {
      return {
        allowed: false,
        source: "rule",
        message: `Permission denied by settings rule. The user's configuration forbids this call; do not retry it verbatim.`,
      };
    }
    // Deletion guard: a tool call that would delete a file/folder always
    // requires interactive approval, in both stances (OVERDRIVE included). One
    // exception: an EXPLICIT subject-scoped allow rule in the user's settings
    // (e.g. `Bash(rm -rf ./tmp/*)`) is a deliberate standing decision about
    // that exact call shape — it beats the guard, so unattended cleanup
    // missions can delete their own temp files without re-prompting forever.
    // Broad grants (bare tool, `Tool(*)`, session allows) never do. The guard
    // never adds a session-allow, so it re-fires on every other matching call.
    // Only LITERAL grants may override the guard: a derived command-shape
    // grant ("git push …") from a benign approval must never let a later
    // destructive variant ("git push --force") skip the always-ask.
    const explicitlyAllowed =
      matchesExplicit(this.allow, tool.name, subject) || this.matchesExact(tool.name, subject, true);
    // OVERDRIVE scope-split: a deletion whose every target provably resolves
    // inside the workspace runs without asking — an autonomous run must be
    // able to clean its own temp files and redo its own work. Only the
    // provable case skips; "unknown" (out-of-tree paths, history rewrites,
    // substitution, root wildcards) keeps the always-ask guard even here.
    const overdriveScoped = this.overdrive && deletionScope === "workspace";
    // Protected target — a `.magentra` state directory (settings, sessions,
    // transcripts). Deleting it always asks, in every mode: it beats the
    // "allow deletions" off-switch, explicit allow rules, and OVERDRIVE.
    const protectedTarget = deletionScope === "protected";
    const deletionSubject =
      protectedTarget || (this.deletionGuard && !explicitlyAllowed && !overdriveScoped)
        ? tool.deletionSubject?.(input)
        : undefined;
    if (deletionSubject !== undefined) {
      const res = await this.requestApproval(
        {
          tool: tool.name,
          input,
          description: deletionSubject,
          // No subject on a protected deletion: its presence is what lets the
          // frontend offer "always allow", and deleting MAGENTRA's own state
          // dir must be confirmed every single time.
          ...(subject !== undefined && !protectedTarget ? { subject } : {}),
        },
        "deletion-guard",
      );
      if (res.decision === "deny") {
        return {
          allowed: false,
          source: "user",
          message: `The user declined this destructive tool call${res.message ? `: ${res.message}` : "."} Deletion calls always require approval; adjust your approach instead of retrying the same call.`,
        };
      }
      // "Always allow" on a destructive prompt grants only this exact subject.
      // A broad grant here would silently disable the deletion guard for the
      // whole tool, which is never what one click on one command should mean.
      // A protected deletion never records a grant at all — it must re-ask.
      if (res.decision === "allow_always" && !protectedTarget) this.grantExact(tool.name, subject);
      return { allowed: true, source: "user", ...(res.message ? { note: res.message } : {}) };
    }

    if (
      matches(this.allow, tool.name, subject) ||
      matches(this.sessionAllow, tool.name, subject) ||
      this.matchesExact(tool.name, subject)
    ) {
      return { allowed: true, source: "rule" };
    }

    // A file edit that escapes the workspace is downgraded from its usual
    // auto-allow to an approval prompt — the frictionless default is meant for
    // edits inside the tree, not for overwriting a shell profile or an SSH key.
    // OVERDRIVE (fully autonomous, risk accepted) and explicit user allow rules
    // above are untouched; only the auto-allow default is overridden.
    let stance = this.stanceDefault(tool);
    if (stance === "allow" && !this.overdrive && tool.isFileEdit && editOutsideWorkspace === true) {
      stance = "ask";
    }
    switch (stance) {
      case "allow":
        return { allowed: true, source: "mode" };
      case "ask": {
        // For commands, "always allow" remembers the command's SHAPE, not its
        // exact text — approving `mkdir -p a` must also cover `mkdir -p b`.
        const shape =
          tool.permissionClass === "execute" && subject !== undefined
            ? deriveAlwaysGrant(subject)
            : undefined;
        const res = await this.requestApproval(
          {
            tool: tool.name,
            input,
            description,
            ...(subject !== undefined ? { subject } : {}),
            ...(shape !== undefined && shape !== subject ? { grant: shape } : {}),
          },
          "ask",
        );
        if (res.decision === "deny") {
          return {
            allowed: false,
            source: "user",
            message: `The user declined this tool call${res.message ? `: ${res.message}` : "."} Adjust your approach instead of retrying the same call.`,
          };
        }
        if (res.decision === "allow_always") {
          if (shape !== undefined) this.grantExact(tool.name, shape, true);
          else this.grantExact(tool.name, subject);
        }
        if (res.decision === "allow_session") {
          // "Always allow this session" means the TOOL, not this exact
          // subject — an exact-subject grant re-asks on every new command/path
          // and reads as broken. Safe to be broad: the deletion guard is
          // checked BEFORE allow rules, so destructive calls still ask.
          // (Targeted subject-scoped grants still exist via addSessionAllow.)
          this.sessionAllow.push({ tool: tool.name, raw: tool.name });
        }
        return { allowed: true, source: "user", ...(res.message ? { note: res.message } : {}) };
      }
    }
  }

  /** Grant matching. Literal grants compare as strings — a `*` in an approved
   *  command stays a `*`. Prefix (command-shape) grants also cover subjects
   *  starting with `subject + " "`; `literalOnly` skips them (deletion-guard
   *  override must never widen through a derived shape). */
  private matchesExact(tool: string, subject: string | undefined, literalOnly = false): boolean {
    if (subject === undefined) return false;
    return this.allowExact.some((g) => {
      if (g.tool !== tool) return false;
      if (g.subject === subject) return !literalOnly || g.prefix !== true;
      return !literalOnly && g.prefix === true && subject.startsWith(`${g.subject} `);
    });
  }

  /** Records an "always allow" grant for this run and persists it. */
  private grantExact(tool: string, subject: string | undefined, prefix = false): void {
    if (subject === undefined) return; // nothing identifiable to scope the grant to
    if (!this.allowExact.some((g) => g.tool === tool && g.subject === subject && (g.prefix === true) === prefix)) {
      this.allowExact.push({ tool, subject, ...(prefix ? { prefix: true } : {}) });
    }
    // A failed write must not turn an approved call into an error: the grant
    // still holds in memory for this run, it just will not survive a restart.
    try {
      this.persistExact?.(tool, subject, prefix);
    } catch {
      // best-effort persistence
    }
  }

  private stanceDefault(tool: AnyToolDefinition): "allow" | "ask" {
    if (this.overdrive) return "allow";
    if (tool.permissionClass === "read" || tool.permissionClass === "interact") return "allow";
    if (tool.isFileEdit) return "allow";
    return "ask";
  }
}

function parseRule(raw: string): ParsedRule {
  const match = /^([A-Za-z_][\w-]*)\((.*)\)$/.exec(raw.trim());
  if (!match) return { tool: raw.trim(), raw };
  return { tool: match[1]!, pattern: globToRegex(match[2]!), raw };
}

function matches(rules: ParsedRule[], tool: string, subject: string | undefined): boolean {
  return rules.some((rule) => {
    if (rule.tool !== tool) return false;
    if (!rule.pattern) return true;
    return subject !== undefined && rule.pattern.test(subject);
  });
}

/**
 * True only for a subject-scoped rule that is not the match-anything wildcard:
 * the deliberate, narrow kind of grant that may override the deletion guard.
 */
function matchesExplicit(rules: ParsedRule[], tool: string, subject: string | undefined): boolean {
  return rules.some(
    (rule) =>
      rule.tool === tool &&
      rule.pattern !== undefined &&
      !rule.raw.endsWith("(*)") &&
      subject !== undefined &&
      rule.pattern.test(subject),
  );
}

function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function exactPattern(subject: string): RegExp {
  return new RegExp(`^${subject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
}

