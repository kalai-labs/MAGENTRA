/**
 * `mirror-default-base-url`.
 *
 * The endpoint a workspace falls back to when it configures no base URL is
 * written twice — once in the engine, once in the app — because the app cannot
 * import the engine (it ships as a bundled child process). If the two strings
 * drift, a fresh workspace goes to a different endpoint depending on which half
 * filled the blank, and nothing in `tsc` can see it: one copy is TypeScript in
 * one build unit and the other is plain JavaScript outside every build.
 *
 * `pure`. Both constants are values; the engine's mapping from settings to an
 * endpoint (`endpointSpecFromSettings`) is a function of its inputs; and the
 * regression guard is a read of two source files. Nothing is spawned and
 * nothing is written.
 *
 * `app/main/config.js` loads in plain Node: its `require("electron")` resolves
 * to the electron package's entry, which is the path to the binary, so `app`
 * is undefined and nothing here calls it. No stub is needed and none is used.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { DEFAULT_OPENAI_BASE_URL, endpointSpecFromSettings } from "@magentra/core";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { repoRoot } from "../lib/inventory.ts";
import { PureTest } from "../lib/pureTest.ts";

const FEATURE = "mirror-default-base-url";

/** Verbatim from the record. */
const INVARIANT = "DEFAULT_BASE_URL is the same string in both halves.";

const requireFromHere = createRequire(import.meta.url);

/** The app's copy, read from the module the main process actually loads. */
function appDefaultBaseUrl(): string {
  const config = requireFromHere(join(repoRoot(), "app", "main", "config.js")) as { DEFAULT_BASE_URL: string };
  return config.DEFAULT_BASE_URL;
}

abstract class DefaultBaseUrlTest extends PureTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
}

/* ---- checklist 1 ----------------------------------------------------- */

class TheTwoDefaultsAreOneString extends DefaultBaseUrlTest {
  readonly id = "the-engine-and-the-app-hold-the-same-default";
  readonly whyItExists =
    "the app's copy was edited to a new provider while the engine kept the old one, so a workspace the wizard left blank booted against an endpoint the user had never seen";

  override run(t: TestRun): void {
    t.assert.equal(typeof DEFAULT_OPENAI_BASE_URL, "string");
    t.assert.equal(
      appDefaultBaseUrl(),
      DEFAULT_OPENAI_BASE_URL,
      "app/main/config.js DEFAULT_BASE_URL and engine/core/src/config/settings.ts DEFAULT_OPENAI_BASE_URL have drifted",
    );
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class BothAreAbsoluteHttpsWithoutATrailingSlash extends DefaultBaseUrlTest {
  readonly id = "both-defaults-are-absolute-https-urls-with-no-trailing-slash";
  readonly whyItExists =
    "a trailing slash on one copy made `${baseUrl}/chat/completions` resolve to a double-slash path on that side only, so two equal-looking defaults probed two different URLs";

  override run(t: TestRun): void {
    for (const [side, value] of [
      ["engine", DEFAULT_OPENAI_BASE_URL],
      ["app", appDefaultBaseUrl()],
    ] as const) {
      const parsed = new URL(value);
      t.assert.equal(parsed.protocol, "https:", `${side}: the default must be an https URL, got ${value}`);
      t.assert.notEqual(parsed.hostname, "", `${side}: the default must name a host`);
      t.assert.equal(value.endsWith("/"), false, `${side}: the default must not end in a slash, got ${value}`);
      // Absolute, and already in the form the URL parser would print it — so
      // neither side has anything to normalize before appending a path.
      t.assert.equal(parsed.href, value, `${side}: the default must be canonical as written`);
    }
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class TheEngineFillsTheBlankWithTheAppsDefault extends DefaultBaseUrlTest {
  readonly id = "a-settings-layer-with-no-base-url-resolves-to-the-apps-default";
  readonly whyItExists =
    "endpointSpecFromSettings is the one place a blank baseUrl becomes an endpoint; if it filled the blank from anywhere but the shared constant, the two halves could agree on the constant and still disagree at boot";

  override run(t: TestRun): void {
    const blank = endpointSpecFromSettings({ provider: "openai-compatible" }, "k");
    t.assert.equal(blank.provider, "openai-compatible");
    t.assert.equal(blank.baseUrl, appDefaultBaseUrl(), "a blank baseUrl must resolve to the app's default, or the two halves boot differently");
    t.assert.equal(blank.apiKey, "k");

    // The control: a configured baseUrl is honoured, so the line above is not
    // passing because the function ignores its input.
    const configured = endpointSpecFromSettings({ provider: "openai-compatible", baseUrl: "http://127.0.0.1:11434/v1" }, "k");
    t.assert.equal(configured.baseUrl, "http://127.0.0.1:11434/v1");

    // And an anthropic connection never carries the OpenAI-compatible default.
    const anthropic = endpointSpecFromSettings({ provider: "anthropic" }, "k");
    t.assert.equal(anthropic.baseUrl, undefined, "the default is an OpenAI-compatible endpoint and must never leak into an anthropic spec");
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class EachHalfHoldsExactlyOneCopy extends DefaultBaseUrlTest {
  readonly id = "each-half-holds-exactly-one-literal-of-the-default";
  readonly whyItExists =
    "a second literal of the URL in either file is a third copy of a mirrored constant, and a later edit that finds one and not the other is a drift the parity test above cannot see";

  override run(t: TestRun): void {
    const literal = DEFAULT_OPENAI_BASE_URL;
    for (const rel of ["engine/core/src/config/settings.ts", "app/main/config.js"]) {
      const source = readFileSync(join(repoRoot(), rel), "utf8");
      const count = source.split(literal).length - 1;
      t.assert.equal(count, 1, `${rel} must hold exactly one literal of ${literal}, found ${count}`);
    }
  }
}

registerFeatureTests(
  new TheTwoDefaultsAreOneString(),
  new BothAreAbsoluteHttpsWithoutATrailingSlash(),
  new TheEngineFillsTheBlankWithTheAppsDefault(),
  new EachHalfHoldsExactlyOneCopy(),
);
