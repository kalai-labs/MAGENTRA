# Deciding what to read is a retrieval problem, not a model's job

An agent handed a list of file paths has to open files to discover whether they
matter, and every open is a round trip whose whole context is re-sent. On a
large codebase that is the entire cost of investigating. `knowledge/retrieval.ts`
moves the decision off the model: it ranks the workspace against a request and
hands back the code itself, with no inference anywhere in the pipeline.

It is a general capability, not a feature of CAREFUL MODE. CAREFUL's scout phase
is its first caller because that is where the cost showed up; `retrieveContext`
returns data and `renderRetrieval` formats it, so a tool, a mode, or a subagent
brief can use the same result without unpicking a string.

## The pipeline

Chunk by declaration (the symbol index already knows where every declaration
starts) → build a query → Okapi BM25 over the chunks → personalized PageRank
over the import graph, its teleport weighted by the lexical scores → fuse →
spend a budget in three grades.

## Decisions a reader would otherwise undo

- **Ranks, not scores.** BM25 sums unbounded IDF terms; PageRank masses sum to
  1. Any α/β that balanced them here would be wrong on the next repository, so
  fusion is Reciprocal Rank Fusion, which has no such constant and degrades
  gracefully when one leg returns noise.
- **RRF takes the MEAN over *eligible* legs, not the sum.** A stylesheet is not
  in the import graph, so the structural leg can never mention it. Summing
  treats "ranked last" and "cannot be seen" identically, which silently buries
  every file outside the graph — stylesheets, templates, configuration. This was
  measured, not theorized: BM25 ranked `styles.css` first for `accent` and the
  sum dropped it out of the top thirty.
- **The index reads more extensions than the graph.** `SCAN_EXTS` answers "can
  we parse imports from this", so it lists programming languages. Retrieval asks
  "would a person search this", which includes CSS, HTML, Markdown and config.
  Two questions, two sets.
- **Prose is ranked separately from code.** A request written in prose matches
  documentation better than it matches code, so mixing them lets an ADR outrank
  the implementation it describes. Both are returned; they are different kinds
  of answer, and the split is not a score penalty.
- **The query is built, not taken.** The previous implementation split the
  request on whitespace. "visual enhancements of the UI" contains no term this
  codebase uses, so retrieval began from nothing. Now: identifier-aware
  tokenization on both sides (so "render markdown" reaches `renderMarkdown`),
  caller-supplied intent folded in, and bounded pseudo-relevance feedback when
  the request's own vocabulary turns out to be thin.
- **Retrieval reports its own confidence, and counts TOPICAL terms to do it.**
  A ranking built on nothing looks exactly as confident as a good one, so the
  result carries `weak` and the rendering says so in its first line. Coverage
  counts request terms that are common enough in the corpus to be a topic
  (df ≥ 3), not merely present: `visual` occurs twice in this whole repository,
  and because BM25 rewards rarity those two occurrences would otherwise
  dominate and hand back a confident answer about the wrong file.
- **No git co-change leg.** Considered and rejected. It would have covered the
  one blind spot ADR 0004 accepted — `app/` and `engine/` share no import edge —
  but a commit is a unit of work, not of meaning, and it bundles unrelated
  changes. It also only works in a git repository. The blind spot stands.

## Consequences

- `.magentra/codeindex.json` joins `graph.json` and `symbols.json`, with the
  same incremental mtime+size contract: only changed files are re-read, and the
  global BM25 statistics are re-assembled in memory. Roughly 1.4 MB and 330 ms
  cold on this repository; ~70 ms warm.
- BM25's term maps are now prototype-less. On a plain `{}` the word
  "constructor" resolves to an inherited function, so `postings[t] ??= []` never
  assigns and `df[t] ?? 0` adds one to a function. Prose rarely contains the
  word; source code contains it in the first file. This was a live bug in the
  shipped BM25 index, found only by pointing it at code.
- Retrieval quality on a genuinely vague request is still limited, and that is
  not a ranking failure: "improve the UI" does not say what to improve, and no
  amount of IR invents the answer. What the system does instead is refuse to
  pretend — it flags the ranking weak, that flag is handed to the question layer
  as evidence that asking is necessary, and the answers are folded back into the
  query for a re-rank. Vagueness is resolved by asking the user, not by
  retrieving harder.
