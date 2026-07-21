// Concept A workbench interactions: persistent navigation, contextual
// inspector, and reversible diff review. This layer only composes existing
// renderer state and IPC seams; engine event semantics stay in their original
// modules.

let activeInspectorTab = "tasks";
let activeReviewPath = null;
let inlineChangesCardEl = null;

function pathLeaf(value) {
  const parts = String(value || "").split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || value || "—";
}

function setWorkbenchTitle(title, meta) {
  if (workTitleTextEl) workTitleTextEl.textContent = title || "Start a new conversation";
  if (workTitleMetaEl) workTitleMetaEl.textContent = meta || "Magentra agent workbench";
}

function syncWorkbenchContext() {
  const workspaceName = activeWorkspace ? pathLeaf(activeWorkspace) : "—";
  if (inspectorWorkspaceEl) {
    inspectorWorkspaceEl.textContent = workspaceName;
    inspectorWorkspaceEl.title = activeWorkspace || "";
  }
  if (inspectorSessionEl) inspectorSessionEl.textContent = currentSessionId || "—";
  if (inspectorModelEl) {
    inspectorModelEl.textContent = activeModel ? pathLeaf(activeModel) : "—";
    inspectorModelEl.title = activeModel || "";
  }
  if (inspectorUsageEl) {
    const parts = [];
    if (contextTokens > 0) parts.push(`~${formatTokensShort(contextTokens)} ctx`);
    inspectorUsageEl.textContent = parts.join(" · ") || "—";
    inspectorUsageEl.classList.toggle("warn", contextWarn);
  }
  if (workspaceOpen) {
    const activeSummary = currentSessionId
      ? sessionSummaries.find((session) => session.id === currentSessionId)
      : null;
    const title = currentSessionId
      ? (activeSummary ? sessionDisplayName(activeSummary) : "Active conversation")
      : "New conversation";
    setWorkbenchTitle(title, `${workspaceName} · ${activeModel ? pathLeaf(activeModel) : "connecting"}`);
  }
}

function switchInspector(tab) {
  activeInspectorTab = ["tasks", "changes", "crew"].includes(tab) ? tab : "tasks";
  inspectorTabs.forEach((button) => {
    const active = button.dataset.inspector === activeInspectorTab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });
  inspectorPanels.forEach((panel) => panel.classList.toggle("hidden", panel.dataset.panel !== activeInspectorTab));
}

function openInspector(tab = activeInspectorTab) {
  if (!workspaceOpen) return;
  railCollapsed = false;
  switchInspector(tab);
  taskRailEl.classList.remove("hidden");
  taskRailEl.setAttribute("aria-hidden", "false");
  taskTabEl.classList.add("hidden");
  document.body.classList.add("inspector-open");
  if (inspectorToggleEl) inspectorToggleEl.classList.add("active");
}

function closeInspector() {
  railCollapsed = true;
  taskRailEl.classList.add("hidden");
  taskRailEl.setAttribute("aria-hidden", "true");
  document.body.classList.remove("inspector-open");
  if (workspaceOpen) taskTabEl.classList.remove("hidden");
  if (inspectorToggleEl) inspectorToggleEl.classList.remove("active");
}

/** Sidebar workspace rail: the active folder plus recent ones, one click to
 * switch. The active row also carries the worktree indicator when the session
 * has moved its cwd. */
function renderSidebarWorkspaces() {
  if (!sidebarWorkspacesListEl) return;
  sidebarWorkspacesListEl.textContent = "";
  const shown = recentWorkspaces.slice(0, 5);
  if (shown.length === 0) {
    const empty = document.createElement("div");
    empty.className = "sidebar-empty";
    empty.textContent = "＋ opens a folder";
    sidebarWorkspacesListEl.appendChild(empty);
    return;
  }
  for (const workspace of shown) {
    const active = workspaceOpen && workspace === activeWorkspace;
    const row = document.createElement("button");
    row.className = "sidebar-workspace-row" + (active ? " active" : "");
    row.disabled = active || busy;
    row.title = active && workspaceWorktree ? `Working in worktree: ${workspaceWorktree}` : workspace;
    const dot = document.createElement("span");
    dot.className = "sidebar-session-dot";
    const label = document.createElement("span");
    label.className = "sidebar-item-label";
    label.textContent = pathLeaf(workspace);
    row.append(dot, label);
    if (active && workspaceWorktree) {
      const meta = document.createElement("span");
      meta.className = "sidebar-item-meta worktree";
      meta.textContent = "⇒ worktree";
      row.appendChild(meta);
    }
    row.addEventListener("click", () => openWorkspaceByPath(workspace));
    sidebarWorkspacesListEl.appendChild(row);
  }
}

