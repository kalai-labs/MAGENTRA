/**
 * `mirror-image-types`.
 *
 * The Read tool sends files with certain extensions to the vision model and
 * refuses them when there is none; the composer's attach picker offers the
 * same extensions when vision is on. The app cannot import the engine, so the
 * extension → media-type table exists twice (`IMAGE_TYPES` in
 * `engine/tools/src/read.ts` and in `app/main.js`). A drift means the picker
 * offers a file Read will refuse, or hides one it would accept.
 *
 * Neither copy is exported, and `app/main.js` cannot load outside Electron, so
 * this file proves the mirror three ways and cross-checks them:
 *
 *   `pure` (items 1–2) — both tables read out of the SOURCE with the
 *        TypeScript parser (the same parser the gateway uses to discover these
 *        tests), as the object literal each file declares. A parser, not a
 *        regex: a regex that misread one side would report agreement or
 *        disagreement for a reason that has nothing to do with the tables.
 *   `fs` (item 4) — the real Read tool, inside a real Engine on a scripted
 *        provider, over a `.png` in a workspace with no vision model: refused,
 *        with the message that says it cannot be seen. The same turn reads a
 *        `.bin`, whose refusal LISTS the engine's keys — a runtime check that
 *        the parsed table is the one the built engine runs.
 *   `ui` (item 3) — the real app's `context:pickFiles` handler, which derives
 *        the picker's filters from ITS table. The native file dialog cannot be
 *        driven by any test on any platform, so the test records what the app
 *        ASKS the dialog for and cancels it — the "assert the ask" line
 *        `full-screen-can-always-be-left` already draws for the window manager.
 *        The product is not touched: the recorder replaces `dialog.showOpenDialog`
 *        in the harness's main-process scope for one call.
 *
 * `pure` + `fs` + `ui`, and the record said `pure`. Re-declared 2026-09-19 for
 * the reasons above: items 3 and 4 only exist once something is running.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";

import { openWorkspace } from "../lib/appDriver.ts";
import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";
import { repoRoot } from "../lib/inventory.ts";
import { PureTest } from "../lib/pureTest.ts";
import { startScriptedEngine, type ScriptedEngine } from "../lib/scriptedEngine.ts";
import { UiTest, type AppHandle } from "../lib/uiTest.ts";

const FEATURE = "mirror-image-types";

/** Verbatim from the record. */
const INVARIANT = "The extensions Read sends to the vision endpoint and the extensions the attach picker offers are the same set.";

const ENGINE_FILE = "engine/tools/src/read.ts";
const APP_FILE = "app/main.js";

/** The five extensions the description pins, so an identical drift on both sides still fails. */
const EXPECTED_KEYS = [".gif", ".jpeg", ".jpg", ".png", ".webp"];

/**
 * The `IMAGE_TYPES` object literal of one source file, as the table it declares.
 *
 * Walks the real AST for `const IMAGE_TYPES = { ... }` and reads each property
 * as `string literal → string literal`. Anything else in that literal — a
 * spread, a computed key, a non-string value — is an error here, because the
 * tables are specified to be plain string maps and a test that silently
 * skipped an entry would report agreement it never checked.
 */
function imageTypesIn(relPath: string): Record<string, string> {
  const source = readFileSync(join(repoRoot(), relPath), "utf8");
  const file = ts.createSourceFile(relPath, source, ts.ScriptTarget.Latest, true, relPath.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  let found: Record<string, string> | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "IMAGE_TYPES" && node.initializer) {
      if (!ts.isObjectLiteralExpression(node.initializer)) throw new Error(`${relPath}: IMAGE_TYPES is not an object literal`);
      const table: Record<string, string> = {};
      for (const prop of node.initializer.properties) {
        if (!ts.isPropertyAssignment(prop) || !ts.isStringLiteral(prop.name) || !ts.isStringLiteral(prop.initializer)) {
          throw new Error(`${relPath}: IMAGE_TYPES holds an entry that is not "string": "string" — ${prop.getText(file)}`);
        }
        table[prop.name.text] = prop.initializer.text;
      }
      if (found !== undefined) throw new Error(`${relPath} declares IMAGE_TYPES twice`);
      found = table;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (found === undefined) throw new Error(`${relPath} declares no IMAGE_TYPES — the description points at a name that has moved`);
  return found;
}

abstract class ImageTypesPureTest extends PureTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
}

/* ---- checklist 1 — pure ---------------------------------------------- */

class TheKeySetsAgree extends ImageTypesPureTest {
  readonly id = "the-engine-and-the-app-name-the-same-image-extensions";
  readonly whyItExists =
    "an extension added to the Read tool and not to the picker is a file the agent can read but the user cannot attach, and the reverse is an attachment nothing can look at";

