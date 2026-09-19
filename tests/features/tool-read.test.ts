/**
 * `tool-read`.
 *
 * Read returns a file as `cat -n` lines — a right-aligned number, a tab, the
 * text — within a 2000-line window that says which offset to continue from.
 * A directory, a missing path and a relative path each get their OWN
 * explanatory error. A NUL byte in the first 8KB means binary, and Read says
 * so instead of returning a page of mojibake. Documents are text-extracted
 * under a 20MB cap. An image is never handed to the coding model: it goes to
 * the configured vision endpoint and comes back as text, or the read is
 * refused. Every success records the read so Edit/Write can check freshness.
 *
 * `fs`, as the record declares: every case is a real file on disk.
 *
 * The tool runs through the same validate-then-execute path the Session uses
 * (`tests/lib/directTool.ts`) against a REAL `FileState` from `@magentra/core`,
 * and the documents go through the real `extractDocumentText`. `strictServices`
 * turns any other service the tool reaches for into a named failure.
 *
 * TWO THINGS ARE BUILT HERE RATHER THAN CHECKED IN, because a binary fixture in
 * the tree is a fixture nobody can read: {@link onePixelPng} writes a genuine
 * PNG (signature, IHDR, IEND, each chunk CRC-32'd) and {@link storedZip} writes
 * a genuine ZIP container (local headers, central directory, end-of-central-
 * directory, CRC-32 per entry) for the DOCX. The PDF is hand-written text with
 * one uncompressed content stream. `engine/core/src/knowledge/docs.ts` accepts
 * STORED entries (method 0) as well as deflate, so no compression is needed.
 *
 * THE ONE STAND-IN is the vision hop — `session.visionUnavailableReason()` and
 * `session.describeImageForContext()`, which are the Session's call to a SECOND
 * MODEL, and a model is the one double this suite allows. It counts its own
 * calls; the assertions are about what READ did with it (refused without it,
 * passed its text through untouched, sent no image bytes onward), never about
 * what the stand-in returned.
 *
 * READ KEYS THE IMAGE BRANCH ON THE EXTENSION (`IMAGE_TYPES[extname(path)]`),
 * not on the file's magic bytes — the fixture is a real PNG all the same, so
 * the test does not depend on that choice being wrong or right.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { FileState, type ToolContext } from "@magentra/core";
import { readTool } from "@magentra/tools";

import { resultText, runTool, strictServices } from "../lib/directTool.ts";
import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";

const FEATURE = "tool-read";

/** Verbatim from the record. */
const INVARIANT =
  "Read returns line-numbered text, refuses a directory/missing/binary file with a distinct explanatory error, extracts documents, and never hands an image to the coding model.";

/** `engine/tools/src/read.ts` — MAX_DOC_BYTES. */
const MAX_DOC_BYTES = 20 * 1024 * 1024;

/* ---- real fixtures, built here ---------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE), as both PNG chunks and ZIP entries carry it. */
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** A genuine 1×1 RGBA PNG header: signature, IHDR, IEND. */
function onePixelPng(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); // width
  ihdr.writeUInt32BE(1, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A ZIP with STORED entries — the container a DOCX is. */
function storedZip(entries: readonly { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18); // compressed size
    local.writeUInt32LE(entry.data.length, 22); // uncompressed size
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, entry.data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); // central directory signature
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0, 10); // method: stored
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(entry.data.length, 20);
    cd.writeUInt32LE(entry.data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42); // offset of the local header
    central.push(cd, name);

    offset += 30 + name.length + entry.data.length;
  }

  const directory = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([Buffer.concat(locals), directory, eocd]);
}

