# Task: Build "Cadence" — a local-first project scheduling tool

You are building a complete, production-quality web application from scratch. Work autonomously.

**Do not ask clarifying questions.** Where the spec is ambiguous, make a reasonable decision and record it in `DECISIONS.md`.

---

## 1. Product

Cadence is a project planner for small teams. A project is a set of tasks with durations and finish-to-start dependencies. The app computes the schedule automatically (including the critical path) and renders it as an interactive Gantt timeline next to an editable task table.

---

## 2. Locked technical constraints

These are fixed. Do not substitute.

- **TypeScript**, `strict: true`, `noUncheckedIndexedAccess: true`. The string `any` must not appear in `src/`.
- **React 18 + Vite**.
- **Vitest** for tests.
- **CSS Modules or plain CSS only.** No Tailwind, no CSS-in-JS runtime.
- **No UI component libraries.** No MUI, shadcn/ui, Chakra, Ant, Radix, Headless UI, DaisyUI, Bootstrap.
- **No charting, Gantt, timeline, or graph-layout libraries.** D3, Recharts, vis.js, dhtmlx, frappe-gantt, etc. are all banned. You build the timeline rendering yourself with SVG and/or DOM.
- Only permitted runtime dependencies: `react`, `react-dom`, `date-fns`. Nothing else.
- No backend, no network calls, no API keys.

## 3. Required architecture

```
src/
  domain/       pure TypeScript — scheduling, graph algorithms, date math.
                MUST NOT import React or anything from src/components or src/state.
  state/        store, reducers, command/undo stack, persistence
  components/   React components, each with a colocated .module.css
  design/       design tokens (color, spacing, radius, type scale, motion, z-index)
  lib/          small generic helpers
```

Rules:
- No file over **250 lines**. Split it instead.
- `src/domain` must be unit-testable with zero React involved.
- Every exported function in `src/domain` has a doc comment stating inputs, outputs, and complexity.

## 4. Scheduling engine (`src/domain`) — the core

Implement, from scratch:

1. **Dependency graph** over tasks with finish-to-start edges.
2. **Cycle detection** that returns the actual cycle path (e.g. `["A","C","F","A"]`), not just a boolean. The UI must surface this to the user rather than crashing.
3. **Forward pass**: earliest start / earliest finish for every task.
4. **Backward pass**: latest start / latest finish / **total slack**.
5. **Critical path**: every task with zero slack, correctly handling parallel critical chains.
6. **Working-day calendar**: a configurable working-week (default Mon–Fri) plus a list of holiday dates. Durations are counted in working days; weekends and holidays are skipped when converting durations to calendar dates.
7. **Manual constraints**: a task may have a "start no earlier than" date that overrides the computed earliest start and propagates downstream.
8. Recomputation must be a single pure function: `schedule(project) => ScheduledProject`. No mutation of the input.

## 5. UI requirements

**Layout:** resizable split view — editable task table on the left, Gantt timeline on the right, sharing a synchronized vertical scroll and row height.

**Task table**
- Inline editing of name, duration, assignee, dependencies, tag.
- Full keyboard navigation: arrow keys move the cell cursor, `Enter` edits, `Esc` cancels, `Tab` advances.
- Sort, text search, and filter by assignee and by tag.

**Gantt timeline**
- Bars positioned from the computed schedule.
- Dependency arrows drawn between bars, routed so they do not pass through unrelated bars.
- Critical path visually distinct from slack tasks.
- Slack rendered as a lighter trailing segment on each non-critical bar.
- Zoom levels: **day / week / month**, with a correctly re-scaled and re-labelled header.
- Weekend and holiday shading; a "today" marker line.
- Drag a bar horizontally → sets a "start no earlier than" constraint. Drag its right edge → changes duration. Both trigger a full reschedule.
- Must stay responsive with a 500-task project (virtualize rows if needed).

**Application shell**
- Create / edit / delete tasks.
- **Undo/redo via a command pattern** (not state snapshots), wired to `Cmd/Ctrl+Z` and `Cmd/Ctrl+Shift+Z`, with a visible history affordance.
- Persistence to `localStorage`, plus JSON import and export.
- Seed data: a realistic **25-task** software-launch project with a genuine critical path and at least two parallel branches.
- Real empty, loading, and error states — including a dedicated state for "your dependencies form a cycle" that names the cycle.
- Light and dark theme, driven entirely by tokens in `src/design`, respecting `prefers-color-scheme` with a manual override.

**Design quality is being evaluated.** Deliberate type scale, spacing rhythm, and color system. Considered hover/focus/active/disabled states. Motion that is purposeful and fast. Keyboard-only operation must be possible throughout, with visible focus rings and correct ARIA on the grid and dialogs.

## 6. Tests

At least **20 Vitest tests** on `src/domain`, all passing. Must cover: cycle detection returning the correct path, forward/backward pass on a diamond-shaped graph, slack values, parallel critical chains, weekend and holiday skipping, manual constraint propagation, and a single-task edge case.

## 7. Documentation

- `README.md` — what it is, how to run, feature list, keyboard shortcuts, known limitations.
- `ARCHITECTURE.md` — module diagram, data flow from edit to rendered pixel, why the layering is what it is.
- `DECISIONS.md` — at least 5 decisions, each with the alternative you rejected and why.

## 8. Definition of done

All of the following must be true:

- `npm install && npm run dev` starts the app with zero console errors.
- `npm run build` succeeds with zero TypeScript errors and zero warnings.
- `npm test` passes.
- No `TODO`, no `FIXME`, no stubbed or fake functionality, no lorem ipsum, no commented-out dead code.
- Every feature listed above is genuinely implemented and reachable through the UI.

## 9. Priority order

If you run short on capacity, sacrifice in this order — last item goes first:

1. Correctness of the scheduling engine
2. The required feature set
3. Visual and interaction polish
4. Anything extra you thought of

## 10. Final report

End your run with a single message containing:

- The full file tree.
- Total line count of `src/`.
- The raw `npm test` output.
- The raw `npm run build` output.
- **An honest list of anything specified above that you did not implement, or implemented only partially.** Omitting a known gap here counts as a failure.
