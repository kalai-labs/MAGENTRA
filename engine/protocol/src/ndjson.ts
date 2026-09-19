/** Newline-delimited JSON framing for the stdio transport. */

export function encodeFrame(frame: unknown): string {
  return JSON.stringify(frame) + "\n";
}

/**
 * Splits an incoming byte/string stream into parsed JSON frames.
 * Malformed lines yield `{ type: "error" }` frames instead of throwing,
 * so one bad frame cannot kill the transport.
 */
export async function* decodeFrames(
  stream: AsyncIterable<Buffer | string>,
): AsyncGenerator<unknown> {
  let buffer = "";
  // A pipe hands over bytes, not characters. A multi-byte UTF-8 sequence that
  // straddles two chunks, decoded one chunk at a time, becomes U+FFFD on both
  // sides of the cut — so "ğ" in a frame arrived as two replacement characters
  // whenever the chunk boundary fell inside it. The streaming decoder holds the
  // partial sequence until the rest of it arrives. (Found by the
  // ndjson-resilience test on 2026-09-19.)
  const decoder = new TextDecoder("utf-8");
  for await (const chunk of stream) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (line.trim() === "") continue;
      yield parseLine(line);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim() !== "") yield parseLine(buffer);
}

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return { type: "error", message: `unparseable frame: ${line.slice(0, 200)}`, fatal: false };
  }
}
