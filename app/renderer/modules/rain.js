// Matrix rain — the falling-glyph canvas behind the UI while the `matrix`
// theme is active. Loaded as a classic script in index.html, sharing the one
// renderer global scope like every other module.
//
// The canvas is mounted on demand and torn down the moment the theme changes,
// so the other two themes carry no idle canvas, no resize listener, and no
// animation frame. applyUiSettings() in state.js is the single caller.

"use strict";

/* global window, document, uiSettings */

// Katakana is what the film used; the digits and Latin caps are what a
// terminal contributes. Mixing them keeps the columns from looking like one
// repeating alphabet at a glance.
const RAIN_GLYPHS =
  "ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ:.=*+-<>";

const RAIN_FONT_PX = 16; // glyph cell size in CSS pixels
const RAIN_FRAME_MS = 55; // ~18fps — the film's cadence, and far cheaper than 60

let rainCanvas = null;
let rainCtx = null;
let rainColumns = []; // per column: the row index of its leading glyph
let rainTimerId = null;
let rainResizeBound = false;
// Canvas has no cascade, so the theme's colors are read out of the custom
// properties once per (re)size and cached here. Nothing in this file hardcodes
// a color — a future theme that reuses the rain gets it recolored for free.
let rainInk = { bg: "3, 7, 5", head: "233, 255, 241", trail: "37, 238, 107" };

/** A cheap deterministic-enough source; the rain never needs real entropy. */
function rainGlyph() {
  return RAIN_GLYPHS[Math.floor(Math.random() * RAIN_GLYPHS.length)];
}

// The canvas opacity at the top of the user's dial. The rain sits behind loose
// transcript text, so "full strength" is still well under 1 for legibility —
// the dial then scales this down toward invisible. Kept here rather than in the
// stylesheet because JS owns the canvas element entirely (CSS never sees it).
const RAIN_BASE_OPACITY = 0.38;

/** The user's rain dial as a 0..1 scalar. 1 is the shipped look, 0 hides the
 * rain outright. Anything missing or out of range reads as the full 1. */
