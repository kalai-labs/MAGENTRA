// Renders the prompt-architecture review HTML sources to the PDFs at the repo root.
//
//   npx electron docs/prompt-review/render.mjs
//
// The previous editions of report.pdf / report-tr.pdf were committed as binaries
// with no source, so they could not be updated without re-authoring from scratch.
// The HTML beside this file is now the source of truth; this script is the build.

import { app, BrowserWindow } from "electron";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

const JOBS = [
  { src: join(HERE, "report.html"), out: join(ROOT, "report.pdf") },
  { src: join(HERE, "report-tr.html"), out: join(ROOT, "report-tr.pdf") },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Destroying the only window fires window-all-closed, whose default handler
// quits the app — which killed the loop after the first document. Hold it open;
// the loop exits explicitly when every job is done.
app.on("window-all-closed", () => {});

app.on("ready", async () => {
  let failed = 0;
  for (const { src, out } of JOBS) {
    // One window per document, fully settled before the next: reusing or
    // tearing down a window in the same tick raced the next loadFile (ERR_FAILED).
    const win = new BrowserWindow({ show: false, webPreferences: { javascript: false } });
    try {
      await win.loadFile(src);
      // Fonts and the @page box need a beat before the print snapshot.
      await sleep(500);
      const pdf = await win.webContents.printToPDF({
        pageSize: "A4",
        printBackground: true,
        margins: { marginType: "default" },
      });
      writeFileSync(out, pdf);
      console.log(`  wrote ${out} (${(pdf.length / 1024).toFixed(0)} KB)`);
    } catch (err) {
      failed++;
      console.error(`  FAILED ${src}: ${err.message}`);
    } finally {
      if (!win.isDestroyed()) win.destroy();
      await sleep(250);
    }
  }
  app.exit(failed === 0 ? 0 : 1);
});
