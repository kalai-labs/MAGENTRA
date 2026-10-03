/**
 * `npm run brain-editor` — the control center for brain/.
 *
 * With no command it opens the editor page. The other commands are the same
 * editor for agents and scripts: they call the same functions the page calls
 * (model.ts), so there is one way to change a brain, whoever changes it.
 *
 * Use `npm run -s` (silent) when you parse the output: without it npm prints
 * its own banner lines on stdout first.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import { SHIPPED_BRAIN } from "./compiler.ts";
import { CHANGE_GUIDE } from "./guide.ts";
import { applyChanges, checkEngine, loadBrain, newProfile, planChanges, type Plan } from "./model.ts";
import { engineState } from "./project.ts";
import { createBrainEditor } from "./server.ts";

const USAGE = `MAGENTRA brain editor — the control center for brain/

  npm run brain-editor                         open the editor page in your browser
  npm run brain-editor -- --no-open --port N   start it without opening a browser

For agents and scripts (add --json for machine-readable output):
  npm run -s brain-editor -- check                       does the brain compile, and does the engine load it?
  npm run -s brain-editor -- show [what]                 what: prompts, tools, knobs, availability,
                                                         prompt <id>, tool <Name>, knob <key>, system-prompt
  npm run -s brain-editor -- plan <changes.json|->       what a change would do; writes nothing
  npm run -s brain-editor -- apply <changes.json|->      make the change (checked first, all or nothing)
  npm run -s brain-editor -- new-profile <dir>           copy this brain into a new, empty folder
  npm run -s brain-editor -- help changes                every change type, its fields, and an example

Options:
  --brain <dir>         edit another brain folder (default: brain/)
  --expect <revision>   refuse the change if the brain moved on since you read it
  --acknowledge <a,b>   the tests you accept moving in the shipped brain (see the plan's heldBy)
  --json                print JSON
`;

const argv = process.argv.slice(2);

function option(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  const next = argv[i + 1];
  return i !== -1 && next !== undefined && !next.startsWith("--") ? next : undefined;
}

function flag(name: string): boolean {
  return argv.includes(`--${name}`);
}

/** The words that are not options or option values. */
function positionals(): string[] {
  const valued = new Set(["--brain", "--port", "--expect", "--acknowledge", "--from"]);
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (valued.has(a)) i++;
    else if (!a.startsWith("--")) out.push(a);
  }
  return out;
}

const asJson = flag("json");
const brainDir = resolve(option("brain") ?? SHIPPED_BRAIN);
const shown = (dir: string): string => relative(process.cwd(), dir) || ".";

function print(value: unknown, human: () => string): void {
  process.stdout.write(asJson ? `${JSON.stringify(value, null, 2)}\n` : `${human()}\n`);
}

function readChanges(source: string | undefined): unknown {
  if (source === undefined) throw new UsageError("name a changes file (JSON), or - to read it from stdin");
  const text = source === "-" ? readFileSync(0, "utf8") : readFileSync(resolve(source), "utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new UsageError(`the changes are not valid JSON: ${(err as Error).message}`);
  }
}

class UsageError extends Error {}

function describePlan(plan: Plan, verb: string): string {
  const lines: string[] = [];
  lines.push(`${plan.ok ? (verb === "apply" ? "Saved" : "Ready to save") : "Refused"}: ${shown(plan.dir)} (revision ${plan.revision})`);
  if (plan.refusal) lines.push(`  ${plan.refusal.code}: ${plan.refusal.message}`);
  for (const s of plan.summary) lines.push(`  - ${s}`);
  if (plan.files.length) {
    lines.push("Files:");
    for (const f of plan.files) lines.push(`  ${f.before === null ? "added  " : f.after === null ? "deleted" : "changed"} ${f.path}`);
  }
  if (plan.heldBy.length) {
    lines.push("Tests this moves in the shipped brain (the owner updates what they expect):");
    for (const h of plan.heldBy) lines.push(`  ${h.test}: ${h.why}`);
  }
  for (const p of plan.newProblems) lines.push(`Problem: ${p}`);
  for (const w of plan.newWarnings) lines.push(`Warning: ${w}`);
  if (!plan.engine.checked) lines.push(`Engine check skipped: ${plan.engine.reason ?? "unavailable"}`);
  return lines.join("\n");
}

