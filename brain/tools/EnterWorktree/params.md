## name
Name for a new worktree (segments of A-Za-z0-9._-, max 64 chars total). Creates .magentra/worktrees/<name> on branch magentra/<name>. Random if omitted.

## path
Path of an EXISTING worktree to switch into (must already appear in `git worktree list`). Mutually exclusive with name.
