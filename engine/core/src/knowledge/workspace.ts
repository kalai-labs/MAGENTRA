import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * Cheap, deterministic facts about the shape of a workspace — no model call, no
 * recursion, no cache. The clarify pre-layer uses these to decide how much of a
 * codebase overview it can afford before putting a question to the user.
 */

const CODE_EXTENSIONS = new Set([".ts", ".js", ".py", ".rs", ".go", ".java", ".c", ".cpp", ".cs", ".rb", ".php"]);

const MARKER_FILES = ["package.json", "pyproject.toml", "Cargo.toml", "go.mod"];

/**
 * Cheap, depth-1 heuristic for "is there enough code here to be worth a graph
 * build" — never recurses, so it is safe to call on every turn. Gates the
 * import-graph load in the clarify skim.
 */
export function workspaceLooksNonTrivial(cwd: string): boolean {
  try {
    const entries = readdirSync(cwd, { withFileTypes: true });
    let codeFileCount = 0;
    for (const entry of entries) {
      if (entry.isFile()) {
        if (MARKER_FILES.includes(entry.name)) return true;
        if (entry.name.endsWith(".sln")) return true;
        const dot = entry.name.lastIndexOf(".");
        if (dot >= 0 && CODE_EXTENSIONS.has(entry.name.slice(dot))) codeFileCount++;
      } else if (entry.isDirectory() && entry.name === "src") {
        return true;
      }
    }
    if (codeFileCount >= 5) return true;
    return false;
  } catch {
    return false;
  }
}

/** Project name from package.json, else the workspace folder name. */
export function projectName(cwd: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { name?: unknown };
    if (typeof pkg.name === "string" && pkg.name.trim()) return pkg.name.trim();
  } catch {
    /* no package.json — fall back to the folder name */
  }
  return basename(cwd) || "workspace";
}
