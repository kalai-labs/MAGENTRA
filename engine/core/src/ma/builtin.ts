/**
 * Built-in discipline skills, shipped in-code and parsed by parseSkillMd at load.
 *
 * The catalog is currently EMPTY: the original disciplines were retired for a
 * from-scratch redesign as "Addons" (their text is archived under
 * /obsolete/skills for reference). A workspace can still define disciplines by
 * dropping a `kind: discipline` file under .magentra/skills/; new built-ins are
 * added back here as `{ id, text }` rows, and any recommended id must be listed
 * in RECOMMENDED_SKILL_IDS (see modes.ts — a startup invariant enforces it).
 */

export interface BuiltinSkill {
  id: string;
  text: string;
}

export const BUILTIN_SKILL_FILES: BuiltinSkill[] = [];
