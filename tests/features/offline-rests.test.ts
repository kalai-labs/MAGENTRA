/**
 * `offline-rests`.
 *
 * `api.github.com` is rate-limited at 60 requests an hour per IP, so the update
 * check reads the releases page instead — a redirect served as JSON when asked
 * for it. And when that fails, nothing is wrong that the user can act on: being
 * offline is not an error state, so the check rests at "up to date" rather than
 * putting a banner in front of someone who cannot do anything about it.
 *
 * `pure`: the module's network call goes through the global `fetch`, which is
 * replaced here and put back. Nothing leaves the machine.
 *
 * HOW THE MODULE IS REACHED. `app/main/updates.js` destructures `electron` at
 * line 23, which outside Electron yields `undefined` for `app` and `shell` —
 * the file still loads, and every function that does not touch them works.
 * `initUpdates` assigns its `broadcast` and `log` callbacks BEFORE it calls
 * `app.getVersion()`, so calling it and catching the failure is what gives the
 * module somewhere to report to. That is a real seam, not a mock: the callbacks
 * are the ones the Electron main process passes.
 *
 * NOT COVERED: checklist 5's second half, `startUpdate()` opening the release
 * page, calls `shell.openExternal` — `shell` is Electron's, and faking it would
 * be testing the fake. What IS covered is the decision in front of it:
 * `assetName` returning null for the platforms that have no artifact, which is
 * what sends that path to the release page in the first place.
 */

import { createRequire } from "node:module";
import { join } from "node:path";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { repoRoot } from "../lib/inventory.ts";
import { PureTest } from "../lib/pureTest.ts";

const FEATURE = "offline-rests";

/** Verbatim from the record. */
const INVARIANT = "The check uses the releases feed, never api.github.com, and a platform with no artifact opens the release page rather than guessing a file name.";

const requireFromHere = createRequire(import.meta.url);

interface UpdateState {
  status?: string;
  version?: string | null;
  tier?: string;
  current?: string;
  notesUrl?: string;
}

interface UpdatesModule {
  initUpdates(options: { broadcast: (state: UpdateState) => void; log: (event: string, data?: unknown) => void; enabled: boolean }): void;
  updateState(): UpdateState;
  checkNow(): Promise<void>;
  assetName(version: string): string | null;
  installTier(): string;
}

function updates(): UpdatesModule {
  return requireFromHere(join(repoRoot(), "app", "main", "updates.js")) as UpdatesModule;
}

interface Recorded {
  readonly events: { event: string; data?: unknown }[];
}

/**
 * Give the module the two callbacks the main process gives it.
 *
 * `initUpdates` throws on `app.getVersion()` outside Electron — AFTER it has
 * assigned them, which is the whole point. The throw is expected and swallowed;
 * anything else is a real failure and is re-thrown.
 */
function wire(module: UpdatesModule): Recorded {
  const events: { event: string; data?: unknown }[] = [];
  try {
    module.initUpdates({ broadcast: () => {}, log: (event, data) => events.push({ event, data }), enabled: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/getVersion|undefined/.test(message)) throw err;
  }
  return { events };
}

/** Run `body` with `fetch` replaced, and put the real one back. */
async function withFetch<T>(impl: (url: string, init?: unknown) => Promise<unknown>, body: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = impl;
  try {
    return await body();
  } finally {
    (globalThis as { fetch: unknown }).fetch = real;
  }
}

abstract class UpdateCheckTest extends PureTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  /** The module, wired, on the assisted tier with a known current version. */
  protected ready(): { module: UpdatesModule; recorded: Recorded } {
    const module = updates();
    const recorded = wire(module);
    // `updateState()` returns the live object, so this is the module's own
    // state, set to the tier whose behaviour this feature is about.
    const state = module.updateState();
    state.tier = "assisted";
    state.current = "1.0.0";
    state.status = "uptodate";
    return { module, recorded };
  }
}

/* ---- checklist 1 and 2 ------------------------------------------------- */

class AFailedCheckRests extends UpdateCheckTest {
  readonly id = "a-failed-or-refused-check-rests-at-up-to-date";
  readonly whyItExists =
    "an error banner for a failed update check gives the user nothing to act on — being offline is not something they can fix from inside the app";

