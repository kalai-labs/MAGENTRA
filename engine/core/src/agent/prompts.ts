import {
  brainPrompt,
  PRODUCT_NAME,
  PRODUCT_REPO_URL,
  promptDefault,
  promptText,
  renderPrompt,
} from "@magentra/protocol";

/**
 * Behavior sections are exported individually so an embedding frontend (e.g.
 * an IDE) can swap or drop any of them. The prose lives in
 * brain/prompts/1-core-system/; the constants below are the shipped DEFAULTS,
 * and `behaviorCore` reads whatever is in force.
 */

// promptDefault, not promptCatalog: the catalog resolves every override, which
// would stat the prompts directory at import and warm the override cache.
const shipped = (id: string): string => promptDefault(id);

const IDENTITY = brainPrompt("system.identity");
const HARNESS = brainPrompt("system.harness");
const COMMUNICATION = brainPrompt("system.communication");
const ACTION_CARE = brainPrompt("system.action-care");
const GIT = brainPrompt("system.git");
const CODE_STYLE = brainPrompt("system.code-style");
const TASKS = brainPrompt("system.tasks");
const WORKING_METHOD = brainPrompt("system.working-method");
const AUTONOMY = brainPrompt("system.autonomy");

export const SECTION_IDENTITY = shipped(IDENTITY);
export const SECTION_HARNESS = shipped(HARNESS);
export const SECTION_COMMUNICATION = shipped(COMMUNICATION);
export const SECTION_ACTION_CARE = shipped(ACTION_CARE);
export const SECTION_GIT = shipped(GIT);
export const SECTION_CODE_STYLE = shipped(CODE_STYLE);
export const SECTION_TASKS = shipped(TASKS);
export const SECTION_WORKING_METHOD = shipped(WORKING_METHOD);
export const SECTION_AUTONOMY = shipped(AUTONOMY);

/** The core sections, in the order they open the system prompt. */
const CORE_SECTIONS = [
  { id: IDENTITY, vars: { product: PRODUCT_NAME, repo: PRODUCT_REPO_URL } },
  { id: HARNESS },
  { id: COMMUNICATION },
  { id: ACTION_CARE },
  { id: GIT },
  { id: CODE_STYLE },
  { id: TASKS },
  { id: WORKING_METHOD },
  { id: AUTONOMY },
] as const;

export function behaviorCore(): string {
  // A section switched off resolves to "" and is dropped, rather than joined in
  // as a blank paragraph between two live sections.
  return CORE_SECTIONS.map((s) => ("vars" in s ? renderPrompt(s.id, s.vars) : promptText(s.id)).trim())
    .filter((text) => text !== "")
    .join("\n\n");
}

export interface PromptEnvironment {
  cwd: string;
  isGitRepo: boolean;
  platform: string;
  model: string;
  date: string;
}

const ENVIRONMENT_BLOCK = brainPrompt("system.environment");

export function environmentBlock(env: PromptEnvironment): string {
  return renderPrompt(ENVIRONMENT_BLOCK, {
    cwd: env.cwd,
    isGitRepo: env.isGitRepo ? "yes" : "no",
    platform: env.platform,
    model: env.model,
    date: env.date,
  });
}

export interface AddonSummary {
  name: string;
  description: string;
}

const ADDONS_BLOCK = brainPrompt("system.addons-block");

export function addonsBlock(addons: AddonSummary[]): string | undefined {
  if (addons.length === 0) return undefined;
  return renderPrompt(ADDONS_BLOCK, { list: addons.map((a) => `- ${a.name}: ${a.description}`).join("\n") });
}

export function buildSystemPrompt(opts: {
  env: PromptEnvironment;
  addons?: AddonSummary[];
  extraSections?: string[];
}): string {
  const parts = [behaviorCore(), environmentBlock(opts.env)];
  const addons = addonsBlock(opts.addons ?? []);
  if (addons) parts.push(addons);
  parts.push(...(opts.extraSections ?? []));
  return parts.map((p) => p.trim()).filter((p) => p !== "").join("\n\n");
}
