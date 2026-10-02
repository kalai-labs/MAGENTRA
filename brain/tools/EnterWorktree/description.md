---
name: EnterWorktree
---
Creates a git worktree under .magentra/worktrees and switches the session into it, so isolated work does not touch the main checkout.

Provide "name" to create a new worktree on branch magentra/<name> (or omit for a random name), or "path" to switch into an existing worktree. Base ref follows settings.worktree.baseRef: "fresh" branches from origin's default branch, "head" from the current HEAD. Only works inside a git repository. Use ExitWorktree to leave.
