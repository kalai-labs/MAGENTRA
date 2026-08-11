# Post-run Q&A — turning 86 binary outcomes into an improvement list

Fill this in after both suites finish (`gpt-oss-120b` for the harness comparison,
`deepseek-v4-flash-0731` for the capability ceiling). Work over the **merged**
job directories, so every trial is in one place:

```powershell
& "$env:APPDATA\uv\tools\harbor\Scripts\python.exe" merge-jobs.py `
    --out jobs-merged\gptoss  jobs\tb2-gpt-oss-120b-*-b*
& "$env:APPDATA\uv\tools\harbor\Scripts\python.exe" merge-jobs.py `
    --out jobs-merged\v4flash jobs\tb2-20260807-1117-b*
```

**Rules for filling this in.** Every answer is a number or a quoted excerpt with
the trial name attached — never an impression. If a question cannot be answered
from the artifacts, write `NO DATA` and note what instrumentation is missing;
that gap is itself a finding. A question whose answer implies no change gets
`NO ACTION` and one line of why, so we do not re-litigate it next run.

**What the artifacts hold** (per trial, under the merged job dir):

| Source | Carries |
|---|---|
| `verifier/ctrf.json` | per-test pass/fail + failure messages |
| `verifier/test-stdout.txt` | raw test output |
| `agent/magentra-events.ndjson` | every protocol frame, timestamped (`t`) |
| `agent/magentra-result.json` | stopReason, turns, toolCalls, durationMs, contextTokens, usage |
| `agent/instruction.txt` | the exact task text |
| `exception.txt`, `trial.log` | harness-level failure |

Frame types confirmed present: `thinking_delta`, `text_delta`, `context_update`,
`tool_call_started`/`_finished`, `tool_output_delta`, `file_edited`,
`command_output`, `task_list_updated`, `turn_started`/`turn_finished`,
`background_notification`, `stderr`. Every frame carries `t` (epoch ms), so any
question below can be answered on a timeline, not just a total.

---

## 0. Is the number trustworthy at all?

Answer these first. If any is wrong, the rest of the analysis is measuring noise.

**0.1** How many trials produced a `reward.txt`? How many died before
verification (`exception.txt`, no reward)?
→ *Ungraded trials count as 0 in the headline. If more than ~3 of 86 died before
verification, the headline understates MAGENTRA and the run needs those tasks
re-driven before publication.*

**0.2** Of the exceptions, how many are `EnvironmentStartTimeoutError` or other
infrastructure faults rather than agent faults?
→ *Infrastructure zeros are not capability results. Re-run them with
`-i <task>` before quoting a final score.*

**0.3** Did any trial run on a different engine build? Check `bundle/version.json`
against each job's `lock.json` agent version.
→ *A mixed-build tally cannot go in the reproducibility section. Re-run the
odd ones out.*

**0.4** Did any task get graded twice across batches with **different** rewards
(re-queued after a key died)? `merge-jobs.py` reports discarded duplicates.
→ *Divergent repeats are free variance data — record them. They are the only
estimate of run-to-run noise we have at `-k 1`.*

**0.5** Was every task's `set_overdrive` acknowledged by an `overdrive_changed`
frame?
→ *Any trial without it ran in the wrong stance and is not comparable.*

---

## 1. Why did it time out? (the question that matters most)

"AgentTimeoutError" is a symptom. These separate the causes. Answer per
timed-out trial, then look for the dominant pattern.

**1.1 Was it nearly finished?** From `ctrf.json`, what fraction of tests passed
in timed-out trials? From the last `task_list_updated` frame, how many task-list
items were still open?
→ *High pass ratio + near-complete task list = a **pacing** problem, not a
capability problem. That is a cheap, high-value fix and a real paper finding.
Low pass ratio + open tasks = genuinely lost; pacing work would not have helped.*

**1.2 Where did the wall-clock actually go?** Bucket the time between
consecutive frames by what preceded it: thinking, tool execution, or model
latency (gap between `tool_call_finished` and the next `thinking_delta`).
→ *Thinking-dominated → cap or budget reasoning. Tool-dominated → the next
questions. Latency-dominated → the endpoint is the bottleneck and no MAGENTRA
change helps.*

**1.3 Was one single command eating the run?** Longest gap between a
`tool_call_started` (Bash) and its `tool_call_finished`.
→ *If one compile/train/download dominates, MAGENTRA needs a **long-command
strategy**: background it and poll, or predict cost before invoking. This is a
concrete feature, not a tuning knob.*

