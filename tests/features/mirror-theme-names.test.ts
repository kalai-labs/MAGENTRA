/**
 * `mirror-theme-names`.
 *
 * The renderer owns the theme choice, but the main process needs the same list
 * one launch early: the window's pre-paint background and the native title-bar
 * overlay are set before the renderer runs, and that is the one frame the
 * renderer can never repaint. So the list is written in `app/main/config.js`
 * and again in `app/renderer/modules/state.js`, and the first entry on both is
 * the default. An index-based mismatch applies the wrong theme; a default that
 * differs paints a dark frame ahead of a light UI.
 *
 * `ui`, and the record said `pure`. Re-declared 2026-09-19: the renderer's copy
 * lives in a classic script that reaches for the DOM as it loads —
 * `state.js` wires its settings controls at the top level — so the only place
 * `THEMES`, `DEFAULT_UI_SETTINGS`, `THEME_TITLEBAR` and `loadUiSettings` exist
 * is a running renderer. The description allows stubbing the DOM to load the
 * file elsewhere; this suite does not stub, and the real page is a launch
 * away. Main's copy is read in the real main process through the harness
 * door, where `readConfig()` has the real `app.getPath("userData")` to read
 * from, so checklist 4 runs against the file the app actually reads.
 *
 * Each test launches the app once. `HOME` is redirected so the app's profiles
 * and global settings are its own.
 */

import { join } from "node:path";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { repoRoot } from "../lib/inventory.ts";
import { UiTest, type AppHandle } from "../lib/uiTest.ts";

const FEATURE = "mirror-theme-names";

/** Verbatim from the record. */
const INVARIANT = "The theme list and its order match between main and the renderer.";

/** What main knows, read from the module the running main process loaded. */
interface MainThemes {
  readonly themes: string[];
  readonly defaultTheme: string;
}

/** What the renderer knows, read from the page's own globals. */
interface RendererThemes {
  readonly themes: string[];
  readonly defaultTheme: string;
  readonly titleBarKeys: string[];
}

abstract class ThemeMirrorTest extends UiTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  protected async startApp(): Promise<AppHandle> {
    const home = this.makeTempDir("magentra-theme-home-");
    return this.launchApp({ HOME: home, USERPROFILE: home });
  }

  /** `require` in the main process returns the module main.js already loaded — the same object, not a re-evaluation. */
  protected async mainThemes(app: AppHandle): Promise<MainThemes> {
    const configPath = JSON.stringify(join(repoRoot(), "app", "main", "config.js"));
    return app.evaluateInMain<MainThemes>(`
      const config = require(${configPath});
      return { themes: [...config.THEMES], defaultTheme: config.DEFAULT_THEME };
    `);
  }

  protected async rendererThemes(app: AppHandle): Promise<RendererThemes> {
    return app.evaluate<RendererThemes>(`({
      themes: [...THEMES],
      defaultTheme: DEFAULT_UI_SETTINGS.theme,
      titleBarKeys: Object.keys(THEME_TITLEBAR),
    })`);
  }
}

/* ---- checklist 1 ----------------------------------------------------- */

class TheListsAgree extends ThemeMirrorTest {
  readonly id = "main-and-the-renderer-list-the-same-themes-in-the-same-order";
  readonly whyItExists =
    "the renderer's segmented control picks by index, so a theme inserted into one list and not the other paints the wrong shade on the next launch";

