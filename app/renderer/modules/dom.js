// DOM references — every element the renderer talks to.
// Loaded as a classic script in index.html — all renderer modules share one
// global scope, in the order the page lists them.

"use strict";

/* global window, document */

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const transcriptEl = document.getElementById("transcript");
const emptyStateEl = document.getElementById("emptyState");
const workspaceBtnEl = document.getElementById("workspaceBtn");
const workspacePathEl = document.getElementById("workspacePath");
const pickFolderBtnEl = document.getElementById("pickFolderBtn");
const agentMeterEl = document.getElementById("agentMeter");
const agentCountEl = document.getElementById("agentCount");
const toolCountEl = document.getElementById("toolCount");
const modelSelectEl = document.getElementById("modelSelect");
const customModelEl = document.getElementById("customModel");
const statusLedEl = document.getElementById("statusLed");
const promptInputEl = document.getElementById("promptInput");
const slashPopEl = document.getElementById("slashPop");
const queueChipEl = document.getElementById("queueChip");
const sendBtnEl = document.getElementById("sendBtn");
const stopBtnEl = document.getElementById("stopBtn");
const clearBtnEl = document.getElementById("clearBtn");
const hintModelEl = document.getElementById("hintModel");
const deleteModalEl = document.getElementById("deleteModal");
const deleteSubjectEl = document.getElementById("deleteSubject");
const allowBtnEl = document.getElementById("allowBtn");
const denyBtnEl = document.getElementById("denyBtn");
const rainCanvas = document.getElementById("rain");
const nowLineEl = document.getElementById("nowLine");
const nowSpinnerEl = document.getElementById("nowSpinner");
const nowTextEl = document.getElementById("nowText");
const nowTimerEl = document.getElementById("nowTimer");
const taskRailEl = document.getElementById("taskRail");
const taskProgressEl = document.getElementById("taskProgress");
const taskCollapseEl = document.getElementById("taskCollapse");
const taskBarFillEl = document.getElementById("taskBarFill");
const taskListEl = document.getElementById("taskList");
const taskTabEl = document.getElementById("taskTab");
const taskTabCountEl = document.getElementById("taskTabCount");
const modeChipsEl = document.getElementById("modeChips");
const teamBtnEl = document.getElementById("teamBtn");
const teamViewEl = document.getElementById("teamView");
const teamCountEl = document.getElementById("teamCount");
const draftTeamBtnEl = document.getElementById("draftTeamBtn");
const teamReloadBtnEl = document.getElementById("teamReloadBtn");
const teamCloseBtnEl = document.getElementById("teamCloseBtn");
const teamRosterEl = document.getElementById("teamRoster");
const teamHireBtnEl = document.getElementById("teamHireBtn");

// dock nav / stage views
const navConsoleEl = document.getElementById("navConsole");
const navSessionsEl = document.getElementById("navSessions");
const navMissionEl = document.getElementById("navMission");
const dockMissionCountEl = document.getElementById("dockMissionCount");
const navSettingsEl = document.getElementById("navSettings");
const consoleViewEl = document.getElementById("consoleView");
const settingsViewEl = document.getElementById("settingsView");
const settingsCloseBtnEl = document.getElementById("settingsCloseBtn");
const scrollPillEl = document.getElementById("scrollPill");
const srAnnounceEl = document.getElementById("srAnnounce");
const shortcutSheetEl = document.getElementById("shortcutSheet");
const jobsChipEl = document.getElementById("jobsChip");
const shortcutCloseBtnEl = document.getElementById("shortcutCloseBtn");
const navLabEl = document.getElementById("navLab");
const dockLabCountEl = document.getElementById("dockLabCount");
const labViewEl = document.getElementById("labView");
const labListEl = document.getElementById("labList");
const labSubEl = document.getElementById("labSub");
const labEmptyEl = document.getElementById("labEmpty");
const labNewBtnEl = document.getElementById("labNewBtn");
const labCloseBtnEl = document.getElementById("labCloseBtn");
const sessionsViewEl = document.getElementById("sessionsView");
const sessionsListEl = document.getElementById("sessionsList");
const sessionsSubEl = document.getElementById("sessionsSub");
const sessionsEmptyEl = document.getElementById("sessionsEmpty");
const sessionsRefreshBtnEl = document.getElementById("sessionsRefreshBtn");
const sessionsSearchEl = document.getElementById("sessionsSearch");
const sessionsCloseBtnEl = document.getElementById("sessionsCloseBtn");

// settings: appearance controls
const setFontEl = document.getElementById("setFont");
const setSizeEl = document.getElementById("setSize");
const setThemeEl = document.getElementById("setTheme");
const setRainEl = document.getElementById("setRain");
const setMotionEl = document.getElementById("setMotion");
const setDetailEl = document.getElementById("setDetail");
const setDeletionsEl = document.getElementById("setDeletions");
const setCommandsEl = document.getElementById("setCommands");
const setWebSearchEl = document.getElementById("setWebSearch");
const hintAutoEl = document.getElementById("hintAuto");
const hintUsageEl = document.getElementById("hintUsage");

// settings: connection card
const setBaseUrlEl = document.getElementById("setBaseUrl");
const setApiKeyEl = document.getElementById("setApiKey");
const setKeyRevealEl = document.getElementById("setKeyReveal");
const setModelDefaultEl = document.getElementById("setModelDefault");
const setConnStatusEl = document.getElementById("setConnStatus");
const setTestBtnEl = document.getElementById("setTestBtn");
const setSaveBtnEl = document.getElementById("setSaveBtn");
const setVersionEl = document.getElementById("setVersion");
const openLogsBtnEl = document.getElementById("openLogsBtn");

// first-run setup wizard
const setupWizardEl = document.getElementById("setupWizard");
const wizCloseBtnEl = document.getElementById("wizCloseBtn");
const wizPresetEls = document.querySelectorAll(".wiz-preset");
const wizBaseUrlEl = document.getElementById("wizBaseUrl");
const wizApiKeyEl = document.getElementById("wizApiKey");
const wizModelEl = document.getElementById("wizModel");
const wizTestBtnEl = document.getElementById("wizTestBtn");
const wizStartBtnEl = document.getElementById("wizStartBtn");
const wizStatusEl = document.getElementById("wizStatus");
const wizApiKeyFieldEl = document.getElementById("wizApiKeyField");
const wizKeyHintEl = document.getElementById("wizKeyHint");
const wizModelsEl = document.getElementById("wizModels");
const wizContextFieldEl = document.getElementById("wizContextField");
const wizContextEl = document.getElementById("wizContext");
const wizNoteEl = document.getElementById("wizNote");

// connection settings: context size
const setContextEl = document.getElementById("setContext");

// startup landing: recent folders
const recentListEl = document.getElementById("recentList");

// changes review panel
const navChangesEl = document.getElementById("navChanges");
const dockChangesCountEl = document.getElementById("dockChangesCount");
const changesViewEl = document.getElementById("changesView");
const changesListEl = document.getElementById("changesList");
const changesSubEl = document.getElementById("changesSub");
const changesEmptyEl = document.getElementById("changesEmpty");
const changesCloseBtnEl = document.getElementById("changesCloseBtn");
