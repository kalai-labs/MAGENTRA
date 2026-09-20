/**
 * `the-openai-compatible-provider-can-actually-carry-an-image`.
 *
 * Every image used to be flattened to `[image omitted]`, so a vision-enabled
 * workspace on an OpenAI-compatible endpoint sent the model nothing and got
 * confident commentary on a picture it never received. A user-role image now
 * serializes to the multimodal `content` array — a text part plus one
 * `image_url` part per image, as a `data:` URL — in the same user message as
 * its text. A message with no image is still a plain string, so servers that
 * never learned the array form keep working.
 *
 * `net`, and the record said `pure`. The serializer (`toWireMessages`) is a
 * private function of `openai-compat.ts`, and the provider reaches the network
 * through the global `fetch` with no injectable transport — so the only place
 * to read what it puts on the wire is the far end of a real socket. Each test
 * runs a real `OpenAICompatProvider` against a local HTTP server and reads the
 * request body the server received. Re-declared 2026-09-19.
 */

import { OpenAICompatProvider, type Msg } from "@magentra/providers";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { NetTest } from "../lib/netTest.ts";

const FEATURE = "the-openai-compatible-provider-can-actually-carry-an-image";

/** Verbatim from the record. */
const INVARIANT = "A user-role image serializes to the multimodal content array; the plain string form is still used when a message has no image.";

/** A tiny streamed completion, so the provider's own turn completes. */
const SSE = ['data: {"choices":[{"delta":{"content":"ok"}}]}', "", 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}', "", "data: [DONE]", "", ""].join("\n");

type WirePart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
interface WireMessage {
  role: string;
  content: string | WirePart[] | null;
  tool_call_id?: string;
}

abstract class WireImageTest extends NetTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  /** Send `messages` through a real provider to a real server; return the wire messages the server received. */
  protected async wireMessagesFor(messages: Msg[]): Promise<WireMessage[]> {
    const server = await this.serve((request) => {
      if (!request.url.endsWith("/chat/completions")) return { status: 404, text: "no" };
      return { status: 200, text: SSE, headers: { "content-type": "text/event-stream" } };
    });
    const provider = new OpenAICompatProvider({ apiKey: "k", baseUrl: `${server.url}/v1`, maxRetries: 0 });
    for await (const _ of provider.stream({ model: "m", system: "", messages, tools: [], maxTokens: 16, signal: new AbortController().signal })) {
      /* drain */
    }
    const chat = server.requests.find((r) => r.url.endsWith("/chat/completions"));
    if (chat === undefined) throw new Error("the provider never reached the server");
    return (JSON.parse(chat.body) as { messages: WireMessage[] }).messages;
  }
}

/* ---- checklist 1 ----------------------------------------------------- */

class TextAndImageBecomeOneArrayMessage extends WireImageTest {
  readonly id = "a-user-message-with-text-and-an-image-is-sent-as-a-text-part-plus-an-image-url-part";
  readonly whyItExists = "the image was flattened to '[image omitted]' and the model, told vision was on, described a picture it had never been sent";

  override async run(t: TestRun): Promise<void> {
    const wire = await this.wireMessagesFor([{ role: "user", content: [{ type: "text", text: "hi" }, { type: "image", mediaType: "image/png", data: "AAAA" }] }]);
    t.assert.equal(wire.length, 1, "one user message, no system message when the system prompt is empty");
    t.assert.equal(wire[0]?.role, "user");
    t.assert.deepEqual(wire[0]?.content, [
      { type: "text", text: "hi" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ]);
  }
}

/* ---- checklist 2 ----------------------------------------------------- */

class TextOnlyStaysAString extends WireImageTest {
  readonly id = "a-user-message-with-only-text-is-sent-as-a-plain-string";
  readonly whyItExists = "servers that never learned the content-array form reject it outright; sending arrays for plain text would have broken every one of them for no gain";

  override async run(t: TestRun): Promise<void> {
    const wire = await this.wireMessagesFor([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
    t.assert.equal(wire.length, 1);
    t.assert.equal(wire[0]?.content, "hi", "a string, not an array");
    t.assert.equal(typeof wire[0]?.content, "string");
  }
}

/* ---- checklist 3 ----------------------------------------------------- */

class AnImageOnlyMessageHasNoEmptyTextPart extends WireImageTest {
  readonly id = "an-image-only-user-message-carries-just-the-image-url-part";
  readonly whyItExists = "an empty text part alongside the image was rejected by strict servers as an empty content block";

  override async run(t: TestRun): Promise<void> {
    const wire = await this.wireMessagesFor([{ role: "user", content: [{ type: "image", mediaType: "image/jpeg", data: "BBBB" }] }]);
    t.assert.equal(wire.length, 1);
    t.assert.deepEqual(wire[0]?.content, [{ type: "image_url", image_url: { url: "data:image/jpeg;base64,BBBB" } }], "just the image, no empty text part");
  }
}

/* ---- checklist 4 ----------------------------------------------------- */

class TwoImagesStayInOneMessage extends WireImageTest {
  readonly id = "two-images-in-one-message-are-two-image-url-parts-in-order-in-the-same-message";
  readonly whyItExists = "one message per image let a server interleave them with the text in the wrong order, and some reject an image-only user turn outright";

  override async run(t: TestRun): Promise<void> {
    const wire = await this.wireMessagesFor([
      {
        role: "user",
        content: [
          { type: "text", text: "compare" },
          { type: "image", mediaType: "image/png", data: "FIRST" },
          { type: "image", mediaType: "image/webp", data: "SECOND" },
        ],
      },
    ]);
    t.assert.equal(wire.length, 1, "still one user message");
    const parts = wire[0]?.content;
    t.assert.ok(Array.isArray(parts));
    t.assert.deepEqual(
      (parts as WirePart[]).map((p) => (p.type === "text" ? "text" : p.image_url.url)),
      ["text", "data:image/png;base64,FIRST", "data:image/webp;base64,SECOND"],
      "text first, then the images in the order they were attached",
    );
  }
}

/* ---- checklist 5 ----------------------------------------------------- */

class AToolResultImageIsFlattened extends WireImageTest {
  readonly id = "an-image-in-a-tool-result-is-flattened-to-image-omitted-on-the-tool-role-message";
  readonly whyItExists = "a role:tool message can carry only text on this wire, so an image there must become words upstream (Session.describeToolImages) — this pins that the provider does not pretend otherwise";

  override async run(t: TestRun): Promise<void> {
    const wire = await this.wireMessagesFor([
      { role: "user", content: [{ type: "text", text: "read it" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "Read", input: { file_path: "/a.png" } }] },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "call_1",
            content: [
              { type: "text", text: "here:" },
              { type: "image", data: "CCCC", mediaType: "image/png" },
            ],
          },
        ],
      },
    ]);
    const tool = wire.find((m) => m.role === "tool");
    t.assert.notEqual(tool, undefined, "the tool result travels as a role:tool message");
    t.assert.equal(tool?.tool_call_id, "call_1");
    t.assert.equal(tool?.content, "here:\n[image omitted]", "the image part is flattened to text on this path");
    t.assert.equal(wire.some((m) => Array.isArray(m.content)), false, "no content array anywhere — no user-role image was sent");
  }
}

registerFeatureTests(
  new TextAndImageBecomeOneArrayMessage(),
  new TextOnlyStaysAString(),
  new AnImageOnlyMessageHasNoEmptyTextPart(),
  new TwoImagesStayInOneMessage(),
  new AToolResultImageIsFlattened(),
);
