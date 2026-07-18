// Concept A workbench interactions: persistent navigation, contextual
// inspector, permission picker, and reversible diff review. This layer only
// composes existing renderer state and IPC seams; engine event semantics stay
// in their original modules.

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
    if (contextTokens > 0) parts.push(`${formatTokensShort(contextTokens)} ctx`);
    if (sessionCostUsd !== null) parts.push(formatUsdShort(sessionCostUsd));
    inspectorUsageEl.textContent = parts.join(" · ") || "—";
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
  for (const session of sessions) {
    const row = document.createElement("button");
    row.className = "sidebar-session" + (session.id === currentSessionId ? " active" : "");
    row.disabled = session.id === currentSessionId || busy;
    row.title = `${sessionDisplayName(session)}\n${formatSessionDate(session.updatedAt)}`;
    const dot = document.createElement("span");
    dot.className = "sidebar-session-dot";
    const label = document.createElement("span");
    label.className = "sidebar-item-label";
    label.textContent = sessionDisplayName(session);
    row.append(dot, label);
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
    meta.className = "sidebar-item-meta";
    meta.textContent = mission.running ? "live" : "";
    row.append(dot, label, meta);
    row.addEventListener("click", () => showView("lab"));
    sidebarMissionsListEl.appendChild(row);
  }
}

function renderInspectorCrew() {
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
  if (undoLastBtnEl) undoLastBtnEl.disabled = sessionChangeOrder.length === 0;
  renderInlineChangesCard();
  if (!reviewDrawerEl.classList.contains("hidden")) renderReviewDrawer(activeReviewPath);
}

function renderInlineChangesCard() {
  if (!streamEl || sessionChanges.size === 0) {
    if (inlineChangesCardEl) inlineChangesCardEl.remove();
    inlineChangesCardEl = null;
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
  for (const [relPath, change] of [...sessionChanges.entries()].slice(0, 6)) {
    const row = document.createElement("button");
    const name = document.createElement("span");
    name.textContent = relPath;
    const counts = document.createElement("span");
    appendDiffCounts(counts, change.adds, change.dels, "b");
    row.append(name, counts);
    row.addEventListener("click", () => openReviewDrawer(relPath));
    list.appendChild(row);
  }
  const actions = document.createElement("div");
  actions.className = "inline-changes-actions";
  const review = document.createElement("button");
  review.textContent = "Review changes";
  review.addEventListener("click", () => openReviewDrawer());
  const undo = document.createElement("button");
  undo.textContent = "Undo last";
  undo.addEventListener("click", () => void undoLastChange());
  actions.append(review, undo);
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

async function undoLastChange() {
  const last = sessionChangeOrder[sessionChangeOrder.length - 1];
  if (!last || !window.magentra.undoChanges) return;
  const response = await window.magentra.undoChanges(last.relPath, [last.diff]);
  if (!response || response.ok !== true) {
    appendSysError(`undo failed for ${last.relPath}: ${(response && response.error) || "unknown error"}`);
    return;
  }
  discardLastSessionDiff();
  appendSysNote(`undid the latest edit to ${last.relPath}`);
}

const PERMISSION_LABELS = {
  default: "Ask before changes",
  acceptEdits: "Auto-accept edits",
  plan: "Plan only",
  bypass: "Autonomous",
};

function syncPermissionMenu(mode) {
  const current = mode || (uiSettings.commands === "ask" ? "default" : "bypass");
  const selection = current === "default" ? "ask" : current === "plan" ? "plan" : "auto";
  if (permissionMenuLabelEl) permissionMenuLabelEl.textContent = PERMISSION_LABELS[current] || PERMISSION_LABELS.default;
  if (inspectorPermissionsEl) inspectorPermissionsEl.textContent = PERMISSION_LABELS[current] || PERMISSION_LABELS.default;
  if (!permissionMenuEl) return;
  permissionMenuEl.querySelectorAll(".permission-option").forEach((option) => {
    option.setAttribute("aria-checked", option.dataset.permission === selection ? "true" : "false");
  });
}

function closePermissionMenu() {
  if (!permissionMenuEl) return false;
  const wasOpen = !permissionMenuEl.classList.contains("hidden");
  permissionMenuEl.classList.add("hidden");
  permissionMenuBtnEl.setAttribute("aria-expanded", "false");
  return wasOpen;
}

function choosePermission(choice) {
  closePermissionMenu();
  if (choice === "plan") {
    window.magentra.send({ type: "set_mode", mode: "plan" });
    renderSafetyHint("plan");
    return;
  }
  uiSettings.commands = choice === "ask" ? "ask" : "auto";
  saveUiSettings();
  syncSegGroup(setCommandsEl, "commands");
  applySafetySettings(false);
}

inspectorTabs.forEach((button) => button.addEventListener("click", () => openInspector(button.dataset.inspector)));
if (inspectorToggleEl) inspectorToggleEl.addEventListener("click", () => {
  if (document.body.classList.contains("inspector-open")) closeInspector();
  else openInspector();
});
if (taskCollapseEl) taskCollapseEl.addEventListener("click", closeInspector);
if (taskTabEl) taskTabEl.addEventListener("click", () => openInspector());
if (reviewAllBtnEl) reviewAllBtnEl.addEventListener("click", () => openReviewDrawer());
if (undoLastBtnEl) undoLastBtnEl.addEventListener("click", () => void undoLastChange());
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
if (permissionMenuBtnEl) permissionMenuBtnEl.addEventListener("click", (event) => {
  event.stopPropagation();
  const opening = permissionMenuEl.classList.contains("hidden");
  permissionMenuEl.classList.toggle("hidden", !opening);
  permissionMenuBtnEl.setAttribute("aria-expanded", opening ? "true" : "false");
});
if (permissionMenuEl) {
  permissionMenuEl.addEventListener("click", (event) => event.stopPropagation());
  permissionMenuEl.querySelectorAll(".permission-option").forEach((option) => {
    option.addEventListener("click", () => choosePermission(option.dataset.permission));
  });
}
if (attachBtnEl) attachBtnEl.addEventListener("click", () => {
  if (!workspaceOpen || promptInputEl.disabled) return;
  const start = promptInputEl.selectionStart || 0;
  const end = promptInputEl.selectionEnd || start;
  promptInputEl.setRangeText("@", start, end, "end");
  promptInputEl.focus();
  promptInputEl.dispatchEvent(new Event("input"));
});
if (logoEl) logoEl.addEventListener("click", () => showView("console"));
document.addEventListener("click", () => closePermissionMenu());

syncPermissionMenu();