function acknowledged(): string[] {
  return (option("acknowledge") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function serve(): Promise<number> {
  const port = Number(option("port") ?? "4321");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError(`--port must be a port number (got ${option("port")})`);
  const editor = createBrainEditor({ brain: brainDir });
  let url: string;
  try {
    ({ url } = await editor.listen(port));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
      process.stderr.write(`brain editor: port ${port} is in use — is the editor already open? Or start it with --port ${port + 1}\n`);
      return 2;
    }
    throw err;
  }
  process.stdout.write(`MAGENTRA brain editor on ${url}\n  editing ${editor.brainDir()}\n  Ctrl+C to stop\n`);
  if (!flag("no-open")) openBrowser(url);
  const stop = (): void => {
    editor.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return -1;
}

/** Best effort, as the gateway does it. */
function openBrowser(url: string): void {
  try {
    const [cmd, args] =
      process.platform === "darwin"
        ? ["open", [url]]
        : process.platform === "win32"
          ? [process.env.COMSPEC ?? "cmd.exe", ["/c", "start", "", url]]
          : ["xdg-open", [url]];
    spawn(cmd as string, args as string[], { stdio: "ignore", detached: true }).unref();
  } catch {
    // The URL is printed above.
  }
}

async function check(): Promise<number> {
  const snapshot = loadBrain(brainDir);
  const engine = snapshot.problems.length === 0 ? await checkEngine(brainDir) : undefined;
  const built = snapshot.shipped ? engineState() : null;
  const ok = snapshot.problems.length === 0 && (engine === undefined || !engine.available || engine.ok);
  const { systemPrompt: _omit, ...engineSummary } = engine && engine.available ? engine : { systemPrompt: undefined };
  print(
    { ok, dir: snapshot.dir, shipped: snapshot.shipped, revision: snapshot.revision, problems: snapshot.problems, warnings: snapshot.warnings, engine: engine ? engineSummary : null, engineState: built },
    () => {
      const lines = [`${ok ? "OK" : "PROBLEMS"}: ${shown(snapshot.dir)} (revision ${snapshot.revision}) — ${snapshot.prompts.length} prompts, ${snapshot.tools.length} tools, ${snapshot.knobs.length} knobs`];
      for (const p of snapshot.problems) lines.push(`  problem: ${p}`);
      for (const w of snapshot.warnings) lines.push(`  warning: ${w}`);
      if (engine && !engine.available) lines.push(`  engine check skipped: ${engine.reason}`);
      if (engine && engine.available && !engine.ok) lines.push(`  the engine does not load this brain: ${engine.error}`);
      if (built === "needs-build") lines.push("  the engine was built from an older brain: run npm run build");
      return lines.join("\n");
    },
  );
  return ok ? 0 : 1;
}

async function show(what: string[]): Promise<number> {
  const s = loadBrain(brainDir);
  const [kind, name] = what;
  if (kind === undefined) {
    print(s, () => `${shown(s.dir)} (revision ${s.revision}): ${s.prompts.length} prompts, ${s.tools.length} tools, ${s.knobs.length} knobs, ${s.problems.length} problems. Add --json for everything.`);
    return 0;
  }
  if (kind === "prompts") {
    print(s.prompts.map(({ text: _t, ...p }) => p), () => s.prompts.map((p) => `${p.enabled ? " " : "-"} ${p.id.padEnd(46)} ${p.label}`).join("\n"));
    return 0;
  }
  if (kind === "tools") {
    print(s.tools, () => s.tools.map((t) => `${t.offered.main ? "M" : "-"}${t.offered.overdrive ? "O" : "-"} ${t.name}`).join("\n"));
    return 0;
  }
  if (kind === "knobs") {
    print(s.knobs, () => s.knobs.map((k) => `${k.key.padEnd(44)} ${JSON.stringify(k.value)}${k.overdriveValue !== undefined ? `  (OVERDRIVE: ${JSON.stringify(k.overdriveValue)})` : ""}`).join("\n"));
    return 0;
  }
  if (kind === "availability") {
    print(s.availability, () => JSON.stringify(s.availability, null, 2));
    return 0;
  }
  if (kind === "system-prompt") {
    const engine = await checkEngine(brainDir);
    if (!engine.available || !engine.ok || engine.systemPrompt === undefined) {
      process.stderr.write(`brain editor: ${engine.available ? (engine.error ?? "the engine did not load") : engine.reason}\n`);
      return 1;
    }
    print({ systemPrompt: engine.systemPrompt }, () => engine.systemPrompt!);
    return 0;
  }
  const item =
    kind === "prompt" ? s.prompts.find((p) => p.id === name) : kind === "tool" ? s.tools.find((t) => t.name === name) : kind === "knob" ? s.knobs.find((k) => k.key === name) : undefined;
  if (!["prompt", "tool", "knob"].includes(kind)) throw new UsageError(`show what? (prompts, tools, knobs, availability, system-prompt, prompt <id>, tool <Name>, knob <key>)`);
  if (item === undefined) {
    process.stderr.write(`brain editor: no ${kind} "${name ?? ""}" in ${shown(s.dir)}\n`);
    return 1;
  }
  print(item, () => ("text" in item ? item.text : "description" in item ? item.description : JSON.stringify(item, null, 2)));
  return 0;
}

async function main(): Promise<number> {
  const [command, ...rest] = positionals();
  if (flag("help") || command === "help") {
    if (rest[0] === "changes") print(CHANGE_GUIDE, () => JSON.stringify(CHANGE_GUIDE, null, 2));
    else process.stdout.write(USAGE);
    return 0;
  }
  switch (command) {
    case undefined:
    case "serve":
      return serve();
    case "check":
      return check();
    case "show":
      return show(rest);
    case "plan":
    case "apply": {
      const changes = readChanges(rest[0]);
      const options = { ...(option("expect") ? { expectRevision: option("expect")! } : {}), acknowledge: acknowledged() };
      const result = command === "plan" ? await planChanges(brainDir, changes, options) : await applyChanges(brainDir, changes, options);
      print(result, () => describePlan(result, command));
      return result.ok ? 0 : 1;
    }
    case "new-profile": {
      if (rest[0] === undefined) throw new UsageError("name the folder for the new profile: new-profile <dir>");
      const result = newProfile(resolve(option("from") ?? brainDir), resolve(rest[0]));
      print(result, () => [result.message, ...result.problems.map((p) => `  problem: ${p}`), result.ok ? `Edit it with: npm run brain-editor -- --brain ${shown(result.dir)}` : ""].filter(Boolean).join("\n"));
      return result.ok ? 0 : 1;
    }
    default:
      throw new UsageError(`unknown command "${command}"`);
  }
}

try {
  const code = await main();
  if (code >= 0) process.exitCode = code;
} catch (err) {
  if (err instanceof UsageError) {
    process.stderr.write(`brain editor: ${err.message}\n\n${USAGE}`);
    process.exitCode = 2;
  } else {
    process.stderr.write(`brain editor: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exitCode = 1;
  }
}

