# MAGENTRA on Terminal-Bench 2.0 — GLM-5 (DeepInfra)

**36 / 89 = 40.4%**

This is the leaderboard-comparable score: the denominator is the whole
suite, and every task not run or not scored counts as 0.

Subset over the 86 tasks actually run: 36 / 86 = 41.9% — **not** leaderboard-comparable.

## Configuration

| | |
|---|---|
| Model | `zai-org/GLM-5` |
| Endpoint | `https://api.deepinfra.com/v1/openai` |
| Precision | fp4 (DeepInfra's served quantization) |
| Context window | 202,752 (the model's real window) |
| Trials per task | k = 1 |
| Engine | MAGENTRA 0.17.3 @ `5e5bf52` |
| Dataset | `terminal-bench/terminal-bench-2` |
| Run started | 2026-08-10T23:11:25.2604820+03:00 |

The engine is the shipped bundle, driven over its normal NDJSON protocol.
The adapter configures only: model/key/endpoint, `clarify: false` (an
unattended benchmark has no user to interview), `contextWindow`, and
OVERDRIVE. Prompts, tools, knowledge graph, reuse gate, permission engine
and turn caps are stock.

## Comparison

| Agent | Model | Score |
|---|---|---|
| **MAGENTRA** | GLM-5 (fp4) | **40.4%** |
| Terminus 2 | GLM 5 | 52.4% ±2.6 |

At k=1 over 89 tasks the binomial standard error on this score is
±5.2 points, and a single task is worth 1.12 points. Differences
smaller than roughly twice that error are not distinguishable from noise;
separating two harnesses confidently needs k>1 or a wider gap.

3 tasks require reading content out of pixels and no vision
endpoint was configured in the container, so they can only score 0. They
are counted as 0 above; the ceiling for this run is 86/89 = 96.6%.

## Cost

- Input tokens: 42,831,456 total — 1,325,984 fresh + 41,505,472 cached (96.9% served from cache)
- Output tokens: 637,508
- Estimated spend at $0.6 / $0.12 cached / $2.08 per Mtok: **$7.10**

Cost is estimated, not billed: cache *writes* are counted with cache
reads and priced at the cached rate, because DeepInfra publishes no
separate write rate and returned a null write count on probe.

## Failure analysis

Of 86 scored tasks, **22 hit the per-task time
wall** (26%) and scored 0 without ever
reaching the verifier. These are not capability failures — the agent was
still working when Harbor killed it — but they are scored as losses, which
is the correct benchmark convention. They are also invisible in the token
totals above: the driver writes its usage file on clean exit only, so work
done inside a timed-out trial is unrecorded and the real spend is higher
than the estimate.

Timed out: `break-filter-js-from-html`, `caffe-cifar-10`, `circuit-fibsqrt`, `compile-compcert`, `dna-assembly`, `feal-differential-cryptanalysis`, `feal-linear-cryptanalysis`, `fix-code-vulnerability`, `gpt2-codegolf`, `llm-inference-batching-scheduler`, `make-doom-for-mips`, `make-mips-interpreter`, `model-extraction-relu-logits`, `overfull-hbox`, `path-tracing`, `polyglot-rust-c`, `protein-assembly`, `regex-chess`, `regex-log`, `torch-pipeline-parallelism`, `torch-tensor-parallelism`, `tune-mjcf`

**1 task(s) failed for a reason other than the clock.**
These are infrastructure or agent failures rather than benchmark
outcomes — the task was never genuinely attempted and lost:

- `train-fasttext` — engine/agent error

## Per-task results

| task | reward | in | cached | out |
|---|---|---|---|---|
| adaptive-rejection-sampler | 0 | 22,107 | 705,408 | 14,241 |
| bn-fit-modify | **1** | 28,244 | 558,176 | 10,811 |
| break-filter-js-from-html | 0 | 0 | 0 | 0 |
| build-cython-ext | 0 | 39,426 | 2,633,824 | 11,866 |
| build-pmars | **1** | 22,799 | 590,112 | 3,651 |
| build-pov-ray | **1** | 55,246 | 903,936 | 7,921 |
| caffe-cifar-10 | 0 | 0 | 0 | 0 |
| cancel-async-tasks | **1** | 2,572 | 87,872 | 2,084 |
| circuit-fibsqrt | 0 | 0 | 0 | 0 |
| cobol-modernization | **1** | 14,055 | 994,400 | 18,211 |
| compile-compcert | 0 | 0 | 0 | 0 |
| configure-git-webserver | **1** | 10,919 | 440,640 | 2,684 |
| constraints-scheduling | **1** | 5,307 | 159,808 | 20,370 |
| count-dataset-tokens | **1** | 17,595 | 183,712 | 4,701 |
| crack-7z-hash | **1** | 20,460 | 701,760 | 3,100 |
| custom-memory-heap-crash | **1** | 35,844 | 1,781,152 | 52,044 |
| db-wal-recovery | 0 | 35,404 | 931,936 | 18,277 |
| distribution-search | **1** | 34,797 | 380,992 | 26,520 |
| dna-assembly | 0 | 0 | 0 | 0 |
| dna-insert | 0 | 12,764 | 530,432 | 19,118 |
| extract-elf | 0 | 34,966 | 593,248 | 9,645 |
| feal-differential-cryptanalysis | 0 | 0 | 0 | 0 |
| feal-linear-cryptanalysis | 0 | 0 | 0 | 0 |
| filter-js-from-html | 0 | 4,356 | 185,920 | 17,055 |
| financial-document-processor | 0 | 4,485 | 94,752 | 3,212 |
| fix-code-vulnerability | 0 | 0 | 0 | 0 |
| fix-git | **1** | 2,394 | 98,624 | 1,384 |
| fix-ocaml-gc | **1** | 55,397 | 2,314,016 | 35,930 |
| gcode-to-text | 0 | 40,966 | 435,552 | 2,790 |
| git-leak-recovery | **1** | 2,573 | 178,624 | 2,101 |
| git-multibranch | **1** | 27,491 | 713,856 | 4,474 |
| gpt2-codegolf | 0 | 0 | 0 | 0 |
| headless-terminal | **1** | 16,650 | 118,336 | 3,498 |
| hf-model-inference | **1** | 16,167 | 200,800 | 2,900 |
| install-windows-3-11 | 0 | 17,272 | 409,504 | 4,403 |
| kv-store-grpc | 0 | 22,323 | 337,088 | 3,431 |
| large-scale-text-editing | **1** | 4,246 | 126,592 | 14,931 |
| largest-eigenval | 0 | 16,838 | 538,912 | 12,658 |
| llm-inference-batching-scheduler | 0 | 0 | 0 | 0 |
| log-summary-date-ranges | **1** | 25,473 | 217,248 | 2,327 |
| mailman | **1** | 24,278 | 860,480 | 7,581 |
| make-doom-for-mips | 0 | 0 | 0 | 0 |
| make-mips-interpreter | 0 | 0 | 0 | 0 |
| mcmc-sampling-stan | **1** | 14,793 | 434,848 | 3,732 |
| merge-diff-arc-agi-task | **1** | 18,326 | 719,680 | 12,157 |
| model-extraction-relu-logits | 0 | 0 | 0 | 0 |
| modernize-scientific-stack | **1** | 3,952 | 108,352 | 2,400 |
| mteb-leaderboard | 0 | 3,226 | 87,904 | 2,594 |
| mteb-retrieve | 0 | 5,002 | 212,320 | 3,518 |
| multi-source-data-merger | **1** | 7,916 | 233,344 | 4,891 |
| nginx-request-logging | **1** | 6,577 | 203,296 | 2,379 |
| openssl-selfsigned-cert | 0 | 3,594 | 155,968 | 2,165 |
| overfull-hbox | 0 | 17,676 | 932,864 | 15,584 |
| password-recovery | **1** | 8,967 | 429,536 | 6,544 |
| path-tracing | 0 | 0 | 0 | 0 |
| path-tracing-reverse | 0 | 107,249 | 4,929,216 | 30,769 |
| polyglot-c-py | 0 | 1,908 | 135,584 | 5,530 |
| polyglot-rust-c | 0 | 0 | 0 | 0 |
| portfolio-optimization | **1** | 6,889 | 189,600 | 3,144 |
| protein-assembly | 0 | 0 | 0 | 0 |
| prove-plus-comm | **1** | 2,107 | 134,816 | 2,360 |
| pypi-server | 0 | 5,881 | 289,504 | 2,501 |
| pytorch-model-cli | 0 | 11,660 | 512,224 | 10,064 |
| pytorch-model-recovery | **1** | 10,019 | 299,136 | 7,484 |
| qemu-alpine-ssh | **1** | 14,193 | 859,648 | 8,685 |
| qemu-startup | 0 | 1,612 | 147,360 | 1,592 |
| query-optimize | 0 | 5,631 | 227,840 | 7,374 |
| raman-fitting | 0 | 80,235 | 992,960 | 8,469 |
| regex-chess | 0 | 0 | 0 | 0 |
| regex-log | 0 | 0 | 0 | 0 |
| reshard-c4-data | **1** | 24,256 | 1,046,848 | 10,934 |
| rstan-to-pystan | **1** | 32,769 | 1,133,056 | 7,293 |
| sam-cell-seg | 0 | 38,057 | 890,656 | 13,099 |
| sanitize-git-repo | 0 | 96,646 | 1,578,816 | 7,611 |
| schemelike-metacircular-eval | 0 | 57,405 | 4,551,136 | 50,716 |
| sparql-university | **1** | 6,276 | 57,568 | 16,169 |
| sqlite-db-truncate | **1** | 5,896 | 151,168 | 4,893 |
| sqlite-with-gcov | **1** | 6,058 | 272,160 | 1,777 |
| torch-pipeline-parallelism | 0 | 0 | 0 | 0 |
| torch-tensor-parallelism | 0 | 2,220 | 23,264 | 16,104 |
| train-fasttext | 0 | 0 | 0 | 0 |
| tune-mjcf | 0 | 0 | 0 | 0 |
| video-processing | 0 | 32,034 | 243,520 | 14,676 |
| vulnerable-secret | **1** | 13,540 | 313,568 | 6,381 |
| winning-avg-corewars | 0 | 0 | 0 | 0 |
| write-compressor | 0 | 0 | 0 | 0 |

Generated from `ledger.json` by `make-results-md.py` — no hand-entered scores.
