import { definePrompt, promptText } from "@magentra/protocol";

const GROUP = "6 · Subagents (Agent tool)";

/**
 * Subagent-type registry. Each type maps to a restricted tool set and a role
 * section appended to the subagent's system prompt. No type ever grants the
 * Agent tool: subagents cannot spawn further subagents (v1: no recursion).
 */

export interface AgentTypeDef {
  name: string;
  /** Shown in the Agent tool description so the model can pick a type. */
  description: string;
  /** Explicit tool allow-list, or "*" meaning every registered tool except Agent. */
  tools: string[] | "*";
  /** Role text appended to the subagent's system prompt. */
  role: string;
}

const READONLY_TOOLS = ["Read", "Glob", "Grep", "TaskList", "TaskGet"];

export const AGENT_TYPES: Record<string, AgentTypeDef> = {
  "general-purpose": {
    name: "general-purpose",
    description:
      "General-purpose agent for researching complex questions, searching code, and executing multi-step tasks end to end. Has every tool except the ability to spawn further subagents.",
    tools: "*",
    role: "You are a general-purpose subagent. Carry out the task completely with your tools, then report the outcome and anything the caller needs to act on.",
  },
  explore: {
    name: "explore",
    description:
      "Read-only fan-out search agent. Use it to sweep the codebase for where something lives across many files and naming conventions; it returns conclusions, not file dumps.",
    tools: READONLY_TOOLS,
    role: "You are an explore subagent: a fast, read-only code searcher. Fan out across the repository to locate the relevant code, then return your conclusions concisely — file paths with line numbers and a short explanation. Do not paste large file contents; summarize what you found.",
  },
  plan: {
    name: "plan",
    description:
      "Read-only software-architect agent. Use it to design an implementation strategy; it returns a step-by-step plan and names the critical files.",
    tools: READONLY_TOOLS,
    role: "You are a plan subagent: a software architect working strictly read-only. Investigate the codebase, weigh approaches and trade-offs, and return a concrete step-by-step implementation plan that names the files to change and the order of work. Do not modify anything.",
  },
};

export const SUBAGENT_RESULT_ID = definePrompt({
  id: "subagent.result-contract",
  group: GROUP,
  label: "Subagent output contract",
  channel: "subagent",
  where:
    "Appended to EVERY subagent's system prompt, on top of the normal core sections. Tells the subagent its final message is captured verbatim as the tool result, not shown to a human.",
  text: `Subagent output contract:
- You are running as a subagent. Your FINAL message is captured verbatim and returned to the calling agent as the result of its tool call. It is raw data for another agent, not a message to a human. Therefore write your final message carefully in the sense of what has to be delivered to the orchestrator agent.
- Do not open with a preamble, greeting, or a description of what you are about to do. Do not ask questions — there is no user to answer. Lead with the answer and include only what the caller needs.`,
});

/** Registers each subagent type's role text so it can be tuned like any other
 *  prompt, and rewrites the roster in place to hold ids instead of literals. */
for (const [key, def] of Object.entries(AGENT_TYPES)) {
  def.role = definePrompt({
    id: `subagent.role.${key}`,
    group: GROUP,
    label: `Role — ${key}`,
    channel: "subagent",
    where: `Prepended to the system prompt of a subagent spawned with agentType "${key}". ${
      def.tools === "*" ? "Has every tool except Agent." : `Restricted to: ${def.tools.join(", ")}.`
    }`,
    text: def.role,
  });
  def.description = definePrompt({
    id: `subagent.description.${key}`,
    group: GROUP,
    label: `Picker blurb — ${key}`,
    channel: "tool",
    where: `Listed inside the Agent tool's own description so the main agent can choose the "${key}" type. Sent on every request that has the Agent tool.`,
    text: def.description,
  });
}

/** The role text in force for a subagent type. */
export function agentRoleText(def: AgentTypeDef): string {
  return promptText(def.role);
}

/** The picker blurb in force for a subagent type. */
export function agentDescriptionText(def: AgentTypeDef): string {
  return promptText(def.description);
}

export function resolveAgentType(agentType: string): AgentTypeDef | undefined {
  return AGENT_TYPES[agentType];
}

/** Tool names a subagent of this type may use — never includes Agent. */
export function agentToolNames(def: AgentTypeDef, all: string[]): string[] {
  const names = def.tools === "*" ? all : def.tools;
  return names.filter((n) => n !== "Agent");
}
