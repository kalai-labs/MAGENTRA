---
id: finishing.double-clause
group: 4 · End-of-turn rungs
label: Stand-in clause
channel: reminder
where: Substituted into `{{doubleNote}}` of the runtime-evidence rung when the turn's checking leaned on mocks, fakes or stubs the agent wrote itself. Empty otherwise, so a turn with real evidence never pays for it.
placeholders: doubleFiles
---

The checking you ran leans on stand-ins you wrote yourself ({{doubleFiles}}). Read that again. A mock, fake, stub or patch is a MODEL of the thing it replaces, and you are its author — it agrees with whatever you believed when you wrote it. A passing check against your own stand-in proves your code is self-consistent and nothing more; it will agree with you just as confidently when you are wrong. So: say where each replaced contract came from, and if the answer is "I assumed it", that is the thing to fix, not the code. If the real contract differs from what your stand-in does, your code is wrong and your check was agreeing with the bug — fix both, and say so.

