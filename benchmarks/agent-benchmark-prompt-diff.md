# Task: Build "Delta" — a text diff viewer

Build a complete, small web app from scratch. Work autonomously.

## Rules of engagement — read first

- **Do not ask clarifying questions.** Decide and move on.
- **Do not restate this spec back to me.** Do not write a plan longer than 5 lines.
- **Keep your chat output minimal.** Write code, not commentary. No progress essays, no per-file explanations, no summaries between steps.
- Target **700–1100 lines** across the file manifest below. Do not exceed it. Do not add features beyond the spec.
- Build it in one pass. Refactor at most once, at the end.

---

## 1. Product

Paste old text on the left, new text on the right. Delta computes a minimal diff and renders it as a proper code-review-quality diff view.

## 2. Locked constraints

- **TypeScript**, `strict: true`. `any` must not appear in `src/`.
- **React 18 + Vite**, **Vitest**.
- **CSS Modules only.** No Tailwind, no CSS-in-JS.
- **No UI component libraries.**
- **No diff libraries.** `diff`, `jsdiff`, `diff-match-patch`, `fast-diff`, `react-diff-viewer` are all banned. You implement the algorithm.
- Runtime dependencies permitted: `react`, `react-dom`. Nothing else.

## 3. File manifest

Build exactly this. No extra files.

```
src/
  diff/
    myers.ts          Myers O(ND) diff -> edit script
    words.ts          word-level intra-line diff
    hunks.ts          group into hunks with context
    patch.ts          serialize to unified diff format
    types.ts
    myers.test.ts
    hunks.test.ts
    patch.test.ts
  components/
    App.tsx
    InputPanes.tsx
    DiffView.tsx      renders both side-by-side and unified
    Toolbar.tsx
    (one .module.css colocated per component)
  design/tokens.css
  main.tsx
```

`src/diff/` must be pure TypeScript with zero React imports.

## 4. Diff engine — the skill check

1. **Myers O(ND) line diff.** Not a naive LCS table, not a line-by-line loop. Backtrack the trace to produce an actual minimal edit script of `equal | insert | delete` operations.
2. **Word-level diff.** For a delete-run immediately followed by an insert-run, pair the lines up and diff them by word so changed lines show inline highlights instead of whole-line replacement.
3. **Hunks.** Group changes with configurable context (0, 3, or 10 lines). Adjacent hunks whose contexts overlap must be merged into one.
4. **Unified patch output.** Emit valid `@@ -oldStart,oldCount +newStart,newCount @@` headers. The line-number math must be correct — this is the easiest thing in the task to get wrong.
5. **Ignore-whitespace mode** that affects equality comparison without changing what text is displayed.

## 5. UI

- Two input textareas, plus a "load sample" button with a realistic ~60-line before/after pair.
- **Side-by-side view:** aligned rows, line numbers on both sides, gutter markers, added/removed/changed row backgrounds, word-level highlights within changed rows.
- **Unified view:** single column, `+`/`−` prefixes, correct interleaving.
- Toggle between the two views. Toggle context size. Toggle ignore-whitespace.
- Unchanged regions between hunks collapse into a clickable "⋯ N unchanged lines" divider that expands.
- Stats bar: lines added, lines removed, hunk count.
- "Copy as patch" button producing the unified diff.
- Keyboard: `n` / `p` jump to next/previous hunk, scrolling it into view.
- Light and dark theme from `design/tokens.css`, with a toggle.

**Design is being evaluated.** Monospace type with a proper line height, a diff color scheme that works in both themes and stays legible for the red/green colorblind case (do not rely on hue alone — use the gutter markers too), aligned columns that never jitter, real hover and focus states. It should look like a tool a developer would actually want to use.

## 6. Tests

**10–14 Vitest tests**, all passing. Must cover: identical inputs produce zero changes, pure insertion, pure deletion, a known minimal edit script, hunk merging when contexts overlap, context clamped at file start and end, word-level diff on a single changed line, and correct `@@` header numbers for a hunk that is not at line 1.

## 7. Definition of done

- `npm install && npm run dev` runs with zero console errors.
- `npm run build` passes with zero TypeScript errors.
- `npm test` passes.
- No `TODO`, no stubs, no dead code.
- `README.md`, under 40 lines.

## 8. Final report — maximum 20 lines

File tree, `src/` line count, `npm test` result line, `npm run build` result line, and **an honest list of anything not implemented or only partially implemented.** Nothing else. Omitting a known gap counts as a failure.
