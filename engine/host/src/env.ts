import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Minimal `.env` loader: KEY=VALUE lines, only filling vars that are unset, so a
 * real environment variable always wins over the file. Deliberately no dotenv
 * dependency — the engine ships as a single bundled file and every avoided
 * dependency is one less thing inside it.
 */
export function loadDotEnv(cwd: string): void {
  let text: string;
  try {
    text = readFileSync(join(cwd, ".env"), "utf8");
  } catch {
    return;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).replace(/^export\s+/, "").trim();
    if (key === "") continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
