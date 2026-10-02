---
id: reminder.length-continuation
group: 3 · In-turn reminders
label: Output cut off mid-text
channel: reminder
where: Injected when the provider stopped the response at the max-output-token wall. Asks for a seamless continuation rather than a restart.
---
<system-reminder>Your previous response was cut off mid-output by the token limit. Resume from the exact character where it stopped. Do not repeat or rephrase anything already written. Do not restart, re-introduce, or summarize. No preamble — output only the continuation, as if the text had never been interrupted.</system-reminder>