const DOCX_CONTENT_TYPES =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="xml" ContentType="application/xml"/></Types>`;

const DOCX_DOCUMENT =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
  `<w:body><w:p><w:r><w:t>Hello from a docx</w:t></w:r></w:p></w:body></w:document>`;

/** A PDF with one uncompressed content stream showing a single string. */
const PDF_SOURCE = [
  "%PDF-1.4",
  "1 0 obj",
  "<< /Length 48 >>",
  "stream",
  "BT /F1 12 Tf 72 700 Td (Hello from a pdf) Tj ET",
  "endstream",
  "endobj",
  "trailer",
  "<< /Root 1 0 R >>",
  "%%EOF",
  "",
].join("\n");

/* ---- the tests -------------------------------------------------------- */

abstract class ReadTest extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  protected dir = "";

  /** The real freshness store the Session hands every tool. */
  protected readonly state = new FileState();

  protected workspace(): string {
    if (this.dir === "") this.dir = this.tempDir("magentra-read-");
    return this.dir;
  }

  protected file(name: string, contents: string | Buffer): string {
    const path = join(this.workspace(), name);
    writeFileSync(path, contents);
    return path;
  }

  /** Everything Read needs for a text or document read, and nothing else. */
  protected ctx(): ToolContext {
    return { cwd: this.workspace(), session: strictServices({ fileState: this.state }) };
  }
}

/* ---- checklist 1 ----------------------------------------------------- */

class TextComesBackNumberedAndWindowed extends ReadTest {
  readonly id = "a-file-comes-back-as-numbered-lines-with-a-window-and-a-continuation-offset";
  readonly whyItExists =
    "unnumbered output left the model unable to say where an Edit snippet came from, and a window that ended without saying which offset to resume from made a long file look like a short one the model had finished reading";

  override async run(t: TestRun): Promise<void> {
    const path = this.file("five.txt", "alpha\nbravo\ncharlie\ndelta\necho");

    const whole = await runTool(readTool, { file_path: path }, this.ctx());
    t.assert.equal(whole.isError, undefined, resultText(whole));
    t.assert.equal(
      resultText(whole),
      ["     1\talpha", "     2\tbravo", "     3\tcharlie", "     4\tdelta", "     5\techo"].join("\n"),
      "cat -n: the number, right-aligned, then a tab, then the line — starting at 1",
    );
    t.assert.equal(this.state.wasRead(path), true, "a successful read is recorded for Edit/Write to check");

    const window = await runTool(readTool, { file_path: path, offset: 2, limit: 2 }, this.ctx());
    const text = resultText(window);
    t.assert.equal(window.isError, undefined, text);
    t.assert.equal(text.startsWith("     3\tcharlie\n     4\tdelta"), true, text);
    t.assert.equal(text.includes("call Read with offset=4"), true, `the notice says where to continue: ${text}`);
    t.assert.equal(text.includes("echo"), false, "and the window really stopped where it said it did");
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class ThreeRefusalsWithThreeReasons extends ReadTest {
  readonly id = "a-directory-a-missing-path-and-a-relative-path-fail-with-different-messages";
  readonly whyItExists =
    "one shared 'could not read file' left the model retrying a directory as if it were a typo; and a relative path resolved against whatever cwd the engine held read a file from somewhere else entirely and called it the one asked for";

  override async run(t: TestRun): Promise<void> {
    const directory = await runTool(readTool, { file_path: this.workspace() }, this.ctx());
    t.assert.equal(directory.isError, true, "a directory is an error");
    t.assert.equal(
      resultText(directory).includes("is a directory"),
      true,
      `it says what it is; it said ${JSON.stringify(resultText(directory))}`,
    );

    const missingPath = join(this.workspace(), "not-here.txt");
    const missing = await runTool(readTool, { file_path: missingPath }, this.ctx());
    t.assert.equal(missing.isError, true, "a missing file is an error");
    t.assert.equal(
      resultText(missing).includes("File does not exist"),
      true,
      `it says so; it said ${JSON.stringify(resultText(missing))}`,
    );

    const relative = await runTool(readTool, { file_path: "five.txt" }, this.ctx());
    t.assert.equal(relative.isError, true, "a relative path is an error");
    t.assert.equal(
      resultText(relative).includes("must be absolute"),
      true,
      `it says why; it said ${JSON.stringify(resultText(relative))}`,
    );

    const messages = new Set([resultText(directory), resultText(missing), resultText(relative)]);
    t.assert.equal(messages.size, 3, "three different failures, three different explanations");
    t.assert.equal(this.state.wasRead(missingPath), false, "and none of them counted as a read");
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class BinaryIsRefusedAndEmptySaysSo extends ReadTest {
  readonly id = "a-nul-byte-refuses-the-read-while-an-empty-file-reads-as-empty";
  readonly whyItExists =
    "a binary returned as UTF-8 filled the transcript with mojibake the model then reasoned about, and an empty file that came back as an empty string read as a successful read of nothing rather than as a file with no content";

  override async run(t: TestRun): Promise<void> {
    const binary = this.file("blob.bin", Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]));
    const refused = await runTool(readTool, { file_path: binary }, this.ctx());
    t.assert.equal(refused.isError, true, "a NUL byte in the head refuses the read");
    t.assert.equal(
      resultText(refused).includes("looks like a binary file"),
      true,
      `it says what it saw; it said ${JSON.stringify(resultText(refused))}`,
    );
    t.assert.equal(resultText(refused).includes("\u0000"), false, "and none of the bytes came back with it");
    t.assert.equal(this.state.wasRead(binary), false, "a refused read is not a read");

    const empty = this.file("empty.txt", "");
    const result = await runTool(readTool, { file_path: empty }, this.ctx());
    t.assert.equal(result.isError, undefined, "an empty file is not an error");
    t.assert.equal(resultText(result), "(the file exists but is empty)");
    t.assert.equal(this.state.wasRead(empty), true, "and it counts as read, so Write may replace it");
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class AnImageNeverReachesTheCodingModel extends ReadTest {
  readonly id = "an-image-is-refused-without-a-vision-model-and-comes-back-as-text-with-one";
  readonly whyItExists =
    "handing a screenshot to a text-only model produced a confident description of a picture nobody had looked at; and returning the image bytes alongside the description would have put the picture in the coding model's context after all";

  override async run(t: TestRun): Promise<void> {
    const bytes = onePixelPng();
    const png = this.file("a.png", bytes);

    // The vision hop is the Session's call to a SECOND MODEL — the one double
    // this suite allows. It counts its own calls; nothing below asserts on what
    // it returned beyond Read passing that text through untouched.
    let describeCalls = 0;
    let sent: { data: string; mediaType: string; label?: string } | undefined;
    const describe = async (image: { data: string; mediaType: string; label?: string }): Promise<string> => {
      describeCalls += 1;
      sent = image;
      return "a red square";
    };

    const refused = await runTool(readTool, { file_path: png }, {
      cwd: this.workspace(),
      session: strictServices({
        fileState: this.state,
        visionUnavailableReason: () => "no vision model",
        describeImageForContext: describe,
      }),
    });
    t.assert.equal(refused.isError, true, "with no vision model, reading an image is refused");
    t.assert.equal(
      resultText(refused).includes("cannot see it"),
      true,
      `it says so plainly; it said ${JSON.stringify(resultText(refused))}`,
    );
    t.assert.equal(resultText(refused).includes("no vision model"), true, "and it passes on the reason it was given");
    t.assert.equal(describeCalls, 0, "the image was never sent anywhere");
    t.assert.equal(this.state.wasRead(png), false, "and a refused read is not a read");

    const described = await runTool(readTool, { file_path: png }, {
      cwd: this.workspace(),
      session: strictServices({
        fileState: this.state,
        visionUnavailableReason: () => undefined,
        describeImageForContext: describe,
      }),
    });
    t.assert.equal(described.isError, undefined, resultText(described));
    t.assert.equal(describeCalls, 1, "the image went to the vision hop exactly once");
    t.assert.equal(sent?.mediaType, "image/png", "as a png");
    t.assert.equal(sent?.label, "a.png");
    t.assert.equal(described.content, "a red square", "and the result is that text — a string, with no image part");
    t.assert.equal(
      resultText(described).includes(bytes.toString("base64").slice(0, 24)),
      false,
      "no image bytes reach the coding model",
    );
    t.assert.equal(this.state.wasRead(png), true, "a described image counts as read");
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

class DocumentsAreExtractedUnderACap extends ReadTest {
  readonly id = "a-docx-and-a-pdf-come-back-as-extracted-numbered-text-and-a-huge-one-is-refused";
  readonly whyItExists =
    "a DOCX read as text was a page of ZIP bytes the model tried to reason about, and an unheaded extraction let it quote a PDF as if it had read the file verbatim; without the cap a 40MB document was inflated into memory before anything could say no";

  override async run(t: TestRun): Promise<void> {
    const docx = this.file(
      "note.docx",
      storedZip([
        { name: "[Content_Types].xml", data: Buffer.from(DOCX_CONTENT_TYPES, "utf8") },
        { name: "word/document.xml", data: Buffer.from(DOCX_DOCUMENT, "utf8") },
      ]),
    );
    const fromDocx = await runTool(readTool, { file_path: docx }, this.ctx());
    const docxText = resultText(fromDocx);
    t.assert.equal(fromDocx.isError, undefined, docxText);
    t.assert.equal(docxText.startsWith("[extracted from docx,"), true, docxText);
    t.assert.equal(docxText.includes("\n     1\tHello from a docx"), true, `numbered like any other read: ${docxText}`);
    t.assert.equal(docxText.includes("PK"), false, "the ZIP container itself never reaches the model");
    t.assert.equal(this.state.wasRead(docx), true, "a successful extraction is recorded");

    const pdf = this.file("note.pdf", PDF_SOURCE);
    const fromPdf = await runTool(readTool, { file_path: pdf }, this.ctx());
    const pdfText = resultText(fromPdf);
    t.assert.equal(fromPdf.isError, undefined, pdfText);
    t.assert.equal(pdfText.startsWith("[extracted from pdf,"), true, pdfText);
    t.assert.equal(pdfText.includes("\tHello from a pdf"), true, `numbered like any other read: ${pdfText}`);
    t.assert.equal(this.state.wasRead(pdf), true);

    // A real file over the cap, not a stubbed stat.
    const huge = this.file("huge.pdf", Buffer.alloc(MAX_DOC_BYTES + 1024, 0x41));
    const refused = await runTool(readTool, { file_path: huge }, this.ctx());
    t.assert.equal(refused.isError, true, "a document over the cap is refused");
    t.assert.equal(
      resultText(refused).includes("File too large for document extraction"),
      true,
      `it says why; it said ${JSON.stringify(resultText(refused))}`,
    );
    t.assert.equal(this.state.wasRead(huge), false, "and nothing of it was read");
  }
}

registerFeatureTests(
  new TextComesBackNumberedAndWindowed(),
  new ThreeRefusalsWithThreeReasons(),
  new BinaryIsRefusedAndEmptySaysSo(),
  new AnImageNeverReachesTheCodingModel(),
  new DocumentsAreExtractedUnderACap(),
);
