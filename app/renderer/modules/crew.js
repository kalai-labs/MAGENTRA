// Crew designer (CREW view) and its card menu.
// Loaded as a classic script in index.html — all renderer modules share one
// global scope, in the order the page lists them.

// ---------------------------------------------------------------------------
// Crew designer (CREW view)
// ---------------------------------------------------------------------------

const DRAFT_TEAM_PROMPT =
  "Analyze this repository (use GraphQuery structure and the atlas) and propose a crew for it: " +
  "2-4 specialists with names, roles, what each would own, and suggested backpack documents. " +
  "Present the roster for my approval first; after I agree, write the .magentra/team/*.md files.";

let teamAgents = [];
let teamProgress = new Map(); // agentId -> { done, total, active }
let teamSeenFirstUpdate = false;

function modelShortName(model) {
  if (!model) return "session model";
  const idx = model.indexOf("/");
  return idx === -1 ? model : model.slice(idx + 1);
}

function hostOf(baseUrl) {
  if (!baseUrl) return "";
  try {
    return new URL(baseUrl).host;
  } catch {
    return "";
  }
}

function setupCrewCardDrop(cardEl, agentId) {
  cardEl.addEventListener("dragover", (e) => {
    e.preventDefault();
    cardEl.classList.add("dropping");
  });
  cardEl.addEventListener("dragleave", () => {
    cardEl.classList.remove("dropping");
  });
  cardEl.addEventListener("drop", (e) => {
    e.preventDefault();
    cardEl.classList.remove("dropping");
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    for (const file of files) {
      let filePath = file.path;
      if (!filePath && window.magentra.getPathForFile) {
        try {
          filePath = window.magentra.getPathForFile(file);
        } catch {
          filePath = null;
        }
      }
      if (!filePath) {
        appendSysNote(`crew: couldn't resolve a path for "${file.name}" — skipped`);
        continue;
      }
      // Immediate feedback: the card only updates when team_updated arrives,
      // which can lag behind the drop by a background index build.
      appendSysNote(`crew: adding "${file.name}" to the backpack — it will be indexed, then distilled into the member's brief`);
      window.magentra.addDoc(agentId, filePath);
    }
  });
}

