import type { PermissionDecision, PermissionMode } from "@magentra/protocol";
import type { AnyToolDefinition } from "../agent/tool.js";

export interface PermissionRequestPayload {
  tool: string;
  input: unknown;
  description?: string;
}

export interface PermissionOutcome {
  allowed: boolean;
  /** Shown to the model when denied. */
  message?: string;
  source: "mode" | "rule" | "user";
}

/** Why requestApproval was invoked, surfaced to the transcript log. */
export type ApprovalSource = "ask" | "deletion-guard";

interface ParsedRule {
  tool: string;
  pattern?: RegExp;
  raw: string;
}

/**
 * Resolution order: deny rules > allow rules > mode default. Mode default may
 * resolve to "ask", which round-trips to the frontend via requestApproval.
 */
export class PermissionEngine {
  private mode: PermissionMode;
  /** When true (default), destructive calls always ask the user, in every mode.
   *  The desktop's "Allow deletions" setting turns this off, after which
   *  deletions resolve through the ordinary rules/mode path like any call. */
  private deletionGuard = true;
  private readonly deny: ParsedRule[];
  private readonly allow: ParsedRule[];
  private readonly sessionAllow: ParsedRule[] = [];

  constructor(
    mode: PermissionMode,
    rules: { allow: string[]; deny: string[] },
    private readonly requestApproval: (
      req: PermissionRequestPayload,
      source: ApprovalSource,
    ) => Promise<{ decision: PermissionDecision; message?: string }>,
  ) {
    this.mode = mode;
    this.allow = rules.allow.map(parseRule);
    this.deny = rules.deny.map(parseRule);
  }

  getMode(): PermissionMode {
    return this.mode;
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  getDeletionGuard(): boolean {
    return this.deletionGuard;
  }

  setDeletionGuard(enabled: boolean): void {
    this.deletionGuard = enabled;
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
  ): Promise<PermissionOutcome> {
    if (matches(this.deny, tool.name, subject)) {
      return {
        allowed: false,
        source: "rule",
        message: `Permission denied by settings rule. The user's configuration forbids this call; do not retry it verbatim.`,
      };
    }
    // Deletion guard: a tool call that would delete a file/folder always
    // requires interactive approval, in every mode (including bypass) and
    // regardless of allow rules or session allows. It is checked before those
    // shortcuts (but after deny rules, which the user configured explicitly
    // to always block the call outright) and never adds a session-allow, so
    // it re-fires on every subsequent matching call.
    const deletionSubject = this.deletionGuard ? tool.deletionSubject?.(input) : undefined;
    if (deletionSubject !== undefined) {
      const res = await this.requestApproval(
        { tool: tool.name, input, description: deletionSubject },
        "deletion-guard",
      );
      if (res.decision === "deny") {
        return {
          allowed: false,
          source: "user",
          message: `The user declined this destructive tool call${res.message ? `: ${res.message}` : "."} Deletion calls always require approval; adjust your approach instead of retrying the same call.`,
        };
      }
      return { allowed: true, source: "user" };
    }

    if (matches(this.allow, tool.name, subject) || matches(this.sessionAllow, tool.name, subject)) {
      return { allowed: true, source: "rule" };
    }

    switch (this.modeDefault(tool)) {
      case "allow":
        return { allowed: true, source: "mode" };
      case "deny":
        return {
          allowed: false,
          source: "mode",
          message:
            this.mode === "plan"
              ? "Plan mode is active: only read-only tools may run. Record intended changes in the plan file instead."
              : "This tool is not permitted in the current mode.",
        };
      case "ask": {
        const res = await this.requestApproval({ tool: tool.name, input, description }, "ask");
        if (res.decision === "deny") {
          return {
            allowed: false,
            source: "user",
            message: `The user declined this tool call${res.message ? `: ${res.message}` : "."} Adjust your approach instead of retrying the same call.`,
          };
        }
        if (res.decision === "allow_session") {
          // "Always allow this session" means the TOOL, not this exact
          // subject — an exact-subject grant re-asks on every new command/path
          // and reads as broken. Safe to be broad: the deletion guard is
          // checked BEFORE allow rules, so destructive calls still ask.
          // (Targeted subject-scoped grants still exist via addSessionAllow —
          // plan approval uses them.)
          this.sessionAllow.push({ tool: tool.name, raw: tool.name });
        }
        return { allowed: true, source: "user" };
      }
    }
  }

  private modeDefault(tool: AnyToolDefinition): "allow" | "deny" | "ask" {
    if (this.mode === "bypass") return "allow";
    if (tool.permissionClass === "read" || tool.permissionClass === "interact") return "allow";
    if (this.mode === "plan") return "deny";
    if (this.mode === "acceptEdits" && tool.isFileEdit) return "allow";
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

function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function exactPattern(subject: string): RegExp {
  return new RegExp(`^${subject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
}

