// The vision path, at the two seams a model never has to be running to prove:
// what an image actually looks like on the wire, and how the vision endpoint is
// stored and redacted in settings.
//
// The wire half is the one that was silently broken: the OpenAI-compatible
// provider flattened every image to "[image omitted]", so a workspace with
// vision on sent the model nothing at all and got confident commentary on a
// picture it had never received.

import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OpenAICompatProvider } from "../../engine/providers/dist/openai-compat.js";
import {
  settingsSchema,
  setSetting,
  describeSettings,
  resolveVisionApiKey,
  VISION_API_KEY_ENV,
} from "../../engine/core/dist/config/settings.js";

/** A server that records the request body and answers with a minimal SSE stream. */
function stubEndpoint() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      seen.push(JSON.parse(body));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "a red button" } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return { server, seen };
}

async function collect(stream) {
  let text = "";
  for await (const event of stream) {
    if (event.type === "text_delta") text += event.text;
  }
  return text;
}

async function main() {
  const { server, seen } = stubEndpoint();
  const port = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
  const provider = new OpenAICompatProvider({ apiKey: "", baseUrl: `http://127.0.0.1:${port}/v1` });

  // ── an image reaches the endpoint as a data URL, with its text ───────────
  const described = await collect(
    provider.stream({
      model: "vision-model",
      system: "describe it",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe this image (bug.png)." },
            { type: "image", data: "QUJD", mediaType: "image/png" },
          ],
        },
      ],
      tools: [],
      maxTokens: 100,
      signal: new AbortController().signal,
    }),
  );
  assert.equal(described, "a red button");

  const withImage = seen[0].messages.find((m) => m.role === "user");
  assert.ok(Array.isArray(withImage.content), "a message carrying an image uses the multimodal array form");
  assert.deepEqual(
    withImage.content.map((part) => part.type),
    ["text", "image_url"],
    "the text that introduces the image travels in the SAME message",
  );
  assert.equal(withImage.content[1].image_url.url, "data:image/png;base64,QUJD");

  // ── no image: still the plain string every server understands ────────────
  await collect(
    provider.stream({
      model: "vision-model",
      system: "",
      messages: [{ role: "user", content: [{ type: "text", text: "plain turn" }] }],
      tools: [],
      maxTokens: 100,
      signal: new AbortController().signal,
    }),
  );
  const plain = seen[1].messages.find((m) => m.role === "user");
  assert.equal(plain.content, "plain turn", "a message with no image is unchanged on the wire");

  server.close();

  // ── settings: the vision endpoint parses, and its key is a secret ────────
  const parsed = settingsSchema.parse({
    vision: true,
    visionConnection: { model: "a-vision-model", baseUrl: "http://127.0.0.1:11434/v1", apiKey: "vis-secret" },
  });
  assert.equal(parsed.visionConnection.provider, "openai-compatible", "the dialect defaults like the main one");
  assert.equal(resolveVisionApiKey(parsed), "vis-secret", "the stored key is used when no env var is set");

  process.env[VISION_API_KEY_ENV] = "from-env";
  assert.equal(resolveVisionApiKey(parsed), "from-env", "an env var wins, as it does for the main key");
  delete process.env[VISION_API_KEY_ENV];

  // A vision connection with no model is not a connection — the engine would
  // have nothing to call, and `vision` would be a switch over an empty endpoint.
  assert.equal(settingsSchema.safeParse({ visionConnection: { baseUrl: "http://x/v1" } }).success, false);

  {
    // $HOME is redirected so this writes nowhere near the real global settings.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "magentra-vision-home-"));
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "magentra-vision-cwd-"));
    try {
      fs.mkdirSync(path.join(cwd, ".magentra"), { recursive: true });
      setSetting(cwd, "visionConnection.model", "a-vision-model");
      // The key is a credential wherever it sits: it goes to the GLOBAL file,
      // never the shareable project one — the same rule the main apiKey follows.
      const applied = setSetting(cwd, "visionConnection.apiKey", "vis-secret");
      assert.equal(applied.file, path.join(home, ".magentra", "settings.json"), "a nested key is still a secret");
      assert.ok(
        !fs.readFileSync(path.join(cwd, ".magentra", "settings.json"), "utf8").includes("vis-secret"),
        "the project file never holds the key",
      );

      const shown = describeSettings(cwd).find((s) => s.key === "visionConnection.apiKey");
      assert.ok(shown && !String(shown.value).includes("vis-secret"), "/settings redacts the vision key");
      assert.match(String(shown.value), /redacted/);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevUserProfile;
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }

  process.stdout.write("✓ images reach the endpoint as data URLs; the vision key is stored and redacted as a secret\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