function createCrewCard(agent) {
  const cardEl = document.createElement("div");
  cardEl.className = "crew-card";
  if (agent.color) cardEl.style.borderTopColor = agent.color;

  const headEl = document.createElement("div");
  headEl.className = "crew-card-head";

  const emojiEl = document.createElement("span");
  emojiEl.className = "crew-emoji";
  emojiEl.textContent = agent.emoji || "◆";

  const nameEl = document.createElement("span");
  nameEl.className = "crew-name";
  nameEl.textContent = agent.name || agent.id;

  // Visible, keyboard-reachable menu button — right-click stays as a shortcut.
  const menuBtnEl = document.createElement("button");
  menuBtnEl.className = "crew-menu-btn";
  menuBtnEl.title = "Member actions";
  menuBtnEl.setAttribute("aria-label", `Actions for ${agent.name || agent.id}`);
  menuBtnEl.textContent = "⋯";
  menuBtnEl.addEventListener("click", (e) => {
    e.stopPropagation();
    openCrewCtxMenu(e, agent.id, agent.name || agent.id);
  });

  const modelEl = document.createElement("span");
  modelEl.className = "crew-model";
  modelEl.textContent = modelShortName(agent.model);
  // A member on its own endpoint shows where it runs (host only — never a key).
  const endpointHost = agent.provider === "anthropic" ? "anthropic" : hostOf(agent.baseUrl);
  if (endpointHost) {
    modelEl.textContent = (modelEl.textContent ? modelEl.textContent + " @ " : "") + endpointHost;
    modelEl.title = agent.baseUrl || "anthropic";
  }

  headEl.appendChild(emojiEl);
  headEl.appendChild(nameEl);
  headEl.appendChild(modelEl);
  headEl.appendChild(menuBtnEl);
  cardEl.appendChild(headEl);

  const roleEl = document.createElement("div");
  roleEl.className = "crew-role";
  roleEl.textContent = agent.role || "";
  cardEl.appendChild(roleEl);

  // Depth line: what this member has done and cost, at a glance.
  const statsEl = document.createElement("div");
  statsEl.className = "crew-stats";
  const tasksDone = agent.tasksCompleted || 0;
  const promoted = agent.lessonsPromoted || 0;
  const candidates = agent.lessonsCandidate || 0;
  const parts = [
    tasksDone > 0 ? `${tasksDone} task${tasksDone === 1 ? "" : "s"} done` : "no work history yet",
    promoted + candidates > 0 ? `${promoted} lesson${promoted === 1 ? "" : "s"} (+${candidates} on probation)` : null,
    agent.spend || null,
  ].filter(Boolean);
  statsEl.textContent = parts.join(" · ");
  cardEl.appendChild(statsEl);

  const blurbEl = document.createElement("div");
  blurbEl.className = "crew-blurb";
  blurbEl.textContent = `role prompt in ${agent.id}.md`;
  cardEl.appendChild(blurbEl);

  const packEl = document.createElement("div");
  packEl.className = "crew-pack";

  const docCount = agent.docCount || 0;
  const progress = teamProgress.get(agent.id);

  const titleEl = document.createElement("div");
  titleEl.className = "pack-title";
  titleEl.textContent = `BACKPACK · ${docCount} doc${docCount === 1 ? "" : "s"} `;
  if (agent.ready) {
    const readyEl = document.createElement("span");
    readyEl.className = "pack-ready";
    readyEl.textContent = "● ready";
    readyEl.title = "Distilled into the member's brief; retrieved on demand during its runs";
    titleEl.appendChild(readyEl);
  } else if (progress && progress.active) {
    const buildingEl = document.createElement("span");
    buildingEl.className = "pack-building";
    buildingEl.textContent = "◐ indexing";
    titleEl.appendChild(buildingEl);
  } else if (docCount > 0) {
    const pendingEl = document.createElement("span");
    pendingEl.className = "pack-building";
    pendingEl.textContent = "○ not indexed yet";
    titleEl.appendChild(pendingEl);
  }
  packEl.appendChild(titleEl);

  // What is actually inside, and what it does — a count alone told the user
  // nothing about the effect of dropping a document on the card.
  if (docCount > 0) {
    const docsEl = document.createElement("ul");
    docsEl.className = "pack-docs";
    for (const doc of agent.docs || []) {
      const li = document.createElement("li");
      li.textContent = doc.split(/[\\/]/).pop();
      li.title = doc;
      docsEl.appendChild(li);
    }
    packEl.appendChild(docsEl);

    const effectEl = document.createElement("div");
    effectEl.className = "pack-effect";
    effectEl.textContent = agent.ready
      ? "✓ distilled into this member's standing brief — key points ride along on every run, details are retrieved when relevant (watch for BackpackSearch in its run log)"
      : "documents are indexed in the background, then distilled into a brief this member carries into every run";
    packEl.appendChild(effectEl);
  }

  const barEl = document.createElement("div");
  barEl.className = "pack-bar";
  const fillEl = document.createElement("div");
  fillEl.className = "pack-bar-fill";
  if (agent.ready) {
    fillEl.style.width = "100%";
    barEl.classList.add("hidden");
  } else if (progress && progress.active) {
    const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
    fillEl.style.width = `${pct}%`;
  } else {
    barEl.classList.add("hidden");
  }
  barEl.appendChild(fillEl);
  packEl.appendChild(barEl);

  if (docCount === 0) {
    const hintEl = document.createElement("div");
    hintEl.className = "pack-drop-hint";
    hintEl.textContent = "drop documents here";
    packEl.appendChild(hintEl);
  }

  cardEl.appendChild(packEl);

  const pathEl = document.createElement("div");
  pathEl.className = "crew-path";
  pathEl.textContent = `.magentra/team/${agent.id}.md`;
  cardEl.appendChild(pathEl);

  setupCrewCardDrop(cardEl, agent.id);
  cardEl.addEventListener("contextmenu", (e) => {
    openCrewCtxMenu(e, agent.id, agent.name || agent.id);
  });

  return cardEl;
}

