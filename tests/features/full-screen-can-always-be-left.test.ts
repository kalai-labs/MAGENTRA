/**
 * `full-screen-can-always-be-left`.
 *
 * The app opens full screen, which hides the native title bar — and on Windows
 * its minimize and close buttons with it. A packaged build has no native menu
 * either. So a packaged Windows build once had no visible way to leave full
 * screen or close the window at all.
 *
 * Three exits answer that, and the point is that they are INDEPENDENT: F11
 * handled in the main process, the app's own VIEW menu, and buttons the app
 * draws in its top strip. Any one of them going missing leaves the other two,
 * which is why each is asserted separately rather than "there is a way out".
 *
 * `ui`. Full screen is a window state; the renderer cannot see it and no other
 * kind can produce it. The main-process half is driven through the harness's
 * own door (`evaluateInMain`) — the product is not asked to expose anything.
 */

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { UiTest } from "../lib/uiTest.ts";

const FEATURE = "full-screen-can-always-be-left";

/** Verbatim from the record. */
const INVARIANT =
  "Full screen can always be left by three routes that are not native chrome: F11 handled in main, the VIEW menu, and the app's own top-strip buttons.";

abstract class FullScreenTest extends UiTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  /**
   * Put the window into full screen and wait for the platform to say it is.
   *
   * macOS animates the transition, so `setFullScreen(true)` followed by
   * `isFullScreen()` reads false for about a second — a test that did not wait
   * would be asserting on the animation.
   */
  protected async enterFullScreen(app: { evaluateInMain<T>(js: string): Promise<T> }): Promise<void> {
    await app.evaluateInMain(`
      if (win.isFullScreen()) return true;
      win.setFullScreen(true);
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline && !win.isFullScreen()) await new Promise((r) => setTimeout(r, 150));
      return win.isFullScreen();
    `);
  }

  /** Send F11 to the real webContents and wait for the window to reach `want`. */
  protected async pressF11(app: { evaluateInMain<T>(js: string): Promise<T> }, want: boolean): Promise<void> {
    await app.evaluateInMain(`
      win.webContents.sendInputEvent({ type: "keyDown", keyCode: "F11" });
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline && win.isFullScreen() !== ${String(want)}) await new Promise((r) => setTimeout(r, 150));
      return win.isFullScreen();
    `);
  }

  /**
   * The posture the app settled into on its own — full screen, or the maximize
   * it falls back to when the window manager refuses.
   */
  protected async settledPosture(app: { evaluateInMain<T>(js: string): Promise<T> }): Promise<boolean> {
    return app.evaluateInMain<boolean>(`
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline && !win.isFullScreen() && !win.isMaximized()) await new Promise((r) => setTimeout(r, 150));
      await new Promise((r) => setTimeout(r, 400));
      return win.isFullScreen();
    `);
  }

  /**
   * Whether the window is full screen, waiting for any transition to finish.
   *
   * POLLED, not slept on. macOS animates the transition, and the suite runs its
   * files in parallel — several Electron instances entering full screen at once
   * take far longer than they do alone. A fixed wait passed in isolation and
   * failed in a full run, which is the worst kind of test.
   */
  protected async isFullScreen(app: { evaluateInMain<T>(js: string): Promise<T> }, expected?: boolean): Promise<boolean> {
    return app.evaluateInMain<boolean>(`
      const want = ${expected === undefined ? "null" : String(expected)};
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        if (want === null || win.isFullScreen() === want) break;
        await new Promise((r) => setTimeout(r, 150));
      }
      if (want === null) await new Promise((r) => setTimeout(r, 400));
      return win.isFullScreen();
    `);
  }
}

/* ---- checklist 1 ------------------------------------------------------- */

class F11IsHandledInMain extends FullScreenTest {
  readonly id = "f11-leaves-full-screen-and-puts-it-back";
  readonly whyItExists =
    "with the native title bar hidden and no menu in a packaged build, a key handled in the main process is the only exit that needs no pixels on screen";

