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
const menuBarEl = document.getElementById("menuBar");
const workspacePathEl = document.getElementById("workspacePath");
const logoEl = document.getElementById("logo");
const sidebarWorkspacesListEl = document.getElementById("sidebarWorkspacesList");
const sidebarSessionsRefreshEl = document.getElementById("sidebarSessionsRefresh");
const sidebarSessionsListEl = document.getElementById("sidebarSessionsList");
const sidebarStatusTextEl = document.getElementById("sidebarStatusText");
const sidebarVersionEl = document.getElementById("sidebarVersion");
const workTitleTextEl = document.getElementById("workTitleText");
const workTitleMetaEl = document.getElementById("workTitleMeta");
const inspectorToggleEl = document.getElementById("inspectorToggle");
const inspectorToggleDotEl = document.getElementById("inspectorToggleDot");
const updateFootEl = document.getElementById("updateFoot");
const updateActionEl = document.getElementById("updateAction");
const updateLabelEl = document.getElementById("updateLabel");
const updateBarEl = document.getElementById("updateBar");
const updateBarFillEl = document.getElementById("updateBarFill");
const updateNotesEl = document.getElementById("updateNotes");
const windowControlsEl = document.getElementById("windowControls");
const winMinimizeBtnEl = document.getElementById("winMinimizeBtn");
const winFullScreenBtnEl = document.getElementById("winFullScreenBtn");
const winCloseBtnEl = document.getElementById("winCloseBtn");
const revealWorkspaceBtnEl = document.getElementById("revealWorkspaceBtn");
const pickFolderBtnEl = document.getElementById("pickFolderBtn");
const agentMeterEl = document.getElementById("agentMeter");
const agentCountEl = document.getElementById("agentCount");
const toolCountEl = document.getElementById("toolCount");
const ctxMeterEl = document.getElementById("ctxMeter");
const ctxMeterValueEl = document.getElementById("ctxMeterValue");
const modelSelectEl = document.getElementById("modelSelect");
const customModelEl = document.getElementById("customModel");
const statusLedEl = document.getElementById("statusLed");
const promptInputEl = document.getElementById("promptInput");
const slashPopEl = document.getElementById("slashPop");
const queueChipEl = document.getElementById("queueChip");
const sendBtnEl = document.getElementById("sendBtn");
const stopBtnEl = document.getElementById("stopBtn");
const clearBtnEl = document.getElementById("clearBtn");
const attachBtnEl = document.getElementById("attachBtn");
const attachChipsEl = document.getElementById("attachChips");
const hintModelEl = document.getElementById("hintModel");
const deleteModalEl = document.getElementById("deleteModal");
const deleteSubjectEl = document.getElementById("deleteSubject");
const allowBtnEl = document.getElementById("allowBtn");
const allowAlwaysBtnEl = document.getElementById("allowAlwaysBtn");
const allowAlwaysHintEl = document.getElementById("allowAlwaysHint");
const denyBtnEl = document.getElementById("denyBtn");
const permissionNoteEl = document.getElementById("permissionNote");
const nowLineEl = document.getElementById("nowLine");
const nowSpinnerEl = document.getElementById("nowSpinner");
const nowTextEl = document.getElementById("nowText");
const nowTokensEl = document.getElementById("nowTokens");
const nowTimerEl = document.getElementById("nowTimer");
const taskRailEl = document.getElementById("taskRail");
const taskProgressEl = document.getElementById("taskProgress");
const taskCollapseEl = document.getElementById("taskCollapse");
const taskBarFillEl = document.getElementById("taskBarFill");
const taskListEl = document.getElementById("taskList");
const taskEmptyEl = document.getElementById("taskEmpty");
const taskRailBarEl = document.querySelector("#inspectorTasks .rail-bar");
const taskTabEl = document.getElementById("taskTab");
const taskTabCountEl = document.getElementById("taskTabCount");
const inspectorTabs = document.querySelectorAll(".inspector-tab");
const inspectorPanels = document.querySelectorAll(".inspector-panel");
const inspectorWorkspaceEl = document.getElementById("inspectorWorkspace");
const inspectorSessionEl = document.getElementById("inspectorSession");
const inspectorModelEl = document.getElementById("inspectorModel");
const inspectorUsageEl = document.getElementById("inspectorUsage");
const inspectorChangesCountEl = document.getElementById("inspectorChangesCount");
const inspectorChangesSummaryEl = document.getElementById("inspectorChangesSummary");
const inspectorChangesListEl = document.getElementById("inspectorChangesList");
const reviewAllBtnEl = document.getElementById("reviewAllBtn");
const reviewDrawerEl = document.getElementById("reviewDrawer");
const reviewSummaryEl = document.getElementById("reviewSummary");
const reviewCloseBtnEl = document.getElementById("reviewCloseBtn");
const reviewFileTabsEl = document.getElementById("reviewFileTabs");
const reviewFileNameEl = document.getElementById("reviewFileName");
const reviewFileCountsEl = document.getElementById("reviewFileCounts");
const reviewDiffEl = document.getElementById("reviewDiff");
const reviewOpenBtnEl = document.getElementById("reviewOpenBtn");
const reviewUndoBtnEl = document.getElementById("reviewUndoBtn");
const reviewDoneBtnEl = document.getElementById("reviewDoneBtn");
const modeChipsEl = document.getElementById("modeChips");

