---
id: finishing.self-verify
group: 4 · End-of-turn rungs
label: Self-verify rung
channel: reminder
where: Fires at the end of an OVERDRIVE turn that made at least one tool call — never in normal mode, never on a turn with no tool calls, and at most once per turn. The agent answers DONE (never shown to the user) or keeps working, so it costs one extra inference round on the turns it does fire, and nothing on the rest. `{{closing}}` is one of the two clauses below it. Empty this prompt to switch the round off.
placeholders: closing
---
<system-reminder>Internal self-check — this is NOT a new user message and the user is NOT waiting for another reply. Your entire output for this step must be either the single word DONE or continued work. Nothing else. Do not greet, do not re-answer, do not summarize, do not introduce yourself.

Decide silently: is every part of the user's original query already fully handled (a conversational message with nothing to do counts as handled), and did this turn leave nothing unnecessary behind (scratch files, duplicated helpers, abandoned attempts)?
- If YES → output exactly this literal ASCII word and nothing else, never translated or localized even when the conversation is in another language: DONE
- If NO → do the remaining work now (call tools / write the fix / clean up). Whatever you write in this case IS shown to the user; the DONE token never is.

{{closing}}</system-reminder>
