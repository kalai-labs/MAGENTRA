# MAGENTRA on Terminal-Bench 2.0 — GLM-5 (DeepInfra)

**34 / 89 = 38.2%**

This is the leaderboard-comparable score: the denominator is the whole
suite, and every task not run or not scored counts as 0.

Subset over the 84 tasks actually run: 34 / 84 = 40.5% — **not** leaderboard-comparable.

## Configuration

| | |
|---|---|
| Model | `deepinfra/zai-org/GLM-5` |
| Endpoint | `https://api.deepinfra.com/v1/openai` |
| Precision | fp4 (DeepInfra), identical to the MAGENTRA run |
| Context window | not set (Terminus manages its own context) |
| Trials per task | k = 1 |
| Engine | MAGENTRA 0.17.3 @ `5e5bf52` |
| Dataset | `terminal-bench/terminal-bench-2` |
| Run started | 2026-08-11T19:41:20.6267460+03:00 |

The engine is the shipped bundle, driven over its normal NDJSON protocol.
The adapter configures only: model/key/endpoint, `clarify: false` (an
unattended benchmark has no user to interview), `contextWindow`, and
OVERDRIVE. Prompts, tools, knowledge graph, reuse gate, permission engine
and turn caps are stock.

## Comparison

| Agent | Model | Score |
|---|---|---|
| **MAGENTRA** | GLM-5 (fp4) | **38.2%** |
| Terminus 2 | GLM 5 | 52.4% ±2.6 |

At k=1 over 89 tasks the binomial standard error on this score is
±5.2 points, and a single task is worth 1.12 points. Differences
smaller than roughly twice that error are not distinguishable from noise;
separating two harnesses confidently needs k>1 or a wider gap.

3 tasks require reading content out of pixels and no vision
endpoint was configured in the container, so they can only score 0. They
are counted as 0 above; the ceiling for this run is 86/89 = 96.6%.

## Cost

- Input tokens: 0 total — 0 fresh + 0 cached (0.0% served from cache)
- Output tokens: 0
- Estimated spend at $0.6 / $0.12 cached / $2.08 per Mtok: **$0.00**

Cost is estimated, not billed: cache *writes* are counted with cache
reads and priced at the cached rate, because DeepInfra publishes no
separate write rate and returned a null write count on probe.

## Failure analysis

Of 84 scored tasks, **26 hit the per-task time
wall** (31%) and scored 0 without ever
reaching the verifier. These are not capability failures — the agent was
still working when Harbor killed it — but they are scored as losses, which
is the correct benchmark convention. They are also invisible in the token
totals above: the driver writes its usage file on clean exit only, so work
done inside a timed-out trial is unrecorded and the real spend is higher
than the estimate.

Timed out: `build-cython-ext`, `caffe-cifar-10`, `circuit-fibsqrt`, `compile-compcert`, `custom-memory-heap-crash`, `db-wal-recovery`, `dna-assembly`, `feal-differential-cryptanalysis`, `feal-linear-cryptanalysis`, `fix-ocaml-gc`, `gcode-to-text`, `gpt2-codegolf`, `largest-eigenval`, `make-doom-for-mips`, `make-mips-interpreter`, `model-extraction-relu-logits`, `password-recovery`, `path-tracing`, `path-tracing-reverse`, `polyglot-rust-c`, `protein-assembly`, `regex-chess`, `schemelike-metacircular-eval`, `train-fasttext`, `tune-mjcf`, `write-compressor`

**2 task(s) failed for a reason other than the clock.**
These are infrastructure or agent failures rather than benchmark
outcomes — the task was never genuinely attempted and lost:

- `qemu-alpine-ssh` — tmux session failed to start
- `qemu-startup` — tmux session failed to start

## Per-task results