/** Bucket an ISO date into the ref design's day groups. */
function sessionDayGroup(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Earlier";
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86400000);
  if (diffDays <= 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return "Earlier";
}

/** Compact relative age ("2m", "3h", "1d") for sidebar rows. */
function relativeAgeShort(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const mins = Math.max(0, Math.round((Date.now() - date.getTime()) / 60000));
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function renderSidebarSessions() {
  if (!sidebarSessionsListEl) return;
  sidebarSessionsListEl.textContent = "";
  if (!workspaceOpen) return;
  const sessions = sessionSummaries.slice(0, 10);
  if (sessions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "sidebar-empty";
    empty.textContent = "No saved conversations";
    sidebarSessionsListEl.appendChild(empty);
    return;
  }
  let lastGroup = null;
  for (const session of sessions) {
    const group = sessionDayGroup(session.updatedAt);
    if (group !== lastGroup) {
      lastGroup = group;
      const heading = document.createElement("div");
      heading.className = "sidebar-subhead";
      heading.textContent = group;
      sidebarSessionsListEl.appendChild(heading);
    }
    const row = document.createElement("button");
    row.className = "sidebar-session" + (session.id === currentSessionId ? " active" : "");
    row.disabled = session.id === currentSessionId || busy;
    row.title = `${sessionDisplayName(session)}\n${formatSessionDate(session.updatedAt)}`;
    const dot = document.createElement("span");
    dot.className = "sidebar-session-dot";
    const label = document.createElement("span");
    label.className = "sidebar-item-label";
    label.textContent = sessionDisplayName(session);
    const meta = document.createElement("span");
    meta.className = "sidebar-item-meta";
    meta.textContent = relativeAgeShort(session.updatedAt);
    row.append(dot, label, meta);
    row.addEventListener("click", () => window.magentra.send({ type: "resume_session", id: session.id }));
    sidebarSessionsListEl.appendChild(row);
  }
}

function renderSidebarMissions() {
  if (!sidebarMissionsListEl) return;
  sidebarMissionsListEl.textContent = "";
  if (!workspaceOpen) return;
  if (labMissions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "sidebar-empty";
    empty.textContent = "No missions";
    sidebarMissionsListEl.appendChild(empty);
    return;
  }
  for (const mission of labMissions.slice(0, 8)) {
    const row = document.createElement("button");
    row.className = "sidebar-mission" + (mission.running ? " running" : "");
    row.title = mission.description || mission.name;
    const dot = document.createElement("span");
    dot.className = "sidebar-mission-dot";
    const label = document.createElement("span");
    label.className = "sidebar-item-label";
    label.textContent = mission.name;
    const meta = document.createElement("span");
    meta.className =
      "sidebar-item-meta" + (mission.running ? " status-running" : mission.scheduled ? " status-scheduled" : "");
    meta.textContent = mission.running ? "Running" : mission.scheduled ? "Scheduled" : "";
    row.append(dot, label, meta);
    row.addEventListener("click", () => showView("lab"));
    sidebarMissionsListEl.appendChild(row);
  }
}

/** Compact crew block at the foot of the Tasks panel (ref layout): every
 * specialist with its readiness, one click away from the full crew view. */
function renderCrewMini() {
  if (!crewMiniListEl) return;
  crewMiniListEl.textContent = "";
  if (crewMiniCountEl) crewMiniCountEl.textContent = teamAgents.length ? String(teamAgents.length) : "";
  const mini = document.getElementById("crewMini");
  if (mini) mini.classList.toggle("hidden", teamAgents.length === 0);
  for (const agent of teamAgents.slice(0, 6)) {
    const row = document.createElement("button");
    row.className = "crew-mini-row";
    const glyph = document.createElement("span");
    glyph.className = "crew-mini-glyph";
    glyph.textContent = agent.ready ? "◈" : "◇";
    const name = document.createElement("span");
    name.className = "crew-mini-name";
    name.textContent = agent.name || agent.id;
    const status = document.createElement("span");
    status.className = "crew-mini-status" + (agent.ready ? " ready" : "");
    status.textContent = agent.ready ? "Ready" : "Indexing";
    row.append(glyph, name, status);
    row.addEventListener("click", () => openInspector("crew"));
    crewMiniListEl.appendChild(row);
  }
}

function renderInspectorCrew() {
  renderCrewMini();
  if (!inspectorCrewListEl) return;
  inspectorCrewListEl.textContent = "";
  if (inspectorCrewCountEl) inspectorCrewCountEl.textContent = teamAgents.length ? String(teamAgents.length) : "";
  if (teamAgents.length === 0) {
    const empty = document.createElement("div");
    empty.className = "sidebar-empty";
    empty.textContent = "No specialists configured";
    inspectorCrewListEl.appendChild(empty);
    return;
  }
  for (const agent of teamAgents) {
    const card = document.createElement("button");
    card.className = "inspector-crew-card";
    const head = document.createElement("div");
    head.className = "inspector-crew-head";
    head.textContent = agent.name || agent.id;
    const status = document.createElement("span");
    status.className = "inspector-crew-status" + (agent.ready ? " ready" : "");
    status.textContent = agent.ready ? "ready" : "indexing";
    head.appendChild(status);
    const role = document.createElement("div");
    role.className = "inspector-crew-role";
    role.textContent = agent.role || agent.description || agent.model || "specialist";
    card.append(head, role);
    card.addEventListener("click", () => showView("team"));
    inspectorCrewListEl.appendChild(card);
  }
}

function sessionChangeTotals() {
  const files = [...sessionChanges.entries()];
  return files.reduce(
    (total, [, change]) => ({ files: total.files + 1, adds: total.adds + change.adds, dels: total.dels + change.dels }),
    { files: 0, adds: 0, dels: 0 },
  );
}

function appendDiffCounts(container, adds, dels, elementName = "span") {
  container.textContent = "";
  const add = document.createElement(elementName);
  add.className = "add";
  add.textContent = `+${adds}`;
  const del = document.createElement(elementName);
  del.className = "del";
  del.textContent = `−${dels}`;
  container.append(add, document.createTextNode(" "), del);
}

function renderInspectorChanges() {
  if (!inspectorChangesListEl) return;
  const files = [...sessionChanges.entries()];
  const total = sessionChangeTotals();
  if (inspectorChangesCountEl) inspectorChangesCountEl.textContent = total.files ? String(total.files) : "";
  if (inspectorChangesSummaryEl) {
    inspectorChangesSummaryEl.textContent = total.files
      ? `${total.files} file${total.files === 1 ? "" : "s"} · +${total.adds} −${total.dels}`
      : "No changes yet";
  }
  inspectorChangesListEl.textContent = "";
  for (const [relPath, change] of files) {
    const row = document.createElement("button");
    row.className = "inspector-change-row";
    const name = document.createElement("span");
    name.className = "inspector-file-name";
    name.textContent = relPath;
    const counts = document.createElement("span");
    counts.className = "diff-counts";
    appendDiffCounts(counts, change.adds, change.dels);
    const meta = document.createElement("span");
    meta.className = "inspector-file-meta";
    meta.textContent = `${change.count} edit${change.count === 1 ? "" : "s"}`;
    row.append(name, counts, meta);
    row.addEventListener("click", () => openReviewDrawer(relPath));
    inspectorChangesListEl.appendChild(row);
  }
  if (reviewAllBtnEl) reviewAllBtnEl.disabled = total.files === 0;
  renderInlineChangesCard();
  if (!reviewDrawerEl.classList.contains("hidden")) renderReviewDrawer(activeReviewPath);
}

// How many files the inline card lists before folding the rest behind the
// "··· N more files" row, and whether that row is currently unfolded. The flag
// survives re-renders (every new edit rebuilds the card) but resets with the
// card itself, so a fresh run of edits starts compact again.
const INLINE_CHANGES_COMPACT = 2;
let inlineChangesExpanded = false;

function renderInlineChangesCard() {
  if (!streamEl || sessionChanges.size === 0) {
    if (inlineChangesCardEl) inlineChangesCardEl.remove();
    inlineChangesCardEl = null;
    inlineChangesExpanded = false;
    return;
  }
  if (!inlineChangesCardEl || !inlineChangesCardEl.isConnected) {
    inlineChangesCardEl = document.createElement("section");
    inlineChangesCardEl.className = "inline-changes-card";
  }
  inlineChangesCardEl.textContent = "";
  const totals = sessionChangeTotals();
  const head = document.createElement("div");
  head.className = "inline-changes-head";
  const title = document.createElement("strong");
  title.textContent = `${totals.files} file${totals.files === 1 ? "" : "s"} changed`;
  const summary = document.createElement("span");
  appendDiffCounts(summary, totals.adds, totals.dels);
  head.append(title, summary);
  const list = document.createElement("div");
  list.className = "inline-changes-list";
  // Compact by default: a long edit run would otherwise push the conversation
  // off screen every time the card re-renders. The rest stay one click away.
  const entries = [...sessionChanges.entries()];
  const shown = inlineChangesExpanded ? entries : entries.slice(0, INLINE_CHANGES_COMPACT);
  for (const [relPath, change] of shown) {
    const row = document.createElement("button");
    const name = document.createElement("span");
    name.textContent = relPath;
    const counts = document.createElement("span");
    appendDiffCounts(counts, change.adds, change.dels, "b");
    row.append(name, counts);
    row.addEventListener("click", () => openReviewDrawer(relPath));
    list.appendChild(row);
  }
  const hidden = entries.length - shown.length;
  if (hidden > 0 || inlineChangesExpanded) {
    const more = document.createElement("button");
    more.className = "inline-changes-more";
    more.textContent = inlineChangesExpanded ? "··· show less" : `··· ${hidden} more file${hidden === 1 ? "" : "s"}`;
    more.setAttribute("aria-expanded", inlineChangesExpanded ? "true" : "false");
    more.addEventListener("click", () => {
      inlineChangesExpanded = !inlineChangesExpanded;
      renderInlineChangesCard();
    });
    list.appendChild(more);
  }
  const actions = document.createElement("div");
  actions.className = "inline-changes-actions";
  const review = document.createElement("button");
  review.textContent = "Review changes";
  review.addEventListener("click", () => openReviewDrawer());
  actions.append(review);
  inlineChangesCardEl.append(head, list, actions);
  withAutoScroll(() => streamEl.appendChild(inlineChangesCardEl));
}

function renderReviewDrawer(preferredPath) {
  const files = [...sessionChanges.entries()];
  if (files.length === 0) {
    closeReviewDrawer();
    return;
  }
  activeReviewPath = sessionChanges.has(preferredPath) ? preferredPath : files[0][0];
  const selected = sessionChanges.get(activeReviewPath);
  const total = sessionChangeTotals();
  reviewSummaryEl.textContent = `${total.files} file${total.files === 1 ? "" : "s"} · +${total.adds} −${total.dels}`;
  reviewFileTabsEl.textContent = "";
  for (const [relPath] of files) {
    const tab = document.createElement("button");
    tab.className = "review-file-tab" + (relPath === activeReviewPath ? " active" : "");
    tab.textContent = pathLeaf(relPath);
    tab.title = relPath;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", relPath === activeReviewPath ? "true" : "false");
    tab.addEventListener("click", () => renderReviewDrawer(relPath));
    reviewFileTabsEl.appendChild(tab);
  }
  reviewFileNameEl.textContent = activeReviewPath;
  appendDiffCounts(reviewFileCountsEl, selected.adds, selected.dels);
  reviewDiffEl.textContent = "";
  selected.diffs.forEach((diff, diffIndex) => {
    if (selected.diffs.length > 1) {
      const heading = document.createElement("span");
      heading.className = "review-line meta";
      heading.textContent = `edit ${diffIndex + 1} of ${selected.diffs.length}`;
      reviewDiffEl.appendChild(heading);
    }
    for (const line of diff.split("\n")) {
      const row = document.createElement("span");
      row.className = "review-line";
      if (line.startsWith("@@")) row.classList.add("hunk");
      else if (line.startsWith("+++ ") || line.startsWith("--- ")) row.classList.add("meta");
      else if (line.startsWith("+")) row.classList.add("add");
      else if (line.startsWith("-")) row.classList.add("del");
      row.textContent = line || " ";
      reviewDiffEl.appendChild(row);
    }
  });
  reviewOpenBtnEl.disabled = false;
  reviewUndoBtnEl.disabled = false;
}

function openReviewDrawer(relPath) {
  if (sessionChanges.size === 0) return;
  reviewDrawerEl.classList.remove("hidden");
  reviewDrawerEl.setAttribute("aria-hidden", "false");
  document.body.classList.add("review-open");
  renderReviewDrawer(relPath);
}

function closeReviewDrawer() {
  reviewDrawerEl.classList.add("hidden");
  reviewDrawerEl.setAttribute("aria-hidden", "true");
  document.body.classList.remove("review-open");
  activeReviewPath = null;
}

async function undoFileChange(relPath) {
  const change = sessionChanges.get(relPath);
  if (!change || !window.magentra.undoChanges) return;
  const response = await window.magentra.undoChanges(relPath, change.diffs);
  if (!response || response.ok !== true) {
    appendSysError(`undo failed for ${relPath}: ${(response && response.error) || "unknown error"}`);
    return;
  }
  discardSessionFileChanges(relPath);
  appendSysNote(`undid ${relPath}`);
}

inspectorTabs.forEach((button) => button.addEventListener("click", () => openInspector(button.dataset.inspector)));
if (inspectorToggleEl) inspectorToggleEl.addEventListener("click", () => {
  if (document.body.classList.contains("inspector-open")) closeInspector();
  else openInspector();
});
if (taskCollapseEl) taskCollapseEl.addEventListener("click", closeInspector);
if (taskTabEl) taskTabEl.addEventListener("click", () => openInspector());
if (reviewAllBtnEl) reviewAllBtnEl.addEventListener("click", () => openReviewDrawer());
if (reviewCloseBtnEl) reviewCloseBtnEl.addEventListener("click", closeReviewDrawer);
if (reviewDoneBtnEl) reviewDoneBtnEl.addEventListener("click", closeReviewDrawer);
if (reviewOpenBtnEl) reviewOpenBtnEl.addEventListener("click", () => {
  if (activeReviewPath && window.magentra.openWorkspaceFile) void window.magentra.openWorkspaceFile(activeReviewPath);
});
if (reviewUndoBtnEl) reviewUndoBtnEl.addEventListener("click", () => {
  if (activeReviewPath) void undoFileChange(activeReviewPath);
});
if (openCrewViewBtnEl) openCrewViewBtnEl.addEventListener("click", () => showView("team"));
if (sidebarSessionsRefreshEl) sidebarSessionsRefreshEl.addEventListener("click", () => requestSessionList());
if (sidebarMissionNewEl) sidebarMissionNewEl.addEventListener("click", () => labNewBtnEl.click());
if (attachBtnEl) attachBtnEl.addEventListener("click", () => {
  if (!workspaceOpen || promptInputEl.disabled) return;
  const start = promptInputEl.selectionStart || 0;
  const end = promptInputEl.selectionEnd || start;
  promptInputEl.setRangeText("@", start, end, "end");
  promptInputEl.focus();
  promptInputEl.dispatchEvent(new Event("input"));
});
if (logoEl) logoEl.addEventListener("click", () => showView("console"));