// dock nav / stage views
const navConsoleEl = document.getElementById("navConsole");
const navHomeEl = document.getElementById("navHome");
const navSessionsEl = document.getElementById("navSessions");
const navMissionEl = document.getElementById("navMission");
const dockMissionCountEl = document.getElementById("dockMissionCount");
const navSettingsEl = document.getElementById("navSettings");
const consoleViewEl = document.getElementById("consoleView");
const settingsViewEl = document.getElementById("settingsView");
const settingsCloseBtnEl = document.getElementById("settingsCloseBtn");
const scrollPillEl = document.getElementById("scrollPill");
const topToastEl = document.getElementById("topToast");
const srAnnounceEl = document.getElementById("srAnnounce");
const shortcutSheetEl = document.getElementById("shortcutSheet");
const jobsChipEl = document.getElementById("jobsChip");
const promptModalEl = document.getElementById("promptModal");
const promptModalTitleEl = document.getElementById("promptModalTitle");
const promptModalHintEl = document.getElementById("promptModalHint");
const promptModalInputEl = document.getElementById("promptModalInput");
const promptModalOkEl = document.getElementById("promptModalOk");
const promptModalCancelEl = document.getElementById("promptModalCancel");
const sessionModalEl = document.getElementById("sessionModal");
const sessionModalBodyEl = document.getElementById("sessionModalBody");
const sessionModalCloseEl = document.getElementById("sessionModalClose");
const sessionModalDoneEl = document.getElementById("sessionModalDone");
const shortcutCloseBtnEl = document.getElementById("shortcutCloseBtn");
const sessionsViewEl = document.getElementById("sessionsView");
const sessionsListEl = document.getElementById("sessionsList");
const sessionsSubEl = document.getElementById("sessionsSub");
const sessionsEmptyEl = document.getElementById("sessionsEmpty");
const sessionsRefreshBtnEl = document.getElementById("sessionsRefreshBtn");
const sessionsSearchEl = document.getElementById("sessionsSearch");
const sessionsCloseBtnEl = document.getElementById("sessionsCloseBtn");

// settings: appearance controls
const setFontEl = document.getElementById("setFont");
const setThemeEl = document.getElementById("setTheme");
const setSizeEl = document.getElementById("setSize");
const setMotionEl = document.getElementById("setMotion");
const setZoomEl = document.getElementById("setZoom");
const setZoomResetBtnEl = document.getElementById("setZoomResetBtn");
const setCompactLimitEl = document.getElementById("setCompactLimit");
const setRainRowEl = document.getElementById("setRainRow");
const setRainNoteEl = document.getElementById("setRainNote");
const setRainOpacityEl = document.getElementById("setRainOpacity");
const setDetailEl = document.getElementById("setDetail");
const setDeletionsEl = document.getElementById("setDeletions");
const setWebSearchEl = document.getElementById("setWebSearch");
const setVisionEl = document.getElementById("setVision");
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
const sourceCodeLinkEl = document.getElementById("sourceCodeLink");
const sourceCodeBtnEl = document.getElementById("sourceCodeBtn");

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
const wizSubEl = document.getElementById("wizSub");
const wizNameEl = document.getElementById("wizName");
const wizSaveProfileBtnEl = document.getElementById("wizSaveProfileBtn");
const wizSaveAsNewBtnEl = document.getElementById("wizSaveAsNewBtn");
const wizProfilesEl = document.getElementById("wizProfiles");
const wizProfilesListEl = document.getElementById("wizProfilesList");
const wizBuildHeadEl = document.getElementById("wizBuildHead");
const navSetupConnEl = document.getElementById("navSetupConn");
const welcomeSetupConnBtnEl = document.getElementById("welcomeSetupConnBtn");
const wizBaseUrlHintEl = document.getElementById("wizBaseUrlHint");
const wizInsecureRowEl = document.getElementById("wizInsecureRow");
const wizInsecureEl = document.getElementById("wizInsecure");
const setInsecureEl = document.getElementById("setInsecure");

