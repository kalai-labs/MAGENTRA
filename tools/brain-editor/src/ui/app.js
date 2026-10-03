// The brain editor page. Plain JS, no build step, no dependencies — the
// gateway's idiom (tools/magentra-gateway/src/ui/app.js).
//
// The page never writes a file itself. Every edit becomes a draft here; a save
// sends the drafts as change objects to POST /api/plan, shows what the server
// found, and on confirmation sends the very same objects to POST /api/apply —
// the function an agent's `npm run brain-editor -- apply` calls too.

"use strict";

/* global BrainMap */

const ACTION_HEADER = "x-magentra-brain-action";

/* ---- the parts of the brain, in plain words -------------------------------- */

const SECTIONS = [
  { id: "core", dir: "1-core-system", title: "System prompt", blurb: "The opening instructions, sent at the start of every request. The sections go out in this order." },
  { id: "conditional", dir: "2-conditional-system", title: "Mode sections", blurb: "Added to the system prompt only while their mode is on, such as OVERDRIVE or project standards." },
  { id: "reminders", dir: "3-in-turn-reminders", title: "Reminders", blurb: "Short notes the engine adds to the conversation during a turn: after a failure, a refusal, a stall, a hook." },
  { id: "finishing", dir: "4-end-of-turn-rungs", title: "Finishing checks", blurb: "What the agent is told when it tries to stop before it has shown the work runs." },
  { id: "background", dir: "5-background-inference", title: "Background calls", blurb: "Prompts for helper calls the user never sees: naming a session, clarifying a request, compacting history, describing images." },
  { id: "toolnotes", dir: "7-tool-descriptions", title: "Tool notes", blurb: "Extra lines tools add to their results, for example when an image cannot be read." },
  { id: "tools", title: "Tools", blurb: "What each tool tells the model it does, and what each of its inputs means." },
  { id: "access", title: "Tool access", blurb: "Which tools the agent may use, in normal mode and in OVERDRIVE. Only the main session follows this; helper agents keep their own tool sets." },
  { id: "behavior", title: "Behaviour", blurb: "The numbers and switches that decide when the texts above are sent and how hard the agent pushes before it stops." },
];
const PROMPT_SECTIONS = SECTIONS.filter((s) => s.dir);

const CHANNELS = {
  system: "Part of the system prompt, sent with every request",
  "system-conditional": "Added to the system prompt while its mode is on",
  reminder: "Added to the conversation as a reminder",
  tool: "Part of a tool's text",
  "side-call": "The instructions of a background call",
  "side-call-user": "A message inside a background call",
  subagent: "Given to a helper call as its role",
};

const DEFAULT_CHANNEL = { core: "system", conditional: "system-conditional", reminders: "reminder", finishing: "reminder", background: "side-call", toolnotes: "tool" };

const KNOB_GROUPS = {
  finishing: "Finishing checks",
  stall: "Stall detector",
  reminders: "Reminders",
  clarify: "Clarifying questions",
  context: "Context window",
  tools: "Tool results",
  evidence: "Evidence word lists",
  overdrive: "OVERDRIVE",
};

const REFUSAL_TITLES = {
  "invalid-change": "This change cannot be made",
  stale: "The brain changed on disk",
  "breaks-brain": "This would break the brain",
  "breaks-engine": "The engine would not start with this",
  mismatch: "The files would not say what you wrote",
  "needs-acknowledge": "This changes text the tests hold",
  busy: "Another save is running",
};

/* ---- state ------------------------------------------------------------------ */

const S = {
  brain: null,
  route: { view: "home" },
  drafts: {},
  search: "",
  engine: null,
  build: null,
  pending: null,
};

let homeMap = null;
let miniMap = null;

/* ---- small helpers ------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);

/** Builds an element. props: class, text, attrs (object), on (events), dataset. Never innerHTML. */
function el(tag, props, ...children) {
  const node = document.createElement(tag);
  if (props) {
    if (props.class) node.className = props.class;
    if (props.text !== undefined) node.textContent = props.text;
    for (const [k, v] of Object.entries(props.attrs || {})) if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? "" : String(v));
    for (const [k, v] of Object.entries(props.on || {})) node.addEventListener(k, v);
    for (const [k, v] of Object.entries(props.dataset || {})) node.dataset[k] = v;
    if (props.value !== undefined) node.value = props.value;
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(typeof c === "string" ? document.createTextNode(c) : c);
  return node;
}

