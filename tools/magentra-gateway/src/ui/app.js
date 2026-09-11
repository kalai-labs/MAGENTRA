/*
 * The read-only surface — SPEC §11 step 5, laid out per §9.
 *
 * Vanilla, no framework, no CDN, no build. It renders three things: the
 * inventory, the gate, and what the gate is blocking. The two writes it can
 * start (reconcile a record, apply a connection profile) are the two the spec
 * marks approval-gated, and each is one deliberate click that sends the
 * action header the server requires.
 *
 * The feature detail opens on the TEST DESCRIPTION, because that is what the
 * user came to read or write; the record's prose, invariant, files and
 * dependencies follow as reference. A description is a `draft` while it is
 * being written and `ready` once the user has approved it as the specification
 * a coding agent implements — ready says nothing about a test existing. Ready
 * descriptions are set apart at the bottom, mirroring where they sit on disk
 * (tests/gateway/descriptions/ready/).
 */

"use strict";

const $ = (id) => document.getElementById(id);

const state = {
  features: [],
  gate: null,
  /** featureId → "draft" | "ready" | "none" — derived from /api/state's descriptions. */
  descOf: new Map(),
  /** { scanned, found, problems } — how discovery got on reading tests/features/. */
  testDiscovery: null,
  filters: { area: "", kind: "", status: "", fresh: "", desc: "" },
  selected: null,
};

/* ---- helpers -------------------------------------------------------- */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function tag(text, className) {
  return el("span", `tag ${className || ""}`.trim(), text);
}