// connection settings: context size
const setContextEl = document.getElementById("setContext");

// vision: which saved profile describes images, in the settings card and in the
// wizard. Both pick from the same profile list; both save with the connection.
const setVisionProfileEl = document.getElementById("setVisionProfile");
const wizVisionProfileEl = document.getElementById("wizVisionProfile");

// startup landing: recent folders
const recentListEl = document.getElementById("recentList");

// addons view + create-addon wizard + tour
const navAddonsEl = document.getElementById("navAddons");
const dockAddonsCountEl = document.getElementById("dockAddonsCount");
const addonsViewEl = document.getElementById("addonsView");
const addonsSubEl = document.getElementById("addonsSub");
const addonsListEl = document.getElementById("addonsList");
const addonCreateBtnEl = document.getElementById("addonCreateBtn");
const addonsCloseBtnEl = document.getElementById("addonsCloseBtn");
const addonWizardEl = document.getElementById("addonWizard");
const addonWizStep1El = document.getElementById("addonWizStep1");
const addonWizStep2El = document.getElementById("addonWizStep2");
const addonDescInputEl = document.getElementById("addonDescInput");
const addonContextInputEl = document.getElementById("addonContextInput");
const addonModelSelectEl = document.getElementById("addonModelSelect");
const addonModelHintEl = document.getElementById("addonModelHint");
const addonWizStatusEl = document.getElementById("addonWizStatus");
const addonWizStatus2El = document.getElementById("addonWizStatus2");
const addonWizCancelEl = document.getElementById("addonWizCancel");
const addonWizGenerateEl = document.getElementById("addonWizGenerate");
const addonWizBackEl = document.getElementById("addonWizBack");
const addonWizInstallEl = document.getElementById("addonWizInstall");
const addonWizFileEl = document.getElementById("addonWizFile");
const addonDraftTextEl = document.getElementById("addonDraftText");
const tourOverlayEl = document.getElementById("tourOverlay");
const tourSpotEl = document.getElementById("tourSpot");
const tourCardEl = document.getElementById("tourCard");
const tourStepLabelEl = document.getElementById("tourStepLabel");
const tourTitleEl = document.getElementById("tourTitle");
const tourCopyEl = document.getElementById("tourCopy");
const tourSkipEl = document.getElementById("tourSkip");
const tourBackEl = document.getElementById("tourBack");
const tourNextEl = document.getElementById("tourNext");

// changes review panel
const navChangesEl = document.getElementById("navChanges");
const dockChangesCountEl = document.getElementById("dockChangesCount");
const changesViewEl = document.getElementById("changesView");
const changesListEl = document.getElementById("changesList");
const changesSubEl = document.getElementById("changesSub");
const changesEmptyEl = document.getElementById("changesEmpty");
const changesCloseBtnEl = document.getElementById("changesCloseBtn");

// OVERDRIVE: composer toggle, first-enable dialog, engage cinematic
const overdriveBtnEl = document.getElementById("overdriveBtn");
const overdriveDialogEl = document.getElementById("overdriveDialog");
const overdriveEngageBtnEl = document.getElementById("overdriveEngageBtn");
const overdriveCancelBtnEl = document.getElementById("overdriveCancelBtn");
const overdriveCinematicEl = document.getElementById("overdriveCinematic");
