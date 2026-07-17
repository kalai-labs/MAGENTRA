// Atmosphere canvas — matrix rain / snowfall / drift, per theme.
// Loaded as a classic script in index.html — all renderer modules share one
// global scope, in the order the page lists them.

// ---------------------------------------------------------------------------
// Atmosphere canvas — theme-aware: matrix rain (phosphor), snowfall (glacier),
// starfield (dusk). Paper has no atmosphere (canvas hidden by CSS).
// ---------------------------------------------------------------------------

(function initAtmosphere() {
  const ctx = rainCanvas.getContext("2d");
  const COL_WIDTH = 14;
  const FONT_SIZE = 13;
  const CHARS =
    "アイウエオカキクケコサシスセソ" +
    "タチツテトナニヌネノハヒフヘホ" +
    "マミムメモヤユヨラリルレロワヲン" +
    "0123456789ABCDEFGHIJKLMN";

  let width = 0;
  let height = 0;
  let columns = [];
  let flakes = [];
  let stars = [];

  function resize() {
    width = window.innerWidth;
    height = window.innerHeight;
    rainCanvas.width = width;
    rainCanvas.height = height;
    const colCount = Math.ceil(width / COL_WIDTH);
    columns = new Array(colCount).fill(0).map(() => Math.floor(Math.random() * (height / FONT_SIZE)));
    const flakeCount = Math.round((width * height) / 14000);
    flakes = new Array(flakeCount).fill(0).map(() => ({
      x: Math.random() * width,
      y: Math.random() * height,
      r: 0.8 + Math.random() * 1.9,
      vy: 0.35 + Math.random() * 0.85,
      sway: Math.random() * Math.PI * 2,
    }));
    const starCount = Math.round((width * height) / 11000);
    stars = new Array(starCount).fill(0).map(() => ({
      x: Math.random() * width,
      y: Math.random() * height,
      r: 0.4 + Math.random() * 1.1,
      phase: Math.random() * Math.PI * 2,
      speed: 0.4 + Math.random() * 1.1,
    }));
  }
  window.addEventListener("resize", resize);
  resize();

  function drawMatrix() {
    ctx.fillStyle = "rgba(5, 8, 5, 0.08)";
    ctx.fillRect(0, 0, width, height);
    ctx.font = `${FONT_SIZE}px monospace`;
    for (let i = 0; i < columns.length; i++) {
      const x = i * COL_WIDTH;
      const y = columns[i] * FONT_SIZE;
      ctx.fillStyle = "#00ff41";
      ctx.fillText(CHARS[Math.floor(Math.random() * CHARS.length)], x, y - FONT_SIZE);
      ctx.fillStyle = "#9fff9f";
      ctx.fillText(CHARS[Math.floor(Math.random() * CHARS.length)], x, y);
      if (y > height && Math.random() < 0.02) columns[i] = 0;
      else columns[i]++;
    }
  }

  function drawSnow() {
    ctx.clearRect(0, 0, width, height);
    for (const f of flakes) {
      f.sway += 0.012;
      f.y += f.vy;
      f.x += Math.sin(f.sway) * 0.3;
      if (f.y > height + 4) { f.y = -4; f.x = Math.random() * width; }
      if (f.x > width + 4) f.x = -4;
      if (f.x < -4) f.x = width + 4;
      ctx.beginPath();
      ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(96, 132, 168, 0.85)";
      ctx.fill();
    }
  }

  let starTime = 0;
  function drawStars() {
    starTime += 0.02;
    ctx.clearRect(0, 0, width, height);
    for (const s of stars) {
      s.y += 0.03; // imperceptible drift, so the sky feels alive
      if (s.y > height + 2) { s.y = -2; s.x = Math.random() * width; }
      const tw = 0.25 + 0.75 * Math.abs(Math.sin(s.phase + starTime * s.speed));
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(226, 216, 190, ${tw})`;
      ctx.fill();
    }
  }

  let lastFrame = 0;

  const reducedMotion = window.matchMedia
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : { matches: false };
  let staticTheme = null; // theme of the frozen frame currently painted, or null while animating

  function frame(now) {
    requestAnimationFrame(frame);
    if (document.hidden) return;
    const theme = document.documentElement.dataset.theme || "phosphor";
    // Hidden canvas (rain off, or paper theme) — skip the draw work too.
    if (document.documentElement.dataset.rain === "off" || theme === "paper") return;
    // The OS reduced-motion setting and the app's CALM motion setting both
    // freeze the atmosphere: draw one static frame, then stop animating.
    if (reducedMotion.matches || document.documentElement.dataset.motion === "calm") {
      if (staticTheme !== theme) {
        if (theme === "glacier") drawSnow();
        else if (theme === "dusk") drawStars();
        else drawMatrix();
        staticTheme = theme;
      }
      return;
    }
    staticTheme = null;
    // Glyph rain reads right at 15fps; drifting particles need 30 to be smooth.
    const interval = theme === "phosphor" ? 1000 / 15 : 1000 / 30;
    if (now - lastFrame < interval) return;
    lastFrame = now;

    if (theme === "glacier") drawSnow();
    else if (theme === "dusk") drawStars();
    else drawMatrix();
  }
  requestAnimationFrame(frame);
})();