/** Replaces a node's children, skipping the null/false an optional part leaves behind. */
function put(node, ...children) {
  node.replaceChildren(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
}

async function api(path) {
  const res = await fetch(path, { cache: "no-store" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${path}: ${res.status}`);
  return data;
}

async function post(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", [ACTION_HEADER]: "1" },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function toast(text, tone) {
  const t = $("toast");
  t.textContent = text;
  t.className = `toast ${tone || ""}`;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), tone === "bad" ? 9000 : 4200);
}

/** "nudgeBudget" → "Nudge budget". */
function words(name) {
  const s = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[._-]+/g, " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many || `${one}s`}`;
}

/* ---- drafts ------------------------------------------------------------------ */
// A draft is an unsaved edit: drafts[kind:target] = { kind, target, fields: { name: { value, base } } }.
// `base` is what the brain said when the edit started; if the brain moves under
// it (an agent, a git checkout), the field is shown as a conflict.

function draftStoreKey() {
  return `magentra-brain-editor:drafts:${S.brain ? S.brain.dir : ""}`;
}

function loadDrafts() {
  try {
    S.drafts = JSON.parse(localStorage.getItem(draftStoreKey()) || "{}") || {};
  } catch {
    S.drafts = {};
  }
}

function saveDrafts() {
  try {
    localStorage.setItem(draftStoreKey(), JSON.stringify(S.drafts));
  } catch {
    // Storage full or blocked: drafts live for this page only.
  }
}

function draftValue(kind, target, field, fallback) {
  const d = S.drafts[`${kind}:${target}`];
  return d && d.fields[field] ? d.fields[field].value : fallback;
}

function hasDraft(kind, target, field) {
  const d = S.drafts[`${kind}:${target}`];
  return Boolean(d && (field === undefined ? Object.keys(d.fields).length : d.fields[field]));
}

/** Records (or clears, when it equals `base`) one edited field. */
function setDraft(kind, target, field, value, base) {
  const key = `${kind}:${target}`;
  const d = S.drafts[key] || { kind, target, fields: {} };
  const prior = d.fields[field];
  if (same(value, prior ? prior.base : base)) delete d.fields[field];
  else d.fields[field] = { value, base: prior ? prior.base : base };
  if (Object.keys(d.fields).length) S.drafts[key] = d;
  else delete S.drafts[key];
  saveDrafts();
  renderSaveBar();
  refreshMarks();
}

function discardDraft(kind, target) {
  delete S.drafts[`${kind}:${target}`];
  saveDrafts();
  renderAll();
}

/** The current value on disk for a draft field, to spot a conflict. */
function diskValue(kind, target, field) {
  const b = S.brain;
  if (kind === "prompt") {
    const p = b.prompts.find((x) => x.id === target);
    return p ? p[field] : undefined;
  }
  if (kind === "tool") {
    const t = b.tools.find((x) => x.name === target);
    if (!t) return undefined;
    if (field === "description") return t.description;
    const param = t.params.find((x) => `param:${x.path}` === field);
    return param ? param.text : null;
  }
  if (kind === "knob") return (b.knobs.find((k) => k.key === target) || {}).value;
  if (kind === "od") {
    const k = b.knobs.find((x) => x.key === target);
    return k && k.overdriveValue !== undefined ? k.overdriveValue : null;
  }
  if (kind === "access") {
    const t = b.tools.find((x) => x.name === target);
    return t ? t.offered[field] : undefined;
  }
  if (kind === "file") {
    const f = b.brokenFiles.find((x) => x.file === target);
    return f ? f.raw : undefined;
  }
  return undefined;
}

function conflicts() {
  const out = [];
  for (const d of Object.values(S.drafts)) {
    for (const [field, f] of Object.entries(d.fields)) {
      if (!same(diskValue(d.kind, d.target, field), f.base)) out.push({ kind: d.kind, target: d.target, field });
    }
  }
  return out;
}

/** Keeps my version of a conflicting field: the disk value becomes its new base. */
function keepMine(kind, target, field) {
  const d = S.drafts[`${kind}:${target}`];
  if (!d || !d.fields[field]) return;
  d.fields[field].base = diskValue(kind, target, field);
  if (same(d.fields[field].value, d.fields[field].base)) delete d.fields[field];
  if (!Object.keys(d.fields).length) delete S.drafts[`${kind}:${target}`];
  saveDrafts();
  renderAll();
}

function useDisk(kind, target, field) {
  const d = S.drafts[`${kind}:${target}`];
  if (!d) return;
  delete d.fields[field];
  if (!Object.keys(d.fields).length) delete S.drafts[`${kind}:${target}`];
  saveDrafts();
  renderAll();
}

/** The drafts as the change objects model.ts accepts. */
function changesFromDrafts() {
  const changes = [];
  for (const d of Object.values(S.drafts)) {
    const v = (f) => d.fields[f] && d.fields[f].value;
    if (d.kind === "prompt") {
      const c = { op: "prompt.update", id: d.target };
      for (const f of Object.keys(d.fields)) c[f] = v(f);
      changes.push(c);
    } else if (d.kind === "tool") {
      const c = { op: "tool.update", name: d.target };
      for (const f of Object.keys(d.fields)) {
        if (f === "description") c.description = v(f);
        else (c.params = c.params || {})[f.slice("param:".length)] = v(f);
      }
      changes.push(c);
    } else if (d.kind === "knob") changes.push({ op: "behavior.set", key: d.target, value: v("value") });
    else if (d.kind === "od") changes.push({ op: "behavior.override", key: d.target, value: v("value") });
    else if (d.kind === "access") {
      const c = { op: "availability.update", tool: d.target };
      for (const f of Object.keys(d.fields)) c[f] = v(f);
      changes.push(c);
    } else if (d.kind === "file") changes.push({ op: "file.write", path: d.target, content: v("content") });
  }
  return changes;
}

/** Brain-map keys of the items the drafts touch. */
function draftedKeys() {
  return Object.values(S.drafts).map((d) => (d.kind === "od" ? `knob:${d.target}` : `${d.kind}:${d.target}`));
}

/* ---- loading ----------------------------------------------------------------- */

async function load() {
  const before = S.brain ? S.brain.dir : null;
  S.brain = await api("/api/brain");
  S.build = S.brain.build;
  if (before !== S.brain.dir) {
    loadDrafts();
    S.engine = null;
  }
  // Drafts for items that no longer exist are dropped, never sent.
  for (const [key, d] of Object.entries(S.drafts)) {
    if (d.kind === "prompt" && !S.brain.prompts.some((p) => p.id === d.target)) delete S.drafts[key];
    if (d.kind === "file" && !S.brain.brokenFiles.some((f) => f.file === d.target)) delete S.drafts[key];
  }
  saveDrafts();
  renderAll();
}

/** Re-renders, keeping the caret where the user was typing. */
function renderAll() {
  const active = document.activeElement;
  const field = active && active.dataset ? active.dataset.field : undefined;
  const sel = field && "selectionStart" in active ? [active.selectionStart, active.selectionEnd, active.scrollTop] : null;
  const scroller = document.querySelector(".editor");
  const scrollTop = scroller ? scroller.scrollTop : 0;
  renderTop();
  renderRail();
  renderMain();
  renderSaveBar();
  if (field) {
    const again = document.querySelector(`[data-field="${CSS.escape(field)}"]`);
    if (again) {
      again.focus();
      if (sel && "setSelectionRange" in again) {
        try {
          again.setSelectionRange(sel[0], sel[1]);
          again.scrollTop = sel[2];
        } catch {
          // not a text field
        }
      }
    }
  }
  const editor = document.querySelector(".editor");
  if (editor) editor.scrollTop = scrollTop;
}

/* ---- top bar ----------------------------------------------------------------- */

function renderTop() {
  const b = S.brain;
  const rel = b.dir.startsWith(`${b.repo}/`) || b.dir.startsWith(`${b.repo}\\`) ? `${b.dir.slice(b.repo.length + 1)}/` : b.dir;
  $("folderPath").textContent = rel;
  $("folderPath").title = b.dir;
  $("folderKind").textContent = b.shipped ? "Shipped brain" : "Profile folder";
  $("folderKind").className = `folder-kind${b.shipped ? "" : " profile"}`;
  $("backToShipped").hidden = b.shipped;

  const status = $("engineStatus");
  const building = S.build && S.build.running;
  let text;
  let cls;
  if (building) {
    text = "Building the engine…";
    cls = "building";
  } else if (!b.shipped) {
    text = "Checked, never built into the engine";
    cls = "";
  } else if (b.engineState === "current") {
    text = "The engine has this brain";
    cls = "current";
  } else if (b.engineState === "needs-build") {
    text = "Saved changes need a build";
    cls = "needs-build";
  } else {
    text = "The brain has problems";
    cls = "broken";
  }
  status.textContent = text;
  status.className = `engine ${cls}`;
  const build = $("buildButton");
  build.hidden = !b.shipped;
  build.disabled = Boolean(building);
  build.textContent = building ? "Building…" : S.build && S.build.finishedAt ? "Build again" : "Build";
  build.classList.toggle("primary", b.engineState === "needs-build" && !building);
}

/* ---- rail -------------------------------------------------------------------- */

function sectionItems(id) {
  const b = S.brain;
  const section = SECTIONS.find((s) => s.id === id);
  if (section && section.dir) {
    const list = b.prompts.filter((p) => p.dir === section.dir);
    if (id === "core") list.sort((x, y) => (x.order ?? 0) - (y.order ?? 0));
    else list.sort((x, y) => (x.id < y.id ? -1 : 1));
    return list;
  }
  if (id === "tools" || id === "access") return b.tools;
  if (id === "behavior") return b.knobs;
  return [];
}

function sectionCount(id) {
  return sectionItems(id).length;
}

function sectionHasDraft(id) {
  const keys = new Set(draftedKeys());
  if (id === "access") return [...keys].some((k) => k.startsWith("access:"));
  if (id === "tools") return [...keys].some((k) => k.startsWith("tool:"));
  if (id === "behavior") return [...keys].some((k) => k.startsWith("knob:"));
  return sectionItems(id).some((p) => keys.has(`prompt:${p.id}`));
}

function sectionHasProblem(id) {
  const section = SECTIONS.find((s) => s.id === id);
  const b = S.brain;
  if (section && section.dir) return b.brokenFiles.some((f) => f.file.startsWith(`prompts/${section.dir}/`));
  if (id === "tools") return b.brokenFiles.some((f) => f.file.startsWith("tools/"));
  if (id === "access") return b.brokenFiles.some((f) => f.file === "availability.json");
  if (id === "behavior") return b.brokenFiles.some((f) => f.file === "behavior.json");
  return false;
}

function renderRail() {
  const list = $("sectionList");
  put(list, 
    ...SECTIONS.map((s) => {
      const current = S.route.view === s.id;
      const mark = sectionHasProblem(s.id) ? "problem" : sectionHasDraft(s.id) ? "draft" : "";
      return el(
        "li",
        null,
        el(
          "a",
          { attrs: { href: `#${s.id}`, "aria-current": current ? "page" : undefined } },
          el("span", { class: `mark ${mark}`, attrs: { "aria-hidden": "true" } }),
          s.title,
          el("span", { class: "count", text: String(sectionCount(s.id)) }),
        ),
      );
    }),
  );
  const b = S.brain;
  const problems = b.problems.length;
  put($("extraList"), 
    ...[
    el("li", null, el("a", { attrs: { href: "#model", "aria-current": S.route.view === "model" ? "page" : undefined } }, "What the model reads")),
    problems || b.warnings.length
      ? el(
          "li",
          null,
          el(
            "a",
            { class: problems ? "alert" : "", attrs: { href: "#problems", "aria-current": S.route.view === "problems" ? "page" : undefined } },
            problems ? "Problems" : "Warnings",
            el("span", { class: "count", text: String(problems || b.warnings.length) }),
          ),
        )
      : null,
    ].filter(Boolean),
  );
  $("miniWrap").hidden = S.route.view === "home";
  if (!miniMap) {
    miniMap = new BrainMap($("miniBrain"), { compact: true });
    $("miniBrain").addEventListener("click", (e) => {
      const r = $("miniBrain").getBoundingClientRect();
      const id = miniMap.sectionAt(e.clientX - r.left, e.clientY - r.top);
      if (id) location.hash = `#${id}`;
    });
    $("miniBrain").addEventListener("mousemove", (e) => {
      const r = $("miniBrain").getBoundingClientRect();
      miniMap.setHover(miniMap.sectionAt(e.clientX - r.left, e.clientY - r.top));
    });
    $("miniBrain").addEventListener("mouseleave", () => miniMap.setHover(null));
  }
  if (!$("miniWrap").hidden) {
    miniMap.resize();
    miniMap.setData(mapData());
    miniMap.setActive(SECTIONS.some((s) => s.id === S.route.view) ? S.route.view : null);
  }
}

/** The brain map's data: one dot per item, its state from the brain and the drafts. */
function mapData() {
  const b = S.brain;
  const drafted = new Set(draftedKeys());
  const broken = new Set(b.brokenFiles.map((f) => f.file));
  return SECTIONS.map((s) => {
    let items;
    if (s.dir) {
      items = sectionItems(s.id).map((p) => ({
        key: `prompt:${p.id}`,
        state: drafted.has(`prompt:${p.id}`) ? "draft" : !p.enabled ? "off" : "ok",
      }));
      for (const f of broken) if (f.startsWith(`prompts/${s.dir}/`)) items.push({ key: `file:${f}`, state: "problem" });
    } else if (s.id === "tools") {
      items = b.tools.map((t) => ({ key: `tool:${t.name}`, state: drafted.has(`tool:${t.name}`) ? "draft" : broken.has(`tools/${t.name}/params.md`) ? "problem" : "ok" }));
    } else if (s.id === "access") {
      items = b.tools.map((t) => ({
        key: `access:${t.name}`,
        state: drafted.has(`access:${t.name}`) ? "draft" : !t.offered.main && !t.offered.overdrive ? "off" : t.offered.main !== t.offered.overdrive ? "overdrive" : "ok",
      }));
    } else {
      items = b.knobs.map((k) => ({
        key: `knob:${k.key}`,
        state: drafted.has(`knob:${k.key}`) ? "draft" : k.overdriveValue !== undefined ? "overdrive" : k.value === false || k.value === 0 ? "off" : "ok",
      }));
    }
    return { id: s.id, items };
  });
}

/** Cheap refresh after a keystroke: marks, map dots and list flags, no full render. */
function refreshMarks() {
  const data = mapData();
  if (homeMap && S.route.view === "home") homeMap.setData(data);
  if (miniMap && S.route.view !== "home") miniMap.setData(data);
  for (const a of document.querySelectorAll("#sectionList a")) {
    const id = a.getAttribute("href").slice(1);
    const mark = a.querySelector(".mark");
    if (mark) mark.className = `mark ${sectionHasProblem(id) ? "problem" : sectionHasDraft(id) ? "draft" : ""}`;
  }
  for (const btn of document.querySelectorAll(".items button[data-key]")) {
    const [kind, ...rest] = btn.dataset.key.split(":");
    const flag = btn.querySelector(".dot.draft");
    const drafted = hasDraft(kind, rest.join(":"));
    if (drafted && !flag) btn.querySelector(".flags").prepend(el("span", { class: "dot draft", attrs: { title: "Unsaved change" } }));
    if (!drafted && flag) flag.remove();
  }
}

/* ---- routing ----------------------------------------------------------------- */

function parseRoute() {
  const raw = decodeURIComponent(location.hash.replace(/^#/, ""));
  const [view, ...rest] = raw.split("/");
  S.route = { view: view || "home", item: rest.length ? rest.join("/") : undefined };
}

function go(view, item) {
  location.hash = item ? `#${view}/${encodeURIComponent(item)}` : `#${view}`;
}

/* ---- main views -------------------------------------------------------------- */

function renderMain() {
  const main = $("main");
  const v = S.route.view;
  if (homeMap && v !== "home") {
    homeMap.destroy();
    homeMap = null;
  }
  if (v === "home") return renderHome(main);
  if (v === "model") return renderModelView(main);
  if (v === "problems") return renderProblems(main);
  const section = SECTIONS.find((s) => s.id === v);
  if (!section) return renderHome(main);
  if (section.dir) return renderPromptSection(main, section);
  if (v === "tools") return renderToolSection(main, section);
  if (v === "access") return renderAccess(main, section);
  return renderBehavior(main, section);
}

function renderHome(main) {
  const b = S.brain;
  const prompts = b.prompts.length;
  const off = b.prompts.filter((p) => !p.enabled).length;
  const health = b.problems.length
    ? el("div", { class: "home-health bad" }, el("b", { text: `${plural(b.problems.length, "problem")} in this brain.` }), el("a", { attrs: { href: "#problems" }, text: "See what to fix" }))
    : el(
        "div",
        { class: "home-health" },
        el("span", { text: b.shipped ? "This is the shipped brain: brain/ in the repository. Tests hold its text, so every saved change names the tests it moves." : "This is a profile folder: a copy you can change freely. No test holds it and the engine is never built from it." }),
      );
  const stage = el("div", { class: "stage" });
  const canvas = el("canvas", { attrs: { "aria-hidden": "true" } });
  stage.append(canvas);
  put(main, 
    el(
      "div",
      { class: "home" },
      el(
        "div",
        { class: "home-text" },
        el("h1", { text: "MAGENTRA's brain" }),
        el("p", { text: "Everything the agent is told, and every rule for when it is told. Pick a part of the brain to read it or change it." }),
        el(
          "div",
          { class: "tally" },
          el("div", null, el("b", { text: String(prompts) }), el("span", { text: off ? `prompts, ${off} off` : "prompts" })),
          el("div", null, el("b", { text: String(b.tools.length) }), el("span", { text: "tools" })),
          el("div", null, el("b", { text: String(b.knobs.length) }), el("span", { text: "behaviour knobs" })),
        ),
        el(
          "ul",
          { class: "legend" },
          el("li", null, el("i", { class: "lit" }), "In use"),
          el("li", null, el("i", { class: "off" }), "Switched off, or set to zero"),
          el("li", null, el("i", { class: "od" }), "Works differently in OVERDRIVE"),
          el("li", null, el("i", { class: "draft" }), "Unsaved change"),
          el("li", null, el("i", { class: "bad" }), "Has a problem"),
        ),
        health,
      ),
      stage,
    ),
  );
  homeMap = new BrainMap(canvas);
  homeMap.setData(mapData());
  const lobes = SECTIONS.map((s) =>
    el(
      "button",
      {
        class: `lobe${sectionHasProblem(s.id) ? " has-problem" : ""}${sectionHasDraft(s.id) ? " has-draft" : ""}`,
        attrs: { type: "button", "aria-label": `${s.title}, ${sectionCount(s.id)} items` },
        dataset: { section: s.id },
        on: {
          click: () => go(s.id),
          mouseenter: () => homeMap && homeMap.setHover(s.id),
          mouseleave: () => homeMap && homeMap.setHover(null),
          focus: () => homeMap && homeMap.setHover(s.id),
          blur: () => homeMap && homeMap.setHover(null),
        },
      },
      s.title,
      el("span", { class: "n", text: String(sectionCount(s.id)) }),
    ),
  );
  stage.append(...lobes);
  const place = () => {
    for (const lobe of lobes) {
      const at = homeMap && homeMap.lobeAnchor(lobe.dataset.section);
      if (!at) continue;
      lobe.style.left = `${at.x}px`;
      lobe.style.top = `${at.y}px`;
    }
  };
  canvas.addEventListener("brainresize", place);
  canvas.addEventListener("mousemove", (e) => {
    const r = canvas.getBoundingClientRect();
    const id = homeMap.sectionAt(e.clientX - r.left, e.clientY - r.top);
    homeMap.setHover(id);
    canvas.style.cursor = id ? "pointer" : "default";
    for (const l of lobes) l.classList.toggle("hot", l.dataset.section === id);
  });
  canvas.addEventListener("click", (e) => {
    const r = canvas.getBoundingClientRect();
    const id = homeMap.sectionAt(e.clientX - r.left, e.clientY - r.top);
    if (id) go(id);
  });
  requestAnimationFrame(() => {
    homeMap.resize();
    place();
  });
  if (S.build && S.build.running) homeMap.setMode("busy");
}

function sectionHead(section, extra) {
  return el("div", { class: "section-head" }, el("div", { class: "row" }, el("h2", { text: section.title }), el("div", { class: "top-spacer" }), extra || null), el("p", { text: section.blurb }));
}

function searchBox(onChange) {
  return el("input", {
    attrs: { type: "search", placeholder: "Find by name, id or text", "aria-label": "Find", "data-field": "search" },
    value: S.search,
    on: {
      input: (e) => {
        S.search = e.target.value;
        onChange();
      },
    },
  });
}

/* ---- prompts ------------------------------------------------------------------ */

function renderPromptSection(main, section) {
  const prompts = sectionItems(section.id);
  const selected = prompts.find((p) => p.id === S.route.item) || prompts[0];
  const listEl = el("ul", { class: "items", attrs: { "aria-label": `${section.title} prompts` } });
  const fill = () => {
    const q = S.search.trim().toLowerCase();
    const shown = prompts.filter((p) => !q || p.id.includes(q) || p.label.toLowerCase().includes(q) || p.text.toLowerCase().includes(q));
    put(listEl, 
      ...shown.map((p, i) =>
        el(
          "li",
          null,
          el(
            "button",
            {
              class: p.enabled ? "" : "off",
              attrs: { type: "button", "aria-current": selected && p.id === selected.id ? "true" : undefined },
              dataset: { key: `prompt:${p.id}` },
              on: { click: () => go(section.id, p.id) },
            },
            section.id === "core" ? el("span", { class: "pos", text: String(prompts.indexOf(p) + 1) }) : el("span"),
            el("span", { class: "label", text: p.label }),
            el(
              "span",
              { class: "flags" },
              hasDraft("prompt", p.id) ? el("span", { class: "dot draft", attrs: { title: "Unsaved change" } }) : null,
              S.brain.overrides && S.brain.overrides.byId[p.id] ? el("span", { class: "dot override", attrs: { title: "Overridden on this machine" } }) : null,
            ),
            el("span", { class: "id", text: p.id }),
          ),
        ),
      ),
    );
    if (!shown.length) listEl.append(el("li", { class: "empty-note", text: "Nothing matches." }));
  };
  fill();
  const broken = S.brain.brokenFiles.filter((f) => f.file.startsWith(`prompts/${section.dir}/`));
  put(main, 
    el(
      "div",
      { class: "section" },
      sectionHead(section, el("button", { class: "btn small", text: "New prompt", attrs: { type: "button" }, on: { click: () => newPromptDialog(section) } })),
      el(
        "div",
        { class: "section-body" },
        el("div", { class: "list" }, el("div", { class: "list-tools" }, searchBox(fill)), listEl),
        el(
          "div",
          { class: "editor" },
          broken.length ? el("div", { class: "note bad", text: `${plural(broken.length, "file")} in this group cannot be read. Fix them on the Problems page.` }) : null,
          selected ? promptEditor(selected, section) : el("p", { class: "empty-note", text: "This group has no prompts yet. Add one with New prompt." }),
        ),
      ),
    ),
  );
}

function promptEditor(p, section) {
  const val = (field) => draftValue("prompt", p.id, field, p[field]);
  const set = (field, value) => setDraft("prompt", p.id, field, value, p[field]);
  const override = S.brain.overrides && S.brain.overrides.byId[p.id];
  const conflictList = conflicts().filter((c) => c.kind === "prompt" && c.target === p.id);

  const text = el("textarea", {
    class: "code",
    attrs: { spellcheck: "false", "data-field": `prompt:${p.id}:text`, "aria-label": "Prompt text" },
    value: val("text"),
  });
  const meta = el("div", { class: "meta" });
  const slotNote = el("div");
  const paintMeta = () => {
    const t = text.value;
    const placeholders = val("placeholders") || [];
    const slots = [...new Set([...t.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]))];
    const unknown = slots.filter((s) => !placeholders.includes(s));
    const lead = /^\s+/.exec(t);
    const trail = /\s+$/.exec(t);
    put(meta, 
      el("span", { text: `${t.length.toLocaleString()} characters` }),
      el("span", { text: plural(t === "" ? 0 : t.split("\n").length, "line") }),
      lead ? el("span", { class: "warn", text: "Starts with blank space, which is sent as written" }) : null,
      trail ? el("span", { class: "warn", text: "Ends with blank space, which is sent as written" }) : null,
    );
    put(slotNote, 
      unknown.length
        ? el("div", { class: "note bad", text: `${unknown.map((s) => `{{${s}}}`).join(", ")} ${unknown.length === 1 ? "is" : "are"} not filled by the engine for this prompt. Saving will be refused; remove ${unknown.length === 1 ? "it" : "them"}, or list ${unknown.length === 1 ? "it" : "them"} under Placeholders only if the code fills ${unknown.length === 1 ? "it" : "them"}.` })
        : null,
    );
  };
  text.addEventListener("input", () => {
    set("text", text.value);
    paintMeta();
  });
  paintMeta();

  const placeholders = val("placeholders") || [];
  const slotChips = placeholders.length
    ? el(
        "div",
        { class: "field" },
        el("div", { class: "name", text: "Filled in by the engine" }),
        el("div", { class: "help", text: "Click one to insert it where the cursor is. The engine replaces it with real values when it sends the prompt." }),
        el(
          "div",
          { class: "chips" },
          ...placeholders.map((name) =>
            el("button", {
              class: "chip accent",
              text: `{{${name}}}`,
              attrs: { type: "button" },
              on: {
                click: () => {
                  const at = text.selectionStart ?? text.value.length;
                  text.setRangeText(`{{${name}}}`, at, text.selectionEnd ?? at, "end");
                  text.dispatchEvent(new Event("input"));
                  text.focus();
                },
              },
            }),
          ),
        ),
      )
    : null;

  const enabled = val("enabled");
  const enabledSwitch = el(
    "button",
    {
      class: "switch",
      attrs: { type: "button", role: "switch", "aria-checked": String(enabled) },
      on: { click: () => (set("enabled", !enabled), renderAll()) },
    },
    el("span", { class: "track" }),
    el("span", { text: enabled ? "In use" : "Switched off: sent as blank, its text kept here" }),
  );

  const chips = el(
    "div",
    { class: "chips" },
    el("span", { class: "chip", text: CHANNELS[val("channel")] || val("channel") }),
    p.usedBy
      ? el("span", { class: "chip", text: p.usedBy.startsWith("the system prompt") ? `Section ${p.usedBy.replace(/^the system prompt, section /, "")} of the system prompt` : `Sent from ${p.usedBy}` })
      : el("span", { class: "chip warn", text: "No engine code sends this yet" }),
    ...p.heldBy.map((h) => el("span", { class: "chip warn", attrs: { title: h.why }, text: `Held by test ${h.test}` })),
    override ? el("span", { class: "chip warn", attrs: { title: override.file }, text: override.blank ? "Switched off on this machine" : "Overridden on this machine" }) : null,
  );

  const orderField =
    p.dir === "1-core-system"
      ? el(
          "div",
          { class: "field" },
          el("div", { class: "name", text: "Place in the system prompt" }),
          el("div", { class: "help", text: "Sections are sent from the lowest number to the highest. The gaps leave room to insert one between two others." }),
          el("input", {
            attrs: { type: "number", min: "0", step: "1", "data-field": `prompt:${p.id}:order`, "aria-label": "Order" },
            value: String(val("order")),
            on: {
              change: (e) => {
                const n = Number(e.target.value);
                if (Number.isInteger(n) && n >= 0) set("order", n);
              },
            },
          }),
        )
      : null;

  const placeholdersInput = el("input", {
    attrs: { type: "text", "data-field": `prompt:${p.id}:placeholders`, "aria-label": "Placeholders", spellcheck: "false" },
    value: placeholders.join(", "),
    on: {
      change: (e) => {
        const list = e.target.value.split(",").map((s) => s.trim()).filter(Boolean);
        set("placeholders", list);
        renderAll();
      },
    },
  });
  const channelSelect = el(
    "select",
    { attrs: { "data-field": `prompt:${p.id}:channel`, "aria-label": "Channel" }, on: { change: (e) => set("channel", e.target.value) } },
    ...S.brain.channels.map((c) => el("option", { attrs: { value: c, selected: c === val("channel") }, text: `${c}: ${CHANNELS[c] || ""}` })),
  );

  return el(
    "div",
    { class: "editor-inner" },
    conflictList.length ? conflictNote(conflictList) : null,
    el(
      "div",
      { class: "title-row" },
      el("input", {
        class: "title-input",
        attrs: { type: "text", "aria-label": "Name", "data-field": `prompt:${p.id}:label` },
        value: val("label"),
        on: { input: (e) => set("label", e.target.value) },
      }),
      enabledSwitch,
    ),
    el("div", { class: "idline", text: `${p.id}  in  ${p.file}` }),
    chips,
    override
      ? el("div", { class: "note warn" }, `On this machine ${override.file} replaces this text${override.blank ? " with nothing, so the prompt is off" : ""}. MAGENTRA sends that file, not the text below, until you delete it.`)
      : null,
    el(
      "div",
      { class: "field" },
      el("div", { class: "name", text: "When it is used" }),
      el("textarea", {
        attrs: { rows: "2", "data-field": `prompt:${p.id}:where`, "aria-label": "When it is used" },
        value: val("where"),
        on: { input: (e) => set("where", e.target.value.replace(/\n/g, " ")) },
      }),
    ),
    orderField,
    el("div", { class: "field" }, el("div", { class: "name" }, "Text", el("small", { text: "sent to the model exactly as written" })), text, meta, slotNote),
    slotChips,
    el(
      "details",
      { class: "more" },
      el("summary", { text: "More settings" }),
      el(
        "div",
        { class: "form" },
        el("div", { class: "field" }, el("div", { class: "name", text: "Placeholders" }), el("div", { class: "help", text: "The {{names}} the engine fills, separated by commas, in the order the code declares them. Change these only together with the code." }), placeholdersInput),
        el("div", { class: "field" }, el("div", { class: "name", text: "Channel" }), el("div", { class: "help", text: "How the prompt reaches the model. It describes the prompt; the code decides where it really goes." }), channelSelect),
        el(
          "div",
          { class: "row" },
          hasDraft("prompt", p.id) ? el("button", { class: "btn small", text: "Undo my changes to this prompt", attrs: { type: "button" }, on: { click: () => discardDraft("prompt", p.id) } }) : null,
          el("button", {
            class: "btn small danger",
            text: "Delete this prompt",
            attrs: { type: "button" },
            on: { click: () => review([{ op: "prompt.delete", id: p.id }], { title: `Delete ${p.id}` }) },
          }),
        ),
      ),
    ),
  );
}

function conflictNote(list) {
  return el(
    "div",
    { class: "note warn" },
    el("b", { text: "This changed on disk while you were editing it, maybe by an agent or a git command." }),
    ...list.map((c) =>
      el(
        "div",
        { class: "row" },
        el("span", { text: `${words(c.field.replace(/^param:/, "parameter "))}:` }),
        el("button", { class: "btn small", text: "Keep my version", attrs: { type: "button" }, on: { click: () => keepMine(c.kind, c.target, c.field) } }),
        el("button", { class: "btn small ghost", text: "Use the version on disk", attrs: { type: "button" }, on: { click: () => useDisk(c.kind, c.target, c.field) } }),
      ),
    ),
  );
}

function newPromptDialog(section) {
  const prefix = { core: "system.", conditional: "system.", reminders: "reminder.", finishing: "finishing.", background: "", toolnotes: "" }[section.id] || "";
  const core = section.id === "core";
  const maxOrder = Math.max(0, ...S.brain.prompts.filter((p) => p.order !== undefined).map((p) => p.order));
  const f = {
    id: el("input", { attrs: { type: "text", spellcheck: "false", "aria-label": "Id" }, value: prefix }),
    label: el("input", { attrs: { type: "text", "aria-label": "Name" } }),
    where: el("input", { attrs: { type: "text", "aria-label": "When it is used" } }),
    order: core ? el("input", { attrs: { type: "number", min: "0", "aria-label": "Order" }, value: String(maxOrder + 10) }) : null,
    text: el("textarea", { class: "code", attrs: { spellcheck: "false", "aria-label": "Text" } }),
  };
  f.text.style.minHeight = "180px";
  const field = (name, help, input) => (input ? el("div", { class: "field" }, el("div", { class: "name", text: name }), help ? el("div", { class: "help", text: help }) : null, input) : null);
  openForm(
    `New prompt in ${section.title}`,
    core
      ? "A new system prompt section is sent with every request as soon as the engine is built."
      : "A new prompt here is not sent until engine code names it with brainPrompt(\"<id>\"). Ask for that code change separately.",
    [
      field("Id", "Dotted, lower case, unique, e.g. system.house-rules. It is also the file name.", f.id),
      field("Name", null, f.label),
      field("When it is used", "One line for people; the model never reads it.", f.where),
      field("Place in the system prompt", "Sent from the lowest number to the highest.", f.order),
      field("Text", "Sent to the model exactly as written.", f.text),
    ],
    "Review",
    () => {
      const change = {
        op: "prompt.create",
        id: f.id.value.trim(),
        group: section.dir,
        label: f.label.value.trim(),
        channel: DEFAULT_CHANNEL[section.id],
        where: f.where.value.trim(),
        text: f.text.value,
      };
      if (core) change.order = Number(f.order.value);
      review([change], { title: `Create ${change.id}`, after: () => go(section.id, change.id) });
    },
  );
}

/* ---- tools -------------------------------------------------------------------- */

function renderToolSection(main, section) {
  const tools = S.brain.tools;
  const selected = tools.find((t) => t.name === S.route.item) || tools[0];
  const listEl = el("ul", { class: "items", attrs: { "aria-label": "Tools" } });
  const fill = () => {
    const q = S.search.trim().toLowerCase();
    const shown = tools.filter((t) => !q || t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q));
    put(listEl, 
      ...shown.map((t) =>
        el(
          "li",
          null,
          el(
            "button",
            {
              class: t.offered.main || t.offered.overdrive ? "" : "off",
              attrs: { type: "button", "aria-current": selected && t.name === selected.name ? "true" : undefined },
              dataset: { key: `tool:${t.name}` },
              on: { click: () => go("tools", t.name) },
            },
            el("span"),
            el("span", { class: "label", text: t.name }),
            el("span", { class: "flags" }, hasDraft("tool", t.name) ? el("span", { class: "dot draft", attrs: { title: "Unsaved change" } }) : null),
            el("span", { class: "id", text: t.offered.main ? (t.offered.overdrive ? "offered" : "offered, not in OVERDRIVE") : t.offered.overdrive ? "only in OVERDRIVE" : "withheld" }),
          ),
        ),
      ),
    );
    if (!shown.length) listEl.append(el("li", { class: "empty-note", text: "Nothing matches." }));
  };
  fill();
  put(main, 
    el(
      "div",
      { class: "section" },
      sectionHead(section),
      el("div", { class: "section-body" }, el("div", { class: "list" }, el("div", { class: "list-tools" }, searchBox(fill)), listEl), el("div", { class: "editor" }, selected ? toolEditor(selected) : null)),
    ),
  );
}

function toolEditor(t) {
  const conflictList = conflicts().filter((c) => c.kind === "tool" && c.target === t.name);
  const desc = el("textarea", {
    class: "code",
    attrs: { spellcheck: "false", "data-field": `tool:${t.name}:description`, "aria-label": "Description" },
    value: draftValue("tool", t.name, "description", t.description),
    on: { input: (e) => setDraft("tool", t.name, "description", e.target.value, t.description) },
  });
  const slots = [...new Set([...t.description.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]))];
  const offered = (ctx) => draftValue("access", t.name, ctx, t.offered[ctx]);
  const accessSwitch = (ctx, label) =>
    el(
      "button",
      {
        class: `switch${ctx === "overdrive" ? " od" : ""}`,
        attrs: { type: "button", role: "switch", "aria-checked": String(offered(ctx)) },
        on: { click: () => (setDraft("access", t.name, ctx, !offered(ctx), t.offered[ctx]), renderAll()) },
      },
      el("span", { class: "track" }),
      el("span", { text: label }),
    );
  return el(
    "div",
    { class: "editor-inner" },
    conflictList.length ? conflictNote(conflictList) : null,
    el("div", { class: "title-row" }, el("h2", { class: "title-input", text: t.name }), accessSwitch("main", "Offered"), accessSwitch("overdrive", "In OVERDRIVE")),
    el("div", { class: "chips" }, ...t.heldBy.map((h) => el("span", { class: "chip warn", attrs: { title: h.why }, text: `Held by test ${h.test}` }))),
    el(
      "div",
      { class: "field" },
      el("div", { class: "name" }, "What the tool says it does", el("small", { text: "sent with every request that offers the tool" })),
      slots.length ? el("div", { class: "help", text: `Keep ${slots.map((s) => `{{${s}}}`).join(", ")}: the tool's code fills ${slots.length === 1 ? "it" : "them"} with real values.` }) : null,
      desc,
    ),
    t.params.length
      ? el(
          "div",
          { class: "field" },
          el("div", { class: "name", text: "What each input means" }),
          el("div", { class: "help", text: "Each text describes one input the model fills in when it calls the tool. The tool's code decides which inputs exist." }),
          el(
            "div",
            { class: "params" },
            ...t.params.map((param) =>
              el(
                "div",
                { class: "param" },
                el("div", { class: "param-head" }, el("code", { text: param.path }), hasDraft("tool", t.name, `param:${param.path}`) ? el("span", { class: "dot draft" }) : null),
                el("textarea", {
                  attrs: { spellcheck: "false", "data-field": `tool:${t.name}:param:${param.path}`, "aria-label": `Input ${param.path}` },
                  value: draftValue("tool", t.name, `param:${param.path}`, param.text),
                  on: { input: (e) => setDraft("tool", t.name, `param:${param.path}`, e.target.value, param.text) },
                }),
              ),
            ),
          ),
        )
      : el("p", { class: "empty-note", text: "This tool has no input texts." }),
    hasDraft("tool", t.name) || hasDraft("access", t.name)
      ? el("div", { class: "row" }, el("button", { class: "btn small", text: "Undo my changes to this tool", attrs: { type: "button" }, on: { click: () => (delete S.drafts[`access:${t.name}`], discardDraft("tool", t.name)) } }))
      : null,
  );
}

/* ---- tool access ---------------------------------------------------------------- */

function renderAccess(main, section) {
  const rows = S.brain.tools.map((t) => {
    const cell = (ctx) => {
      const on = draftValue("access", t.name, ctx, t.offered[ctx]);
      return el(
        "td",
        null,
        el(
          "button",
          {
            class: `switch${ctx === "overdrive" ? " od" : ""}`,
            attrs: { type: "button", role: "switch", "aria-checked": String(on), "aria-label": `${t.name} ${ctx === "main" ? "normally" : "in OVERDRIVE"}` },
            on: { click: () => (setDraft("access", t.name, ctx, !on, t.offered[ctx]), renderAll()) },
          },
          el("span", { class: "track" }),
          el("span", { text: on ? "Offered" : "Withheld" }),
        ),
      );
    };
    return el(
      "tr",
      { class: hasDraft("access", t.name) ? "drafted" : "" },
      el("td", null, el("div", { class: "tool-name", text: t.name }), el("div", { class: "tool-note", text: (t.description.split(/(?<=\.)\s/)[0] || "").slice(0, 110) })),
      cell("main"),
      cell("overdrive"),
    );
  });
  put(main, 
    el(
      "div",
      { class: "section" },
      sectionHead(section),
      el(
        "div",
        { class: "section-body single" },
        el(
          "div",
          { class: "editor" },
          el(
            "div",
            { class: "editor-inner" },
            S.brain.shipped ? el("div", { class: "note", text: "The shipped brain withholds Agent and Workflow on purpose: helper agents are not ready yet. A tool that is withheld is not sent to the model, and a call to it is refused by name." }) : null,
            el("table", { class: "access" }, el("thead", null, el("tr", null, el("th", { text: "Tool" }), el("th", { text: "Normal mode" }), el("th", { text: "OVERDRIVE" }))), el("tbody", null, ...rows)),
          ),
        ),
      ),
    ),
  );
}

/* ---- behaviour ------------------------------------------------------------------- */

function renderBehavior(main, section) {
  const b = S.brain;
  const groups = Object.keys(KNOB_GROUPS).filter((g) => b.knobs.some((k) => k.key.startsWith(`${g}.`)));
  const current = groups.includes(S.route.item) ? S.route.item : groups[0];
  const listEl = el(
    "ul",
    { class: "items", attrs: { "aria-label": "Knob groups" } },
    ...groups.map((g) =>
      el(
        "li",
        null,
        el(
          "button",
          { attrs: { type: "button", "aria-current": g === current ? "true" : undefined }, on: { click: () => go("behavior", g) } },
          el("span"),
          el("span", { class: "label", text: KNOB_GROUPS[g] }),
          el("span", { class: "flags" }, b.knobs.some((k) => k.key.startsWith(`${g}.`) && (hasDraft("knob", k.key) || hasDraft("od", k.key))) ? el("span", { class: "dot draft" }) : null),
          el("span", { class: "id", text: plural(b.knobs.filter((k) => k.key.startsWith(`${g}.`) && k.rule.type !== "overrides").length, "knob") }),
        ),
      ),
    ),
  );
  const knobs = b.knobs.filter((k) => k.key.startsWith(`${current}.`) && k.rule.type !== "overrides");
  const overridable = b.overridable.includes(current);
  const blocks = [];
  let lastSub = null;
  for (const k of knobs) {
    const parts = k.key.split(".");
    const sub = parts.slice(0, -1).join(".");
    if (sub !== lastSub) {
      lastSub = sub;
      blocks.push(el("div", { class: "knob-group" }, el("h3", { text: parts.slice(0, -1).map(words).join(" › ") }), b.sections[sub] ? el("p", { text: b.sections[sub] }) : null));
    }
    blocks.push(knobRow(k, overridable));
  }
  put(main, 
    el(
      "div",
      { class: "section" },
      sectionHead(section),
      el(
        "div",
        { class: "section-body" },
        el("div", { class: "list" }, el("div", { class: "list-tools" }, el("span", { class: "range", text: "Groups" })), listEl),
        el(
          "div",
          { class: "editor" },
          el(
            "div",
            { class: "editor-inner" },
            !b.behavior ? el("div", { class: "note bad", text: "behavior.json cannot be read. Fix it on the Problems page." }) : null,
            current === "overdrive" ? el("div", { class: "note od", text: "What OVERDRIVE changes in the other groups is set next to each knob there, in its OVERDRIVE column." }) : null,
            el("div", { class: "knobs" }, ...blocks),
          ),
        ),
      ),
    ),
  );
}

function knobRow(k, overridable) {
  const value = draftValue("knob", k.key, "value", k.value);
  const drafted = hasDraft("knob", k.key) || hasDraft("od", k.key);
  const control = knobControl(k.rule, value, (v) => setDraft("knob", k.key, "value", v, k.value), `knob:${k.key}`, false);
  let od = null;
  if (overridable) {
    const base = k.overdriveValue !== undefined ? k.overdriveValue : null;
    const odValue = draftValue("od", k.key, "value", base);
    od =
      odValue === null
        ? el(
            "div",
            { class: "knob-od" },
            el("span", { class: "label", text: "In OVERDRIVE" }),
            el("span", { class: "same", text: "Same as normal" }),
            el("button", { class: "btn small ghost", text: "Set a different value", attrs: { type: "button" }, on: { click: () => (setDraft("od", k.key, "value", value, base), renderAll()) } }),
          )
        : el(
            "div",
            { class: "knob-od" },
            el("span", { class: "label", text: "In OVERDRIVE" }),
            knobControl(k.rule, odValue, (v) => setDraft("od", k.key, "value", v, base), `od:${k.key}`, true),
            el("button", { class: "btn small ghost", text: "Use the normal value", attrs: { type: "button" }, on: { click: () => (setDraft("od", k.key, "value", null, base), renderAll()) } }),
          );
  }
  const name = k.key.split(".").pop();
  return el(
    "div",
    { class: `knob${drafted ? " drafted" : ""}` },
    el("div", { class: "knob-name" }, el("b", { text: words(name) }), el("code", { text: k.key }), el("p", { text: k.rule.doc })),
    el("div", { class: "knob-control" }, control),
    od || el("div"),
  );
}

/** A control for one knob rule. `onChange(value)` records the draft. */
function knobControl(rule, value, onChange, fieldId, od) {
  if (rule.type === "bool") {
    return el(
      "button",
      { class: `switch${od ? " od" : ""}`, attrs: { type: "button", role: "switch", "aria-checked": String(Boolean(value)), "data-field": fieldId }, on: { click: () => (onChange(!value), renderAll()) } },
      el("span", { class: "track" }),
      el("span", { text: value ? "On" : "Off" }),
    );
  }
  if (rule.type === "enum") {
    return el(
      "div",
      { class: `segmented${od ? " od" : ""}`, attrs: { role: "group" } },
      ...rule.values.map((v) => el("button", { text: v, attrs: { type: "button", "aria-pressed": String(v === value) }, on: { click: () => (onChange(v), renderAll()) } })),
    );
  }
  if (rule.type === "int") {
    const note = el("span", { class: "range", text: `${rule.min.toLocaleString()} to ${rule.max.toLocaleString()}` });
    const input = el("input", {
      attrs: { type: "number", min: String(rule.min), max: String(rule.max), step: "1", "data-field": fieldId },
      value: String(value),
      on: {
        input: (e) => {
          const n = Number(e.target.value);
          const okay = e.target.value !== "" && Number.isInteger(n) && n >= rule.min && n <= rule.max;
          note.className = okay ? "range" : "range bad";
          note.textContent = okay ? `${rule.min.toLocaleString()} to ${rule.max.toLocaleString()}` : `Must be a whole number from ${rule.min.toLocaleString()} to ${rule.max.toLocaleString()}`;
          if (e.target.value !== "" && Number.isFinite(n)) onChange(n);
        },
      },
    });
    return el("div", { class: "knob-control" }, input, note);
  }
  if (rule.type === "list") {
    const list = Array.isArray(value) ? value : [];
    const pattern = new RegExp(rule.item.source, rule.item.flags);
    const hint = el("span", { class: "range", text: `${list.length} of ${rule.min} to ${rule.max} entries` });
    const add = el("input", {
      class: "tag-add",
      attrs: { type: "text", placeholder: "Add, then Enter", spellcheck: "false", "data-field": `${fieldId}:add`, "aria-label": "Add an entry" },
      on: {
        keydown: (e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          const v = e.target.value.trim();
          if (!v) return;
          if (!pattern.test(v)) {
            hint.className = "range bad";
            hint.textContent = `"${v}" is not allowed here`;
            return;
          }
          if (list.includes(v)) {
            hint.className = "range bad";
            hint.textContent = `"${v}" is already in the list`;
            return;
          }
          onChange([...list, v]);
          renderAll();
        },
      },
    });
    return el(
      "div",
      { class: "knob-control" },
      el(
        "div",
        { class: "tags" },
        ...list.map((item, i) =>
          el(
            "span",
            { class: "tag" },
            item,
            el("button", { text: "×", attrs: { type: "button", "aria-label": `Remove ${item}` }, on: { click: () => (onChange(list.filter((_, j) => j !== i)), renderAll()) } }),
          ),
        ),
      ),
      add,
      hint,
    );
  }
  return el("span", { class: "range", text: "Edited per key in the other groups." });
}

/* ---- what the model reads ------------------------------------------------------- */

function renderModelView(main) {
  const body = el("div", { class: "editor-inner" }, el("p", { class: "empty-note", text: "Asking the engine…" }));
  put(main, 
    el(
      "div",
      { class: "section" },
      el("div", { class: "section-head" }, el("h2", { text: "What the model reads" }), el("p", { text: "The system prompt as the last build of the engine assembles it from the saved brain, for a sample workspace. Unsaved changes are not in it. Prompt overrides on this machine are left out." })),
      el("div", { class: "section-body single" }, el("div", { class: "editor" }, body)),
    ),
  );
  const show = (r) => {
    if (!r.available) {
      put(body, el("div", { class: "note warn", text: `The engine cannot be asked: ${r.reason}.` }));
      return;
    }
    if (!r.ok) {
      put(body, el("div", { class: "note bad", text: `The engine does not load this brain: ${r.error}` }));
      return;
    }
    const pins = S.brain.shipped && r.pins ? Object.entries(r.pins) : [];
    put(body, 
      el(
        "div",
        { class: "chips" },
        el("span", { class: "chip accent", text: "The engine loads this brain" }),
        ...pins.map(([test, pin]) => el("span", { class: `chip ${pin.holds ? "" : "warn"}`, attrs: { title: pin.difference || "" }, text: `${test}: ${pin.holds ? "matches the approved text" : "differs from the approved text"}` })),
        el("button", { class: "chip", text: "Copy", attrs: { type: "button" }, on: { click: () => navigator.clipboard.writeText(r.systemPrompt).then(() => toast("Copied the system prompt.", "ok")) } }),
      ),
      r.unreadParams && r.unreadParams.length ? el("div", { class: "note warn", text: `Input texts no tool reads (never sent): ${r.unreadParams.join(", ")}` }) : null,
      el("pre", { class: "preview", text: r.systemPrompt }),
    );
  };
  if (S.engine && S.engine.revision === S.brain.revision) show(S.engine.result);
  else
    api("/api/engine")
      .then((result) => {
        S.engine = { revision: S.brain.revision, result };
        if (S.route.view === "model") show(result);
      })
      .catch((err) => put(body, el("div", { class: "note bad", text: err.message })));
}

/* ---- problems -------------------------------------------------------------------- */

function renderProblems(main) {
  const b = S.brain;
  const broken = b.brokenFiles.map((f) =>
    el(
      "div",
      { class: "field" },
      el("div", { class: "name" }, el("code", { text: f.file })),
      el("ul", null, ...f.problems.map((p) => el("li", { text: p.replace(`${f.file}: `, "") }))),
      el("textarea", {
        class: "code",
        attrs: { spellcheck: "false", "data-field": `file:${f.file}`, "aria-label": `Contents of ${f.file}` },
        value: draftValue("file", f.file, "content", f.raw),
        on: { input: (e) => setDraft("file", f.file, "content", e.target.value, f.raw) },
      }),
    ),
  );
  const fileless = b.problems.filter((p) => !b.brokenFiles.some((f) => p.startsWith(`${f.file}: `)));
  put(main, 
    el(
      "div",
      { class: "section" },
      el("div", { class: "section-head" }, el("h2", { text: b.problems.length ? "Problems" : "Warnings" }), el("p", { text: "Problems stop the build; fix each one here or in its section. Warnings never stop it: each names a prompt that states a value the knobs no longer have." })),
      el(
        "div",
        { class: "section-body single" },
        el(
          "div",
          { class: "editor" },
          el(
            "div",
            { class: "editor-inner" },
            fileless.length ? el("div", { class: "note bad" }, el("b", { text: "Problems" }), el("ul", null, ...fileless.map((p) => el("li", { text: p })))) : null,
            broken.length ? el("p", { text: "These files cannot be read. Edit them as plain files; the save checks them like any other change." }) : null,
            ...broken,
            b.warnings.length ? el("div", { class: "note warn" }, el("b", { text: "Warnings" }), el("ul", null, ...b.warnings.map((w) => el("li", { text: w })))) : null,
            !b.problems.length && !b.warnings.length ? el("p", { class: "empty-note", text: "Nothing to fix." }) : null,
          ),
        ),
      ),
    ),
  );
}

/* ---- save bar and review ---------------------------------------------------------- */

function renderSaveBar() {
  const n = Object.values(S.drafts).reduce((sum, d) => sum + Object.keys(d.fields).length, 0);
  $("saveBar").hidden = n === 0;
  $("saveCount").textContent = `${plural(n, "unsaved change")}`;
}

/** A line diff (longest common subsequence), with three lines of context around each change. */
function lineDiff(before, after) {
  const a = before === null ? [] : before.split("\n");
  const b = after === null ? [] : after.split("\n");
  if (a.length * b.length > 4_000_000) return [{ t: "gap", s: "This file is too large to compare here." }];
  const dp = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) ops.push({ t: "same", s: a[i++], k: j++ });
    else if (j < b.length && (i >= a.length || dp[i][j + 1] >= dp[i + 1][j])) ops.push({ t: "add", s: b[j++] });
    else ops.push({ t: "del", s: a[i++] });
  }
  const keep = ops.map(() => false);
  ops.forEach((op, n) => {
    if (op.t !== "same") for (let m = Math.max(0, n - 3); m <= Math.min(ops.length - 1, n + 3); m++) keep[m] = true;
  });
  const out = [];
  let skipped = 0;
  ops.forEach((op, n) => {
    if (keep[n]) {
      if (skipped) out.push({ t: "gap", s: `… ${plural(skipped, "line")} unchanged` });
      skipped = 0;
      out.push(op);
    } else skipped++;
  });
  if (skipped) out.push({ t: "gap", s: `… ${plural(skipped, "line")} unchanged` });
  return out;
}