// ---------------------------------------------------------------------------
// Crew card context menu (right-click to remove an agent)
// ---------------------------------------------------------------------------

let openCtxMenuEl = null;
let closeOpenCtxMenuListeners = null;

function closeCtxMenu() {
  if (!openCtxMenuEl) return;
  if (closeOpenCtxMenuListeners) closeOpenCtxMenuListeners();
  closeOpenCtxMenuListeners = null;
  if (openCtxMenuEl.parentNode) openCtxMenuEl.parentNode.removeChild(openCtxMenuEl);
  openCtxMenuEl = null;
}

function openCrewCtxMenu(e, agentId, displayName) {
  e.preventDefault();
  closeCtxMenu();

  const menuEl = document.createElement("div");
  menuEl.className = "ctx-menu";

  const editEl = document.createElement("button");
  editEl.className = "ctx-item";
  editEl.textContent = "✎ EDIT FILE";
  editEl.addEventListener("click", async () => {
    try {
      await window.magentra.editAgent(agentId);
    } finally {
      closeCtxMenu();
    }
  });
  menuEl.appendChild(editEl);

  const addDocEl = document.createElement("button");
  addDocEl.className = "ctx-item";
  addDocEl.textContent = "＋ ADD DOCUMENT";
  addDocEl.addEventListener("click", async () => {
    try {
      const result = await window.magentra.pickDoc(agentId);
      if (result && result.ok) {
        appendSysNote(`crew: added a document to ${displayName}`);
      }
    } finally {
      closeCtxMenu();
    }
  });
  menuEl.appendChild(addDocEl);

  const exportEl = document.createElement("button");
  exportEl.className = "ctx-item";
  exportEl.textContent = "⇪ EXPORT PACK";
  exportEl.title = "Pack this member into <id>.crewpack.json (refuses to export secrets)";
  exportEl.addEventListener("click", () => {
    window.magentra.send({ type: "slash_command", command: "crew", args: `export ${agentId}` });
    showView("console");
    closeCtxMenu();
  });
  menuEl.appendChild(exportEl);

  const sepEl = document.createElement("div");
  sepEl.className = "ctx-sep";
  menuEl.appendChild(sepEl);

  const dismissEl = document.createElement("button");
  dismissEl.className = "ctx-item danger";
  dismissEl.textContent = "✕ DISMISS MEMBER";
  dismissEl.addEventListener("click", async () => {
    try {
      const result = await window.magentra.removeAgent(agentId);
      if (result && result.removed) {
        appendSysNote(`dismissed ${displayName} from the crew`);
      }
    } finally {
      closeCtxMenu();
    }
  });
  menuEl.appendChild(dismissEl);

  document.body.appendChild(menuEl);

  const menuRect = menuEl.getBoundingClientRect();
  let left = e.clientX;
  let top = e.clientY;
  // Keyboard activation reports 0,0 — anchor to the invoking element instead.
  if (!left && !top && e.target && e.target.getBoundingClientRect) {
    const anchor = e.target.getBoundingClientRect();
    left = anchor.left;
    top = anchor.bottom + 4;
  }
  if (left + menuRect.width > window.innerWidth) left = window.innerWidth - menuRect.width - 4;
  if (top + menuRect.height > window.innerHeight) top = window.innerHeight - menuRect.height - 4;
  if (left < 4) left = 4;
  if (top < 4) top = 4;
  menuEl.style.left = `${left}px`;
  menuEl.style.top = `${top}px`;

  openCtxMenuEl = menuEl;

  const onDocClick = (ev) => {
    if (!menuEl.contains(ev.target)) closeCtxMenu();
  };
  const onKeydown = (ev) => {
    if (ev.key === "Escape") closeCtxMenu();
  };
  const onScroll = () => closeCtxMenu();

  document.addEventListener("click", onDocClick, true);
  document.addEventListener("keydown", onKeydown);
  window.addEventListener("scroll", onScroll, true);
  teamViewEl.addEventListener("scroll", onScroll);

  closeOpenCtxMenuListeners = () => {
    document.removeEventListener("click", onDocClick, true);
    document.removeEventListener("keydown", onKeydown);
    window.removeEventListener("scroll", onScroll, true);
    teamViewEl.removeEventListener("scroll", onScroll);
  };
}

