import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { SessionServices, ToolDefinition, ToolResult } from "@magentra/core";

/**
 * EnterWorktree / ExitWorktree. Creates and switches into git worktrees under
 * .magentra/worktrees/<name>, and restores/removes them on exit.
 *
 * Uses two optional session capabilities:
 *   - setCwd(dir): switches the session working directory so subsequent tools
 *     operate inside the worktree. Required by EnterWorktree.
 *   - worktreeBaseRef: "fresh" | "head" (from settings.worktree.baseRef). Defaults
 *     to "fresh" when absent.
 */

interface WorktreeState {
  dir: string;
  branch?: string; // set only for worktrees we created
  base: string; // base ref used at creation ("" for path-entered worktrees)
  originalCwd: string;
  createdByUs: boolean;
}

// Per-session active worktree, keyed on the SessionServices identity.
const active = new WeakMap<SessionServices, WorktreeState>();

function git(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((res) => {
    execFile("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code =
        err && typeof (err as { code?: unknown }).code === "number"
          ? (err as { code: number }).code
          : err
            ? 1
            : 0;
      res({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

function validateName(name: string): string | undefined {
  if (name.length === 0 || name.length > 64) return "name must be 1-64 characters total";
  for (const seg of name.split("/")) {
    if (seg === "" || seg === "." || seg === "..") return "name segments may not be empty, '.', or '..'";
    if (!/^[A-Za-z0-9._-]+$/.test(seg)) return `invalid name segment "${seg}" (allowed: A-Z a-z 0-9 . _ -)`;
  }
  return undefined;
}

function randomName(): string {
  return `wt-${randomBytes(4).toString("hex")}`;
}

function normalizePath(p: string): string {
  const abs = resolve(p).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

function worktreePaths(porcelain: string): string[] {
  return porcelain
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length).trim());
}

// -- EnterWorktree -----------------------------------------------------------

const enterSchema = z
  .object({
    name: z
      .string()
      .optional()
      .describe(
        "Name for a new worktree (segments of A-Za-z0-9._-, max 64 chars total). Creates .magentra/worktrees/<name> on branch magentra/<name>. Random if omitted.",
      ),
    path: z
      .string()
      .optional()
      .describe("Path of an EXISTING worktree to switch into (must already appear in `git worktree list`). Mutually exclusive with name."),
  })
  .refine((d) => !(d.name !== undefined && d.path !== undefined), {
    message: "name and path are mutually exclusive",
  });

export const enterWorktreeTool: ToolDefinition<z.infer<typeof enterSchema>> = {
  name: "EnterWorktree",
  description: `Creates a git worktree under .magentra/worktrees and switches the session into it, so isolated work does not touch the main checkout.

Provide "name" to create a new worktree on branch magentra/<name> (or omit for a random name), or "path" to switch into an existing worktree. Base ref follows settings.worktree.baseRef: "fresh" branches from origin's default branch, "head" from the current HEAD. Only works inside a git repository. Use ExitWorktree to leave.`,
  permissionClass: "execute",
  describeInput: (input) => (input.path ? `enter worktree ${input.path}` : `create worktree ${input.name ?? "(random)"}`),
  execute: async (input, ctx): Promise<ToolResult> => {
    const session = ctx.session;
    if (typeof session.setCwd !== "function") {
      return {
        content:
          "Cannot switch into a worktree: this session's embedder did not wire the cwd hook (setCwd), so the working directory cannot be changed.",
        isError: true,
      };
    }
    if (active.has(ctx.session)) {
      const cur = active.get(ctx.session)!;
      return { content: `A worktree session is already active (${cur.dir}). Run ExitWorktree first.`, isError: true };
    }

    const repo = ctx.cwd;
    const inside = await git(["rev-parse", "--is-inside-work-tree"], repo);
    if (inside.code !== 0 || inside.stdout.trim() !== "true") {
      return { content: "EnterWorktree requires a git repository, but this directory is not inside one.", isError: true };
    }

    // --- path variant: switch into an existing worktree, never created by us ---
    if (input.path !== undefined) {
      const target = resolve(repo, input.path);
      const list = await git(["worktree", "list", "--porcelain"], repo);
      const paths = worktreePaths(list.stdout);
      const match = paths.find((p) => normalizePath(p) === normalizePath(target));
      if (!match) {
        return {
          content: `Path is not a registered git worktree: ${target}\nKnown worktrees:\n${paths.join("\n") || "(none)"}`,
          isError: true,
        };
      }
      session.setCwd(match);
      active.set(ctx.session, { dir: match, base: "", originalCwd: repo, createdByUs: false });
      return {
        content: `Entered existing worktree ${match} (not created by Magentra; ExitWorktree will not remove it). Session cwd switched.`,
      };
    }

    // --- name variant: create a fresh worktree ---
    const name = input.name ?? randomName();
    const nameErr = validateName(name);
    if (nameErr) return { content: nameErr, isError: true };

    const dir = join(repo, ".magentra", "worktrees", name);
    const branch = `magentra/${name}`;
    const baseRef = session.worktreeBaseRef ?? "fresh";
    let base = "HEAD";
    if (baseRef === "fresh") {
      const sym = await git(["symbolic-ref", "refs/remotes/origin/HEAD"], repo);
      if (sym.code === 0 && sym.stdout.trim()) {
        base = sym.stdout.trim().replace("refs/remotes/", ""); // e.g. origin/main
      } else {
        base = "HEAD"; // no remote — branch from current HEAD
      }
    }

    const add = await git(["worktree", "add", dir, "-b", branch, base], repo);
    if (add.code !== 0) {
      return { content: `git worktree add failed: ${(add.stderr || add.stdout).trim()}`, isError: true };
    }
    session.setCwd(dir);
    active.set(ctx.session, { dir, branch, base, originalCwd: repo, createdByUs: true });
    return { content: `Created worktree at ${dir} on branch ${branch} (base ${base}). Session cwd switched.` };
  },
  inputSchema: enterSchema,
};

// -- ExitWorktree ------------------------------------------------------------

const exitSchema = z.object({
  action: z
    .enum(["keep", "remove"])
    .describe("keep: leave the worktree and branch in place. remove: delete the worktree and its branch."),
  discard_changes: z
    .boolean()
    .optional()
    .default(false)
    .describe("Required to remove a worktree that has uncommitted changes or unmerged commits; otherwise removal is refused."),
});

export const exitWorktreeTool: ToolDefinition<z.infer<typeof exitSchema>> = {
  name: "ExitWorktree",
  description: `Leaves the active Magentra worktree and restores the original session cwd.

action "keep" preserves the worktree and its branch. action "remove" deletes both, but refuses (listing the work) if there are uncommitted changes or commits not in the base ref, unless discard_changes is true. Worktrees entered via an existing path are never removed. No-op if no worktree session is active.`,
  permissionClass: "execute",
  describeInput: (input) => `exit worktree (${input.action})`,
  deletionSubject: (input) => (input.action === "remove" ? "remove the active worktree and its branch" : undefined),
  execute: async (input, ctx): Promise<ToolResult> => {
    const session = ctx.session;
    const st = active.get(ctx.session);
    if (!st) return { content: "No worktree session is active; nothing to exit." };

    const restore = (): void => session.setCwd?.(st.originalCwd);

    if (input.action === "keep") {
      restore();
      active.delete(ctx.session);
      return { content: `Left worktree ${st.dir}; branch preserved. Session cwd restored to ${st.originalCwd}.` };
    }

    // remove
    if (!st.createdByUs) {
      restore();
      active.delete(ctx.session);
      return {
        content: `Worktree ${st.dir} was entered via path and is never removed by Magentra. Session cwd restored to ${st.originalCwd}.`,
      };
    }

    const status = await git(["status", "--porcelain"], st.dir);
    const dirty = status.stdout.trim();
    let unmerged = "";
    if (st.base && st.base !== "HEAD") {
      const log = await git(["log", "--oneline", `${st.base}..HEAD`], st.dir);
      unmerged = log.stdout.trim();
    }

    if ((dirty || unmerged) && !input.discard_changes) {
      const parts: string[] = [];
      if (dirty) parts.push(`Uncommitted changes:\n${dirty}`);
      if (unmerged) parts.push(`Commits not in ${st.base}:\n${unmerged}`);
      return {
        content: `Refusing to remove worktree ${st.dir} — it has work that would be lost. Re-run with discard_changes:true to force removal, or commit/merge first.\n\n${parts.join("\n\n")}`,
        isError: true,
      };
    }

    restore();
    const rm = await git(["worktree", "remove", "--force", st.dir], st.originalCwd);
    if (rm.code !== 0) {
      // Leave state cleared but report the failure.
      active.delete(ctx.session);
      return { content: `git worktree remove failed: ${(rm.stderr || rm.stdout).trim()}`, isError: true };
    }
    if (st.branch) await git(["branch", "-D", st.branch], st.originalCwd);
    active.delete(ctx.session);
    return {
      content: `Removed worktree ${st.dir}${st.branch ? ` and branch ${st.branch}` : ""}. Session cwd restored to ${st.originalCwd}.`,
    };
  },
  inputSchema: exitSchema,
};