function diffView(file) {
  const status = file.before === null ? "new file" : file.after === null ? "deleted" : "changed";
  return el(
    "div",
    { class: "diff" },
    el("div", { class: "diff-file", text: `${file.path}  (${status})` }),
    ...lineDiff(file.before, file.after).map((l) => el("div", { class: l.t, text: `${l.t === "add" ? "+ " : l.t === "del" ? "- " : "  "}${l.s === "" ? " " : l.s}` })),
  );
}

/**
 * Plans `changes` on the server and shows the result. On "Save", applies the
 * same changes with the acknowledgements ticked. `opts.fromDrafts` clears the
 * drafts after a successful save.
 */
async function review(changes, opts) {
  opts = opts || {};
  const dialog = $("reviewDialog");
  if (!changes.length) return;
  put(dialog, el("div", { class: "sheet-head" }, el("h2", { attrs: { id: "reviewTitle" }, text: "Checking…" }), el("p", { text: "Staging a copy of the brain, compiling it, and loading it into the engine." })));
  if (!dialog.open) dialog.showModal();
  setBusy(true);
  const revision = S.brain.revision;
  const { data: plan } = await post("/api/plan", { changes, expectRevision: revision }).finally(() => setBusy(false));
  showPlan(dialog, plan, changes, revision, opts);
}

