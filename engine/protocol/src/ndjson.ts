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
  for await (const chunk of stream) {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (line.trim() === "") continue;
      yield parseLine(line);
    }
  }
  if (buffer.trim() !== "") yield parseLine(buffer);
}

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return { type: "error", message: `unparseable frame: ${line.slice(0, 200)}`, fatal: false };
  }
}