function rainOpacityScalar() {
  if (typeof uiSettings !== "object" || !uiSettings) return 1;
  const value = Number(uiSettings.rainOpacity);
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

/** Push the current dial value onto the mounted canvas. Cheap enough to call on
 * every sync; the whole effect of the setting lives in this one line. */
function rainApplyOpacity() {
  if (rainCanvas) rainCanvas.style.opacity = String(RAIN_BASE_OPACITY * rainOpacityScalar());
}

/** True when the user has asked for stillness — either the app's own CALM
 * motion setting or the OS-level reduced-motion preference. The rain then
 * paints one static frame instead of animating, so the theme still reads as
 * itself without anything moving. */
function rainMotionStilled() {
  if (typeof uiSettings === "object" && uiSettings && uiSettings.motion === "calm") return true;
  return Boolean(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
}

/** Pull the active theme's background and accent out of the CSS custom
 * properties. Both are published as bare `r, g, b` channels for exactly this
 * kind of call site, so they drop straight into an rgb(). The bright head is
 * the accent walked most of the way to white rather than a fourth token —
 * one accent is all a theme has to define for the rain to work. */
function rainReadInk() {
  const css = getComputedStyle(document.documentElement);
  const channels = (name, fallback) => {
    const raw = css.getPropertyValue(name).trim();
    return /^\d+\s*,\s*\d+\s*,\s*\d+$/.test(raw) ? raw : fallback;
  };
  const bg = channels("--bg-rgb", "3, 7, 5");
  const trail = channels("--accent-rgb", "37, 238, 107");
  const head = trail
    .split(",")
    .map((n) => Math.round(Number(n) + (255 - Number(n)) * 0.78))
    .join(", ");
  rainInk = { bg, head, trail };
}

/** Size the backing store to the device pixel ratio and reseed the columns.
 * Called on mount and on every resize — the column count is width-derived. */
function rainResize() {
  if (!rainCanvas || !rainCtx) return;
  rainReadInk();
  const dpr = window.devicePixelRatio || 1;
  const w = window.innerWidth;
  const h = window.innerHeight;
  rainCanvas.width = Math.max(1, Math.floor(w * dpr));
  rainCanvas.height = Math.max(1, Math.floor(h * dpr));
  rainCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  rainCtx.font = `${RAIN_FONT_PX}px ${getComputedStyle(document.documentElement).getPropertyValue("--mono") || "monospace"}`;
  rainCtx.textBaseline = "top";

  const columnCount = Math.max(1, Math.ceil(w / RAIN_FONT_PX));
  const rowCount = Math.ceil(h / RAIN_FONT_PX);
  // Seed each column at a random height above the fold so the first frame
  // already looks mid-storm rather than like a curtain dropping in unison.
  rainColumns = Array.from({ length: columnCount }, () => Math.floor(Math.random() * -rowCount));

  // A resize wipes the backing store, so a stilled (CALM) rain has to repaint
  // its one frame now — nothing else will until the theme changes.
  if (rainMotionStilled()) rainPaintStill();
}

/** One static frame: a sparse field of dim glyphs, no trails, no motion.
 * Clears first, so switching FULL → CALM replaces the live trails rather than
 * freezing them under the new field. */
function rainPaintStill() {
  if (!rainCtx) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  const rowCount = Math.ceil(h / RAIN_FONT_PX);
  rainCtx.clearRect(0, 0, w, h);
  rainCtx.fillStyle = `rgba(${rainInk.trail}, 0.16)`;
  for (let col = 0; col < rainColumns.length; col += 1) {
    for (let row = 0; row < rowCount; row += 1) {
      // Sparse — a solid wall of glyphs would fight the UI for attention.
      if (Math.random() > 0.14) continue;
      rainCtx.fillText(rainGlyph(), col * RAIN_FONT_PX, row * RAIN_FONT_PX);
    }
  }
}

/** One animated frame: translucent black over the last frame leaves the trails,
 * then each column draws a bright leading glyph and steps down. */
function rainFrame() {
  if (!rainCtx) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  const rowCount = Math.ceil(h / RAIN_FONT_PX);

  // The fade is what makes the tails: each frame dims what came before by a
  // fixed amount rather than clearing, so a glyph decays over ~15 frames.
  rainCtx.fillStyle = `rgba(${rainInk.bg}, 0.09)`;
  rainCtx.fillRect(0, 0, w, h);

  for (let col = 0; col < rainColumns.length; col += 1) {
    const row = rainColumns[col];
    const x = col * RAIN_FONT_PX;
    const y = row * RAIN_FONT_PX;
    if (row >= 0 && y < h) {
      // Leading glyph is near-white, the one behind it full phosphor — the
      // two-tone head is what separates a matrix rain from green noise.
      rainCtx.fillStyle = `rgba(${rainInk.head}, 0.85)`;
      rainCtx.fillText(rainGlyph(), x, y);
      rainCtx.fillStyle = `rgba(${rainInk.trail}, 0.55)`;
      rainCtx.fillText(rainGlyph(), x, y - RAIN_FONT_PX);
    }
    // Recycle past the bottom, with a random restart so columns desynchronize
    // instead of falling into lockstep over time.
    rainColumns[col] = row > rowCount && Math.random() > 0.975 ? 0 : row + 1;
  }
}

function rainStartLoop() {
  if (rainTimerId !== null) return;
  rainTimerId = window.setInterval(rainFrame, RAIN_FRAME_MS);
}

function rainStopLoop() {
  if (rainTimerId === null) return;
  window.clearInterval(rainTimerId);
  rainTimerId = null;
}

function rainMount() {
  if (rainCanvas) return;
  rainCanvas = document.createElement("canvas");
  rainCanvas.id = "matrixRain";
  // Pure decoration: kept out of the accessibility tree entirely.
  rainCanvas.setAttribute("aria-hidden", "true");
  document.body.appendChild(rainCanvas);
  rainCtx = rainCanvas.getContext("2d");
  rainResize();
  if (!rainResizeBound) {
    window.addEventListener("resize", rainResize);
    // Nothing should animate against a hidden window; the loop resumes on
    // return with the trails still on the canvas, so it picks up mid-storm.
    document.addEventListener("visibilitychange", syncMatrixRain);
    rainResizeBound = true;
  }
}

function rainUnmount() {
  rainStopLoop();
  if (rainCanvas && rainCanvas.parentNode) rainCanvas.parentNode.removeChild(rainCanvas);
  rainCanvas = null;
  rainCtx = null;
  rainColumns = [];
}

/** Bring the rain in line with the current theme, motion setting, and window
 * visibility. Idempotent — applyUiSettings() calls it on every settings
 * change, and the visibility listener calls it on every tab flip. */
function syncMatrixRain() {
  const wanted = document.documentElement.dataset.theme === "matrix";
  if (!wanted) {
    rainUnmount();
    return;
  }
  rainMount();
  rainApplyOpacity();
  // A dialled-to-zero rain is invisible, so there is nothing to animate — stop
  // the loop and spend no frames on it until the user brings it back.
  if (rainMotionStilled() || document.hidden || rainOpacityScalar() === 0) {
    rainStopLoop();
    if (!document.hidden && rainOpacityScalar() > 0) rainPaintStill();
    return;
  }
  rainStartLoop();
}

// state.js applies the saved settings before this script exists (it guards the
// call), so take the first sync here once the function is defined.
syncMatrixRain();
