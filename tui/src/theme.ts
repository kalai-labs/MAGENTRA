/**
 * magentra-tui theme — Windows Terminal "Campbell" palette.
 *
 * Dark background, white prose. Colour is used sparingly and semantically,
 * borrowed from how PSReadLine tokenises a PowerShell command line:
 *
 *   command   -> bright yellow    (our tool verbs)
 *   string    -> bright cyan      (our file paths / targets)
 *   number    -> white            (our metrics)
 *   variable  -> bright green     (our prompt marker, success)
 *   comment   -> bright black     (our rail, hints, reasoning)
 *   error     -> bright red       (our failures)
 *
 * We never paint the background: the terminal's own dark background shows
 * through, so magentra-tui sits inside the user's colourscheme instead of
 * fighting it.
 *
 * Two speakers, two colours. Green marks what you said; magenta marks what
 * Magentra said. Everything else is machine output and stays neutral, so a
 * glance down the left edge tells you who is talking without reading a word.
 */

export const campbell = {
  black: '#0C0C0C',
  red: '#C50F1F',
  green: '#13A10E',
  yellow: '#C19C00',
  blue: '#0037DA',
  magenta: '#881798',
  cyan: '#3A96DD',
  white: '#CCCCCC',
  brightBlack: '#767676',
  brightRed: '#E74856',
  brightGreen: '#16C60C',
  brightYellow: '#F9F1A5',
  brightBlue: '#3B78FF',
  brightMagenta: '#B4009E',
  brightCyan: '#61D6D6',
  brightWhite: '#F2F2F2',
} as const;

/** Semantic tokens. Components only ever reference these, never raw hex. */
export const theme = {
  /** Assistant prose — the main reading surface. */
  prose: campbell.brightWhite,
  /** Echo of what the user typed. Recedes; it's already known. */
  userText: campbell.white,
  /** The ❯ prompt marker and success glyphs. You. */
  marker: campbell.brightGreen,
  /** The ◆ marker on everything Magentra says. */
  speaker: campbell.brightMagenta,
  /** The ┊ gutter rail around machine activity. */
  rail: campbell.brightBlack,
  /** Tool verbs: read, edit, run, grep… */
  verb: campbell.brightYellow,
  /** Tool targets: file paths, patterns, commands. */
  target: campbell.brightCyan,
  /** Right-aligned metrics: 88L, +1-1, exit 1. */
  metric: campbell.white,
  /** Reasoning rows, hints, footers, anything ambient. */
  muted: campbell.brightBlack,
  /** Failures. The only red in the app. */
  danger: campbell.brightRed,
  /** Startup banner accent. */
  banner: campbell.brightMagenta,
  /** Composer border, idle. */
  border: campbell.brightBlack,
  /** Composer border while a turn is in flight. */
  borderActive: campbell.brightBlue,
} as const;

/** Glyph vocabulary. Kept in one place so the whole app speaks one language. */
export const glyph = {
  prompt: '❯', // ❯  user input
  speaker: '◆', // ◆  Magentra speaking
  rail: '┊', // ┊  gutter
  tool: '▸', // ▸  tool call
  fail: '✕', // ✕  failed tool call
  reason: '◌', // ◌  reasoning
  branch: '└', // └  sub-detail
  taskDone: '✓', // ✓  completed task (checklist, not rail)
  taskNow: '●', // ●  in-progress task
  taskTodo: '○', // ○  pending task
  up: '↑', // ↑  tokens
  cursor: '█', // █  composer cursor
} as const;

/** Braille spinner — reads as motion without shouting. */
export const spinnerFrames = [
  '⠋',
  '⠙',
  '⠹',
  '⠸',
  '⠼',
  '⠴',
  '⠦',
  '⠧',
  '⠇',
  '⠏',
] as const;

/** Column widths for the tool rail, so every row aligns. */
export const layout = {
  railIndent: '  ',
  verbWidth: 6,
} as const;
