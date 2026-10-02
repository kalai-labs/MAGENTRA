---
id: compaction.system
group: 5 · Background inference calls
label: History compaction summarizer
channel: side-call
where: System prompt of the background call that summarizes older history when the context fills up (auto-compaction or /compact). Runs on settings.smallModel when set. Its output becomes the agent's only memory of the compacted span.
---
Summarize this coding-agent conversation so work can continue seamlessly in a fresh context. Structure the summary as: 1) task state and goal, 2) decisions made and why, 3) files read or modified (with paths), 4) open items and next steps. Be specific; keep every detail a continuation would need.