async function post(path, body) {
  const res = await fetch(path, {
    method: "POST",
    // The header is what makes this an explicit UI action rather than something
    // any other page in the browser could have caused.
    headers: { "content-type": "application/json", "x-magentra-gateway-action": "1" },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

/**
 * Keep each row's freshness in step with the gate. The gate arrives on its own
 * over SSE, and a list that still said "fresh" next to a red lamp would be the
 * exact drift this tool exists to make impossible.
 */
function applyGate() {
  if (!state.gate) return;
  const stale = new Set(state.gate.freshness.stale.map((s) => s.id));
  for (const f of state.features) f.fresh = !stale.has(f.id);
}

/**
 * One word per feature about its descriptions. `draft` wins over `ready`: a
 * feature with a ready description and a new draft is still being written.
 */
function applyDescriptions(descriptions) {
  state.descOf = new Map();
  for (const d of descriptions) {
    for (const id of d.featureIds) {
      const cur = state.descOf.get(id);
      if (d.status === "draft" || cur === undefined) state.descOf.set(id, d.status);
    }
  }
  for (const f of state.features) f.desc = state.descOf.get(f.id) || "none";
}

const DESC_LABEL = { draft: "draft", ready: "ready", none: "no description" };

/* ---- header --------------------------------------------------------- */

function renderHeader() {
  const gate = state.gate;
  const fresh = gate ? gate.freshness.ok : false;
  const connected = gate ? gate.connection.kind === "connected" : false;

  $("lamp-fresh").classList.toggle("on", fresh);
  $("lamp-conn").classList.toggle("on", connected);

  const n = (pred) => state.features.filter(pred).length;
  const disagree = n((f) => f.testsAgree === false);
  $("count").textContent =
    `${state.features.length} features · ${n((f) => f.status === "untested" && !f.deferred)} untested · ` +
    `${n((f) => f.status === "partial")} partial · ${n((f) => f.status === "covered")} covered · ${n((f) => f.deferred)} deferred` +
    `${disagree ? ` · ${disagree} RECORD/FILE MISMATCH` : ""}` +
    `   |   descriptions: ${n((f) => f.desc === "ready")} ready · ${n((f) => f.desc === "draft")} draft · ${n((f) => f.desc === "none")} missing`;
}

/* ---- left column ---------------------------------------------------- */

function renderAreas() {
  const counts = new Map();
  for (const f of state.features) counts.set(f.area, (counts.get(f.area) || 0) + 1);

  const host = $("areas");
  host.textContent = "";
  const rows = [["", "all", state.features.length], ...[...counts].sort().map(([a, n]) => [a, a, n])];
  for (const [value, label, n] of rows) {
    const row = el("div", `row${state.filters.area === value ? " sel" : ""}`);
    row.append(el("span", null, label), el("span", "n", String(n)));
    row.onclick = () => {
      state.filters.area = value;
      renderAreas();
      renderList();
    };
    host.append(row);
  }
}

/**
 * Ready / draft / missing, as clickable rows with counts. This is the tracking
 * view: one glance says how much of the inventory has an approved description
 * an agent may implement, and one click lists exactly those features.
 */
function renderDescNav() {
  const host = $("descs");
  host.textContent = "";
  const count = (k) => state.features.filter((f) => f.desc === k).length;
  const rows = [
    ["", "all", state.features.length, ""],
    ["draft", DESC_LABEL.draft, count("draft"), "draft"],
    ["ready", DESC_LABEL.ready, count("ready"), "ready"],
    ["none", DESC_LABEL.none, count("none"), "nodesc"],
  ];
  for (const [value, label, n, cls] of rows) {
    const row = el("div", `row ${cls}${state.filters.desc === value ? " sel" : ""}`);
    row.append(el("span", null, label), el("span", "n", String(n)));
    row.onclick = () => {
      state.filters.desc = value;
      renderDescNav();
      renderList();
    };
    host.append(row);
  }
}

function fillSelect(select, values) {
  for (const v of values) select.append(new Option(v, v));
}

/* ---- middle column -------------------------------------------------- */

function visible() {
  const { area, kind, status, fresh, desc } = state.filters;
  return state.features.filter(
    (f) =>
      (!area || f.area === area) &&
      (!kind || f.kinds.includes(kind)) &&
      (!status || f.status === status) &&
      (!fresh || (fresh === "stale" ? !f.fresh : f.fresh)) &&
      (!desc || f.desc === desc),
  );
}

function descTag(f) {
  const cls = f.desc === "none" ? "nodesc" : f.desc;
  return tag(DESC_LABEL[f.desc], cls);
}

function renderList() {
  const host = $("list");
  host.textContent = "";
  const rows = visible();

  const head = el("h2", null, `FEATURES — ${rows.length} shown`);
  host.append(head);

  for (const f of rows) {
    const card = el("div", `feat ${f.status}${state.selected === f.id ? " sel" : ""}`);
    const line = el("div", "feat-head");
    line.append(el("b", null, f.name), el("span", "sect", f.section));
    card.append(line);

    const tags = el("div", "tags");
    tags.append(descTag(f));
    for (const k of f.kinds) tags.append(tag(k));
    tags.append(tag(f.status, f.status));
    tags.append(f.fresh ? tag("fresh", "fresh") : tag("STALE", "stale"));
    if (f.deferred) tags.append(tag("deferred", "deferred"));
    // How many tests actually exist and run for this row, and whether the
    // record's own array still agrees with them. Both come from reading
    // tests/features/, so a row can no longer look proven without being it.
    if (f.proven > 0) tags.append(tag(`${f.proven} test${f.proven === 1 ? "" : "s"}`, "covered"));
    if (f.testsAgree === false) tags.append(tag("RECORD ≠ FILES", "stale"));
    card.append(tags);

    card.onclick = () => select(f.id);
    host.append(card);
  }

  if (rows.length === 0) host.append(el("div", "note", "nothing matches these filters."));
}

/** ↑/↓ through whatever the filters are currently showing; Esc closes. */
function moveSelection(delta) {
  const rows = visible();
  if (rows.length === 0) return;
  const at = rows.findIndex((f) => f.id === state.selected);
  const next = at === -1 ? 0 : Math.min(rows.length - 1, Math.max(0, at + delta));
  select(rows[next].id);
}

async function select(id) {
  state.selected = id;
  document.body.classList.add("detail-open");
  renderList();
  scrollSelectedIntoView();
  const host = $("detail");
  host.textContent = "";
  host.append(el("div", "note", "loading…"));
  const res = await fetch(`/api/features/${encodeURIComponent(id)}`);
  if (!res.ok) return;
  const payload = await res.json();
  // A slower request for a feature the user has since navigated away from must
  // not overwrite the one they are looking at now.
  if (state.selected !== id) return;
  renderDetail(payload);
}

function deselect() {
  state.selected = null;
  document.body.classList.remove("detail-open");
  renderList();
  renderPlaceholder();
}

function scrollSelectedIntoView() {
  const card = $("list").querySelector(".feat.sel");
  if (card) card.scrollIntoView({ block: "nearest" });
}

function renderPlaceholder() {
  const host = $("detail");
  host.textContent = "";
  const box = el("div", "placeholder");
  box.append(el("div", null, "Pick a feature to read what must be tested, what it is, and what it touches."));
  const keys = el("div", "hint");
  keys.append(document.createTextNode("navigate with "));
  keys.append(el("kbd", null, "↑"), document.createTextNode(" "), el("kbd", null, "↓"));
  keys.append(document.createTextNode(" · close with "));
  keys.append(el("kbd", null, "Esc"));
  box.append(keys);
  host.append(box);
}

function renderDetail(payload) {
  const { feature, freshness, dependencies, descriptions } = payload;
  const host = $("detail");
  host.textContent = "";

  const all = descriptions || [];
  const drafts = all.filter((d) => d.status === "draft");
  const ready = all.filter((d) => d.status === "ready");

  // Sticky, so scrolling through dependencies never loses which feature this is.
  const head = el("div", null);
  head.id = "detail-head";
  head.append(el("h3", null, feature.name), el("div", "id", `${feature.id} · ${feature.area} · ${feature.section}`));
  const tags = el("div", "tags");
  tags.append(descTag(feature));
  for (const k of feature.kinds) tags.append(tag(k));
  tags.append(tag(feature.status, feature.status));
  tags.append(freshness.fresh ? tag("fresh", "fresh") : tag("STALE", "stale"));
  if (feature.deferred) tags.append(tag("deferred", "deferred"));
  head.append(tags);
  host.append(head);

  // First, because it is what the user came for.
  host.append(section(
    drafts.length ? `TEST DESCRIPTION — ${drafts.length} draft` : ready.length ? "TEST DESCRIPTION — no open draft" : "TEST DESCRIPTION — none yet",
    renderDescriptions(feature, drafts),
    "sec-desc",
  ));

  host.append(section("INVARIANT", el("div", "invariant", feature.invariant)));
  host.append(section("PROSE (verbatim from FEATURES.md)", el("div", "prose", feature.prose)));

  const files = el("ul", "files");
  for (const f of feature.entryFiles) {
    const drifted = freshness.drifted.includes(f);
    const deleted = freshness.deleted.includes(f);
    files.append(el("li", drifted ? "drift" : null, `${f}${deleted ? "  (DELETED)" : drifted ? "  (drifted)" : ""}`));
  }
  host.append(section(`ENTRY FILES — hashed ${freshness.recordedAt}`, files));

  host.append(section("DEPENDENCIES", renderDeps(dependencies)));
  const proof = payload.tests || { discovered: [], drift: null, problems: [] };
  const runnable = proof.discovered.filter((t) => t.registered).length;
  host.append(section(
    runnable === proof.discovered.length ? `TESTS — ${runnable}` : `TESTS — ${runnable} of ${proof.discovered.length} run`,
    renderTests(feature, proof, ready.length),
  ));

  // Last, and apart: ready is approved and waiting for an agent. It lives in
  // descriptions/ready/ on disk and here it is folded shut, so the working
  // view stays about what is still being written.
  if (ready.length) host.append(section(`READY FOR AN AGENT — ${ready.length}`, renderReady(feature, ready), "sec-ready"));
}

function renderDeps(deps) {
  const box = el("div");
  // §6: an empty set is never the answer — it would say "depends on nothing".
  if (!deps.available) {
    box.append(el("div", "empty", deps.reason));
    return box;
  }

  const s = deps.summary;
  const stats = el("div", "dep-summary");
  const stat = (n, label, warn) => {
    const d = el("div", `dep-stat${warn ? " warn" : ""}`);
    d.append(el("b", null, String(n)), el("span", null, label));
    return d;
  };
  stats.append(stat(s.directImporters, "DIRECT IMPORTERS"));
  stats.append(stat(s.transitiveImporters, "TRANSITIVE"));
  stats.append(stat(s.untypedAppReach, "UNTYPED app/ REACH", s.untypedAppReach > 0));
  stats.append(stat(s.frameSeams, "FRAME SEAMS", s.frameSeams > 0));
  box.append(stats);

  if (s.crossesUntypedSeam) {
    box.append(el("div", "seam-warning",
      "This crosses into app/, which nothing typechecks. `npm run build` passing proves nothing here — read the handler by hand and change both sides in one edit."));
  }

  for (const [file, d] of Object.entries(deps.files)) {
    const card = el("div", "dep-file");
    card.append(el("b", null, file));
    card.append(el("div", "sum", d.risk));
    const add = (label, items, cls) => {
      if (!items.length) return;
      card.append(el("div", "cur-label", label));
      const ul = el("ul");
      for (const it of items.slice(0, 12)) ul.append(el("li", cls, it));
      if (items.length > 12) ul.append(el("li", "sum", `… ${items.length - 12} more`));
      card.append(ul);
    };
    add("EXPORTS", d.exports);
    add("IMPORTED BY", d.directImporters);
    add("UNTYPED app/ FILES THAT REACH THIS", d.untypedAppReach, "untyped");
    add("EXPORTS NAMED IN app/ BY STRING — A RENAME WILL NOT FAIL THE BUILD",
        d.untypedSeam.map((x) => `${x.name} → ${x.files.join(", ")}`), "untyped");
    add("PROTOCOL FRAME STRINGS CROSSED",
        d.frames.map((x) => `${x.type} — emitted ${x.emitted.length}, handled ${x.handled.length}${x.crossesIntoApp ? " (one side in app/)" : ""}`),
        "untyped");
    box.append(card);
  }

  if (deps.mirroredConstants.length) {
    box.append(el("div", "cur-label", "MIRRORED CONSTANTS THIS SITS ON"));
    for (const m of deps.mirroredConstants) {
      const card = el("div", "dep-file");
      card.append(el("b", null, m.name), el("div", "sum", m.invariant));
      box.append(card);
    }
  }
  if (deps.unindexed.length) {
    box.append(el("div", "note", `not in the scanned graph: ${deps.unindexed.join(", ")}`));
  }
  return box;
}

/**
 * What proves this feature — read out of `tests/features/<id>.test.ts` by the
 * server, never from the record's array alone (SPEC §11 step 6, decisions/0007).
 *
 * Every row carries its `whyItExists`, which §9 requires of a test row and
 * which nothing could show before discovery existed. The two disagreements
 * worth a red border are a test that cannot run and an id the record claims
 * with no test behind it; the second is a ticked box, and it is the reason the
 * comparison is here rather than left to a reader of two files.
 */
function renderTests(feature, proof, readyCount) {
  const box = el("div");
  const discovered = proof.discovered || [];
  const drift = proof.drift;

  if (discovered.length === 0) {
    box.append(el("div", "empty", feature.deferred
      ? "no tests — this feature is deferred (renderer-only). It never counts against coverage, and removing that flag is a decision."
      : "no tests. This feature is unproven: nothing in the repository asserts the invariant above."));
    // Say which of the two states this is. A ready description and no test is
    // work waiting to be done; no description and no test is work not yet
    // specified, and the two need different things next.
    box.append(el("div", "note", readyCount
      ? `a ready description is waiting for an agent to implement it, and tests/features/${feature.id}.test.ts does not exist yet. Ready is not proof.`
      : `discovery read tests/features/${feature.id}.test.ts and found no test class there.`));
  }

  for (const t of discovered) {
    const card = el("div", `test-row${t.registered ? "" : " dead"}`);
    const head = el("div", "test-head");
    head.append(el("b", null, t.id), tag(t.kind), t.registered ? tag("runs", "covered") : tag("NEVER RUNS", "untested"));
    card.append(head);
    // Ability 2: why this test exists, in the test's own words.
    card.append(el("div", "why", t.whyItExists));
    card.append(el("div", "note", `${t.className} · ${t.file}:${t.line}`));
    if (t.invariant !== feature.invariant) {
      card.append(el("div", "mismatch", `its invariant does not match this record's — the test says: "${t.invariant}"`));
    }
    box.append(card);
  }

  if (drift && !drift.agrees) {
    const warn = el("div", "empty");
    warn.append(el("b", null, "the record and the files disagree"));
    for (const id of drift.recordedWithoutTest) {
      warn.append(el("div", "file", `"${id}" is listed in this record's tests array, but no test in the files defines it — a ticked box with nothing behind it.`));
    }
    for (const id of drift.testedWithoutRecord) {
      warn.append(el("div", "file", `"${id}" exists and runs, but this record's tests array does not list it. §2.1 defines that array as the ids present in the test file — add it.`));
    }
    for (const m of drift.invariantMismatch) {
      warn.append(el("div", "file", `"${m.id}" states a different invariant from this record.`));
    }
    warn.append(el("div", "note", "Status above is derived from the FILES, so it is already honest; the array is the stored copy that has drifted."));
    box.append(warn);
  } else if (discovered.length > 0) {
    box.append(el("div", "note", "the record's tests array agrees with the files."));
  }

  for (const p of proof.problems || []) {
    box.append(el("div", "mismatch", `${p.file}${p.line ? `:${p.line}` : ""} — ${p.detail}`));
  }
  return box;
}

/* ---- description body ------------------------------------------------ */

/**
 * A body is free text, but the seeded ones follow a shape — an ALL-CAPS header
 * line (WHAT / WHY / WHERE / TEST CHECKLIST) followed by its lines — and that
 * shape is rendered as labelled rows, numbered lines as a list, backticked
 * spans and file paths as code. Anything else is shown as it was typed.
 */
const HEADER = /^[A-Z][A-Z ]{2,}$/;
const PATH = /(?:^|[\s(—,;:])((?:[\w.-]+\/)+[\w.-]+\.[a-z]{1,5})/g;

function inline(text, into) {
  // backticks first, then bare paths inside the plain runs.
  const parts = text.split(/(`[^`]+`)/);
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      into.append(el("code", null, part.slice(1, -1)));
      continue;
    }
    let last = 0;
    for (const m of part.matchAll(PATH)) {
      const start = m.index + m[0].length - m[1].length;
      if (start > last) into.append(document.createTextNode(part.slice(last, start)));
      into.append(el("code", "path", m[1]));
      last = start + m[1].length;
    }
    if (last < part.length) into.append(document.createTextNode(part.slice(last)));
  }
}

function renderDescBody(body) {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const firstText = lines.find((l) => l.trim() !== "");
  if (firstText === undefined || !HEADER.test(firstText.trim())) {
    return el("div", "desc-body", body);
  }

  const sections = [];
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (HEADER.test(line.trim())) sections.push({ label: line.trim(), lines: [] });
    else if (sections.length) sections[sections.length - 1].lines.push(line);
  }

  const box = el("div", "d-body");
  for (const s of sections) {
    const row = el("div", "d-sec");
    row.append(el("div", "d-label", s.label.toLowerCase()));
    const text = el("div", "d-text");
    let list = null;
    for (const line of s.lines) {
      const t = line.trim();
      if (!t) continue;
      const m = /^(\d+)[.)]\s+(.*)$/.exec(t);
      if (m) {
        if (!list) { list = el("ol"); text.append(list); }
        const li = el("li");
        inline(m[2], li);
        list.append(li);
      } else {
        list = null;
        const p = el("p");
        inline(t, p);
        text.append(p);
      }
    }
    row.append(text);
    box.append(row);
  }
  return box;
}

/* ---- descriptions --------------------------------------------------- */

function descMeta(d) {
  const meta = el("div", "desc-meta");
  meta.append(el("span", `desc-status ${d.status}`, d.status === "draft" ? "DRAFT" : "READY"));
  if (d.featureIds.length > 1) meta.append(el("span", null, `${d.featureIds.length} features`));
  meta.append(el("span", "spacer", ""), el("span", null, `updated ${d.updatedAt.slice(0, 16).replace("T", " ")}`));
  return meta;
}

function descActions(feature, d, card) {
  const bar = el("div", "editor-bar");
  const edit = el("button", "act", "edit");
  edit.onclick = () => openEditor(feature, d, card);
  const toggle = el("button", "act", d.status === "draft" ? "mark ready" : "back to draft");
  toggle.onclick = async () => {
    if (d.status === "draft" && !confirm("Mark this description ready?\n\nReady means: you have read it and this is the test procedure a coding agent should implement, as written. It does not mean a test exists.\n\nThe file moves to tests/gateway/descriptions/ready/.")) return;
    toggle.disabled = true;
    const { ok, data } = await post(`/api/descriptions/${encodeURIComponent(d.id)}/${d.status === "draft" ? "ready" : "draft"}`);
    if (!ok) alert(data.error || "could not update");
    await refresh();
  };
  const del = el("button", "act danger", "delete");
  del.onclick = async () => {
    if (!confirm("Delete this description?")) return;
    const res = await fetch(`/api/descriptions/${encodeURIComponent(d.id)}`, {
      method: "DELETE", headers: { "x-magentra-gateway-action": "1" },
    });
    if (!res.ok) alert("could not delete");
    await refresh();
  };
  bar.append(edit, toggle, el("span", "spacer", ""), del);
  return bar;
}

/**
 * The description surface — SPEC §2.2. Write what must be tested and save it.
 * The record lands in tests/gateway/descriptions/, which is where a coding
 * agent reads it when the user asks for the test to be written (decisions/0006).
 *
 * `mark ready` is a separate button from `save`, deliberately: saving an edit
 * can never be the thing that approves a directive, and nothing here approves
 * one on its own.
 */
function renderDescriptions(feature, drafts) {
  const box = el("div");

  for (const d of drafts) {
    const card = el("div", "desc draft");
    card.append(descMeta(d));
    card.append(renderDescBody(d.body));
    card.append(el("div", "hint",
      "A draft. Edit the checklist into the test procedure you want, then mark it ready — that is what the coding agent implements."));
    card.append(descActions(feature, d, card));
    box.append(card);
  }

  const add = el("button", "act primary", drafts.length ? "add another description" : "write what must be tested");
  add.onclick = () => openEditor(feature, null, add);
  box.append(add);
  if (!drafts.length) {
    box.append(el("div", "hint",
      "Free text: how the tests shall be written, what to watch for, what a previous attempt got wrong. A coding agent reads it from tests/gateway/descriptions/ when asked to write the test."));
  }
  return box;
}

/** Ready descriptions, folded shut. "back to draft" returns one to the working view. */
function renderReady(feature, ready) {
  const box = el("div");
  for (const d of ready) {
    const fold = el("details", "desc ready");
    const sum = el("summary");
    sum.append(descMeta(d));
    fold.append(sum);
    const card = el("div");
    card.append(renderDescBody(d.body));
    card.append(descActions(feature, d, fold));
    fold.append(card);
    box.append(fold);
  }
  return box;
}

function openEditor(feature, existing, replaces) {
  const wrap = el("div", "desc editing");
  const area = el("textarea");
  area.value = existing ? existing.body : "";
  area.placeholder =
    `What must be tested about "${feature.name}"?\n\n` +
    `Any text works. An ALL-CAPS line starts a labelled block, and numbered lines become a list, for example:\n\n` +
    `WHAT\n…\n\nWHERE\nengine/core/src/… — functionName()\n\nTEST CHECKLIST\n1. …\n2. …`;
  area.rows = Math.min(40, Math.max(14, area.value.split("\n").length + 2));
  wrap.append(area);

  const bar = el("div", "editor-bar");
  const save = el("button", "act primary", existing ? "save changes" : "save description");
  const status = el("span", "hint", "");
  save.onclick = async () => {
    const body = area.value.trim();
    if (!body) { status.textContent = "an empty description is not a directive"; return; }
    save.disabled = true;
    status.textContent = "saving…";
    const { ok, data } = await post("/api/descriptions", {
      ...(existing ? { id: existing.id } : {}),
      featureIds: [feature.id],
      body,
    });
    if (!ok) { save.disabled = false; status.textContent = data.error || "could not save"; return; }
    await refresh();
  };
  const cancel = el("button", "act", "cancel");
  cancel.onclick = () => select(feature.id);
  bar.append(save, cancel, status, el("span", "spacer", ""), el("span", "hint", "Ctrl+Enter saves · Esc cancels"));
  wrap.append(bar);

  replaces.replaceWith(wrap);
  area.focus();
  // Ctrl/Cmd+Enter saves, so writing a paragraph does not end in a mouse hunt.
  area.onkeydown = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); save.click(); }
    if (e.key === "Escape") { e.preventDefault(); cancel.click(); }
    e.stopPropagation();
  };
}

function section(title, body, className) {
  const s = el("section", className);
  s.append(el("h2", null, title), body);
  return s;
}

/* ---- right column: the gate ----------------------------------------- */

function renderGate() {
  const host = $("gate");
  host.textContent = "";
  const gate = state.gate;
  if (!gate) return void host.append(el("div", "note", "waiting for the gate…"));

  if (gate.blocked) {
    const banner = el("div", "blocked-banner");
    banner.append(el("b", null, "BLOCKED"));
    banner.append(el("div", null, `${state.features.length} features cannot be trusted until this is resolved`));
    for (const reason of gate.blockedReasons) banner.append(el("div", "note", `· ${reason}`));
    host.append(banner);
  } else {
    const ok = el("div", "note", "both stages pass — every record matches its code, and this folder is connected.");
    host.append(ok);
  }

  /* stage 1 */
  host.append(el("h2", null, `FRESHNESS — ${gate.freshness.stale.length} stale of ${gate.freshness.checked}`));
  if (gate.freshness.stale.length === 0) {
    host.append(el("div", "note", "every record matches the contents of the files it names."));
  } else {
    for (const s of gate.freshness.stale) {
      const item = el("div", "stale-item");
      item.append(el("b", null, s.id));
      // The specific drifted file, per stale feature — not just the feature.
      for (const f of s.drifted) item.append(el("span", "file", `${f}${s.deleted.includes(f) ? "  (DELETED)" : ""}`));
      if (s.drifted.length === 0) {
        item.append(el("span", "file", "rollup differs but no single file did — entryFiles order changed"));
      }
      const button = el("button", "recon", `reconcile ${s.id}`);
      button.onclick = async () => {
        button.disabled = true;
        const { ok, data } = await post(`/api/features/${encodeURIComponent(s.id)}/reconcile`);
        if (!ok) alert(data.error || "reconcile failed");
        await refresh();
      };
      item.append(button);
      host.append(item);
    }
    host.append(
      el(
        "div",
        "recon-warning",
        "Reconciling is a review, then a re-record. Re-recording without reading the change defeats the mechanism — the hash will agree with code nobody checked.",
      ),
    );
  }

  /* test discovery — reported beside the gate, not as a third stage of it */
  const td = state.testDiscovery;
  if (td) {
    host.append(el("h2", null, `TESTS — ${td.found} in ${td.scanned} file${td.scanned === 1 ? "" : "s"}`));
    if (td.problems.length === 0) {
      host.append(el("div", "note", td.scanned === 0
        ? "tests/features/ is empty. Every testable record therefore reads untested, which is the truth."
        : "every test file was read; each test names the feature it proves."));
    } else {
      for (const p of td.problems) {
        const item = el("div", "stale-item");
        item.append(el("b", null, `${p.file}${p.line ? `:${p.line}` : ""}`));
        item.append(el("span", "file", p.detail));
        host.append(item);
      }
      host.append(el("div", "recon-warning", "A test file discovery cannot read is a test the inventory cannot count. This does not block the gate (decisions/0005 defines two stages) — it is a gap to close."));
    }
  }

  /* stage 2 */
  const conn = gate.connection;
  host.append(el("h2", null, "CONNECTION"));

  if (conn.kind === "refused") {
    host.append(el("div", "empty", conn.message));
    return;
  }

  // Connected: say what this folder points at before offering to change it.
  if (conn.kind === "connected") {
    const cur = el("div", "current");
    cur.append(el("div", "cur-label", "this folder is pointed at"));
    if (conn.current) {
      cur.append(el("div", "cur-model", conn.current.model || "(no model named)"));
      const bits = [];
      if (conn.current.baseUrl) bits.push(conn.current.baseUrl);
      if (conn.current.provider) bits.push(conn.current.provider);
      if (conn.current.reasoningEffort) bits.push(`effort ${conn.current.reasoningEffort}`);
      bits.push(conn.current.hasKeyLine ? "key in .env" : "keyless");
      cur.append(el("div", "sum", bits.join(" · ")));
    } else {
      cur.append(el("div", "sum", "a key in the environment — this folder itself names no connection"));
    }
    host.append(cur);
    host.append(el("div", "note", "Presence, not reachability: no endpoint was probed, so a dead endpoint is a test failure, not a gate failure."));
  } else {
    host.append(el("div", "note", `no credentials in this folder. ${conn.profiles.length} saved profile(s) in ${conn.profilesPath}:`));
  }

  const connected = conn.kind === "connected";
  if (connected) host.append(el("h2", null, "SWITCH TO"));

  for (const p of conn.profiles) {
    const row = el("div", `profile${p.matchesWorkspace ? " active" : ""}`);
    const left = el("div");
    const title = el("div", null, p.name);
    if (p.matchesWorkspace) title.append(tag("in use", "fresh"));
    left.append(title, el("div", "sum", p.summary));
    const button = el("button", null, p.matchesWorkspace ? "re-apply" : "use here");
    button.onclick = async () => {
      button.disabled = true;
      const { ok, data } = await post("/api/connection/apply", { profileId: p.id });
      if (!ok) alert(data.error || "could not apply profile");
      await refresh();
    };
    row.append(left, button);
    host.append(row);
  }

  if (connected) {
    const clear = el("button", "recon", "disconnect this folder");
    clear.onclick = async () => {
      // The one destructive action in the UI, so it asks. It removes the key
      // line and the connection keys; it does not delete either file.
      if (!confirm("Clear this folder's connection?\n\nRemoves the API-key line from .env and the connection keys from .magentra/settings.json. Everything else in both files is left alone.")) return;
      clear.disabled = true;
      const { ok, data } = await post("/api/connection/clear");
      if (!ok) alert(data.error || "could not disconnect");
      await refresh();
    };
    host.append(clear);
    if (conn.environmentKeyVar) {
      host.append(el("div", "recon-warning",
        `${conn.environmentKeyVar} is set in the environment, so this folder reads as connected whatever is written here. Disconnecting cannot clear it — unset it in your shell.`));
    }
  }

  host.append(el("div", "recon-warning", "Applying writes two files: the key into .env and the connection into .magentra/settings.json — the same two the IDE writes."));
}

/* ---- wiring --------------------------------------------------------- */

async function refresh() {
  const res = await fetch("/api/state");
  const data = await res.json();
  if (!res.ok) {
    document.body.textContent = `the inventory did not load:\n\n${data.error}`;
    return;
  }
  state.features = data.features;
  state.gate = data.gate;
  state.testDiscovery = data.testDiscovery || null;
  applyGate();
  applyDescriptions(data.descriptions || []);
  if ($("f-kind").options.length === 1) {
    fillSelect($("f-kind"), data.vocabulary.kinds);
    fillSelect($("f-status"), data.vocabulary.statuses);
  }
  renderHeader();
  renderAreas();
  renderDescNav();
  renderList();
  renderGate();
  if (state.selected) select(state.selected);
  else renderPlaceholder();
}

for (const [id, key] of [["f-kind", "kind"], ["f-status", "status"], ["f-fresh", "fresh"]]) {
  $(id).onchange = (e) => {
    state.filters[key] = e.target.value;
    renderList();
  };
}

$("back").onclick = deselect;

document.addEventListener("keydown", (e) => {
  if (e.target && /^(TEXTAREA|INPUT|SELECT)$/.test(e.target.tagName)) return;
  if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); moveSelection(1); }
  else if (e.key === "ArrowUp" || e.key === "k") { e.preventDefault(); moveSelection(-1); }
  else if (e.key === "Escape") deselect();
});

// Gate state and file-watch invalidation arrive here, so a file edited in the
// editor turns the freshness lamp red without a reload. A description change
// re-reads state, because the done / to test counts in the nav come from it.
const events = new EventSource("/api/events");
events.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.type === "descriptions" || msg.type === "tests") {
    // "tests" means a test file changed what the inventory can claim, so the
    // derived status of some record moved. Only a re-read carries that.
    refresh();
    return;
  }
  if (msg.type === "gate") {
    state.gate = msg.gate;
    applyGate();
    renderHeader();
    renderGate();
    renderList();
    if (state.selected) select(state.selected);
  }
};

refresh();
