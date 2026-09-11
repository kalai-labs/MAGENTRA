/**
 * `connections-live-in-one-place`.
 *
 * Two places to type an API key can disagree, and then nobody — not the user,
 * not a support thread — can tell which surface configured what. So the
 * Settings view holds appearance, activity, context and safety, and points at
 * the wizard; the endpoint, the key, the model, TEST and SAVE live in the
 * wizard alone, and vision is toggled per workspace from the context menu that
 * names the tab it was opened from.
 *
 * `pure` reads the page's markup and the modules' source, because "there is no
 * second place" is a claim about what exists. `ui` opens the real menu in the
 * real app, because a context menu is built when it is opened and not before.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { openWorkspace, waitForSpawn } from "../lib/appDriver.ts";
import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { repoRoot } from "../lib/inventory.ts";
import { PureTest } from "../lib/pureTest.ts";
import { UiTest } from "../lib/uiTest.ts";

const FEATURE = "connections-live-in-one-place";

/** Verbatim from the record. */
const INVARIANT = "The Settings view carries no endpoint, key, model, TEST or save controls at all; the connection wizard owns every one.";

/** The wizard's fields. Each must exist exactly once, in the wizard. */
const WIZARD_IDS = ["wizBaseUrl", "wizApiKey", "wizModel", "wizTestBtn", "wizStartBtn"];

function indexHtml(): string {
  return readFileSync(join(repoRoot(), "app", "renderer", "index.html"), "utf8");
}

/* ---- checklist 1, 2, 5 and 6 — pure ------------------------------------ */

class ThereIsNoSecondPlace extends PureTest {
  readonly featureId = FEATURE;
  readonly id = "settings-holds-no-connection-field-and-the-wizard-holds-them-once";
  readonly invariant = INVARIANT;
  readonly whyItExists =
    "two surfaces that both write an endpoint can disagree, and the user has no way to tell which one the engine actually read";

  override run(t: TestRun): void {
    const html = indexHtml();

    // Checklist 2: each field exists exactly once in the whole page.
    for (const id of WIZARD_IDS) {
      const occurrences = html.split(`id="${id}"`).length - 1;
      t.assert.equal(occurrences, 1, `${id} must exist exactly once — a second copy is a second place to configure a connection`);
    }

    // Checklist 1: and none of them, nor anything like them, is in Settings.
    const start = html.indexOf('<section id="settingsView"');
    t.assert.notEqual(start, -1, "the settings view must exist to be checked");
    const settings = html.slice(start, html.indexOf("</section>", start));
    t.assert.ok(settings.length > 500, "the settings view must have been captured, not an empty slice");

    for (const id of WIZARD_IDS) {
      t.assert.equal(settings.includes(id), false, `${id} must not appear in the settings view`);
    }
    t.assert.doesNotMatch(settings, /id="wiz/, "no wizard field may live in Settings");
    t.assert.doesNotMatch(settings, /placeholder="[^"]*(base url|api key|endpoint)/i, "Settings must not ask for an endpoint or a key");
    t.assert.doesNotMatch(settings, />\s*(TEST|SAVE)\s*</i, "TEST and SAVE belong to the wizard, where the connection is");

    // Checklist 5: and it says where they went.
    t.assert.match(settings, /SET UP CONNECTIONS/, "Settings must point at the one place a connection is defined");

    // Checklist 6: one writer. Only the wizard's own module and the main
    // process's connection code may send a connection anywhere.
    const modules = join(repoRoot(), "app", "renderer", "modules");
    const writers: string[] = [];
    for (const name of readdirSync(modules).filter((n) => n.endsWith(".js"))) {
      const source = readFileSync(join(modules, name), "utf8");
      if (/saveProfile\s*\(|applyProfile\s*\(|testConnection\s*\(/.test(source)) writers.push(name);
    }
    t.assert.deepEqual(
      writers.sort(),
      ["setup.js"],
      `only the wizard's module may save, apply or test a connection; these also do: ${writers.join(", ")}`,
    );
  }
}

/* ---- checklist 3 and 4 — ui -------------------------------------------- */

class TheMenuOffersTheWizardForThatRow extends UiTest {
  readonly featureId = FEATURE;
  readonly id = "the-workspace-menu-offers-the-wizard-and-the-vision-toggle";
  readonly invariant = INVARIANT;
  readonly whyItExists =
    "the wizard is the only place a connection is defined, so every surface that lets a user change one has to be a way INTO it rather than a copy of it";

  override async run(t: TestRun): Promise<void> {
    const home = this.makeTempDir("magentra-conn-home-");
    const workspace = this.makeTempDir("magentra-conn-ws-");
    this.writeJsonFile(join(workspace, ".magentra", "settings.json"), {
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "model-one",
    });
    const app = await this.launchApp({ HOME: home, USERPROFILE: home });
    await openWorkspace(app, workspace);
    await waitForSpawn(workspace);

    // The menu is built when it is opened, by the product's own builder.
    const menu = await app.evaluate<{ items: string[]; opened: string | null }>(`
      (() => {
        const host = document.createElement("div");
        document.body.appendChild(host);
        let opened = null;
        const realOpen = openConnectionsWizard;
        openConnectionsWizard = (mode, tabId) => { opened = String(mode) + ":" + String(tabId); };
        try {
          appendConnectionCtxItems(host, "tab-under-test");
          const items = [...host.querySelectorAll("button, .ctx-item")].map((el) => (el.textContent || "").trim());
          const connect = [...host.querySelectorAll("button, .ctx-item")].find((el) => /SET CONNECTION/i.test(el.textContent || ""));
          if (connect) connect.click();
          return { items, opened };
        } finally {
          openConnectionsWizard = realOpen;
          host.remove();
        }
      })()
    `);

    t.assert.ok(
      menu.items.some((label) => /SET CONNECTION/i.test(label)),
      `the workspace menu must offer the wizard; it offered ${JSON.stringify(menu.items)}`,
    );
    t.assert.ok(menu.items.some((label) => /VISION/i.test(label)), "and the per-workspace vision toggle");
    t.assert.equal(
      menu.opened,
      "apply:tab-under-test",
      "choosing it must open the wizard for THAT row's tab — not for whichever console happens to be focused",
    );
  }
}

registerFeatureTests(new ThereIsNoSecondPlace(), new TheMenuOffersTheWizardForThatRow());
