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
export type ApprovalSource = "ask" | "deletion-guard" | "protected-path";

/**
 * Paths a file-editing tool may never write without an explicit confirmation,
 * in every stance (OVERDRIVE included). Two families:
 *   - `.magentra/**` — MAGENTRA's own state (settings, sessions, transcripts,
 *     team files). Corrupting it breaks the workspace, not just the task.
 *   - `.env`, `.env.*` — secrets. An accidental overwrite is unrecoverable and
 *     a careless one leaks credentials into a diff.
 * The deletion guard already covers *removing* these; this covers *editing*.
 */
export function protectedEditPath(absPath: string): string | undefined {
  const segments = absPath.split(/[\\/]/);
  if (segments.some((s) => s.toLowerCase() === ".magentra")) return absPath;
  const base = segments[segments.length - 1]?.toLowerCase() ?? "";
  if (base === ".env" || base.startsWith(".env.")) return absPath;
  return undefined;
}

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
 * Resolution order: deny rules > protected-path guard > deletion guard >
 * allow rules > stance default.
 *
 * The stance default is ALLOW for every class (2026-07-26). Commands, network
 * calls and file edits no longer ask — the friction bought little, because the
 * two things worth confirming are not classes of tool at all but classes of
 * TARGET, and both are guarded ahead of the stance:
 *   - deletion guard — anything that removes a file, folder or worktree.
 *   - protected-path guard — edits into `.magentra/**` or a `.env*` file.
 *
 * OVERDRIVE turns both off: it means nothing asks, literally. Deny rules are
 * the one thing it does not override — a deny rule refuses rather than asks,
 * and silently ignoring the user's own configuration would be a different
 * feature.
 */
export class PermissionEngine {
  /** When true (default), destructive calls always ask the user, in both
   *  stances. The desktop's "Allow deletions" setting turns this off, after
   *  which deletions resolve through the ordinary rules/stance path. */
  private deletionGuard = true;
  /** OVERDRIVE: nothing asks. Every call runs unless a deny rule forbids it —
   *  deletions at any scope (the `.magentra` state dir included), edits to
   *  protected paths, and writes outside the workspace. It is an explicit
   *  user-thrown switch, so it is allowed to mean what it says. */
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
    /** The absolute path when a file-edit call targets a protected file
     *  (`.magentra/**` or `.env*`) — such an edit always asks, in every stance. */
    editProtectedPath?: string,
  ): Promise<PermissionOutcome> {
    if (matches(this.deny, tool.name, subject)) {
      return {
        allowed: false,
        source: "rule",
        message: `Permission denied by settings rule. The user's configuration forbids this call; do not retry it verbatim.`,
      };
    }

    // Protected-path guard: an edit into MAGENTRA's own state dir or a .env
    // file confirms every time, ahead of allow rules and the stance — the same
    // placement, and for the same reason, as the deletion guard below. A
    // deliberate narrow grant (an explicit `Tool(path)` allow rule, or an
    // earlier "always allow" on this exact path) satisfies it; broad grants
    // and OVERDRIVE never do.
    if (editProtectedPath !== undefined && !this.overdrive) {
      const deliberatelyAllowed =
        matchesExplicit(this.allow, tool.name, subject) || this.matchesExact(tool.name, subject, true);
      if (!deliberatelyAllowed) {
        const res = await this.requestApproval(
          {
            tool: tool.name,
            input,
            description: `${description ?? tool.name} — protected path: ${editProtectedPath}`,
            ...(subject !== undefined ? { subject } : {}),
          },
          "protected-path",
        );
        if (res.decision === "deny") {
          return {
            allowed: false,
            source: "user",
            message: `The user declined this edit to a protected path (${editProtectedPath})${res.message ? `: ${res.message}` : "."} Edits to .magentra state and .env files always require approval; do not retry the same call.`,
          };
        }
        // Literal grant only — one approval covers this exact file, never a
        // command shape or the whole tool.
        if (res.decision === "allow_always") this.grantExact(tool.name, subject);
        return { allowed: true, source: "user", ...(res.message ? { note: res.message } : {}) };
      }
    }
    // Deletion guard: a tool call that would delete a file/folder requires
    // interactive approval. OVERDRIVE skips it outright — see below. One other
    // exception: an EXPLICIT subject-scoped allow rule in the user's settings
    // (e.g. `Bash(rm -rf ./tmp/*)`) is a deliberate standing decision about
    // that exact call shape — it beats the guard, so a repeated cleanup can
    // run without re-prompting forever. Broad grants (bare tool, `Tool(*)`, session allows) never do. The guard
    // never adds a session-allow, so it re-fires on every other matching call.
    // Only LITERAL grants may override the guard: a derived command-shape
    // grant ("git push …") from a benign approval must never let a later
    // destructive variant ("git push --force") skip the always-ask.
    const explicitlyAllowed =
      matchesExplicit(this.allow, tool.name, subject) || this.matchesExact(tool.name, subject, true);
    // Protected target — a `.magentra` state directory (settings, sessions,
    // transcripts). Deleting it asks in every mode EXCEPT OVERDRIVE: it beats
    // the "allow deletions" off-switch and explicit allow rules, but not a
    // switch the user threw by hand.
    const protectedTarget = deletionScope === "protected";
    const deletionSubject =
      // OVERDRIVE means nothing asks — including this, at any scope.
      this.overdrive ? undefined
      : protectedTarget || (this.deletionGuard && !explicitlyAllowed)
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

  /**
   * Allow-all. Every gate that still exists is target-shaped (deletion guard,
   * protected-path guard, out-of-workspace edits) or user-authored (deny
   * rules), and all of them are resolved before this point. Kept as a method
   * rather than inlined so the `"ask"` half of the switch below stays live for
   * the out-of-workspace downgrade, and so restoring a class-based stance is a
   * one-line change.
   */
  private stanceDefault(_tool: AnyToolDefinition): "allow" | "ask" {
    return "allow";
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

