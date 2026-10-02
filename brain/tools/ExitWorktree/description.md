---
name: ExitWorktree
---
Leaves the active Magentra worktree and restores the original session cwd.

action "keep" preserves the worktree and its branch. action "remove" deletes both, but refuses (listing the work) if there are uncommitted changes or commits not in the base ref, unless discard_changes is true. Worktrees entered via an existing path are never removed. No-op if no worktree session is active.
