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
  /**
   * A ``` delimiter. It is not prose and must not be printed as such: it
   * renders as the top or bottom edge of the block, carrying the info string
   * (`ts`, `bash`) as a label so the reader can see what the listing is.
   */
  | { kind: 'fence'; info: string; open: boolean }
  /** `┊ ◌ thought   4.1s` — one row marking a completed thinking block. */
  | { kind: 'reasoning'; ms: number }
  /** `┊ ▸ bash   npm test              ok` — one completed tool call. */
  | { kind: 'tool'; verb: string; target: string; metric: string; status: ToolStatus }
  /** `┊ ▸ agent  explore the parser` — a subagent header row. */
  | { kind: 'agent'; text: string; status: ToolStatus }
  /**
   * A line of a shell command's actual output, committed under its tool row.
   *
   * Only tools that stream (Bash, Workflow) produce these, so an ordinary Read
   * never adds any. Without them a terminal session showed a command's exit
   * code and nothing else — you could not see what the command said.
   */
  | { kind: 'output'; text: string; dim?: boolean }
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