  override async run(t: TestRun): Promise<void> {
    const app = await this.startApp();
    const main = await this.mainThemes(app);
    const renderer = await this.rendererThemes(app);
    t.assert.ok(main.themes.length >= 2, "there must be more than one theme for order to mean anything");
    t.assert.deepEqual(renderer.themes, main.themes, "app/main/config.js THEMES and app/renderer/modules/state.js THEMES have drifted");
    t.assert.equal(new Set(main.themes).size, main.themes.length, "no theme is listed twice");
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class TheDefaultsAgree extends ThemeMirrorTest {
  readonly id = "mains-default-theme-is-the-renderers-default-theme";
  readonly whyItExists =
    "main paints the first frame in its default while the renderer applies its own, and when those differed every launch flashed a dark window ahead of a light UI";

  override async run(t: TestRun): Promise<void> {
    const app = await this.startApp();
    const main = await this.mainThemes(app);
    const renderer = await this.rendererThemes(app);
    t.assert.equal(renderer.defaultTheme, main.defaultTheme, "DEFAULT_THEME and DEFAULT_UI_SETTINGS.theme disagree");
    t.assert.equal(main.defaultTheme, main.themes[0], "the default is the first entry, on the main side");
    t.assert.ok(renderer.themes.includes(renderer.defaultTheme), "the renderer's default is one of its own themes");
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class EveryThemeHasTitleBarColours extends ThemeMirrorTest {
  readonly id = "every-theme-has-a-title-bar-colour-entry";
  readonly whyItExists =
    "a theme with no THEME_TITLEBAR entry leaves the native window controls in the previous theme's colours, which reads as a half-applied theme";

  override async run(t: TestRun): Promise<void> {
    const app = await this.startApp();
    const renderer = await this.rendererThemes(app);
    for (const theme of renderer.themes) {
      t.assert.ok(renderer.titleBarKeys.includes(theme), `theme "${theme}" has no THEME_TITLEBAR entry`);
    }
    // And no orphan colours for a theme that no longer exists.
    t.assert.deepEqual([...renderer.titleBarKeys].sort(), [...renderer.themes].sort(), "THEME_TITLEBAR names exactly the themes");
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class AnUnknownThemeResetsOnBothSides extends ThemeMirrorTest {
  readonly id = "an-unknown-theme-resets-to-the-default-in-main-and-in-the-renderer";
  readonly whyItExists =
    "a legacy theme name left in config.json or localStorage put the shell on a data-theme with no token block behind it, so the window rendered unstyled";

  override async run(t: TestRun): Promise<void> {
    const app = await this.startApp();
    const main = await this.mainThemes(app);
    const configPath = JSON.stringify(join(repoRoot(), "app", "main", "config.js"));

    // Main: the file the app really reads, in its isolated userData directory.
    // Written with the theme in question, read back through readConfig().
    const mainRead = await app.evaluateInMain<{ unknown: string; known: string }>(`
      const fs = require("node:fs");
      const path = require("node:path");
      const config = require(${configPath});
      const file = path.join(electron.app.getPath("userData"), "config.json");
      fs.writeFileSync(file, JSON.stringify({ theme: "neon-legacy" }), "utf8");
      const unknown = config.readConfig().theme;
      fs.writeFileSync(file, JSON.stringify({ theme: ${JSON.stringify(main.themes[main.themes.length - 1])} }), "utf8");
      const known = config.readConfig().theme;
      return { unknown, known };
    `);
    t.assert.equal(mainRead.unknown, main.defaultTheme, "main: an unknown theme in config.json must read as the default");
    // The control proves readConfig() read THIS file: a known theme comes back as itself.
    t.assert.equal(mainRead.known, main.themes[main.themes.length - 1], "main: a known theme in config.json must be honoured");

    // Renderer: the same value in localStorage, through the sanitizer the page runs at load.
    const rendererRead = await app.evaluate<{ unknown: string; known: string }>(`
      (() => {
        const previous = localStorage.getItem(UI_SETTINGS_KEY);
        try {
          localStorage.setItem(UI_SETTINGS_KEY, JSON.stringify({ theme: "neon-legacy" }));
          const unknown = loadUiSettings().theme;
          localStorage.setItem(UI_SETTINGS_KEY, JSON.stringify({ theme: THEMES[THEMES.length - 1] }));
          const known = loadUiSettings().theme;
          return { unknown, known };
        } finally {
          if (previous === null) localStorage.removeItem(UI_SETTINGS_KEY);
          else localStorage.setItem(UI_SETTINGS_KEY, previous);
        }
      })()
    `);
    t.assert.equal(rendererRead.unknown, main.defaultTheme, "renderer: an unknown saved theme must collapse to the same default main uses");
    t.assert.equal(rendererRead.known, main.themes[main.themes.length - 1], "renderer: a known saved theme must be honoured");
  }
}

registerFeatureTests(new TheListsAgree(), new TheDefaultsAgree(), new EveryThemeHasTitleBarColours(), new AnUnknownThemeResetsOnBothSides());
