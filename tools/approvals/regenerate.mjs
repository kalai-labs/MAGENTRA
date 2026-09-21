/**
 * Regenerate the approved artifacts.
 *
 *     npm run approve
 *
 * This is the ONLY thing in the repository that writes an approved artifact,
 * and a person runs it. No test does, and no environment variable makes one:
 * an approval a test can grant itself is not an approval.
 *
 * Running this does not approve anything by itself. It moves the bytes; the
 * approval is the diff you then read in `git diff` and carry in a commit. If
 * the diff is not one you meant to make, that is the guard working — put the
 * product back rather than committing the new artifact.
 *
 * The printers are imported from `tests/lib/approved.ts` rather than repeated
 * here, so this command and the tests can never disagree about what the
 * artifact should contain.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const { approvedPath, overriddenPromptIds, renderSystemPrompt, renderToolContract } = await import(
  new URL("../../tests/lib/approved.ts", import.meta.url).href
);

const ARTIFACTS = [
  {
    featureId: "system-prompt-is-pinned",
    name: "system-prompt.txt",
    render: renderSystemPrompt,
    guardOverrides: true,
  },
  {
    featureId: "tool-wire-contract-is-pinned",
    name: "tools.json",
    render: renderToolContract,
    guardOverrides: false,
  },
];

let changed = 0;

for (const artifact of ARTIFACTS) {
  if (artifact.guardOverrides) {
    const overridden = overriddenPromptIds();
    if (overridden.length > 0) {
      console.error(
        `refusing to regenerate ${artifact.name}: ${overridden.length} prompt override(s) are in effect ` +
          `(${overridden.join(", ")}).\n` +
          "An override is a local edit. Regenerating now would commit it as the product's default.\n" +
          "Clear them, or point MAGENTRA_PROMPTS_DIR at an empty directory, and run again.",
      );
      process.exitCode = 1;
      continue;
    }
  }

  const path = approvedPath(artifact.featureId, artifact.name);
  const next = artifact.render();

  let previous = null;
  try {
    previous = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  } catch {
    previous = null;
  }

  if (previous === next) {
    console.log(`unchanged  ${artifact.featureId}/${artifact.name}`);
    continue;
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, next, "utf8");
  changed++;
  console.log(`${previous === null ? "created   " : "REWROTE   "} ${artifact.featureId}/${artifact.name}`);
}

if (changed > 0) {
  console.log(
    `\n${changed} artifact(s) moved. Read the diff before committing it — that diff is the approval.`,
  );
}
