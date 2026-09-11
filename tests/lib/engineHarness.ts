/**
 * The engine, in a child process, with a fake provider — the program a
 * `ProcTest` spawns when the thing under test is how the engine handles a
 * frame.
 *
 * WHY A CHILD AND NOT AN IMPORT. The desktop app does not call the engine, it
 * SPAWNS it and speaks NDJSON over its stdio (`engine/host/src/serve.ts`), and
 * `set_connection` is a frame on that wire. A test that constructed an Engine
 * in-process and called `send()` would prove the handler and skip the wire —
 * and the wire is where the two halves of this repo are joined by nothing but a
 * string literal. So the harness is the real host loop (`runServe`) around a
 * real Engine, and only the Provider is a double.
 *
 * WHAT IS FAKED, AND WHAT THAT COSTS. `EngineOptions.providerFactory` exists
 * for exactly this, and `FakeProvider` is the repo's own scripted provider — no
 * test may call a real API. Everything else is the shipped code: the real
 * Session, the real settings object, the real registry, the real frame decoder.
 *
 * HOW THE TEST SEES INSIDE. Three of the four things `set_connection` must do
 * happen to state that never leaves this process — `process.env`, the in-memory
 * `Settings`, and which Provider the Session now holds. So this harness reports
 * them, as extra NDJSON lines with `type: "harness"`, interleaved in order with
 * the engine's own events on the same stdout. It reports only what it OBSERVES:
 * the spec the engine asked it to build from, the environment and settings as
 * they stand at that moment, and the messages the real Session hands the
 * provider. It never asserts, and it never reports anything it was told to
 * report — a harness that echoed the test's own expectation back would be the
 * mock-returns-what-the-mock-was-told non-test this suite forbids.
 *
 * `provider_built` is emitted ONLY from the factory, so a count of those lines
 * is a count of real provider rebuilds — which is what tells `/settings
 * baseUrl` (rebuilds) from `/settings model` (must not).
 *
 * REQUIRES `npm run build`. It imports the engine through its package entry
 * points, which resolve to each package's `dist/` — the same built code the app
 * spawns. `dist/` is gitignored, so a fresh clone must build before this runs;
 * the test says so when the entry point is missing rather than failing obscurely.
 *
 * Run as: node tests/lib/engineHarness.ts <workspace-dir>
 */

import { DEFAULT_API_KEY_ENV, Engine, loadSettings } from "@magentra/core";
import { runServe } from "@magentra/host";
import { encodeFrame } from "@magentra/protocol";
import { FakeProvider } from "@magentra/providers";
import type { Msg, Provider, ProviderEvent, StreamRequest } from "@magentra/providers";
import { createDefaultRegistry } from "@magentra/tools";

/** The four variables `handleSetConnection` is specified to clear for a keyless endpoint. */
const KEY_VARS = [DEFAULT_API_KEY_ENV, "OPENAI_API_KEY", "DEEPINFRA_API_KEY", "ANTHROPIC_API_KEY"] as const;

/** Settings fields the connection frame is specified to write, clear, or leave alone. */
const WATCHED_SETTINGS = [
  "provider",
  "baseUrl",
  "model",
  "contextWindow",
  "reasoningEffort",
  "apiKey",
  "apiKeyEnv",
  "vision",
  "visionConnection",
  "allowInsecureTls",
] as const;

function report(event: string, extra: Record<string, unknown>): void {
  process.stdout.write(encodeFrame({ type: "harness", event, ...extra }));
}

/** The environment as it stands, limited to the variables that decide which key is sent. */
function envSnapshot(): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const name of KEY_VARS) out[name] = process.env[name] ?? null;
  out["NODE_TLS_REJECT_UNAUTHORIZED"] = process.env["NODE_TLS_REJECT_UNAUTHORIZED"] ?? null;
  return out;
}

/**
 * The watched settings, plus the full key list.
 *
 * The key list is what makes "deleted" provable: `apiKey: undefined` and no
 * `apiKey` at all serialize to the same JSON, and the frame's contract is that
 * the key is DELETED from settings, not blanked.
 */
function settingsSnapshot(settings: Record<string, unknown>): Record<string, unknown> {
  const watched: Record<string, unknown> = {};
  for (const name of WATCHED_SETTINGS) {
    if (name in settings) watched[name] = settings[name];
  }
  return { watched, keys: Object.keys(settings).sort() };
}

function textOf(message: Msg): string {
  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/**
 * A scripted provider that announces every call. Each generation answers with
 * its own number, so which provider the LIVE session is talking to is visible
 * in the assistant's text rather than inferred from a spy.
 */
function makeProvider(generation: number): Provider {
  const fake = new FakeProvider(Array.from({ length: 8 }, () => ({ text: `answer-from-provider-${generation}` })));
  return {
    stream(req: StreamRequest): AsyncIterable<ProviderEvent> {
      report("stream", {
        generation,
        messages: req.messages.map((m) => ({ role: m.role, text: textOf(m) })),
      });
      return fake.stream(req);
    },
  };
}

const cwd = process.argv[2];
if (cwd === undefined || cwd === "") {
  process.stderr.write("engineHarness: a workspace directory is required as argv[2]\n");
  process.exit(2);
}

const { settings } = loadSettings(cwd);

// Generation 1 is the boot provider, built here rather than by the factory —
// the engine only calls the factory to REBUILD. So a `provider_built` line
// always means a rebuild, and never means "an engine started".
let generation = 1;

const engine = new Engine({
  cwd,
  settings,
  provider: makeProvider(generation),
  registry: createDefaultRegistry(),
  providerFactory: (spec) => {
    generation += 1;
    // Reported from INSIDE the rebuild, so the environment and settings are
    // captured at the moment the engine considered the connection applied —
    // after handleSetConnection's writes, before anything else can run.
    report("provider_built", {
      generation,
      spec: { provider: spec.provider, baseUrl: spec.baseUrl ?? null, apiKey: spec.apiKey, numCtx: spec.numCtx ?? null },
      env: envSnapshot(),
      settings: settingsSnapshot(settings as unknown as Record<string, unknown>),
    });
    return makeProvider(generation);
  },
});

await runServe(engine);