function showPlan(dialog, plan, changes, revision, opts, applied) {
  if (plan.error) {
    put(dialog, el("div", { class: "sheet-head bad" }, el("h2", { text: "The check did not run" }), el("p", { text: plan.error })), el("div", { class: "sheet-foot" }, el("button", { class: "btn", text: "Close", attrs: { type: "button" }, on: { click: () => dialog.close() } })));
    return;
  }
  const code = plan.refusal ? plan.refusal.code : null;
  const blocking = code && code !== "needs-acknowledge";
  const acks = plan.heldBy.map((h) => ({ h, box: el("input", { attrs: { type: "checkbox", "aria-label": `Accept moving ${h.test}` } }) }));
  const save = el("button", { class: "btn primary", text: `Save ${plural(plan.files.length, "file")}`, attrs: { type: "button" } });
  const syncSave = () => (save.disabled = Boolean(blocking) || plan.files.length === 0 || acks.some((a) => !a.box.checked));
  for (const a of acks) a.box.addEventListener("change", syncSave);
  syncSave();
  save.addEventListener("click", async () => {
    save.disabled = true;
    setBusy(true);
    const { data: result } = await post("/api/apply", { changes, expectRevision: revision, acknowledge: acks.map((a) => a.h.test) }).finally(() => setBusy(false));
    if (result.applied) {
      dialog.close();
      if (opts.fromDrafts) {
        S.drafts = {};
        saveDrafts();
      }
      const fired = keysOfChanges(changes);
      toast(`Saved ${plural(result.files.length, "file")}.${result.shipped ? " Build to put it into the engine." : ""}`, "ok");
      await load();
      for (const map of [homeMap, miniMap]) if (map) map.fire(fired);
      if (opts.after) opts.after();
    } else {
      if (homeMap) homeMap.setMode("error");
      showPlan(dialog, result, changes, revision, opts, true);
    }
  });

  const ok = plan.ok && plan.files.length > 0;
  const title = plan.files.length === 0 && !code ? "Nothing to save" : code ? REFUSAL_TITLES[code] || "Refused" : opts.title || "Ready to save";
  const lede =
    plan.files.length === 0 && !code
      ? "The files already say this."
      : code === "needs-acknowledge"
        ? "The change checks out, and it moves text the tests hold in the shipped brain. Tick each test to save anyway; the owner then approves the new text."
        : plan.refusal
          ? plan.refusal.message
          : "The brain compiles, the engine loads it, and every text compiles back to exactly what you wrote.";
  const engineLine = plan.engine.checked
    ? `The engine ${plan.engine.loads ? "loads the changed brain" : "does not load the changed brain"}.${plan.engine.systemPromptChanged ? " The system prompt changes." : ""}${plan.engine.toolsChanged ? " What the tools say changes." : ""}`
    : `The engine was not asked: ${plan.engine.reason}.`;
  put(dialog, 
    el("div", { class: `sheet-head ${ok || code === "needs-acknowledge" ? "ok" : code ? "bad" : ""}` }, el("h2", { attrs: { id: "reviewTitle" }, text: title }), el("p", { text: lede })),
    el(
      "div",
      { class: "sheet-body" },
      plan.summary.length ? el("div", null, el("h3", { text: "What changes" }), el("ul", null, ...plan.summary.map((s) => el("li", { text: s })))) : null,
      acks.length
        ? el(
            "div",
            { class: "form" },
            el("h3", { text: "Tests this moves" }),
            ...acks.map(({ h, box }) => el("label", { class: "ack" }, box, el("b", { text: h.test }), el("span", { text: h.why }))),
          )
        : null,
      plan.newProblems.length ? el("div", { class: "note bad" }, el("b", { text: "New problems" }), el("ul", null, ...plan.newProblems.map((p) => el("li", { text: p })))) : null,
      plan.mismatches.length ? el("div", { class: "note bad" }, el("ul", null, ...plan.mismatches.map((p) => el("li", { text: p })))) : null,
      plan.newWarnings.length ? el("div", { class: "note warn" }, el("b", { text: "Warnings (they do not stop the save)" }), el("ul", null, ...plan.newWarnings.map((w) => el("li", { text: w })))) : null,
      plan.fixedProblems.length ? el("div", { class: "note" }, el("b", { text: "Fixes" }), el("ul", null, ...plan.fixedProblems.map((p) => el("li", { text: p })))) : null,
      plan.files.length ? el("p", { class: "meta", text: engineLine }) : null,
      ...plan.files.map(diffView),
    ),
    el(
      "div",
      { class: "sheet-foot" },
      el("span", { class: "grow", text: applied ? "Nothing was written." : plan.shipped ? "Saving writes brain/. Build afterwards to put it into the engine." : "Saving writes the profile folder." }),
      code === "stale" ? el("button", { class: "btn", text: "Load the new version", attrs: { type: "button" }, on: { click: () => (dialog.close(), load()) } }) : null,
      el("button", { class: "btn ghost", text: blocking || plan.files.length === 0 ? "Close" : "Cancel", attrs: { type: "button" }, on: { click: () => dialog.close() } }),
      blocking || plan.files.length === 0 ? null : save,
    ),
  );
}

