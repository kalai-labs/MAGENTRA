---
id: addon-author.retry-feedback
group: 5 · Background inference calls
label: Addon author — validator rejection
channel: side-call-user
where: Appended after a blank line to addon-author.instruction on the wizard's 2nd and 3rd attempt, when the previous draft failed validation. `{{error}}` is the validator's reason. When switched off, the retry is sent without it.
placeholders: error
---
Your previous attempt was rejected by the validator:
{{error}}
Return ONLY the corrected file, starting with the "---" line — no sentence before it.
