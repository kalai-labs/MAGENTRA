---
id: system.environment
group: 1 · Core system prompt
label: Environment block
channel: system
where: Appended after the behavior sections. The only place the agent learns the cwd, platform, model name and today's date. Part of the main system prompt, sent on every request of every session.
placeholders: cwd, isGitRepo, platform, model, date
order: 100
---
Environment:
- Working directory: {{cwd}}
- Git repository: {{isGitRepo}}
- Platform: {{platform}}
- Model: {{model}}
- Today's date: {{date}}
