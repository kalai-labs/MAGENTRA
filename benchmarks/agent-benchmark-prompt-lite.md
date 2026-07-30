# Task: Build "Tincture" — a color system generator

Build a complete, small web app from scratch. Work autonomously.

**Do not ask clarifying questions.** Where the spec is ambiguous, decide and note it in the README.

**Keep it tight.** This is a deliberately small project: aim for roughly 900–1300 lines across 10–15 files. Do not gold-plate, do not add features beyond the spec, do not refactor more than once.

---

## 1. Product

The user enters one seed color. Tincture generates a full, accessible color system from it — tonal ramps, semantic colors, and a contrast matrix — and previews it live on a mock interface. The user can then export the system.

---

## 2. Locked constraints

- **TypeScript**, `strict: true`. The string `any` must not appear in `src/`.
- **React 18 + Vite**.
- **Vitest** for tests.
- **CSS Modules or plain CSS only.** No Tailwind, no CSS-in-JS.
- **No UI component libraries.** No MUI, shadcn, Radix, Chakra, Ant, Bootstrap.
- **No color libraries.** chroma.js, culori, colorjs.io, color2k, tinycolor are all banned — you write the color math yourself.
- Only permitted runtime dependencies: `react`, `react-dom`. Nothing else.
- No backend, no network calls.

## 3. Structure

```
src/
  color/        pure TypeScript color math — no React imports
  components/   React components + colocated .module.css
  design/       the app's own design tokens
```

`src/color` must be unit-testable with zero React involved. No file over 200 lines.

## 4. Color engine (`src/color`) — the skill check

Implement from scratch, no libraries:

1. **Conversions:** hex ⇄ sRGB ⇄ linear RGB ⇄ OKLab ⇄ OKLCH. Round-tripping a color must return it unchanged within a small epsilon.
2. **Gamut clamping:** an OKLCH color outside sRGB must be brought into gamut by reducing chroma while preserving lightness and hue — not by naively clipping RGB channels.
3. **Tonal ramp:** from the seed, produce 11 steps (`50, 100, 200 … 900, 950`) with perceptually even OKLCH lightness spacing and a chroma curve that peaks in the mid-tones and falls off at both ends.
4. **Neutral ramp:** 11 steps at very low chroma, subtly tinted toward the seed hue.
5. **Semantic ramps:** success / warning / danger, generated at fixed target hues but matched to the seed's chroma character, so they read as one family.
6. **WCAG 2.1 contrast ratio** between any two colors, computed from relative luminance.
7. **`bestTextOn(color)`** — returns the ramp step (not just black or white) that gives the highest contrast while staying in the family, and reports whether it clears AA (4.5) and AAA (7).

## 5. UI

- Seed input: hex field **and** a color picker, kept in sync, with invalid input handled gracefully.
- All ramps rendered as swatch rows. Each swatch shows its hex, its OKLCH values, and its contrast ratio against both white and black. Click to copy the hex.
- **Contrast matrix:** a grid of every ramp step against every other, each cell marked AA / AAA / fail. Must stay readable — this is a layout problem, solve it.
- **Live preview panel:** a mock interface recolored by the generated system — nav bar, card, primary and secondary buttons, a text input, a success toast, a danger alert, a piece of body copy. This is how the system proves it works.
- Light and dark mode, both driven by the generated ramps, with a toggle.
- Export as **CSS custom properties** and as **JSON**, copyable to clipboard.
- Seed color encoded in the URL hash so a system can be shared by link.

**Design quality is being evaluated.** The app itself must look considered — real type scale, real spacing rhythm, real hover/focus/active states, visible focus rings, purposeful and fast motion. A color tool that is itself ugly has failed the task.

## 6. Tests

**8–12 Vitest tests** on `src/color`, all passing. Must cover: hex→OKLCH→hex round-trip, gamut clamping of an out-of-gamut color, monotonically decreasing lightness across a ramp, a known contrast ratio (black on white = 21), and `bestTextOn` for both a very light and a very dark input.

## 7. Docs

`README.md` only — under 100 lines. What it is, how to run, the ramp-generation approach in a short paragraph, and 3 decisions you made with the alternative you rejected.

## 8. Definition of done

- `npm install && npm run dev` runs with zero console errors.
- `npm run build` succeeds with zero TypeScript errors.
- `npm test` passes.
- No `TODO`, no stubs, no lorem ipsum, no dead code.

## 9. Final report

End with one message containing: the file tree, total `src/` line count, raw `npm test` output, raw `npm run build` output, and **an honest list of anything you did not implement or implemented only partially.** Omitting a known gap counts as a failure.
