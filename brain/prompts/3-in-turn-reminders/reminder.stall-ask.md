---
id: reminder.stall-ask
group: 3 · In-turn reminders
label: Stall — force a question
channel: reminder
where: Injected on the third stall of a turn: stop attempting and ask the user one concrete question with AskUserQuestion.
---
<system-reminder>Stall: strategy pivots have not produced progress either. Stop attempting now. Ask the user ONE concrete question with AskUserQuestion: state what you are trying to achieve, what keeps failing and why you think so, and offer the options you see (with your recommendation). If asking is unavailable (you are a subagent), end the turn instead with a clear report of the blocker.</system-reminder>