/** Brain-map keys for the items a list of changes touches. */
function keysOfChanges(changes) {
  return changes.map((c) =>
    c.op.startsWith("prompt.") ? `prompt:${c.id}` : c.op === "tool.update" ? `tool:${c.name}` : c.op === "availability.update" ? `access:${c.tool}` : c.op.startsWith("behavior.") ? `knob:${c.key}` : `file:${c.path}`,
  );
}

function setBusy(on) {
  for (const map of [homeMap, miniMap]) if (map) map.setMode(on ? "busy" : S.build && S.build.running ? "busy" : "idle");
}

/* ---- forms: new profile, open folder ---------------------------------------------- */

function openForm(title, lede, fields, actionLabel, onAction) {
  const dialog = $("formDialog");
  const action = el("button", { class: "btn primary", text: actionLabel, attrs: { type: "submit" } });
  const form = el(
    "form",
    {
      attrs: { method: "dialog" },
      on: {
        submit: (e) => {
          e.preventDefault();
          dialog.close();
          onAction();
        },
      },
    },
    el("div", { class: "sheet-head" }, el("h2", { text: title }), lede ? el("p", { text: lede }) : null),
    el("div", { class: "sheet-body" }, el("div", { class: "form" }, ...fields.filter(Boolean))),
    el("div", { class: "sheet-foot" }, el("button", { class: "btn ghost", text: "Cancel", attrs: { type: "button" }, on: { click: () => dialog.close() } }), action),
  );
  put(dialog, form);
  dialog.showModal();
  const first = form.querySelector("input, textarea");
  if (first) first.focus();
}

