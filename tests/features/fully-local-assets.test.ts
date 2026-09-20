/**
 * `fully-local-assets`.
 *
 * The renderer loads nothing from the internet. One CDN script, style or font
 * and the app stops working offline or air-gapped — and the strict CSP that
 * makes that guarantee enforceable would have to be relaxed to let it in, which
 * is the part that does not grow back.
 *
 * `pure` reads the page and the stylesheet, because a policy and a set of
 * relative paths are facts about files. `proc` runs the packager, because what
 * is shipped is a different tree from the source. `ui` boots the real app,
 * because a CSP violation only exists when a browser enforces one.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { withExclusiveLock } from "../lib/exclusive.ts";
import { repoRoot } from "../lib/inventory.ts";
import { ProcTest } from "../lib/procTest.ts";
import { PureTest } from "../lib/pureTest.ts";
import { UiTest } from "../lib/uiTest.ts";

const FEATURE = "fully-local-assets";

/** Verbatim from the record. */
const INVARIANT =
  "default-src 'none' with style/script/font all 'self': nothing is fetched from the web at runtime, so the app works air-gapped.";

const RENDERER = join(repoRoot(), "app", "renderer");

function indexHtml(): string {
  return readFileSync(join(RENDERER, "index.html"), "utf8");
}

/* ---- checklist 1, 2 and 3 — pure --------------------------------------- */

class NothingPointsAtTheInternet extends PureTest {
  readonly featureId = FEATURE;
  readonly id = "the-policy-forbids-the-web-and-nothing-asks-for-it";
  readonly invariant = INVARIANT;
  readonly whyItExists =
    "a single CDN reference breaks the app for anyone offline or air-gapped, and the policy that would have caught it has to be relaxed to let it in — after which nothing catches the next one";

  override run(t: TestRun): void {
    const html = indexHtml();

    // Checklist 1: the policy itself.
    const meta = /<meta[^>]*http-equiv="Content-Security-Policy"[^>]*content="([^"]*)"/i.exec(html);
    t.assert.notEqual(meta, null, "the page must carry a Content-Security-Policy");
    const policy = meta?.[1] ?? "";
    for (const directive of ["default-src 'none'", "style-src 'self'", "script-src 'self'", "font-src 'self'"]) {
      t.assert.ok(policy.includes(directive), `the policy must state ${directive}; it says "${policy}"`);
    }
    t.assert.doesNotMatch(policy, /https?:/, "no http or https source may appear in the policy");
    t.assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval/, "a policy that allows inline code is not a policy");

    // Checklist 2: every reference is relative, in the page and the stylesheet.
    const referenced: string[] = [];
    for (const match of html.matchAll(/<script[^>]*\ssrc="([^"]+)"/gi)) referenced.push(match[1]!);
    for (const match of html.matchAll(/<link[^>]*\shref="([^"]+)"/gi)) referenced.push(match[1]!);
    const css = readFileSync(join(RENDERER, "styles.css"), "utf8");
    for (const match of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) referenced.push(match[1]!);

    t.assert.ok(referenced.length > 10, `the page must actually reference its assets, found ${referenced.length}`);
    const remote = referenced.filter((href) => /^(https?:)?\/\//i.test(href));
    t.assert.deepEqual(remote, [], "every asset must be a relative path — these are fetched from the web");

    // Checklist 3: every font the stylesheet asks for is here, with its licence.
    const fonts = referenced.filter((href) => href.endsWith(".woff2"));
    t.assert.ok(fonts.length > 0, "the stylesheet must actually bundle fonts, or this feature is untested");
    for (const font of fonts) {
      t.assert.equal(existsSync(join(RENDERER, font)), true, `${font} is referenced but not shipped`);
    }
    t.assert.equal(
      existsSync(join(RENDERER, "fonts", "OFL-1.1.txt")),
      true,
      "a bundled font carries its licence, or the product is redistributing one without it",
    );
  }
}

/* ---- checklist 5 — proc ------------------------------------------------- */

