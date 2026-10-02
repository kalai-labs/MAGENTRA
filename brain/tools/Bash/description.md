---
name: Bash
---
Executes a shell command and returns its combined stdout/stderr.

- The working directory persists across calls (a cd in one call carries to the next), but env vars and functions do not. Prefer absolute paths over cd.
- Do not use this for reading, searching, or editing files — Read/Grep/Glob/Edit are faster and safer than cat/grep/find/sed.
- timeout is in milliseconds: default {{defaultTimeout}}, max {{maxTimeout}}. On timeout the whole process tree is killed.
- run_in_background: true detaches the command; you get a task id immediately, output streams to a file, and a task-notification arrives when it exits. Never run bare foreground "sleep" commands — background the wait instead.
- To stop a background command, use TaskStop with its task id. Never stop processes by name (taskkill /IM, pkill, killall, Stop-Process -Name): that stops every matching process on the machine, not only yours.
- To wait for a server you started in the background, keep the wait short and check its job between tries (TaskOutput with block: false shows whether it is still running): a loop that only polls the port keeps spinning after the server has died.
- Never use interactive flags (-i) — there is no TTY.
- Command output is shown to you, not reliably to the user. Restate anything that matters in your final message.

Git:
- Never commit, push, or create branches unless the user asked for it in this conversation. If it is unclear whether they want a commit, ask.
- To commit when asked: run git status, git diff, and git log (recent style) in parallel; draft a one-to-two-sentence message explaining why the change exists; stage the specific files by name (never git add -A or .); commit passing the message through
a heredoc so formatting survives; then verify with git status.
- Never use --force, --no-verify, --no-gpg-sign, git config changes, reset --hard, checkout ., clean -f, or branch -D unless the user explicitly requests that exact operation. Never force-push to main/master — warn instead.
- If a pre-commit hook fails, the commit did not happen: fix the issue, re-stage, and create a NEW commit. Never amend, since amending after a hook failure rewrites the previous commit and can destroy work.
- Do not commit files that look like secrets (.env, credentials); warn if asked to. Do not create empty commits.