function profileDialog() {
  const input = el("input", { attrs: { type: "text", spellcheck: "false", placeholder: "../magentra-brains/careful-reviewer", "aria-label": "Folder" } });
  openForm(
    "Copy this brain to a new folder",
    "A profile is a full copy of a brain that you can change freely. No test holds it, and the engine is still built from brain/ only. The folder must be new or empty; nothing is ever overwritten.",
    [el("div", { class: "field" }, el("div", { class: "name", text: "New folder" }), el("div", { class: "help", text: "A path relative to the repository, or an absolute path." }), input)],
    "Copy",
    async () => {
      const { data } = await post("/api/profile", { to: input.value });
      if (!data.ok) return toast(data.message || data.error || "The copy failed.", "bad");
      toast(data.message, "ok");
      openForm("Profile created", data.message, [], "Open it now", () => openFolder(data.dir));
    },
  );
}

function openFolderDialog() {
  const input = el("input", { attrs: { type: "text", spellcheck: "false", placeholder: "../magentra-brains/careful-reviewer", "aria-label": "Folder" } });
  openForm("Open another brain folder", "Edit a profile folder with the same checks. Unsaved changes stay with the folder they were made in.", [el("div", { class: "field" }, el("div", { class: "name", text: "Folder" }), input)], "Open", () => openFolder(input.value));
}

