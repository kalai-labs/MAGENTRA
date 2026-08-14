// Renders the big-picture architecture reference to BIG-PICTURE.pdf at the repo root.
//
//   npx electron docs/big-picture/render.mjs
//
// Same shape as docs/prompt-review/render.mjs, and for the same reason: the HTML
// beside this file is the source of truth, this script is the build. A PDF
// committed without its source cannot be updated without re-authoring it.

import { app, BrowserWindow } from "electron";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

const JOBS = [{ src: join(HERE, "big-picture.html"), out: join(ROOT, "BIG-PICTURE.pdf") }];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Destroying the only window fires window-all-closed, whose default handler
// quits the app before the loop finishes. Hold it open; we exit explicitly.
app.on("window-all-closed", () => {});

app.on("ready", async () => {
  let failed = 0;
  for (const { src, out } of JOBS) {
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
