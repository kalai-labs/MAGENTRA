// The brain map: MAGENTRA's brain drawn as a brain.
//
// Every dot is a real piece of the brain — a prompt, a tool, a knob, a tool's
// access switch — placed in the lobe of the section it belongs to. Lit dots
// are in use, dim dots are switched off, red dots have a problem, amber rings
// are unsaved edits. Pulses travel between neighbours; a save fires the
// neurons it changed, a build speeds the whole brain up.
//
// The canvas is decoration only (aria-hidden). The lobes are also real
// <button>s laid over it by app.js, so the map works with a keyboard and a
// screen reader. Motion stops under prefers-reduced-motion and while the tab
// is hidden. Classic script: defines window.BrainMap.

"use strict";

(function () {
  /** The drawing space: 1000 × 760, a side view facing left. */
  const W = 1000;
  const H = 760;

  /** The cerebrum's outline, clockwise from the bottom of the frontal lobe. */
  const CEREBRUM = [
    [150, 470], [105, 360], [128, 248], [198, 158], [318, 94], [468, 66], [622, 78], [752, 128],
    [852, 222], [902, 334], [886, 432], [822, 500], [704, 526], [604, 546], [482, 576], [360, 582], [252, 546],
  ];
  const CEREBELLUM = { x: 768, y: 586, rx: 118, ry: 64 };
  const STEM = [[586, 540], [664, 544], [650, 716], [604, 716]];

  /** Folds drawn faintly inside the cerebrum, so it reads as a brain before any dot appears. */
  const SULCI = [
    [[300, 120], [340, 240], [300, 330], [330, 430]],
    [[470, 90], [450, 200], [500, 280], [470, 360]],
    [[620, 100], [600, 190], [650, 260], [620, 330]],
    [[180, 300], [260, 290], [330, 330], [420, 320]],
    [[300, 470], [420, 440], [560, 470], [700, 450]],
    [[740, 180], [760, 260], [820, 300], [860, 380]],
  ];

  /** Where each section lives. `shape`: the part of the brain its dots may fill. */
  const LOBES = {
    core: { x: 250, y: 320, rx: 140, ry: 150, shape: "cerebrum" },
    conditional: { x: 470, y: 160, rx: 130, ry: 76, shape: "cerebrum" },
    background: { x: 520, y: 330, rx: 96, ry: 86, shape: "cerebrum" },
    tools: { x: 690, y: 226, rx: 120, ry: 96, shape: "cerebrum" },
    toolnotes: { x: 664, y: 392, rx: 64, ry: 52, shape: "cerebrum" },
    finishing: { x: 826, y: 360, rx: 70, ry: 112, shape: "cerebrum" },
    reminders: { x: 396, y: 486, rx: 196, ry: 78, shape: "cerebrum" },
    behavior: { x: CEREBELLUM.x, y: CEREBELLUM.y, rx: CEREBELLUM.rx - 10, ry: CEREBELLUM.ry - 8, shape: "cerebellum" },
    access: { x: 624, y: 640, rx: 34, ry: 80, shape: "stem" },
  };

  /** A small deterministic random source, so the brain looks the same on every load. */
  function seeded(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hashString(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
    return h >>> 0;
  }

  /** A smooth closed path through the points (Catmull-Rom as Béziers). */
  function smoothPath(points) {
    const p = new Path2D();
    const n = points.length;
    p.moveTo(points[0][0], points[0][1]);
    for (let i = 0; i < n; i++) {
      const p0 = points[(i - 1 + n) % n];
      const p1 = points[i];
      const p2 = points[(i + 1) % n];
      const p3 = points[(i + 2) % n];
      p.bezierCurveTo(
        p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6,
        p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6,
        p2[0], p2[1],
      );
    }
    p.closePath();
    return p;
  }

  function polygonPath(points) {
    const p = new Path2D();
    points.forEach(([x, y], i) => (i === 0 ? p.moveTo(x, y) : p.lineTo(x, y)));
    p.closePath();
    return p;
  }

  function ellipsePath(e) {
    const p = new Path2D();
    p.ellipse(e.x, e.y, e.rx, e.ry, 0, 0, Math.PI * 2);
    return p;
  }

  const SHAPES = {
    cerebrum: smoothPath(CEREBRUM),
    cerebellum: ellipsePath(CEREBELLUM),
    stem: polygonPath(STEM),
  };

  /** Reads a colour channel triple ("56, 217, 210") from a CSS custom property. */
  function cssRgb(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  class BrainMap {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {{ compact?: boolean }} [options]
     */
    constructor(canvas, options) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.compact = Boolean(options && options.compact);
      this.probe = document.createElement("canvas").getContext("2d");
      this.sections = [];
      this.nodes = [];
      this.byKey = new Map();
      this.edges = [];
      this.adjacent = [];
      this.pulses = [];
      this.rings = [];
      this.active = null;
      this.hover = null;
      this.mode = "idle";
      this.bornAt = performance.now();
      this.lastSpawn = 0;
      this.frame = 0;
      this.staticLayer = document.createElement("canvas");
      this.reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
      this.colors = {};
      this.readColors();
      this.onResize = () => this.resize();
      window.addEventListener("resize", this.onResize);
      this.onVisibility = () => this.loop();
      document.addEventListener("visibilitychange", this.onVisibility);
      this.reduced.addEventListener?.("change", () => this.loop());
      this.resize();
    }

    readColors() {
      this.colors = {
        accent: cssRgb("--accent-rgb", "56, 217, 210"),
        accentHi: cssRgb("--accent-hi-rgb", "140, 238, 233"),
        od: cssRgb("--od-accent-rgb", "255, 140, 26"),
        red: cssRgb("--red-rgb", "241, 106, 120"),
        amber: cssRgb("--amber-rgb", "244, 168, 58"),
        green: cssRgb("--green-rgb", "64, 209, 131"),
        dim: cssRgb("--dim-rgb", "96, 107, 118"),
      };
    }

    /** Lobe centre in CSS pixels, for app.js to place the lobe buttons. */
    lobeAnchor(id) {
      const lobe = LOBES[id];
      if (!lobe) return null;
      return { x: this.ox + lobe.x * this.scale, y: this.oy + lobe.y * this.scale };
    }

    /**
     * @param {{ id: string, items: { key: string, state: string }[] }[]} sections
     */
    setData(sections) {
      const sameShape =
        this.sections.length === sections.length &&
        this.sections.every((s, i) => s.id === sections[i].id && s.items.length === sections[i].items.length && s.items.every((it, j) => it.key === sections[i].items[j].key));
      this.sections = sections;
      if (sameShape) {
        // Only states changed: keep the layout and the pulses in flight.
        for (const s of sections) for (const it of s.items) {
          const node = this.byKey.get(it.key);
          if (node) node.state = it.state;
        }
      } else {
        this.layout();
      }
      this.paintStatic();
      this.loop();
    }

    /** Places every item's dot in its lobe and links neighbours. Deterministic. */
    layout() {
      this.nodes = [];
      this.byKey = new Map();
      for (const section of this.sections) {
        const lobe = LOBES[section.id];
        if (!lobe) continue;
        const shape = SHAPES[lobe.shape];
        const rand = seeded(hashString(section.id));
        const placed = [];
        const minGap = Math.max(9, Math.sqrt((Math.PI * lobe.rx * lobe.ry) / Math.max(section.items.length, 1)) * 0.62);
        for (const item of section.items) {
          let best = null;
          for (let attempt = 0; attempt < 60; attempt++) {
            const a = rand() * Math.PI * 2;
            const r = Math.sqrt(rand());
            const x = lobe.x + Math.cos(a) * r * lobe.rx;
            const y = lobe.y + Math.sin(a) * r * lobe.ry;
            if (!this.probe.isPointInPath(shape, x, y)) continue;
            const gap = placed.reduce((m, p) => Math.min(m, Math.hypot(p.x - x, p.y - y)), Infinity);
            if (!best || gap > best.gap) best = { x, y, gap };
            if (gap >= minGap) break;
          }
          if (!best) best = { x: lobe.x, y: lobe.y };
          const node = { key: item.key, section: section.id, x: best.x, y: best.y, state: item.state, phase: rand() * Math.PI * 2, flash: 0, r: 2.1 + rand() * 1.5 };
          placed.push(node);
          this.nodes.push(node);
          this.byKey.set(item.key, node);
        }
      }
      // Links: each dot to its nearest neighbours in its own lobe, plus a few long fibres between lobes.
      const edges = [];
      const seen = new Set();
      const add = (i, j) => {
        const k = i < j ? `${i}-${j}` : `${j}-${i}`;
        if (i === j || seen.has(k)) return;
        seen.add(k);
        edges.push([i, j]);
      };
      this.nodes.forEach((n, i) => {
        const near = this.nodes
          .map((m, j) => ({ j, d: m.section === n.section ? Math.hypot(m.x - n.x, m.y - n.y) : Infinity }))
          .filter((o) => o.j !== i && o.d < Infinity)
          .sort((a, b) => a.d - b.d)
          .slice(0, 3);
        for (const o of near) add(i, o.j);
      });
      const rand = seeded(7);
      const sections = [...new Set(this.nodes.map((n) => n.section))];
      for (let s = 0; s < sections.length; s++) {
        for (let t = s + 1; t < sections.length; t++) {
          const a = this.nodes.filter((n) => n.section === sections[s]);
          const b = this.nodes.filter((n) => n.section === sections[t]);
          if (!a.length || !b.length) continue;
          const la = LOBES[sections[s]];
          const lb = LOBES[sections[t]];
          if (Math.hypot(la.x - lb.x, la.y - lb.y) > 330) continue;
          for (let k = 0; k < 2; k++) {
            const na = a[Math.floor(rand() * a.length)];
            const nb = b[Math.floor(rand() * b.length)];
            add(this.nodes.indexOf(na), this.nodes.indexOf(nb));
          }
        }
      }
      this.edges = edges;
      this.adjacent = this.nodes.map(() => []);
      edges.forEach(([i, j], e) => {
        this.adjacent[i].push(e);
        this.adjacent[j].push(e);
      });
      this.pulses = [];
      this.bornAt = performance.now();
    }

    resize() {
      const rect = this.canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.cssW = Math.max(rect.width, 1);
      this.cssH = Math.max(rect.height, 1);
      this.canvas.width = Math.round(this.cssW * dpr);
      this.canvas.height = Math.round(this.cssH * dpr);
      this.dpr = dpr;
      this.scale = Math.min(this.cssW / W, this.cssH / H);
      this.ox = (this.cssW - W * this.scale) / 2;
      this.oy = (this.cssH - H * this.scale) / 2;
      this.staticLayer.width = this.canvas.width;
      this.staticLayer.height = this.canvas.height;
      this.readColors();
      this.paintStatic();
      this.draw(performance.now());
      this.canvas.dispatchEvent(new CustomEvent("brainresize"));
    }

    /** The section under a point in CSS pixels, or null. */
    sectionAt(cssX, cssY) {
      const x = (cssX - this.ox) / this.scale;
      const y = (cssY - this.oy) / this.scale;
      let best = null;
      let bestD = Infinity;
      for (const s of this.sections) {
        const l = LOBES[s.id];
        if (!l) continue;
        const d = ((x - l.x) / l.rx) ** 2 + ((y - l.y) / l.ry) ** 2;
        if (d < 1.15 && d < bestD) {
          best = s.id;
          bestD = d;
        }
      }
      return best;
    }

    setActive(id) {
      this.active = id;
      this.paintStatic();
      this.loop();
    }

    setHover(id) {
      if (this.hover === id) return;
      this.hover = id;
      this.paintStatic();
      this.loop();
    }

    /** "idle", "busy" (checking, building), "success" or "error". success and error fade back to idle. */
    setMode(mode) {
      this.mode = mode;
      this.modeAt = performance.now();
      if (mode === "success" || mode === "error") {
        const c = mode === "success" ? this.colors.green : this.colors.red;
        this.rings.push({ x: W / 2, y: H / 2 - 40, at: performance.now(), color: c, max: 620 });
      }
      this.loop();
    }

    /** Fires the given items' neurons: a ring and pulses out along their links. Used after a save. */
    fire(keys) {
      const now = performance.now();
      for (const key of keys) {
        const node = this.byKey.get(key);
        if (!node) continue;
        node.flash = 1;
        this.rings.push({ x: node.x, y: node.y, at: now, color: this.colors.accentHi, max: 90 });
        const i = this.nodes.indexOf(node);
        for (const e of this.adjacent[i]) this.spawn(e, i, now, 1);
      }
      this.loop();
    }

    spawn(edgeIndex, from, now, energy) {
      const [a, b] = this.edges[edgeIndex];
      const start = from === b ? b : a;
      const end = start === a ? b : a;
      const na = this.nodes[start];
      const nb = this.nodes[end];
      const length = Math.hypot(nb.x - na.x, nb.y - na.y);
      this.pulses.push({ from: start, to: end, at: now, ms: 260 + length * 4.2, energy, edge: edgeIndex });
    }

    /** The edges, the outline and the folds: drawn once per change into an offscreen layer. */
    paintStatic() {
      const ctx = this.staticLayer.getContext("2d");
      const c = this.colors;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.staticLayer.width, this.staticLayer.height);
      ctx.setTransform(this.dpr * this.scale, 0, 0, this.dpr * this.scale, this.dpr * this.ox, this.dpr * this.oy);

      const glow = ctx.createRadialGradient(470, 330, 40, 470, 330, 520);
      glow.addColorStop(0, `rgba(${c.accent}, 0.10)`);
      glow.addColorStop(1, `rgba(${c.accent}, 0.0)`);
      for (const [name, shape] of Object.entries(SHAPES)) {
        ctx.fillStyle = glow;
        ctx.fill(shape);
        ctx.lineWidth = 2.2;
        ctx.strokeStyle = `rgba(${c.accent}, ${name === "cerebrum" ? 0.42 : 0.32})`;
        ctx.shadowColor = `rgba(${c.accent}, 0.55)`;
        ctx.shadowBlur = 18 * this.scale * this.dpr;
        ctx.stroke(shape);
        ctx.shadowBlur = 0;
      }
      ctx.save();
      ctx.clip(SHAPES.cerebrum);
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = `rgba(${c.accent}, 0.16)`;
      for (const s of SULCI) {
        ctx.beginPath();
        ctx.moveTo(s[0][0], s[0][1]);
        ctx.bezierCurveTo(s[1][0], s[1][1], s[2][0], s[2][1], s[3][0], s[3][1]);
        ctx.stroke();
      }
      ctx.restore();

      const focus = this.hover || this.active;
      ctx.lineWidth = 1;
      for (const [i, j] of this.edges) {
        const a = this.nodes[i];
        const b = this.nodes[j];
        const lit = focus && (a.section === focus || b.section === focus);
        const dim = focus && !lit;
        ctx.strokeStyle = `rgba(${c.accent}, ${lit ? 0.34 : dim ? 0.05 : 0.13})`;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }

    loop() {
      if (this.raf) return;
      const step = (now) => {
        this.raf = 0;
        this.draw(now);
        if (this.shouldAnimate()) this.raf = requestAnimationFrame(step);
      };
      this.raf = requestAnimationFrame(step);
    }

    /** Reduced motion and a hidden tab both get one still frame and no loop. */
    shouldAnimate() {
      return !document.hidden && !this.reduced.matches;
    }

    draw(now) {
      const ctx = this.ctx;
      const c = this.colors;
      const still = this.reduced.matches;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.drawImage(this.staticLayer, 0, 0);
      ctx.setTransform(this.dpr * this.scale, 0, 0, this.dpr * this.scale, this.dpr * this.ox, this.dpr * this.oy);

      // Pulses: spawn on a cadence the mode sets, travel, and sometimes carry on.
      if (!still && this.edges.length) {
        const every = this.mode === "busy" ? 28 : this.compact ? 520 : 240;
        if (now - this.lastSpawn > every) {
          this.lastSpawn = now;
          const e = Math.floor(Math.random() * this.edges.length);
          this.spawn(e, this.edges[e][Math.random() < 0.5 ? 0 : 1], now, this.mode === "busy" ? 0.9 : 0.6);
        }
      }
      const focus = this.hover || this.active;
      const alive = [];
      for (const p of this.pulses) {
        const t = (now - p.at) / p.ms;
        if (t >= 1) {
          const target = this.nodes[p.to];
          target.flash = Math.max(target.flash, p.energy * 0.8);
          if (!still && p.energy > 0.35 && Math.random() < 0.55) {
            const next = this.adjacent[p.to].filter((e) => e !== p.edge);
            if (next.length) this.spawn(next[Math.floor(Math.random() * next.length)], p.to, now, p.energy * 0.8);
          }
          continue;
        }
        alive.push(p);
        const a = this.nodes[p.from];
        const b = this.nodes[p.to];
        const ease = t * t * (3 - 2 * t);
        const x = a.x + (b.x - a.x) * ease;
        const y = a.y + (b.y - a.y) * ease;
        const tx = a.x + (b.x - a.x) * Math.max(0, ease - 0.18);
        const ty = a.y + (b.y - a.y) * Math.max(0, ease - 0.18);
        const tint = this.mode === "busy" ? c.accentHi : c.accent;
        const alpha = (focus && a.section !== focus && b.section !== focus ? 0.25 : 0.85) * p.energy;
        const trail = ctx.createLinearGradient(tx, ty, x, y);
        trail.addColorStop(0, `rgba(${tint}, 0)`);
        trail.addColorStop(1, `rgba(${tint}, ${alpha})`);
        ctx.strokeStyle = trail;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(x, y);
        ctx.stroke();
        ctx.fillStyle = `rgba(${c.accentHi}, ${alpha})`;
        ctx.beginPath();
        ctx.arc(x, y, 2.4, 0, Math.PI * 2);
        ctx.fill();
      }
      this.pulses = alive.slice(-400);

      // Neurons. On load they light lobe by lobe: the one orchestrated moment.
      const order = ["core", "conditional", "background", "tools", "toolnotes", "reminders", "finishing", "behavior", "access"];
      const age = now - this.bornAt;
      for (const n of this.nodes) {
        const born = still ? 1 : Math.min(1, Math.max(0, (age - order.indexOf(n.section) * 110) / 420));
        if (born <= 0) continue;
        const twinkle = still ? 0.85 : 0.72 + 0.28 * Math.sin(now / 900 + n.phase);
        const dimmed = focus && n.section !== focus ? 0.32 : 1;
        let rgb = c.accent;
        let a = 0.9;
        if (n.state === "off") {
          rgb = c.dim;
          a = 0.7;
        } else if (n.state === "problem") rgb = c.red;
        else if (n.state === "overdrive") rgb = c.od;
        const r = n.r * (1 + n.flash * 0.9) * (0.4 + 0.6 * born);
        if (n.state !== "off") {
          ctx.fillStyle = `rgba(${rgb}, ${0.16 * twinkle * dimmed * born + n.flash * 0.25})`;
          ctx.beginPath();
          ctx.arc(n.x, n.y, r * 3.2, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = `rgba(${rgb}, ${a * twinkle * dimmed * born})`;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fill();
        if (n.state === "draft") {
          ctx.strokeStyle = `rgba(${c.amber}, ${0.55 + 0.45 * Math.sin(now / 260)})`;
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          ctx.arc(n.x, n.y, r + 4, 0, Math.PI * 2);
          ctx.stroke();
        }
        n.flash *= 0.94;
      }

      // Rings: the visible answer to a save, a build, a failure.
      this.rings = this.rings.filter((ring) => {
        const t = (now - ring.at) / 900;
        if (t >= 1 || still) return false;
        ctx.strokeStyle = `rgba(${ring.color}, ${0.6 * (1 - t)})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(ring.x, ring.y, 6 + ring.max * t, 0, Math.PI * 2);
        ctx.stroke();
        return true;
      });
      this.frame++;
    }

    destroy() {
      cancelAnimationFrame(this.raf);
      window.removeEventListener("resize", this.onResize);
      document.removeEventListener("visibilitychange", this.onVisibility);
    }
  }

  BrainMap.LOBES = Object.keys(LOBES);
  window.BrainMap = BrainMap;
})();