  override async run(t: TestRun): Promise<void> {
    // Offline: the request rejects outright.
    const offline = this.ready();
    await withFetch(
      () => Promise.reject(new Error("getaddrinfo ENOTFOUND github.com")),
      () => offline.module.checkNow(),
    );
    t.assert.equal(offline.module.updateState().status, "uptodate", "being offline must not become an error state");
    t.assert.equal(offline.module.updateState().version, null);
    t.assert.ok(
      offline.recorded.events.some((e) => e.event === "update-check-failed"),
      `the failure must still be recorded for anyone reading the log; saw ${JSON.stringify(offline.recorded.events)}`,
    );

    // Refused: the page answers, with a status that is not OK. The body is
    // deliberately a VALID-looking answer — if the status were not what decides,
    // this tag would be believed. An empty body made both readings agree and
    // let a mutation through.
    const refused = this.ready();
    await withFetch(
      () => Promise.resolve({ ok: false, status: 404, json: async () => ({ tag_name: "v9.9.9" }) }),
      () => refused.module.checkNow(),
    );
    t.assert.equal(refused.module.updateState().status, "uptodate", "a non-OK answer is no answer, not an error");
    t.assert.equal(refused.module.updateState().version, null);

    // The control: a real answer must still be noticed, or the two cases above
    // would pass for a check that never does anything.
    const available = this.ready();
    await withFetch(
      () => Promise.resolve({ ok: true, status: 200, json: async () => ({ tag_name: "v9.9.9" }) }),
      () => available.module.checkNow(),
    );
    t.assert.equal(available.module.updateState().status, "available", "a newer release must still be reported");
    t.assert.equal(available.module.updateState().version, "9.9.9");
  }
}

/* ---- checklist 3 ------------------------------------------------------- */

class TheRateLimitedApiIsNeverAsked extends UpdateCheckTest {
  readonly id = "the-rate-limited-api-is-never-the-thing-asked";
  readonly whyItExists =
    "api.github.com allows 60 requests an hour per IP, so an office behind one address would start failing its update checks for everyone at once";

  override async run(t: TestRun): Promise<void> {
    const asked: string[] = [];
    const ready = this.ready();
    await withFetch(
      (url) => {
        asked.push(String(url));
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ tag_name: "v1.0.0" }) });
      },
      () => ready.module.checkNow(),
    );

    t.assert.equal(asked.length, 1, "one check is one request");
    t.assert.ok(asked[0]?.startsWith("https://github.com/"), `the check must read the releases page, asked ${asked[0]}`);
    t.assert.doesNotMatch(String(asked[0]), /api\.github\.com/, "the rate-limited API must never be the thing asked");
    t.assert.match(String(asked[0]), /\/releases\/latest$/);

    // And nothing else in the module reaches for it either. The name does
    // appear once, in the comment explaining why it is not used — so what is
    // checked is that no line of CODE mentions it.
    const code = readSource()
      .split("\n")
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join("\n");
    t.assert.doesNotMatch(code, /api\.github\.com/, "the rate-limited API must not be reachable from any code path in the updater");

    // The notes link the UI offers is the same host.
    t.assert.ok(String(ready.module.updateState().notesUrl).startsWith("https://github.com/"));
  }
}

function readSource(): string {
  const { readFileSync } = requireFromHere("node:fs") as typeof import("node:fs");
  return readFileSync(join(repoRoot(), "app", "main", "updates.js"), "utf8");
}

/* ---- checklist 5 (the decision in front of the browser hand-off) -------- */

class NoArtifactMeansTheReleasePage extends UpdateCheckTest {
  readonly id = "a-platform-with-no-artifact-names-no-file";
  readonly whyItExists =
    "guessing a file name for a platform that publishes none sent the user to a 404 instead of the release page, where the thing they wanted was listed";

  override run(t: TestRun): void {
    const { assetName } = updates();

    // The platform branches are read from `process`, so this is the only way to
    // ask about a machine that is not this one. Restored in the `finally`, and
    // `PureTest` fails the test if it ever is not.
    const realPlatform = process.platform;
    const realArch = process.arch;
    const pretend = (platform: string, arch: string): void => {
      Object.defineProperty(process, "platform", { value: platform, configurable: true });
      Object.defineProperty(process, "arch", { value: arch, configurable: true });
    };
    try {
      pretend("darwin", "x64");
      t.assert.equal(assetName("1.2.3"), null, "no Intel mac dmg is published, so no file name may be guessed");

      pretend("darwin", "arm64");
      t.assert.equal(assetName("1.2.3"), "MAGENTRA-1.2.3-mac-arm64.dmg", "the arm64 dmg is published and must be named exactly");

      pretend("linux", "arm64");
      t.assert.equal(assetName("1.2.3"), null, "only x64 Linux artifacts are published");
    } finally {
      Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
      Object.defineProperty(process, "arch", { value: realArch, configurable: true });
    }

    t.assert.equal(process.platform, realPlatform, "the platform must be put back before anything else runs");
  }
}

registerFeatureTests(new AFailedCheckRests(), new TheRateLimitedApiIsNeverAsked(), new NoArtifactMeansTheReleasePage());