function renderRoster() {
  teamRosterEl.textContent = "";
  for (const agent of teamAgents) {
    teamRosterEl.appendChild(createCrewCard(agent));
  }
  const addEl = document.createElement("div");
  addEl.className = "crew-add";
  addEl.textContent = "+ NEW AGENT";
  addEl.addEventListener("click", () => {
    window.magentra.createTeamTemplate();
  });
  teamRosterEl.appendChild(addEl);
  renderInspectorCrew();
}

function onTeamUpdated(event) {
  const agents = event.agents || [];
  teamAgents = agents;
  for (const agent of agents) {
    if (agent.ready) teamProgress.delete(agent.id);
  }

  teamBtnEl.classList.remove("hidden");
  teamBtnEl.classList.toggle("has-team", agents.length > 0);
  teamCountEl.textContent = agents.length > 0 ? `${agents.length} agents` : "no agents";

  renderRoster();

  if (teamSeenFirstUpdate) {
    appendSysNote(`crew updated: ${agents.length} agents`);
  }
  teamSeenFirstUpdate = true;
}

function resetTeamView() {
  closeCtxMenu();
  teamAgents = [];
  teamProgress.clear();
  teamSeenFirstUpdate = false;
  teamBtnEl.classList.add("hidden");
  teamBtnEl.classList.remove("has-team", "active");
  teamCountEl.textContent = "no agents";
  teamRosterEl.textContent = "";
  renderInspectorCrew();
}

function onBackpackProgress(event) {
  if (!event.agentId) return;
  teamProgress.set(event.agentId, {
    done: event.done || 0,
    total: event.total || 0,
    active: true,
  });
  renderRoster();
}

navConsoleEl.addEventListener("click", () => showView("console"));
teamBtnEl.addEventListener("click", () => showView("team"));
teamCloseBtnEl.addEventListener("click", () => showView("console"));
navSettingsEl.addEventListener("click", () => showView("settings"));
settingsCloseBtnEl.addEventListener("click", () => showView("console"));
teamReloadBtnEl.addEventListener("click", () => window.magentra.reloadTeam());
if (teamHireBtnEl) {
  teamHireBtnEl.addEventListener("click", async () => {
    const source = await showPromptModal({
      title: "HIRE FROM PACK",
      hint:
        "Path or URL of a .crewpack.json (one member) or .teampack.json (whole crew). " +
        "Packs are tamper-EVIDENT, not forge-proof: records are hash-chained but unsigned — hire only from sources you trust.",
      placeholder: "/path/to/reviewer.crewpack.json or https://…",
    });
    if (!source || !source.trim()) return;
    const path = source.trim();
    const command = path.includes("teampack") ? "team" : "crew";
    window.magentra.send({ type: "slash_command", command, args: `hire ${path}` });
    showView("console");
  });
}
draftTeamBtnEl.addEventListener("click", () => {
  showView("console");
  promptInputEl.value = DRAFT_TEAM_PROMPT;
  sendMessage();
});