| task | reward | in | cached | out |
|---|---|---|---|---|
| adaptive-rejection-sampler | 0 | 0 | 0 | 0 |
| bn-fit-modify | 0 | 0 | 0 | 0 |
| break-filter-js-from-html | **1** | 0 | 0 | 0 |
| build-cython-ext | 0 | 0 | 0 | 0 |
| build-pmars | **1** | 0 | 0 | 0 |
| build-pov-ray | 0 | 0 | 0 | 0 |
| caffe-cifar-10 | 0 | 0 | 0 | 0 |
| cancel-async-tasks | **1** | 0 | 0 | 0 |
| circuit-fibsqrt | 0 | 0 | 0 | 0 |
| cobol-modernization | **1** | 0 | 0 | 0 |
| compile-compcert | 0 | 0 | 0 | 0 |
| configure-git-webserver | 0 | 0 | 0 | 0 |
| constraints-scheduling | **1** | 0 | 0 | 0 |
| count-dataset-tokens | **1** | 0 | 0 | 0 |
| crack-7z-hash | **1** | 0 | 0 | 0 |
| custom-memory-heap-crash | 0 | 0 | 0 | 0 |
| db-wal-recovery | 0 | 0 | 0 | 0 |
| distribution-search | **1** | 0 | 0 | 0 |
| dna-assembly | 0 | 0 | 0 | 0 |
| dna-insert | 0 | 0 | 0 | 0 |
| extract-elf | **1** | 0 | 0 | 0 |
| feal-differential-cryptanalysis | 0 | 0 | 0 | 0 |
| feal-linear-cryptanalysis | 0 | 0 | 0 | 0 |
| filter-js-from-html | 0 | 0 | 0 | 0 |
| financial-document-processor | 0 | 0 | 0 | 0 |
| fix-code-vulnerability | **1** | 0 | 0 | 0 |
| fix-git | **1** | 0 | 0 | 0 |
| fix-ocaml-gc | 0 | 0 | 0 | 0 |
| gcode-to-text | 0 | 0 | 0 | 0 |
| git-leak-recovery | **1** | 0 | 0 | 0 |
| git-multibranch | **1** | 0 | 0 | 0 |
| gpt2-codegolf | 0 | 0 | 0 | 0 |
| headless-terminal | **1** | 0 | 0 | 0 |
| hf-model-inference | **1** | 0 | 0 | 0 |
| install-windows-3-11 | 0 | 0 | 0 | 0 |
| kv-store-grpc | **1** | 0 | 0 | 0 |
| large-scale-text-editing | **1** | 0 | 0 | 0 |
| largest-eigenval | 0 | 0 | 0 | 0 |
| llm-inference-batching-scheduler | **1** | 0 | 0 | 0 |
| log-summary-date-ranges | **1** | 0 | 0 | 0 |
| mailman | **1** | 0 | 0 | 0 |
| make-doom-for-mips | 0 | 0 | 0 | 0 |
| make-mips-interpreter | 0 | 0 | 0 | 0 |
| mcmc-sampling-stan | **1** | 0 | 0 | 0 |
| merge-diff-arc-agi-task | **1** | 0 | 0 | 0 |
| model-extraction-relu-logits | **1** | 0 | 0 | 0 |
| modernize-scientific-stack | **1** | 0 | 0 | 0 |
| mteb-leaderboard | 0 | 0 | 0 | 0 |
| mteb-retrieve | 0 | 0 | 0 | 0 |
| multi-source-data-merger | **1** | 0 | 0 | 0 |
| nginx-request-logging | **1** | 0 | 0 | 0 |
| openssl-selfsigned-cert | 0 | 0 | 0 | 0 |
| overfull-hbox | 0 | 0 | 0 | 0 |
| password-recovery | 0 | 0 | 0 | 0 |
| path-tracing | 0 | 0 | 0 | 0 |
| path-tracing-reverse | 0 | 0 | 0 | 0 |
| polyglot-c-py | 0 | 0 | 0 | 0 |
| polyglot-rust-c | 0 | 0 | 0 | 0 |
| portfolio-optimization | **1** | 0 | 0 | 0 |
| protein-assembly | 0 | 0 | 0 | 0 |
| prove-plus-comm | **1** | 0 | 0 | 0 |
| pypi-server | **1** | 0 | 0 | 0 |
| pytorch-model-cli | **1** | 0 | 0 | 0 |
| pytorch-model-recovery | **1** | 0 | 0 | 0 |
| qemu-alpine-ssh | — | 0 | 0 | 0 |
| qemu-startup | — | 0 | 0 | 0 |
| query-optimize | **1** | 0 | 0 | 0 |
| raman-fitting | 0 | 0 | 0 | 0 |
| regex-chess | 0 | 0 | 0 | 0 |
| regex-log | 0 | 0 | 0 | 0 |
| reshard-c4-data | **1** | 0 | 0 | 0 |
| rstan-to-pystan | 0 | 0 | 0 | 0 |
| sam-cell-seg | 0 | 0 | 0 | 0 |
| sanitize-git-repo | 0 | 0 | 0 | 0 |
| schemelike-metacircular-eval | 0 | 0 | 0 | 0 |
| sparql-university | 0 | 0 | 0 | 0 |
| sqlite-db-truncate | **1** | 0 | 0 | 0 |
| sqlite-with-gcov | 0 | 0 | 0 | 0 |
| torch-pipeline-parallelism | 0 | 0 | 0 | 0 |
| torch-tensor-parallelism | 0 | 0 | 0 | 0 |
| train-fasttext | 0 | 0 | 0 | 0 |
| tune-mjcf | 0 | 0 | 0 | 0 |
| video-processing | 0 | 0 | 0 | 0 |
| vulnerable-secret | 0 | 0 | 0 | 0 |
| winning-avg-corewars | 0 | 0 | 0 | 0 |
| write-compressor | 0 | 0 | 0 | 0 |

Generated from `ledger.json` by `make-results-md.py` — no hand-entered scores.
