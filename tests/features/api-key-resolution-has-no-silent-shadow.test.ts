/**
 * `api-key-resolution-has-no-silent-shadow`.
 *
 * The pin used to STOP the search. A stale `apiKeyEnv` left over from another
 * provider skipped the key the app had just written into `MAGENTRA_API_KEY` and
 * fell all the way through to a stored key for a different endpoint — so one
 * provider's key went confidently to another's URL, was reported as "API key
 * rejected", and the correct key sat unused in the environment the whole time.
 *
 * So the order is the feature, and so is the ADMISSION: the result says where
 * the key came from, and a pin naming an unset variable is reported as dangling
 * rather than silently ignored.
 *
 * `pure`, and it reads `process.env` — which is exactly what `PureTest` checks
 * across the test. Every variable is set through {@link withEnv}, which puts
 * the environment back; if it ever stopped doing so, the kind would fail the
 * test rather than let the leak reach whatever runs next in this file.
 */

import { resolveApiKey, resolveApiKeySource } from "@magentra/core";
import type { Settings } from "@magentra/core";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { PureTest } from "../lib/pureTest.ts";

const FEATURE = "api-key-resolution-has-no-silent-shadow";

/** Verbatim from the record. */
const INVARIANT =
  "Key order is pinned apiKeyEnv, then standard env names, then the stored key; a pin never shadows the key just written, and blank env vars do not count as set.";

/** Every variable resolution can consult, cleared before each case so nothing inherited decides the answer. */
const ALL_KEY_VARS = ["MAGENTRA_API_KEY", "OPENAI_API_KEY", "DEEPINFRA_API_KEY", "ANTHROPIC_API_KEY"] as const;

/**
 * `resolveApiKeySource` reads three fields. Building the whole validated
 * `Settings` object would mean loading a layer off disk, which this kind does
 * not do — so the three are cast, and a change to the shape of the rest cannot
 * make this test wrong about the order.
 */
function settings(fields: { provider?: string; apiKeyEnv?: string; apiKey?: string }): Settings {
  return { provider: fields.provider ?? "openai-compatible", ...fields } as unknown as Settings;
}

/**
 * Run `body` with exactly `vars` in the environment, and put everything back.
 *
 * Restoring is not politeness: the tests in one file share a process, so a
 * leaked key would decide the next test's answer.
 */
