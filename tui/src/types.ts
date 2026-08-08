/** Every visual atom the transcript can contain. */

export type ToolStatus = 'ok' | 'fail';

export type LineBody =
  /** Echo of the user's submitted text: `❯ fix the off-by-one` */
  | { kind: 'user'; text: string }
  /** A message sent into a running turn (steer_message). */
  | { kind: 'steer'; text: string }
  /**
   * A line of Magentra's speech (Markdown, styled per line at commit).
   *
   * `lead` is true only for the first line of a turn — the one that carries the
   * ◆ speaker marker. Every later line indents to align under it, so a turn
   * reads as one continuous voice rather than a bulleted list.
   *
   * `code` marks a line inside a ``` fence: rendered verbatim, no inline
   * parsing — decided at commit time by the emitter's fence state.
   */
  | { kind: 'prose'; text: string; lead?: boolean; code?: boolean }
  /** `┊ ◌ reasoning   4.1s` — one row marking a completed thinking block. */
  | { kind: 'reasoning'; ms: number }
  /** `┊ ▸ bash   npm test              ok` — one completed tool call. */
  | { kind: 'tool'; verb: string; target: string; metric: string; status: ToolStatus }
  /** `┊ ▸ agent  explore the parser` — a subagent header row. */
  | { kind: 'agent'; text: string; status: ToolStatus }
  /** Vertical breathing room. */
  | { kind: 'blank' }
  /** Turn footer, from turn_finished — engine figures rendered verbatim. */
  | { kind: 'done'; stopReason: string; outputTokens: number; contextTokens: number }
  /** Turn was cut short by the user. */
  | { kind: 'interrupted' }
  /** Output of a slash command, or a system notice. */
  | { kind: 'notice'; text: string }
  /** Something the engine reported as an error. */
  | { kind: 'error'; text: string }
  /** The startup banner, from session_started. */
  | { kind: 'banner'; model: string; cwd: string; sessionId: string };

/** A committed transcript line. `id` is the React key and is monotonic. */
export type Line = LineBody & { id: number };