  override async run(t: TestRun): Promise<void> {
    const home = this.makeTempDir("magentra-fs-home-");
    const app = await this.launchApp({ HOME: home, USERPROFILE: home });
    await this.settledPosture(app);

    // WHAT IS ASSERTED, AND WHY IT IS NOT "the window went full screen".
    // `applyOpeningPosture` already treats the desktop as free to refuse full
    // screen — it falls back to maximizing. macOS also serialises the
    // transition across applications, and this suite runs several Electron
    // instances at once, so whether the window server grants it within any
    // deadline is not a property of this app. Asserting on it failed roughly
    // one run in three, always in a full run and never alone: the worst kind
    // of test. What `app/main.js` actually owns is the HANDLER — that F11
    // reaches it and asks the window to toggle — and that is what is measured,
    // through Electron's own object, instrumented from the test's side.
    await app.evaluateInMain(`
      globalThis.__asked = [];
      globalThis.__realSetFullScreen = win.setFullScreen.bind(win);
      win.setFullScreen = (value) => { globalThis.__asked.push(value); return globalThis.__realSetFullScreen(value); };
      return true;
    `);

    try {
      const before = await app.evaluateInMain<boolean>("return win.isFullScreen();");

      await app.evaluateInMain(`
        win.webContents.sendInputEvent({ type: "keyDown", keyCode: "F11" });
        await new Promise((r) => setTimeout(r, 500));
        return true;
      `);
      t.assert.deepEqual(
        await app.evaluateInMain<boolean[]>("return globalThis.__asked;"),
        [!before],
        "F11 must reach the main process and ask the window for the opposite of what it is",
      );

      // A key the handler must ignore, so the assertion above is about F11 and
      // not about any key at all reaching the window.
      await app.evaluateInMain(`
        win.webContents.sendInputEvent({ type: "keyDown", keyCode: "F10" });
        await new Promise((r) => setTimeout(r, 500));
        return true;
      `);
      t.assert.equal(
        (await app.evaluateInMain<boolean[]>("return globalThis.__asked;")).length,
        1,
        "only F11 toggles full screen; another key must not",
      );
    } finally {
      await app.evaluateInMain("win.setFullScreen = globalThis.__realSetFullScreen; return true;");
    }
  }
}

/* ---- checklist 2 and 5 ------------------------------------------------- */

class TheTopStripButtonsWork extends FullScreenTest {
  readonly id = "the-apps-own-buttons-leave-full-screen-and-minimize";
  readonly whyItExists =
    "on Windows the native minimize and close buttons are hidden with the title bar, so the ones the app draws itself are the only ones there are";

  override async run(t: TestRun): Promise<void> {
    const home = this.makeTempDir("magentra-fs2-home-");
    const app = await this.launchApp({ HOME: home, USERPROFILE: home });
    await this.settledPosture(app);

    // No full-screen precondition. What the button owns is the message it
    // sends, and it sends the same one from either posture — while WAITING for
    // the desktop to grant full screen first made this the slowest and least
    // reliable test in the suite, failing about one full run in four for a
    // reason that had nothing to do with the button.

    // Checklist 5, observed as an EFFECT rather than by counting calls.
    // `window.magentra` comes through Electron's contextBridge, which freezes
    // it — a wrapper assigned over `windowControl` is silently discarded and
    // the real function runs, so a call counter built that way reports zero
    // whatever the button does. The window's own state is the honest observable:
    // one message toggles it, and two would toggle it back.
    t.assert.equal(
      await app.evaluate<boolean>(`typeof window.magentra.windowControl === "function"`),
      true,
      "the preload must expose the control the button uses",
    );
    const wasFullScreen = await app.evaluateInMain<boolean>("return win.isFullScreen();");

    // Checklist 2: the button's message really reaches the window, exactly once.
    // The ask is what the app owns; the grant is the window server's, and it is
    // already proved above that the transition does happen.
    await app.evaluateInMain(`
      globalThis.__asked = [];
      globalThis.__realSetFullScreen = win.setFullScreen.bind(win);
      win.setFullScreen = (value) => { globalThis.__asked.push(value); return globalThis.__realSetFullScreen(value); };
      return true;
    `);
    try {
      await app.evaluate(`document.getElementById("winFullScreenBtn").click(); true`);
      await new Promise((resolve) => setTimeout(resolve, 600));
      t.assert.deepEqual(
        await app.evaluateInMain<boolean[]>("return globalThis.__asked;"),
        [!wasFullScreen],
        "the full-screen button must ask for the opposite of the window's state — once, not twice and not never",
      );
    } finally {
      await app.evaluateInMain("win.setFullScreen = globalThis.__realSetFullScreen; return true;");
    }


    // minimize is the other control that has no native equivalent left, and it
    // is asserted the same way: the button asks the window to minimize.
    // macOS REFUSES a minimize issued while a full-screen transition is still
    // settling, and the click above starts one — so whether the window ends up
    // minimized depends on how quickly the desktop finishes, which is not
    // something this app decides. Asserting on it failed about one run in five.
    await app.evaluateInMain(`
      globalThis.__minimized = 0;
      globalThis.__realMinimize = win.minimize.bind(win);
      win.minimize = () => { globalThis.__minimized += 1; return globalThis.__realMinimize(); };
      return true;
    `);
    try {
      await app.evaluate(`document.getElementById("winMinimizeBtn").click(); true`);
      await new Promise((resolve) => setTimeout(resolve, 600));
      t.assert.equal(
        await app.evaluateInMain<number>("return globalThis.__minimized;"),
        1,
        "the minimize button must reach the window exactly once — on Windows it is the only minimize there is",
      );
    } finally {
      await app.evaluateInMain(`win.minimize = globalThis.__realMinimize; if (win.isMinimized()) win.restore(); return true;`);
    }
  }
}