**1.4 Was it looping?** Count repeated identical or near-identical tool calls
(same tool + same target path). Count edit→revert→edit cycles on one file from
`file_edited` frames.
→ *Loops mean the agent could not tell that an attempt failed. The fix is in
**observation quality** — tool results that make failure legible — not in more
turns.*

**1.5 Was it re-reading what it already knew?** How many `Read`/`Grep` calls hit
a path already read earlier in the same trial?
→ *High re-read rate points at **context eviction**: it forgot and re-fetched.
Cross-check with 4.x. Fix is retention//compaction policy, not tooling.*

**1.6 Did it ever run the thing it wrote?** Ratio of `file_edited` to
`command_output` frames in timed-out trials versus in winning trials.
→ *Editing without executing is exactly what the **runtime evidence floor** is
meant to catch. If timed-out trials show a much lower execute ratio, the floor
is firing too late or not at all under OVERDRIVE — check whether it fired.*

**1.7 What was it doing in its final 90 seconds?** Quote the last 10 frames of
each timed-out trial.
→ *This is the single most informative artifact for the paper. Wrapping up →
pacing. Mid-debug → capability. Repeating itself → loop detection.*

**1.8** How many timed-out trials would have been saved by +5 / +10 / +20
minutes? (Compare the completion trajectory against remaining task-list items.)
→ *If +5 min rescues several, the finding is that MAGENTRA's pacing is
mismatched to the task budget — worth stating explicitly, and worth a
`timeout-aware` mode that triages when the clock runs short.*

---

## 2. Near-miss versus total failure

**2.1** Distribution of pass ratios in `ctrf.json` across all reward-0 trials
(e.g. 8/9 passed vs 0/9).
→ *A fat near-miss tail means MAGENTRA is doing the work but missing a
requirement. That is a **finishing** problem, and the finishing rungs are the
lever. A bimodal all-or-nothing distribution means comprehension failures
instead — different fix entirely.*

**2.2** For each near-miss, what did the one failing test actually assert?
Cluster the failure messages.
→ *Recurring clusters (edge cases, error handling, output format, tolerances)
each name a specific prompt or rung improvement.*

**2.3** Did the agent claim success in its final message while failing tests?
Compare the last `text_delta` against `reward.txt`.
→ *False completion claims are the most damaging failure mode for a product.
If common, the **self-verify rung is not biting** and that is the top fix,
outranking everything else in this document.*

**2.4** Conversely, did any trial honestly report an unverified gap and still
pass?
→ *Evidence the "honest gap outranks a manufactured green" rung works. Worth
quoting in the paper.*

---

## 3. The finishing rungs under OVERDRIVE

**3.1** In how many trials did the **runtime evidence floor** fire (a turn that
wrote runnable source and ran nothing)? Did the reminder change behaviour —
i.e. was there a `command_output` after it?
→ *Fires-but-ignored means the reminder is too weak for a small model. Consider
escalating from reminder to block under OVERDRIVE.*

**3.2** Did the **circular-check floor** ever fire? Did the agent verify against
a stub or mock it wrote in the same turn?
→ *If it fired and the agent still shipped the stub-backed result, the rung
needs teeth.*

**3.3** How many turns ended via self-verify `DONE` versus hitting a cap or the
wall? (`stopReason` in `magentra-result.json`.)
→ *A high `DONE` rate on failing tasks means self-verify is satisfied too
easily — the highest-leverage prompt change available.*

**3.4** Correlate `stopReason` with reward.
→ *If `DONE` correlates no better than chance with passing, self-verification
is decorative and should be redesigned around executable evidence.*

---

## 4. Context economics

**4.1** Peak `contextTokens` per trial versus reward. Did any trial approach the
model's window?
→ *If wins cluster below a threshold and losses above it, context pressure is
causal, and compaction is the fix.*

**4.2** Cache-read share of input tokens (`usage.cacheReadTokens` /
total input).
→ *Low share means prompt churn — the prefix is being invalidated. That is
pure waste and directly costs money and latency.*

**4.3** `thinking_delta` volume versus reward.
→ *407k thinking deltas across 42 trials in the partial run. If losers think
far more than winners, unbounded reasoning is a liability and deserves a budget.*

**4.4** Ratio of `tool_output_delta` volume to useful action. Are large tool
outputs (file dumps, logs) crowding the window?
→ *Points at output truncation/summarisation policy in the tool layer.*