  override run(t: TestRun): void {
    const engine = Object.keys(imageTypesIn(ENGINE_FILE)).sort();
    const app = Object.keys(imageTypesIn(APP_FILE)).sort();
    t.assert.deepEqual(app, engine, `${APP_FILE} IMAGE_TYPES and ${ENGINE_FILE} IMAGE_TYPES name different extensions`);
    t.assert.deepEqual(engine, EXPECTED_KEYS, "the set is the five the description pins; a change here is a product decision, not a drift");
    for (const key of engine) t.assert.match(key, /^\.[a-z0-9]+$/, `${key} must be a lower-case dotted extension, the form both lookups use`);
  }
}

/* ---- checklist 2 — pure ---------------------------------------------- */

class TheMediaTypesAgree extends ImageTypesPureTest {
  readonly id = "every-shared-extension-maps-to-the-same-media-type";
  readonly whyItExists =
    "the app labels an attachment with its media type and the engine labels the same bytes for the vision endpoint; two labels for one file is a request the endpoint rejects on one path only";

  override run(t: TestRun): void {
    const engine = imageTypesIn(ENGINE_FILE);
    const app = imageTypesIn(APP_FILE);
    for (const key of Object.keys(engine)) {
      t.assert.equal(app[key], engine[key], `${key}: app says ${String(app[key])}, engine says ${engine[key]}`);
    }
    t.assert.equal(engine[".jpg"], "image/jpeg");
    t.assert.equal(engine[".jpeg"], "image/jpeg", ".jpg and .jpeg are one media type");
    for (const value of Object.values(engine)) t.assert.match(value, /^image\/[a-z]+$/, `${value} is not an image media type`);
  }
}

/* ---- checklist 3 — ui ------------------------------------------------ */

/** A keyless local endpoint: enough for the app to open the workspace as configured. */
const LOCAL_ENDPOINT = "http://127.0.0.1:11434/v1";

interface DialogFilter {
  readonly name: string;
  readonly extensions: string[];
}

class ThePickerOffersExactlyTheEngineExtensions extends UiTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  readonly id = "the-attach-picker-offers-the-engines-extensions-only-when-vision-is-ready";
  readonly whyItExists =
    "the picker listed images for a workspace with no vision model, so the user attached one and the turn ended with 'images need a vision model' after the fact";

  /** Record what the app asks the OS file dialog for, and cancel it. One call, then restored. */
  private async recordedFilters(app: AppHandle): Promise<DialogFilter[]> {
    await app.evaluateInMain(`
      const { dialog } = electron;
      const original = dialog.showOpenDialog;
      globalThis.__pickerAsk = undefined;
      dialog.showOpenDialog = async (_win, options) => {
        dialog.showOpenDialog = original;
        globalThis.__pickerAsk = options;
        return { canceled: true, filePaths: [] };
      };
    `);
    const picked = await app.evaluate<{ ok?: boolean }>(`window.magentra.pickContextFiles({})`);
    if (picked.ok !== false) throw new Error(`a cancelled dialog must come back as ok:false, got ${JSON.stringify(picked)}`);
    const ask = await app.evaluateInMain<{ filters?: DialogFilter[] } | undefined>(`return globalThis.__pickerAsk;`);
    if (ask === undefined || !Array.isArray(ask.filters)) throw new Error("the app opened no file dialog, or asked it for no filters");
    return ask.filters;
  }

  override async run(t: TestRun): Promise<void> {
    const home = this.makeTempDir("magentra-picker-home-");
    const app = await this.launchApp({ HOME: home, USERPROFILE: home });
    const workspace = this.makeTempDir("magentra-picker-ws-");
    this.writeJsonFile(join(workspace, ".magentra", "settings.json"), { provider: "openai-compatible", baseUrl: LOCAL_ENDPOINT, model: "m" });
    await openWorkspace(app, workspace);

    const engineExts = Object.keys(imageTypesIn(ENGINE_FILE)).map((e) => e.slice(1)).sort();

    // Vision NOT ready: no Images filter, and no image extension anywhere.
    const without = await this.recordedFilters(app);
    t.assert.equal(without.some((f) => f.name === "Images"), false, "with no vision model the picker must not offer an Images filter");
    const offeredWithout = without.flatMap((f) => f.extensions);
    for (const ext of engineExts) t.assert.equal(offeredWithout.includes(ext), false, `${ext} must not be offered while nothing can look at it`);

    // Vision ready: the workspace's connection names a vision model and the
    // switch is on. `currentVisionConnection` reads the settings file fresh.
    this.writeJsonFile(join(workspace, ".magentra", "settings.json"), {
      provider: "openai-compatible",
      baseUrl: LOCAL_ENDPOINT,
      model: "m",
      vision: true,
      visionConnection: { provider: "openai-compatible", baseUrl: LOCAL_ENDPOINT, model: "a-vision-model" },
    });
    const withVision = await this.recordedFilters(app);
    const images = withVision.find((f) => f.name === "Images");
    t.assert.notEqual(images, undefined, "with vision ready the picker must offer an Images filter");
    t.assert.deepEqual([...(images?.extensions ?? [])].sort(), engineExts, "the Images filter must be exactly the engine's extensions, without the dot");
    const attachable = withVision.find((f) => f.name === "Attachable files");
    for (const ext of engineExts) t.assert.ok(attachable?.extensions.includes(ext), `the first (active) filter must include ${ext}, or images are hidden until the user switches filters`);
  }
}

