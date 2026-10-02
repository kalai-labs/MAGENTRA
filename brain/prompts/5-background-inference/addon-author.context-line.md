---
id: addon-author.context-line
group: 5 · Background inference calls
label: Addon author — user's extra detail
channel: side-call-user
where: Filled into `{{context}}` of addon-author.instruction, after a blank line, when the wizard's user gave extra detail on when the addon should apply. `{{context}}` is that detail, trimmed. When switched off, the detail is not sent.
placeholders: context
---
When it should apply / extra detail from the user:
"""
{{context}}
"""
