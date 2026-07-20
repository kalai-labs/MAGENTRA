import { ToolRegistry } from "@magentra/core";
import { readTool } from "./read.js";
import { writeTool } from "./write.js";
import { editTool } from "./edit.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { bashTool } from "./bash.js";
import { taskCreateTool, taskGetTool, taskListTool, taskUpdateTool } from "./tasks.js";
import { askUserQuestionTool } from "./askUserQuestion.js";
import { agentTool } from "./agent.js";
import { taskOutputTool, taskStopTool } from "./taskControl.js";
import { webFetchTool } from "./webFetch.js";
import { webSearchTool } from "./webSearch.js";
import { monitorTool } from "./monitor.js";
import { enterWorktreeTool, exitWorktreeTool } from "./worktree.js";
import { pushNotificationTool } from "./pushNotification.js";
import { cronCreateTool, cronDeleteTool, cronListTool, scheduleWakeupTool } from "./cron.js";
import { skillTool } from "./skill.js";
import { workflowTool } from "./workflow.js";
import { graphQueryTool } from "./graphQuery.js";
import { crewRunTool } from "./crewRun.js";
import { backpackSearchTool } from "./backpackSearch.js";

export {
  readTool,
  writeTool,
  editTool,
  globTool,
  grepTool,
  bashTool,
  taskCreateTool,
  taskUpdateTool,
  taskListTool,
  taskGetTool,
  askUserQuestionTool,
  agentTool,
  taskStopTool,
  taskOutputTool,
  webFetchTool,
  webSearchTool,
  monitorTool,
  enterWorktreeTool,
  exitWorktreeTool,
  pushNotificationTool,
  cronCreateTool,
  cronDeleteTool,
  cronListTool,
  scheduleWakeupTool,
  skillTool,
  workflowTool,
  graphQueryTool,
  crewRunTool,
  backpackSearchTool,
};
export { resolveBashPath, spawnShell, killTree, bashDeletionSubject } from "./bash.js";
export {
  type SearchBackend,
  type SearchResult,
  BraveBackend,
  DuckDuckGoBackend,
  TavilyBackend,
  parseDuckDuckGoHtml,
} from "./webSearch.js";
export { resolveTaskId } from "./tasks.js";
export { htmlToText } from "./webFetch.js";

export function createDefaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of [
    readTool,
    writeTool,
    editTool,
    globTool,
    grepTool,
    bashTool,
    taskCreateTool,
    taskUpdateTool,
    taskListTool,
    taskGetTool,
    askUserQuestionTool,
    agentTool,
    taskStopTool,
    taskOutputTool,
    webFetchTool,
    webSearchTool,
    monitorTool,
    enterWorktreeTool,
    exitWorktreeTool,
    pushNotificationTool,
    cronCreateTool,
    cronDeleteTool,
    cronListTool,
    scheduleWakeupTool,
    skillTool,
    workflowTool,
    graphQueryTool,
    crewRunTool,
    backpackSearchTool,
  ]) {
    registry.register(tool);
  }
  return registry;
}
