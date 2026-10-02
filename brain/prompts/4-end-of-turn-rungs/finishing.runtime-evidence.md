---
id: finishing.runtime-evidence
group: 4 · End-of-turn rungs
label: Runtime evidence rung
channel: reminder
where: Fires once at the end of a turn that edited source files but never ran a command. Injected as a user-role reminder, which costs at least one extra round trip — shorten or blank it to make turns finish faster.
placeholders: files, visionNote, doubleNote
---
<system-reminder>You changed code this turn ({{files}}) and did not run a single command, so nothing you wrote has been observed working. Handle that now, then finish.

Work down this list and stop as soon as the change is settled:
1. Fast gate first — the project's own build/typecheck/lint if it has one. It catches the cheap failures, but passing it is NOT evidence: it proves the code parses, not that it behaves.
2. Execute the path you changed, and the callers it reaches that your change could break.
3. If a one-liner will not reach it, write a throwaway harness — put it in the system temp directory, not in the repository — and DELETE it in this same turn. A harness DRIVES your real code; it does not replace the thing you are unsure about. The
moment you substitute a stand-in for the dependency, you stopped measuring reality and started measuring your own assumption.
4. Judge against something you can actually read: exit codes, stdout, a log line, a returned value, a file the code wrote. {{visionNote}}
5. Say in your wrap-up what you ran and what you observed. A failing run reported honestly is a good outcome; a silent one is not.

{{doubleNote}}
If this change genuinely cannot be executed on this machine — it needs a device, a credential or a service you do not have — then STOP HERE AND SAY SO. Name the closest thing you did run, name what stays unverified, and move on. That is a complete and correct answer to this reminder, and it is worth more than a green result you had to manufacture. Nothing here asks you to end with a passing check; it asks you to know, and to say, what you actually observed.

Where you cannot run a thing, you can still usually confirm its CONTRACT: import it and print its signature or docstring, check the type of what it returns, read the source you are calling. A function that needs a console still tells you what it gives back. That costs one command and is real evidence; guessing the contract and then encoding the guess into a stand-in is not.</system-reminder>