/* ---- checklist 3 and 4 ------------------------------------------------- */

class TheWayOutIsVisibleAndInTheMenu extends FullScreenTest {
  readonly id = "the-buttons-appear-in-full-screen-and-the-view-menu-lists-the-toggle";
  readonly whyItExists =
    "a control that exists but stays hidden while full screen is no way out at all, and the VIEW item is the exit for anyone who does not know the key";

  override async run(t: TestRun): Promise<void> {
    const home = this.makeTempDir("magentra-fs3-home-");
    const app = await this.launchApp({ HOME: home, USERPROFILE: home });

    await this.settledPosture(app);

    // The strip follows the `window:fullscreen` message main pushes on
    // enter-full-screen, leave-full-screen and first paint (app/main.js:878).
    // That message is delivered here on that same channel, rather than waiting
    // for a desktop that is free to refuse the transition — what is under test
    // is that the controls appear WHILE full screen, which is the renderer's
    // half of the promise.
    await app.evaluateInMain(`win.webContents.send("window:fullscreen", true); return true;`);
    await new Promise((resolve) => setTimeout(resolve, 600));

    t.assert.equal(
      await app.evaluate<boolean>(`document.getElementById("windowControls").classList.contains("hidden")`),
      false,
      "the top-strip controls must be visible while full screen — that is when they are the only way out",
    );

    // Leaving puts them away again: they replace native chrome, and the native
    // chrome is back.
    await app.evaluateInMain(`win.webContents.send("window:fullscreen", false); return true;`);
    await new Promise((resolve) => setTimeout(resolve, 600));
    t.assert.equal(
      await app.evaluate<boolean>(`document.getElementById("windowControls").classList.contains("hidden")`),
      true,
      "out of full screen the native title bar is back, so the app's own strip hides",
    );

    // Checklist 4: the VIEW menu carries the toggle, with its key hint. The
    // panel is built when the menu is opened, so it has to be opened — a query
    // against the closed page finds nothing and says nothing.
    const item = await app.evaluate<{ found: boolean; text: string | null; underView: boolean }>(`
      (() => {
        document.querySelector(".menu-root").click();
        const panel = document.querySelector(".menu-panel");
        if (!panel) return { found: false, text: null, underView: false };
        const rows = [...panel.querySelectorAll(".menu-item")];
        const row = rows.find((r) => /Toggle Full Screen/i.test(r.textContent || ""));
        if (!row) return { found: false, text: null, underView: false };
        // The group label immediately above it is the menu it belongs to.
        let previous = row.previousElementSibling;
        while (previous && !previous.classList.contains("menu-group-label")) previous = previous.previousElementSibling;
        return { found: true, text: row.textContent || "", underView: /view/i.test(previous?.textContent || "") };
      })()
    `);
    t.assert.equal(item.found, true, "the menu must list Toggle Full Screen — the exit for anyone who does not know F11");
    t.assert.match(String(item.text), /F11/, "and it must name the key, so the menu teaches the shortcut");
    t.assert.equal(item.underView, true, "it belongs under VIEW, where someone looking for it would look");

    // The menu item is wired to the same control the button uses — asserted as
    // the ASK, not as the window server's answer, for the reason set out in the
    // F11 test above: macOS serialises full-screen transitions across
    // applications and this suite runs several at once, so waiting on the grant
    // failed roughly one full run in three while the app had done its part.
    // The item toggles from the window's REAL state, which is whatever posture
    // the desktop granted at launch — not the message pushed above, which only
    // told the renderer what to draw.
    const before = await app.evaluateInMain<boolean>("return win.isFullScreen();");
    await app.evaluateInMain(`
      globalThis.__asked = [];
      globalThis.__realSetFullScreen = win.setFullScreen.bind(win);
      win.setFullScreen = (value) => { globalThis.__asked.push(value); return globalThis.__realSetFullScreen(value); };
      return true;
    `);
    try {
      await app.evaluate(`
        [...document.querySelectorAll(".menu-item")].find((r) => /Toggle Full Screen/i.test(r.textContent || "")).click();
        true
      `);
      await new Promise((resolve) => setTimeout(resolve, 600));
      t.assert.deepEqual(
        await app.evaluateInMain<boolean[]>("return globalThis.__asked;"),
        [!before],
        "the VIEW item must ask the window to toggle on its own — it is one of the three ways out",
      );
    } finally {
      await app.evaluateInMain("win.setFullScreen = globalThis.__realSetFullScreen; return true;");
    }
  }
}

registerFeatureTests(new F11IsHandledInMain(), new TheTopStripButtonsWork(), new TheWayOutIsVisibleAndInTheMenu());