class ThePackagedTreeCarriesTheSameAssets extends ProcTest {
  readonly featureId = FEATURE;
  readonly id = "the-packaged-renderer-ships-the-same-fonts-and-licence";
  readonly invariant = INVARIANT;
  readonly whyItExists =
    "the source tree is not what ships; a packaging step that dropped the fonts would leave the app rendering in a fallback face, offline and unlicensed";

  override readonly timeoutMs: number = 120_000;

  override async run(t: TestRun): Promise<void> {
    // The packager writes ONE fixed output directory and removes it first, and
    // three features run it. Without this lock a second run deletes the tree
    // this one is asserting about, and the failure reads as a missing font.
    await withExclusiveLock("bundle-engine", async () => {
      const bundler = this.spawn(process.execPath, [join(repoRoot(), "app", "scripts", "bundle-engine.js")]);
      const exit = await bundler.exited();
      t.assert.equal(exit.code, 0, `the packager must succeed:\n${bundler.stderr()}`);

      const packaged = join(repoRoot(), "app", "build-resources", "app", "renderer", "fonts");
      t.assert.equal(existsSync(packaged), true, "the packaged renderer must carry its fonts directory");

      const source = readdirSync(join(RENDERER, "fonts")).sort();
      const shipped = readdirSync(packaged).sort();
      for (const name of source.filter((n) => n.endsWith(".woff2") || n === "OFL-1.1.txt")) {
        t.assert.ok(shipped.includes(name), `${name} is in the source tree but not in the package`);
        t.assert.deepEqual(
          readFileSync(join(packaged, name)),
          readFileSync(join(RENDERER, "fonts", name)),
          `${name} must ship byte-for-byte — a re-encoded font is a different font`,
        );
      }
    });
  }
}

/* ---- checklist 4 — ui --------------------------------------------------- */

class TheRunningPageFetchesNothing extends UiTest {
  readonly featureId = FEATURE;
  readonly id = "the-running-page-reports-no-blocked-or-failed-resource";
  readonly invariant = INVARIANT;
  readonly whyItExists =
    "a policy is a promise until a browser enforces it; the only proof that nothing reaches for the web is a real page loading with nothing blocked";

  override async run(t: TestRun): Promise<void> {
    const home = this.makeTempDir("magentra-assets-home-");

    // Every console message and every failed request the page makes, captured
    // from the main process before the page is even asked about itself.
    const app = await this.launchApp({ HOME: home, USERPROFILE: home });
    const report = await app.evaluateInMain<{ violations: string[]; failures: string[]; fonts: number }>(`
      globalThis.__csp = [];
      globalThis.__failed = [];
      win.webContents.on("console-message", (_e, _level, message) => {
        if (/Content Security Policy|Refused to (load|connect)|ERR_/i.test(message)) globalThis.__csp.push(message);
      });
      win.webContents.session.webRequest.onErrorOccurred((details) => globalThis.__failed.push(details.url + " " + details.error));
      win.webContents.reload();
      await new Promise((r) => setTimeout(r, 6000));
      const fonts = await win.webContents.executeJavaScript("document.fonts ? document.fonts.size : 0");
      return { violations: globalThis.__csp, failures: globalThis.__failed, fonts };
    `);

    t.assert.deepEqual(report.violations, [], "the page must load with nothing refused by its own policy");
    t.assert.deepEqual(
      report.failures.filter((url) => !url.startsWith("devtools")),
      [],
      "and with no request failing — a fetch that fails offline is a fetch that should not exist",
    );
    t.assert.ok(report.fonts > 0, `the bundled faces must actually be registered, saw ${report.fonts}`);

    // Nothing in the loaded page points anywhere but at itself.
    const remote = await app.evaluate<string[]>(`
      [...document.querySelectorAll("script[src], link[href], img[src]")]
        .map((el) => el.getAttribute("src") || el.getAttribute("href") || "")
        .filter((href) => /^(https?:)?\\/\\//i.test(href))
    `);
    t.assert.deepEqual(remote, [], "the live DOM must reference nothing off this machine");
  }
}

registerFeatureTests(new NothingPointsAtTheInternet(), new ThePackagedTreeCarriesTheSameAssets(), new TheRunningPageFetchesNothing());
