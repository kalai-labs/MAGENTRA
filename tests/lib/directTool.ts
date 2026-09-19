/**
 * Running one tool the way the Session runs it — for the kinds that prove a
 * tool by its own result rather than by a whole turn.
 *
 * WHAT THIS IS. `Session.executeToolCalls` validates a call's input through
 * the tool's own zod schema and then calls `execute(input, ctx, signal)`. This
 * file does exactly those two steps and nothing else, so a test can hand a
 * real tool a real store and read what it returned.
 *
 * WHAT `ctx.session` IS HERE. A tool reaches its collaborators through
 * `SessionServices`: the task store, the file-state tracker, the `askUser`
 * hop to the frontend, and so on. A test supplies the REAL ones the tool under
 * test uses — a `TaskStore` on a temp state directory, a `FileState` — and
 * plays the frontend for the one hop that IS the frontend (`askUser`). Nothing
 * the tool does is stubbed.
 *
 * Every service the test did not supply is a LOUD absence. `strictServices`
 * hands back a proxy that throws on any other property, naming it — so a tool
 * that quietly starts depending on `session.remind` fails the test that runs
 * it, with the name of the service, instead of reading `undefined` and going
 * on. A partial cast to `SessionServices` would hide exactly that.
 */

import type { AnyToolDefinition, SessionServices, ToolContext, ToolResult } from "@magentra/core";

/**
 * The services a tool may reach, from the ones a test really built.
 *
 * A property the test did not provide throws when read, so an unexpected
 * dependency is a named failure and never a silent `undefined`.
 */
export function strictServices(provided: Partial<SessionServices>): SessionServices {
  return new Proxy(provided as SessionServices, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && !(prop in target)) {
        throw new Error(
          `the tool reached for session.${prop}, which this test did not provide — ` +
            `either the tool now depends on it (build the real one here) or the test is running the wrong tool`,
        );
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

/** Text of a result, whatever shape the tool chose. */
export function resultText(result: ToolResult): string {
  if (typeof result.content === "string") return result.content;
  return result.content.map((part) => (part.type === "text" ? (part.text ?? "") : "[image]")).join("\n");
}

/**
 * Validate `rawInput` with the tool's schema, exactly as the Session does, then run it.
 *
 * @throws when the input does not satisfy the schema — a test that wants to
 * assert on a rejection calls `tool.inputSchema.safeParse` itself.
 */
export async function runTool(
  tool: AnyToolDefinition,
  rawInput: unknown,
  ctx: ToolContext,
  signal: AbortSignal = new AbortController().signal,
): Promise<ToolResult> {
  const parsed = tool.inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`${tool.name} refused the input this test built: ${issues}`);
  }
  return tool.execute(parsed.data as never, ctx, signal);
}
