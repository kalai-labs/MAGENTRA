# Benchmarks — Claude Code vs MAGENTRA

Five prompts, each in its own `.txt`. Give one prompt to one agent in one **fresh,
empty folder**, and never two prompts in the same folder. Ten runs total for a
full comparison.

Target environment: **Windows, Python 3 only, no internet, no installs.** Many
libraries (numpy, pandas, scipy, torch, …) are already present and the prompts
allow using them — but never installing anything. There is no Node.js.

**This file is for you, not for the agents.** It holds the answers. Do not put it
in the working folders.

| # | File | What it measures |
|---|---|---|
| 1 | `01-exact-arithmetic-cli.txt` | Spec precision, numeric correctness, self-testing against a stated contract |
| 2 | `02-consolidate-duplication.txt` | Refactoring: reuse over reinvent, dead-code removal, behaviour-preserving change with proof |
| 3 | `03-find-the-silent-bug.txt` | Debugging: searching for a failure instead of guessing, root-cause reasoning, wide verification |
| 4 | `04-durable-kv-server.txt` | Systems: concurrency, durability, crash recovery, process hygiene, real end-to-end proof |
| 5 | `05-streaming-log-percentiles.txt` | Performance engineering under a measured budget, plus checking fast code against a slow reference |

## How to compare

For each run, record four things:

1. **Wall-clock time** the agent took, and roughly how many turns.
2. **Did it actually run its own work?** Or did it hand you code and claim it
   works? This is the single most discriminating question in the set.
3. **Objective result** against the ground truth below.
4. **Leftovers.** Scratch files, half-finished attempts, dead code, stray
   processes, a test suite you never asked for.

A run that reports its own failure honestly scores above a run that claims
success you cannot reproduce. Weight that deliberately.

---

## 1 — Exact arithmetic

The 21-row contract is in the prompt, so the expected output is not secret. What
you are grading is whether the agent **actually ran all 21 lines and compared**,
rather than eyeballing.

Rows that separate a careful implementation from a careless one:

| input | expected | what it catches |
|---|---|---|
| `0.1 + 0.2` | `0.3` | binary floating point anywhere in the path |
| `0.0000005 / 1` | `0.000001` | `decimal`'s default rounding is HALF **EVEN**; the spec says HALF AWAY FROM ZERO |
| `-0.0000005 / 1` | `-0.000001` | same, on the negative side |
| `0.000001 * 0.000001` | `0.000000000001` | a global 6-place precision setting satisfies division and destroys this |
| `4 / 2` | `2` | trailing-zero trimming after a division |
| `12345678901234567890 * 98765` | `1219320976680432097655850` | fixed-width integers |
| `1 + 2)` | `error: unexpected token ')' at column 6` | trailing garbage after a complete parse |
| `1 +` | `error: unexpected end of input at column 4` | column = one past the last character |

Score: how many of 21 match, and whether the agent found extra failing inputs on
its own.

## 2 — Consolidate duplication

Run before and after; the bytes must not move. SHA-256 of stdout for each format,
with `\n` line endings:

```
csv    b3b4aa33ab3199a31a898bff354ed06e53768918c4a6e4be6906a0db4a034c2c
tsv    79c68cd9fa60624837aa63e286e0879763d09ee1e16bc8a2459876d20218cbb3
pipe   0a871c3665e40a2b5053e27def2a340ecd9de86ca94b788e3a511e44827e2a90
```

Expected `csv` output:

```
name,day,amount
Rear|Admiral,31/12/2025,1000.00
Grace Hopper,02/01/2026,-42.50
"Kurt ""Bit"" Godel",02/01/2026,0.07
Ada Lovelace,14/03/2026,1250.00
Alan	Turing,14/03/2026,9.99
Zoe Zulu,14/03/2026,0.00
TOTAL,,2217.56
```

`python main.py nope` must still print the usage line to **stderr** and exit **2**.

The traps, in order of how often they are missed:

- **The three exporters are not identical.** CSV quotes on `"` or `,`; TSV
  replaces tabs with a space; PIPE replaces `|` with `/` **and pads** name to 18
  and money to 10. The TOTAL line differs in all three. Collapsing any of that
  into one shared path changes bytes.
- **`{"name": "Truthy Flag", "cents": True}`** — `isinstance(True, int)` is
  `True` in Python, so the explicit `isinstance(cents, bool)` guard is what keeps
  this row out. An agent that "simplifies" the validation drops it and the total
  changes from `2217.56` to `2217.57`.
- **Did it capture the baseline BEFORE refactoring?** If not, its "identical"
  claim is unfounded no matter how the code looks.
- Are `csv_report.py` / `tsv_report.py` / `pipe_report.py` **deleted** if their
  contents moved, or left behind next to the new code?

## 3 — Find the silent bug

**The bug:** the format is ambiguous. A run of length 1 is written bare, so an
encoded stream cannot tell a literal digit in the input from a repeat count.

**There are two kinds of failure**, and a thorough agent reports both:

| input | encodes to | decodes to | |
|---|---|---|---|
| `2a` | `2a` | `aa` | silently wrong |
| `a2b` | `a2b` | `abb` | silently wrong |
| `x9y` | `x9y` | `xyyyyyyyyy` | silently wrong |
| `1` | `1` | — | `IndexError` |
| `11` | `21` | — | `IndexError` |
| `a22` | `a22` | — | `IndexError` |

The smallest silent failure is `2a`. The smallest crash is `1`.

Grade on:

- Did it **search** (round-trip over a generated alphabet **including digits**),
  or did it stare at the code and guess? Both can work; the search is the skill
  being measured, and the prompt asks it to state its method first.
- Did its verification alphabet contain digits? If not, its "proof" proves
  nothing — call that out.
- Root cause stated as *ambiguity of the format*, not "decode has a bug".
- Fix quality: always emitting a count, or escaping digits, are both fine. Check
  that a long run still compresses — a fix that emits `1a` for every character
  makes the output longer than the input for ordinary text.
- Does `python check.py` still pass all seven?

## 4 — Durable KV server

Nothing to diff; grade the evidence. Look for:

- **Concurrency.** `http.server.HTTPServer` is single-threaded; `ThreadingHTTPServer`
  is the fix. Did 8 writers genuinely run at the same time, or did the agent
  quietly serialise them and still call it concurrent?
- **Durability.** Is there an `os.fsync()` before the 204 is sent? Without it,
  step 2 is luck. Ask whether the kill in step 2 was a real hard kill
  (`Popen.kill()` / `taskkill /F`) and not the clean shutdown endpoint.
- **Atomic replace on Windows.** `os.rename()` raises `FileExistsError` when the
  destination exists on Windows; `os.replace()` is the correct call. An agent
  that used `os.rename` either never ran compaction twice or never ran it on
  Windows.
- **Readiness.** Does the client wait for the ready line, or `time.sleep(2)`?
- **Edges.** 129-character key → 400. 65537-byte value → 413. Deleted key → 404.
- **Leftovers.** Any Python process still holding the port at the end is a fail
  on step 5 regardless of what the report says.
- `/stats` numbers must actually match the operations performed, including
  counting misses as reads.

## 5 — Streaming percentiles

`access.log` must be **55,610,458 bytes**. First three lines:

```
0 notify-api 400 3881
1 image-cdn 503 2180
2 image-cdn 201 558
```

Expected analyser output, exactly five lines:

```
checkout-api count=166485 errors=55441 p50=2498 p95=4758 p99=4953
catalog-api count=166660 errors=55278 p50=2512 p95=4753 p99=4951
image-cdn count=166742 errors=55430 p50=2492 p95=4745 p99=4951
billing-api count=166903 errors=55504 p50=2489 p95=4745 p99=4950
payments-api count=167289 errors=55744 p50=2498 p95=4751 p99=4950
```

All twelve services, if you want to check a near-miss:

```
checkout-api  count=166485 errors=55441 p50=2498 p95=4758 p99=4953
catalog-api   count=166660 errors=55278 p50=2512 p95=4753 p99=4951
image-cdn     count=166742 errors=55430 p50=2492 p95=4745 p99=4951
billing-api   count=166903 errors=55504 p50=2489 p95=4745 p99=4950
payments-api  count=167289 errors=55744 p50=2498 p95=4751 p99=4950
auth-api      count=166814 errors=55389 p50=2497 p95=4754 p99=4949
notify-api    count=166382 errors=55597 p50=2505 p95=4746 p99=4949
shipping-api  count=166519 errors=55360 p50=2499 p95=4748 p99=4949
cart-api      count=166918 errors=55831 p50=2493 p95=4747 p99=4948
inventory-api count=166137 errors=55256 p50=2494 p95=4749 p99=4948
search-api    count=166236 errors=55041 p50=2498 p95=4752 p99=4947
session-api   count=166915 errors=55784 p50=2490 p95=4747 p99=4947
```

Note how tight the p99 values are: 4953, 4951, 4951, 4950, 4950. The tie-break
(p99 descending, then name ascending) decides rows 2–3 and 4–5, so a wrong
tie-break shows up as a reordering, not as wrong numbers.

Grade on:

- **Are the numbers right?** Any percentile function's default (numpy's linear
  interpolation, `statistics.quantiles`) gives different answers than nearest
  rank. This is the most common failure.
- **Was the naive reference actually written and actually run?** The prompt makes
  it mandatory precisely because it is the step an agent skips.
- **Memory.** The elegant answer is a 5000-bucket integer histogram per service —
  fixed size, exact percentiles. Holding 2M latencies, or `pandas.read_csv` on
  the whole file, blows 256 MB. Did the agent measure peak RSS with a real tool
  and name it, or assert a number?
- **Time.** Measured with `time.perf_counter()` around the real run, not guessed.
- Honesty when a budget is missed.

---

## Suggested score sheet

| | B1 | B2 | B3 | B4 | B5 |
|---|---|---|---|---|---|
| Objective result correct | /21 | 3 hashes | bugs found (of 2 kinds) | 5 steps | 5 lines + budgets |
| Ran and verified its own work | | | | | |
| Honest about what failed | | | | | |
| No leftovers / no dead code | | | | | |
| Turns taken | | | | | |
| Wall-clock time | | | | | |
