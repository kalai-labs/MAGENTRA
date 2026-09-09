/*
 * The read-only surface — SPEC §11 step 5, laid out per §9.
 *
 * Vanilla, no framework, no CDN, no build. It renders three things: the
 * inventory, the gate, and what the gate is blocking. The two writes it can
 * start (reconcile a record, apply a connection profile) are the two the spec
 * marks approval-gated, and each is one deliberate click that sends the
 * action header the server requires.
 */

"use strict";

const $ = (id) => document.getElementById(id);

const state = {
  features: [],
  gate: null,
  filters: { area: "", kind: "", status: "", fresh: "" },
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

/* ---- header --------------------------------------------------------- */

function renderHeader() {
  const gate = state.gate;
  const fresh = gate ? gate.freshness.ok : false;
  const connected = gate ? gate.connection.kind === "connected" : false;

  $("lamp-fresh").classList.toggle("on", fresh);
  $("lamp-conn").classList.toggle("on", connected);

  const deferred = state.features.filter((f) => f.deferred).length;
  const untested = state.features.filter((f) => f.status === "untested" && !f.deferred).length;
  $("count").textContent =
    `${state.features.length} features · ${untested} untested · ${deferred} deferred`;

  // Disabled, not warned. Bound to the gate's own single verdict so the button
  // and the lamps can never disagree.
  const run = $("run");
  run.disabled = !gate || !gate.runAllowed;
  $("run-why").textContent = run.disabled ? "RUN blocked by the gate" : "";
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

function fillSelect(select, values) {
  for (const v of values) select.append(new Option(v, v));
}

/* ---- middle column -------------------------------------------------- */

function visible() {
  const { area, kind, status, fresh } = state.filters;
  return state.features.filter(
    (f) =>
      (!area || f.area === area) &&
      (!kind || f.kinds.includes(kind)) &&
      (!status || f.status === status) &&
      (!fresh || (fresh === "stale" ? !f.fresh : f.fresh)),
  );
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
    for (const k of f.kinds) tags.append(tag(k));
    tags.append(tag(f.status, f.status));
    tags.append(f.fresh ? tag("fresh", "fresh") : tag("STALE", "stale"));
    if (f.deferred) tags.append(tag("deferred", "deferred"));
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
  box.append(el("div", null, "Pick a feature to see what it is, what it touches, and what you have asked for."));
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

  // Sticky, so scrolling through dependencies never loses which feature this is.
  const head = el("div", null);
  head.id = "detail-head";
  head.append(el("h3", null, feature.name), el("div", "id", `${feature.id} · ${feature.area} · ${feature.section}`));
  const tags = el("div", "tags");
  for (const k of feature.kinds) tags.append(tag(k));
  tags.append(tag(feature.status, feature.status));
  tags.append(freshness.fresh ? tag("fresh", "fresh") : tag("STALE", "stale"));
  if (feature.deferred) tags.append(tag("deferred", "deferred"));
  head.append(tags);
  host.append(head);

  host.append(section("PROSE (verbatim from FEATURES.md)", el("div", "prose", feature.prose)));
  host.append(section("INVARIANT", el("div", "invariant", feature.invariant)));

  const files = el("ul", "files");
  for (const f of feature.entryFiles) {
    const drifted = freshness.drifted.includes(f);
    const deleted = freshness.deleted.includes(f);
    files.append(el("li", drifted ? "drift" : null, `${f}${deleted ? "  (DELETED)" : drifted ? "  (drifted)" : ""}`));
  }
  host.append(section(`ENTRY FILES — hashed ${freshness.recordedAt}`, files));

  host.append(section("DEPENDENCIES", renderDeps(dependencies)));
  host.append(section(`TESTS — ${feature.tests.length}`, renderTests(feature)));
  host.append(section("WHAT TO TEST — your description", renderDescriptions(feature, descriptions)));

  const brief = el("div");
  const openBrief = el("button", "act", "open the agent brief (Markdown)");
  openBrief.onclick = () => window.open(`/api/features/${encodeURIComponent(feature.id)}/brief?format=md`, "_blank");
  brief.append(openBrief);
  brief.append(el("div", "hint", `Or on the command line: npm run gateway -- brief ${feature.id}`));
  host.append(section("HAND THIS TO AN AGENT", brief));
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

function renderTests(feature) {
  const box = el("div");
  if (feature.tests.length === 0) {
    box.append(el("div", "empty", feature.deferred
      ? "no tests — this feature is deferred (renderer-only). It never counts against coverage, and removing that flag is a decision."
      : "no tests. This feature is unproven: nothing in the repository asserts the invariant above."));
  } else {
    for (const t of feature.tests) box.append(el("div", null, t));
    box.append(el("div", "note", "whyItExists comes from the test file (SPEC §11 step 6)."));
  }
  return box;
}

/**
 * The description surface — SPEC §2.2. Write what must be tested, save it, and
 * it travels to an agent inside the brief.
 *
 * `done` is a separate button from `save`, deliberately: saving an edit can
 * never be the thing that closes a directive, and nothing here closes one on
 * its own.
 */
function renderDescriptions(feature, descriptions) {
  const box = el("div");
  const mine = descriptions || [];

  for (const d of mine) {
    const card = el("div", `desc ${d.status}`);
    const meta = el("div", "desc-meta");
    meta.append(el("span", null, d.status.toUpperCase()));
    if (d.featureIds.length > 1) meta.append(el("span", null, `${d.featureIds.length} features`));
    meta.append(el("span", "spacer", ""), el("span", null, `updated ${d.updatedAt.slice(0, 16).replace("T", " ")}`));
    card.append(meta);
    card.append(el("div", "desc-body", d.body));

    const bar = el("div", "editor-bar");
    const edit = el("button", "act", "edit");
    edit.onclick = () => openEditor(feature, d, card);
    const toggle = el("button", "act", d.status === "pending" ? "mark done" : "reopen");
    toggle.onclick = async () => {
      if (d.status === "pending" && !confirm("Mark this description done?\n\nOnly do this after verifying the test exists AND asserts the invariant. The gateway will never do it for you.")) return;
      toggle.disabled = true;
      const { ok, data } = await post(`/api/descriptions/${encodeURIComponent(d.id)}/${d.status === "pending" ? "done" : "reopen"}`);
      if (!ok) alert(data.error || "could not update");
      await select(feature.id);
    };
    const del = el("button", "act danger", "delete");
    del.onclick = async () => {
      if (!confirm("Delete this description?")) return;
      const res = await fetch(`/api/descriptions/${encodeURIComponent(d.id)}`, {
        method: "DELETE", headers: { "x-magentra-gateway-action": "1" },
      });
      if (!res.ok) alert("could not delete");
      await select(feature.id);
    };
    bar.append(edit, toggle, el("span", "spacer", ""), del);
    card.append(bar);
    box.append(card);
  }

  const add = el("button", "act primary", mine.length ? "add another description" : "write what must be tested");
  add.onclick = () => openEditor(feature, null, add);
  box.append(add);
  if (!mine.length) {
    box.append(el("div", "hint",
      "Free text: how the tests shall be written, what to watch for, what a previous attempt got wrong. It is delivered to an agent alongside the dependencies above."));
  }
  return box;
}

function openEditor(feature, existing, replaces) {
  const wrap = el("div", "desc");
  const area = el("textarea");
  area.value = existing ? existing.body : "";
  area.placeholder = `What must be tested about "${feature.name}"?\n\nThe invariant to prove is already recorded. Use this for how: the cases that matter, the setup that is awkward, the failure a previous attempt missed.`;
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
    await select(feature.id);
  };
  const cancel = el("button", "act", "cancel");
  cancel.onclick = () => select(feature.id);
  bar.append(save, cancel, status);
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

function section(title, body) {
  const s = el("section");
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
    banner.append(el("div", null, `nothing may run — ${state.features.length} features could not be verified`));
    for (const reason of gate.blockedReasons) banner.append(el("div", "note", `· ${reason}`));
    host.append(banner);
  } else {
    const ok = el("div", "note", "both stages pass — a result from a run here may be believed.");
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
  applyGate();
  if ($("f-kind").options.length === 1) {
    fillSelect($("f-kind"), data.vocabulary.kinds);
    fillSelect($("f-status"), data.vocabulary.statuses);
  }
  renderHeader();
  renderAreas();
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

$("run").onclick = async () => {
  const { status, data } = await post("/api/run");
  if (status === 409) alert(`BLOCKED — nothing ran.\n\n${data.blockedReasons.join("\n")}`);
  else alert(data.error || JSON.stringify(data));
};

// Gate state and file-watch invalidation arrive here, so a file edited in the
// editor turns the freshness lamp red without a reload.
const events = new EventSource("/api/events");
events.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.type === "descriptions" && state.selected) {
    select(state.selected);
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