/* ---- checklist 4 — fs ------------------------------------------------ */

/** A 1x1 PNG — enough bytes to be a real file with the extension in question. */
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

class ReadRefusesAnImageWithNoVisionModel extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;
  readonly id = "read-refuses-exactly-the-listed-extensions-when-no-vision-model-is-configured";
  readonly whyItExists =
    "a Read that returned an image's bytes as text to a model that cannot see gave the agent a page of mojibake to reason about instead of an honest refusal";

  override readonly timeoutMs: number = 60_000;

  #engine: ScriptedEngine | undefined;

  override async tearDown(): Promise<void> {
    await this.#engine?.close();
  }

  override async run(t: TestRun): Promise<void> {
    this.redirectHome();
    const workspace = this.tempDir("magentra-read-image-");
    mkdirSync(join(workspace, "pics"), { recursive: true });
    const png = join(workspace, "pics", "square.png");
    writeFileSync(png, Buffer.from(PNG_BASE64, "base64"));
    const binary = join(workspace, "pics", "blob.bin");
    writeFileSync(binary, Buffer.from([0x00, 0x01, 0x02, 0x00, 0x7f]));
    const text = join(workspace, "notes.txt");
    writeFileSync(text, "just text\n", "utf8");

    // No vision model in this workspace's settings. The script: one round of
    // three reads (read-only tools run in one batch), then the two calls the
    // finishing ladder makes after a batch with an error — the error-batch
    // reminder answered, then the one recovery nudge.
    this.#engine = await startScriptedEngine({
      workspace,
      settings: { provider: "openai-compatible", baseUrl: LOCAL_ENDPOINT, model: "m" },
      turns: [
        {
          toolCalls: [
            { name: "Read", input: { file_path: png } },
            { name: "Read", input: { file_path: binary } },
            { name: "Read", input: { file_path: text } },
          ],
        },
        { text: "I could not look at the image." },
        { text: "Nothing more to do." },
      ],
    });
    const turn = await this.#engine.runTurn("read the picture, the blob and the notes");
    t.assert.deepEqual(turn.errors, [], `the turn must not error: ${turn.errors.join(" | ")}`);
    t.assert.equal(turn.toolResults.length, 3, "all three reads must have run");

    // Pair each result with the path its call asked for, through the call id
    // the two events share — the order tools finish in is not the order they started.
    const pathOfCall = new Map<string, string>();
    for (const event of turn.events) {
      if (event.type === "tool_call_started") pathOfCall.set(event.id, (event.input as { file_path?: string }).file_path ?? "");
    }
    const byPath = (p: string) => turn.toolResults.find((r) => r.tool === "Read" && pathOfCall.get(r.id) === p);
    const image = byPath(png);
    t.assert.notEqual(image, undefined);
    t.assert.equal(image?.isError, true, "an image with no vision model must be refused");
    t.assert.match(image?.resultPreview ?? "", /is an image and you cannot see it/, "the refusal must say the image cannot be seen");
    t.assert.match(image?.resultPreview ?? "", /names no vision model/, "and why");
    t.assert.doesNotMatch(image?.resultPreview ?? "", /binary file/, "an image is refused as an image, never as an unknown binary");

    // The binary refusal lists the engine's image extensions — the table the
    // BUILT engine runs, compared against the table parsed from its source.
    const blob = byPath(binary);
    t.assert.equal(blob?.isError, true, "a NUL-bearing file is refused as binary");
    const listed = /images \(([^)]+)\)/.exec(blob?.resultPreview ?? "")?.[1]?.split("/").sort();
    t.assert.deepEqual(listed, Object.keys(imageTypesIn(ENGINE_FILE)).sort(), "the extensions the running engine treats as images are the ones its source declares");

    // Control: a text file with an extension outside the set reads normally.
    const notes = byPath(text);
    t.assert.equal(notes?.isError, false, "a text file is not an image and must be read");
    t.assert.match(notes?.resultPreview ?? "", /just text/);

    // What the model was actually told, from the provider's own record of the
    // requests: the full refusal, as a tool_result block in the history, not a
    // preview. (`messages` on a recorded request is the live session history.)
    const toolResults = this.#engine.provider.requests
      .flatMap((request) => request.messages)
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .filter((block) => block.type === "tool_result")
      .map((block) => JSON.stringify(block));
    t.assert.ok(toolResults.length >= 3, "the three reads' results must have gone back to the model");
    t.assert.ok(
      toolResults.some((block) => /square\.png is an image and you cannot see it/.test(block)),
      "the refusal must reach the model as a tool result",
    );
  }
}

registerFeatureTests(new TheKeySetsAgree(), new TheMediaTypesAgree(), new ThePickerOffersExactlyTheEngineExtensions(), new ReadRefusesAnImageWithNoVisionModel());