---

## 5. Planning and task-list behaviour

**5.1** Did trials that used `TaskCreate`/`TaskUpdate` outperform those that did
not? (112 `task_list_updated` frames across the partial run.)
→ *If planning does not correlate with winning, it is ceremony and costs
tokens. If it does, consider making it mandatory under OVERDRIVE.*

**5.2** Were task lists kept honest — items marked `completed` that the tests
then failed?
→ *Same failure family as 2.3: self-reported completion diverging from reality.*

**5.3** Median tasks planned versus completed in wins versus losses.
→ *Over-planning (many items, few done) suggests the plan is written once and
never revised; under-planning suggests it dives in blind.*

---

## 6. Tool layer

**6.1** Tool-call histogram for wins versus losses. (Observed on one failure:
`Grep:33 Edit:29 Read:24 Bash:8` — search-heavy, execution-light.)
→ *A distinct losing profile is directly actionable: bias the prompt toward the
winning profile, or make the expensive tool cheaper.*

**6.2** Which tools most often returned errors, and did the agent recover?
→ *High error + low recovery on a specific tool = that tool's contract or error
message is unclear. Concrete, local fix.*

**6.3** Any tool never used across 86 tasks?
→ *Dead weight in the prompt, costing tokens on every call.*

**6.4** Time cost per tool (from frame timestamps).
→ *Ranks where latency engineering would actually pay.*

---

## 7. Model-attributable versus harness-attributable

Answer by comparing the same task across the two suites.

**7.1** Which tasks did v4-flash win that gpt-oss lost?
→ *Pure capability gap. No MAGENTRA change recovers these — say so, and stop
counting them as harness failures.*

**7.2** Which tasks did **both** lose, and did they lose the same way?
→ *Same-way losses are harness-shaped and are the real improvement backlog.
Different-way losses are model-shaped.*

**7.3** Did either model produce malformed tool calls or protocol errors
(`stderr` frames, parse failures)?
→ *Robustness gap in the protocol layer — matters for supporting weak models.*

**7.4** Did gpt-oss need more turns for tasks both won?
→ *Quantifies the efficiency cost of a weaker model under the same harness —
a good table for the paper.*

---

## 8. Against the baselines

**8.1** Final MAGENTRA + gpt-oss-120b score over **89**, next to Terminus 2
(18.7%) and Mini-SWE-Agent (14.2%).
→ *The headline. Include the confidence interval; at `-k 1` it will be wide.*

**8.2** Which tasks did MAGENTRA win that the baselines' published runs did not
(where per-task data is available)?
→ *Names the capability the architecture actually buys.*

**8.3** Is the gap larger on long-horizon tasks than short ones?
→ *If MAGENTRA's advantage concentrates in long tasks, the argument is about
state and finishing, not tooling — sharpens the paper's thesis.*

**8.4** Token and wall-clock cost per solved task versus baselines.
→ *If MAGENTRA wins more but costs disproportionately more, that is an honest
limitation to state before a reviewer states it for you.*

---

## 9. Reward hacking and honesty

**9.1** Did any trial modify or weaken the tests instead of the code? Grep
`file_edited` paths for test files.
→ *Must be disclosed if present, and hard-blocked if so.*

**9.2** Did any trial hard-code expected outputs rather than compute them?
→ *Optionally cross-check with `harbor analyze`, whose default rubric includes
`reward_hacking`.*

**9.3** Did any trial declare completion without running anything at all?
→ *Direct evidence on whether the evidence floor holds under OVERDRIVE.*

---

## 10. Synthesis — fill in last

**10.1** The three most frequent *root causes* of reward-0, by trial count.

**10.2** For each: is the fix a **prompt** change, a **rung** change, a **tool**
change, or a **runtime/pacing** change? Estimate tasks recoverable.

**10.3** Ranked improvement list — expected tasks recovered ÷ implementation
cost. This is the deliverable; everything above exists to produce it.

**10.4** What could not be answered from the artifacts, and what instrumentation
would be needed next time?
→ *Feed this back into `driver.mjs` before the next run. Instrumentation debt
compounds — a question we could not answer this round will still be unanswerable
next round unless it is fixed now.*

**10.5** Which findings are strong enough for the preprint, and which are
single-trial anecdotes?
→ *Guard against over-claiming from n=1. A pattern needs several trials or it
is an illustration, not a result.*
