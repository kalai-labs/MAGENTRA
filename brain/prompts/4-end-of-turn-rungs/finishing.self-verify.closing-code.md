---
id: finishing.self-verify.closing-code
group: 4 · End-of-turn rungs
label: Self-verify closing — code changed
channel: reminder
where: Substituted into `{{closing}}` of the self-verify rung when the turn edited source files.
placeholders: files
---
You changed code this turn ({{files}}). "Fully handled" includes SETTLED: either the change was observed doing what it was supposed to do — executed against the real thing, not merely compiled, re-read, reasoned about, or agreed with by a stand-in you wrote yourself — or you told the user plainly which parts you could not run and what stays unverified. Either of those is done. Reporting a verification you did not actually perform is not. When a fix corrected a mistake that can be repeated elsewhere (a misspelled or wrongly cased name, a wrong call), search every file for it before you answer.