async function openFolder(dir) {
  const { ok, data } = await post("/api/open", { dir });
  if (!ok) return toast(data.error || "That folder cannot be opened.", "bad");
  S.search = "";
  go("home");
  await load();
}

/* ---- build ----------------------------------------------------------------------- */

async function startBuild() {
  const { ok, data } = await post("/api/build", {});
  if (!ok) return toast(data.error || "The build did not start.", "bad");
  S.build = data;
  renderTop();
  showBuild();
  setBusy(true);
}

function showBuild() {
  const dialog = $("buildDialog");
  const b = S.build;
  const done = b && !b.running;
  const good = done && b.exitCode === 0;
  put(dialog, 
    el(
      "div",
      { class: `sheet-head ${done ? (good ? "ok" : "bad") : ""}` },
      el("h2", { attrs: { id: "buildTitle" }, text: !b ? "No build yet" : b.running ? "Building the engine" : good ? "Built" : "The build failed" }),
      el("p", { text: "npm run build: compile brain/ into the engine, then compile the engine." }),
    ),
    el("div", { class: "sheet-body" }, el("pre", { class: "log", attrs: { id: "buildLog" }, text: b ? b.log || "Starting…" : "" })),
    el("div", { class: "sheet-foot" }, el("button", { class: "btn", text: "Close", attrs: { type: "button" }, on: { click: () => dialog.close() } })),
  );
  if (!dialog.open) dialog.showModal();
  const log = $("buildLog");
  if (log) log.scrollTop = log.scrollHeight;
}

