import {
  brainPrompt,
  coreSectionOrder,
  PRODUCT_NAME,
  PRODUCT_REPO_URL,
  promptDefault,
  renderPrompt,
} from "@magentra/protocol";

/**
 * Behavior sections are exported individually so an embedding frontend (e.g.
 * an IDE) can swap or drop any of them. The prose lives in
 * brain/prompts/1-core-system/; the constants below are the shipped DEFAULTS,
 * and `behaviorCore` reads whatever is in force.
 *
 * WHICH core sections exist and their ORDER come from brain: each
 * 1-core-system file's `order:` (coreSectionOrder()). A section file added
 * there joins the prompt with no change here. Two of them are data sections
 * whose text code fills — the environment block and the addon roster — so they
 * hold their place in the order but are not part of behaviorCore().
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

const ENVIRONMENT_BLOCK = brainPrompt("system.environment");
const ADDONS_BLOCK = brainPrompt("system.addons-block");

/** The vars every behaviour section is rendered with (only system.identity ships slots for them). */
const SECTION_VARS = { product: PRODUCT_NAME, repo: PRODUCT_REPO_URL };

/** A behaviour section as in force now; a switched-off one renders "". */
function behaviorSection(id: string): string {
  return renderPrompt(id, SECTION_VARS);
}

export function behaviorCore(): string {
  // A section switched off resolves to "" and is dropped, rather than joined in
  // as a blank paragraph between two live sections.
  return coreSectionOrder()
    .filter((id) => id !== ENVIRONMENT_BLOCK && id !== ADDONS_BLOCK)
    .map((id) => behaviorSection(id).trim())
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

export function addonsBlock(addons: AddonSummary[]): string | undefined {
  if (addons.length === 0) return undefined;
  return renderPrompt(ADDONS_BLOCK, { list: addons.map((a) => `- ${a.name}: ${a.description}`).join("\n") });
}

export function buildSystemPrompt(opts: {
  env: PromptEnvironment;
  addons?: AddonSummary[];
  extraSections?: string[];
}): string {
  // The 1-core-system sections in brain's order, the two data sections in
  // their place among them, then the extra sections in the order given.
  const parts: string[] = [];
  for (const id of coreSectionOrder()) {
    if (id === ENVIRONMENT_BLOCK) parts.push(environmentBlock(opts.env));
    else if (id === ADDONS_BLOCK) {
      const addons = addonsBlock(opts.addons ?? []);
      if (addons) parts.push(addons);
    } else parts.push(behaviorSection(id));
  }
  parts.push(...(opts.extraSections ?? []));
  return parts.map((p) => p.trim()).filter((p) => p !== "").join("\n\n");
}
