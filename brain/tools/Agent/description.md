---
name: Agent
---
Delegates a task to a fresh subagent with its own context window and a restricted tool set, then returns the subagent's final report as the tool result.

Use it to fan out independent work (parallel Agent calls in one turn run concurrently), or to run a large search whose intermediate file contents you do not want in your own context. The subagent shares your working directory but starts with no memory of this conversation, so its prompt must be self-contained.

Once you delegate a search, do not also run it yourself — wait for the result. For a single-fact lookup where you already know the file or symbol, search directly instead.

The subagent's report is never shown to the user, so relay what matters. Subagents cannot spawn further subagents and cannot ask the user questions.

Available subagent types:
{{agentTypes}}