function withEnv<T>(vars: Record<string, string | undefined>, body: () => T): T {
  const saved = new Map<string, string | undefined>();
  const remember = (name: string): void => {
    if (!saved.has(name)) saved.set(name, process.env[name]);
  };
  try {
    for (const name of ALL_KEY_VARS) {
      remember(name);
      delete process.env[name];
    }
    for (const [name, value] of Object.entries(vars)) {
      remember(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    return body();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

abstract class KeyOrderTest extends PureTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
}

/* ---- checklist 1 ----------------------------------------------------- */

class AStalePinDoesNotShadow extends KeyOrderTest {
  readonly id = "a-stale-pin-does-not-shadow-the-key-just-written";
  readonly whyItExists =
    "a pin left over from another provider stopped the search, so the key the app had just written was skipped and a stored key for a different endpoint was sent instead";

  override run(t: TestRun): void {
    const resolved = withEnv({ MAGENTRA_API_KEY: "k1" }, () =>
      resolveApiKeySource(settings({ apiKeyEnv: "DEEPINFRA_API_KEY", apiKey: "k2" })),
    );

    t.assert.equal(resolved.key, "k1", "an unset pin must not stop the search at the stored key");
    t.assert.equal(resolved.from, "MAGENTRA_API_KEY", "and the result must say which variable answered");
    t.assert.equal(resolved.danglingKeyEnv, "DEEPINFRA_API_KEY", "the pin that named nothing is reported, not ignored");
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class ALivePinWins extends KeyOrderTest {
  readonly id = "a-pin-that-names-a-set-variable-wins";
  readonly whyItExists =
    "the pin is the user's explicit choice of variable; if a standard name could beat it, naming one would do nothing";

  override run(t: TestRun): void {
    const resolved = withEnv({ MY_OWN_KEY_VAR: "pinned", MAGENTRA_API_KEY: "standard" }, () =>
      resolveApiKeySource(settings({ apiKeyEnv: "MY_OWN_KEY_VAR", apiKey: "stored" })),
    );

    t.assert.equal(resolved.key, "pinned", "the pinned variable is consulted first");
    t.assert.equal(resolved.from, "MY_OWN_KEY_VAR");
    t.assert.equal(resolved.danglingKeyEnv, undefined, "a pin that answered is not dangling");
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class BlankIsNotSet extends KeyOrderTest {
  readonly id = "a-blank-env-var-does-not-count-as-set";
  readonly whyItExists =
    "an exported but empty variable counted as the key, so an empty Authorization header was sent and the endpoint's refusal was blamed on the key's value";

  override run(t: TestRun): void {
    const resolved = withEnv({ MAGENTRA_API_KEY: "", OPENAI_API_KEY: "k3" }, () => resolveApiKeySource(settings({})));
    t.assert.equal(resolved.key, "k3", "a blank variable is skipped, not taken");
    t.assert.equal(resolved.from, "OPENAI_API_KEY");

    // Whitespace is blank too — a key pasted as a newline is not a key.
    const spaces = withEnv({ MAGENTRA_API_KEY: "   ", OPENAI_API_KEY: "k3" }, () => resolveApiKeySource(settings({})));
    t.assert.equal(spaces.key, "k3");

    // And a blank pin falls through to the standard names rather than winning.
    const blankPin = withEnv({ MY_OWN_KEY_VAR: "", MAGENTRA_API_KEY: "k1" }, () =>
      resolveApiKeySource(settings({ apiKeyEnv: "MY_OWN_KEY_VAR" })),
    );
    t.assert.equal(blankPin.key, "k1");
    t.assert.equal(blankPin.danglingKeyEnv, "MY_OWN_KEY_VAR", "a pin naming a blank variable names nothing");
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class TheStoredKeyIsLast extends KeyOrderTest {
  readonly id = "the-stored-key-is-last-and-nothing-is-a-real-answer";
  readonly whyItExists =
    "'where did this key come from' had no answer, so a key resolved from the wrong place looked identical to the right one";

  override run(t: TestRun): void {
    const stored = withEnv({}, () => resolveApiKeySource(settings({ apiKey: "stored" })));
    t.assert.equal(stored.key, "stored");
    t.assert.equal(stored.from, "settings", "the stored key is a named source like any other");

    const nothing = withEnv({}, () => resolveApiKeySource(settings({})));
    t.assert.equal(nothing.key, undefined, "no key anywhere is an answer, not a guess");
    t.assert.equal(nothing.from, undefined);

    // A whitespace-only stored key is not a key either.
    const blankStored = withEnv({}, () => resolveApiKeySource(settings({ apiKey: "   " })));
    t.assert.equal(blankStored.key, undefined);

    // The wrapper agrees with the detailed form.
    t.assert.equal(withEnv({ MAGENTRA_API_KEY: "k1" }, () => resolveApiKey(settings({}))), "k1");
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

class AnthropicConsultsItsOwnName extends KeyOrderTest {
  readonly id = "anthropic-consults-only-its-own-variable";
  readonly whyItExists =
    "an OPENAI_API_KEY in the environment was sent to Anthropic, which refused it — and the message blamed the key the user had correctly set elsewhere";

  override run(t: TestRun): void {
    const resolved = withEnv({ OPENAI_API_KEY: "openai", ANTHROPIC_API_KEY: "anthropic" }, () =>
      resolveApiKeySource(settings({ provider: "anthropic" })),
    );
    t.assert.equal(resolved.key, "anthropic");
    t.assert.equal(resolved.from, "ANTHROPIC_API_KEY");

    // With only the other provider's key set, anthropic has nothing — it must
    // not borrow it.
    const borrowed = withEnv({ OPENAI_API_KEY: "openai", MAGENTRA_API_KEY: "magentra" }, () =>
      resolveApiKeySource(settings({ provider: "anthropic" })),
    );
    t.assert.equal(borrowed.key, undefined, "another provider's key is not this provider's key");
    t.assert.equal(borrowed.from, undefined);

    // The converse: an openai-compatible connection does not read ANTHROPIC_API_KEY.
    const compat = withEnv({ ANTHROPIC_API_KEY: "anthropic" }, () => resolveApiKeySource(settings({})));
    t.assert.equal(compat.key, undefined);
  }
}

registerFeatureTests(
  new AStalePinDoesNotShadow(),
  new ALivePinWins(),
  new BlankIsNotSet(),
  new TheStoredKeyIsLast(),
  new AnthropicConsultsItsOwnName(),
);