/* ---- events ------------------------------------------------------------------------ */

function listen() {
  const events = new EventSource("/api/events");
  events.onmessage = (e) => {
    const event = JSON.parse(e.data);
    if (event.type === "brain") load().catch((err) => toast(err.message, "bad"));
    if (event.type === "build") {
      const wasRunning = S.build && S.build.running;
      S.build = event.build;
      renderTop();
      if ($("buildDialog").open) showBuild();
      if (wasRunning && !event.build.running) {
        const good = event.build.exitCode === 0;
        setBusy(false);
        for (const map of [homeMap, miniMap]) if (map) map.setMode(good ? "success" : "error");
        toast(good ? "Built. The engine now carries this brain." : "The build failed. Open the log to see why.", good ? "ok" : "bad");
        load();
      }
    }
  };
}

function wire() {
  window.addEventListener("hashchange", () => {
    parseRoute();
    renderAll();
    $("main").focus({ preventScroll: true });
  });
  $("reviewButton").addEventListener("click", () => review(changesFromDrafts(), { fromDrafts: true }));
  $("discardAll").addEventListener("click", () => {
    if (!confirm("Discard every unsaved change?")) return;
    S.drafts = {};
    saveDrafts();
    renderAll();
  });
  $("buildButton").addEventListener("click", () => (S.build && S.build.running ? showBuild() : startBuild()));
  $("engineStatus").addEventListener("click", () => S.build && showBuild());
  const menu = $("folderMenu");
  const toggleMenu = (open) => {
    menu.hidden = !open;
    $("folderButton").setAttribute("aria-expanded", String(open));
  };
  $("folderButton").addEventListener("click", (e) => {
    e.stopPropagation();
    toggleMenu(menu.hidden);
  });
  document.addEventListener("click", () => toggleMenu(false));
  menu.addEventListener("click", (e) => {
    const action = e.target.dataset.action;
    toggleMenu(false);
    if (action === "profile") profileDialog();
    if (action === "open") openFolderDialog();
    if (action === "shipped") openFolder("");
  });
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (Object.keys(S.drafts).length) review(changesFromDrafts(), { fromDrafts: true });
    }
    if (e.key === "/" && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
      const search = document.querySelector('input[type="search"]');
      if (search) {
        e.preventDefault();
        search.focus();
      }
    }
    if (e.key === "Escape") toggleMenu(false);
  });
  window.addEventListener("beforeunload", (e) => {
    if (Object.keys(S.drafts).length) e.preventDefault();
  });
}

parseRoute();
wire();
load()
  .then(listen)
  .catch((err) => {
    put($("main"), el("div", { class: "editor" }, el("div", { class: "note bad", text: `The editor could not read the brain: ${err.message}` })));
  });
