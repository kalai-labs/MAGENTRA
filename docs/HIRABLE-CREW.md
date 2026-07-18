# The Hirable Crew — portable AI employees

Magentra crew members are not prompt files. They are **employees**: they learn from verified work,
carry a tamper-evident service record, and can be exported, moved between projects, or handed to
another user — arriving with their knowledge and their CV intact.

This document covers the three subsystems and the commands.

## 1. Experience — how a member learns (probation → promotion)

Every crew member accumulates **lessons** at `.magentra/team/experience/<id>.json`. The pipeline
is deliberately conservative — the danger with agent memory is not learning too little, it is a
weak model writing wrong lessons into its own durable memory and compounding:

1. **Capture.** When the orchestrator marks a member-owned task *completed* (the verified moment),
   a one-shot small-model call distills at most **2 candidate lessons** from the member's report.
   Each must pass structural validators: ≤ 300 chars, no secrets, no machine paths, not a
   near-duplicate, not narration. Anything failing is dropped silently.
2. **Probation.** Candidates ride along on the member's later runs, marked `(unproven)`. A run
   whose task completes **confirms** them; a bounce (the same task re-dispatched after failed
   verification) **contradicts** them.
3. **Promotion.** 3 confirmations across ≥ 2 distinct tasks with zero contradictions → the lesson
   becomes durable, injected first on every run.
4. **Retirement.** 2 contradictions retire a lesson — promoted or not. Wrong knowledge is
   evictable; retired lessons never travel in an export.

Lessons carry a **scope**: `general` (true anywhere), `stack:<tag>` (true for a technology), or
`project` (true only in this repo). Scope decides how a lesson transfers when the member is hired
elsewhere.

## 2. Service record — the CV

Append-only, hash-chained JSONL at `.magentra/team/experience/<id>.record.jsonl`. Events:
`created`, `task_completed` (with the **model** that earned it), `task_bounced`,
`lesson_promoted`, `lesson_retired`, `exported`, `hired`.

Each entry's hash covers its content and links to the previous hash, so any receiver can verify
the history is internally consistent and unmodified since export. Honest scope: **tamper-evident,
not forge-proof** — the manifest reserves a `signature` field for future key-based attestation.
Records name projects by folder basename only; full paths never leave the machine.

## 3. Crew packs — export and hire

A member serializes to a single portable JSON file: `<id>.crewpack.json` — definition, its docs
(contents travel, not references), the built backpack (BM25 + embeddings arrive ready — nothing
is re-paid on import), surviving lessons, and the service record.

### Export

```
/crew export <id> [dest-dir]
/crew export <id> redact        # mask findings instead of refusing
```

Export **fails closed**: every surface is scanned for secret-shaped strings (API keys, tokens,
PEM blocks) and machine paths. Findings are listed and the export refuses unless `redact` is
given, which masks them with `[REDACTED]` and proceeds.

### Hire

```
/crew hire <path-to-crewpack> [as <new-id>]
```

Hiring validates everything before writing anything: schema, every content hash, the record
chain, path traversal. Then it materializes docs under `.magentra/team/docs/<id>/`, rewrites the
member's `docs:` list, installs the backpack (embedding-model mismatch → embeddings dropped,
BM25 keeps working), imports lessons, and appends a `hired` event continuing the chain.

**Imported knowledge does not arrive with unearned trust.** Default policy (`reprobation`): every
imported lesson re-enters probation as a candidate with reset counters — it must re-earn
promotion on *your* verified tasks. `project`-scoped lessons *always* re-earn, under any policy
(what was true in project A may be false in project B). The record keeps the full history either
way. Advisory fields (model hint, tool list) are validated against your setup, never trusted.

### Inspect

```
/crew                 # roster + readiness + record summary per member
/crew record <id>     # the service record, verified
/crew lessons <id>    # the experience ledger by status
```

## Format notes

- Team files, mode/style files, lessons, records, packs: all plain markdown/JSON/JSONL — readable,
  diffable, editable with any editor. Style files load from `.magentra/modes/*.md` (canonical) and
  the same `.md` skill format.
- The pack format version is `crewpack: 1`; unknown future fields are preserved on round-trip.
