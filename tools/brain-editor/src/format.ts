/**
 * Writing brain files — the inverse of tools/brain/compile.mjs's readers.
 *
 * The compiler parses brain files; nothing in the repo wrote them until the
 * editor. Each function here produces the exact bytes the compiler's FILE
 * RULES read back (brain/README.md, "File rules"). They are never trusted on
 * their own: model.ts compiles every staged file and refuses a save whose
 * compiled result is not exactly what was asked. The two small readers at the
 * bottom exist only for what the compiler's result does not carry — the body of
 * a prompt marked `enabled: false` (it compiles to "") and a params.md file's
 * own section order (the compiler sorts) — and model.ts cross-checks them
 * against the compiler on every load.
 */

import type { Json } from "./compiler.ts";

/** The frontmatter keys of a prompt file, in the order the shipped files use. */
export const PROMPT_KEY_ORDER = ["id", "group", "label", "channel", "where", "placeholders", "order", "enabled"] as const;

export interface PromptFile {
  readonly id: string;
  readonly group: string;
  readonly label: string;
  readonly channel: string;
  readonly where: string;
  readonly placeholders?: readonly string[];
  readonly order?: number;
  /** false writes `enabled: false`; true (or absent) writes no line. */
  readonly enabled?: boolean;
  readonly text: string;
}

/** Thrown for input no brain file can hold. The message is shown as is. */
export class FormatError extends Error {}

/**
 * Text as a brain file holds it. CRLF folds to LF, as the compiler folds it on
 * read, so a pasted Windows text saves as what it compiles to. A lone CR has no
 * LF meaning and is refused rather than guessed at.
 */
export function normalizeText(text: string, what: string): string {
  const folded = text.replace(/\r\n/g, "\n");
  if (folded.includes("\r")) throw new FormatError(`${what} contains a carriage return on its own; brain files use plain line ends`);
  return folded;
}

function frontmatterValue(key: string, value: string): string {
  if (value === "" || value !== value.trim()) throw new FormatError(`${key} must not be empty or start or end with a space`);
  if (/[\r\n]/.test(value)) throw new FormatError(`${key} must be one line`);
  return `${key}: ${value}`;
}

/** A prompts/<group-dir>/<id>.md file. */
export function formatPrompt(p: PromptFile): string {
  const lines = [
    frontmatterValue("id", p.id),
    frontmatterValue("group", p.group),
    frontmatterValue("label", p.label),
    frontmatterValue("channel", p.channel),
    frontmatterValue("where", p.where),
  ];
  if (p.placeholders && p.placeholders.length > 0) lines.push(frontmatterValue("placeholders", p.placeholders.join(", ")));
  if (p.order !== undefined) lines.push(frontmatterValue("order", String(p.order)));
  if (p.enabled === false) lines.push("enabled: false");
  return `---\n${lines.join("\n")}\n---\n${normalizeText(p.text, "the text")}\n`;
}

/** A tools/<Name>/description.md file. */
export function formatToolDescription(name: string, description: string): string {
  return `---\n${frontmatterValue("name", name)}\n---\n${normalizeText(description, "the description")}\n`;
}

export interface ParamSection {
  readonly path: string;
  readonly text: string;
}

/**
 * A tools/<Name>/params.md file: `## <path>` headings, each text followed by
 * one blank line except the last. Returns undefined for no sections (the file
 * is then deleted; params.md is optional).
 */
export function formatParams(sections: readonly ParamSection[]): string | undefined {
  if (sections.length === 0) return undefined;
  return sections
    .map(({ path, text }) => {
      const body = normalizeText(text, `parameter "${path}"`);
      if (body === "") throw new FormatError(`parameter "${path}" has no text`);
      if (/(^|\n)## /.test(body)) throw new FormatError(`parameter "${path}": a line starting with "## " would read as a new heading`);
      if (/\s/.test(path)) throw new FormatError(`parameter path "${path}" must not contain spaces`);
      return `## ${path}\n${body}\n`;
    })
    .join("\n");
}

/** availability.json, in the shipped layout. */
export function formatAvailability(main: readonly string[], overdrive: readonly string[]): string {
  return `${JSON.stringify({ main, overdrive }, null, 2)}\n`;
}

/* ---- behavior.json: change one value, keep every other byte ---------------- */

interface Span {
  readonly start: number;
  readonly end: number;
}

/** Where each value sits in a JSON text, keyed by dotted path ("" = the root). Objects only; arrays are leaves. */
function valueSpans(text: string): Map<string, Span> {
  const spans = new Map<string, Span>();
  let i = 0;
  const ws = (): void => {
    while (i < text.length && /\s/.test(text[i]!)) i++;
  };
  const str = (): void => {
    i++;
    while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    i++;
  };
  const value = (path: string): void => {
    ws();
    const start = i;
    const c = text[i];
    if (c === "{") {
      i++;
      ws();
      while (text[i] !== "}") {
        const keyStart = i;
        str();
        const key = JSON.parse(text.slice(keyStart, i)) as string;
        ws();
        i++; // :
        value(path === "" ? key : `${path}.${key}`);
        ws();
        if (text[i] === ",") {
          i++;
          ws();
        }
      }
      i++;
    } else if (c === "[") {
      let depth = 0;
      do {
        if (text[i] === '"') {
          str();
          continue;
        }
        if (text[i] === "[") depth++;
        if (text[i] === "]") depth--;
        i++;
      } while (depth > 0 && i < text.length);
    } else if (c === '"') {
      str();
    } else {
      while (i < text.length && /[^\s,}\]]/.test(text[i]!)) i++;
    }
    spans.set(path, { start, end: i });
  };
  value("");
  return spans;
}

/** The indentation of the line `offset` sits on. */
function indentAt(text: string, offset: number): string {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))![0];
}

/** `value` as JSON at an indent, matching the file: a list stays on one line if it was on one line and still fits. */
function render(value: Json, indent: string, wasOneLine: boolean): string {
  if (Array.isArray(value) && wasOneLine) {
    const one = JSON.stringify(value).replace(/","/g, '", "');
    if (indent.length + one.length <= 110) return one;
  }
  return JSON.stringify(value, null, 2).replace(/\n/g, `\n${indent}`);
}

/**
 * behavior.json with the value at `path` replaced by `value` and nothing else
 * moved, or undefined when the path is not in the text (the caller then writes
 * the whole object). Used for leaves and for the whole overdrive.overrides
 * object, which always exists in a valid file.
 */
export function replaceJsonValue(text: string, path: string, value: Json): string | undefined {
  let spans: Map<string, Span>;
  try {
    JSON.parse(text);
    spans = valueSpans(text);
  } catch {
    return undefined;
  }
  const span = spans.get(path);
  if (!span) return undefined;
  const old = text.slice(span.start, span.end);
  if (JSON.stringify(JSON.parse(old)) === JSON.stringify(value)) return text;
  return text.slice(0, span.start) + render(value, indentAt(text, span.start), !old.includes("\n")) + text.slice(span.end);
}

/* ---- the two readers (cross-checked against the compiler in model.ts) ----- */

/**
 * The frontmatter lines and the body of a well-formed brain .md file, or
 * undefined. The same split as compile.mjs's parseFrontmatter + bodyOf.
 */
export function splitFrontmatter(raw: string): { fields: Map<string, string>; body: string } | undefined {
  const text = (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) return undefined;
  const close = text.indexOf("\n---\n", 3);
  if (close === -1) return undefined;
  const fields = new Map<string, string>();
  for (const line of text.slice(4, close).split("\n")) {
    const m = /^([a-z]+): (.*)$/.exec(line);
    if (!m) return undefined;
    fields.set(m[1]!, m[2]!);
  }
  const rest = text.slice(close + 5);
  if (!rest.endsWith("\n")) return undefined;
  return { fields, body: rest.slice(0, -1) };
}

/** A params.md file's sections in file order, or undefined. The same split as compile.mjs's parseParams. */
export function splitParams(raw: string): ParamSection[] | undefined {
  const text = (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).replace(/\r\n/g, "\n");
  if (!text.startsWith("## ") || !text.endsWith("\n")) return undefined;
  const starts = [0];
  for (let i = text.indexOf("\n## "); i !== -1; i = text.indexOf("\n## ", i + 1)) starts.push(i + 1);
  const out: ParamSection[] = [];
  for (let k = 0; k < starts.length; k++) {
    const start = starts[k]!;
    const end = k + 1 < starts.length ? starts[k + 1]! : text.length;
    const lineEnd = text.indexOf("\n", start);
    const tail = k + 1 === starts.length ? "\n" : "\n\n";
    const raw2 = text.slice(lineEnd + 1, end);
    if (!raw2.endsWith(tail)) return undefined;
    out.push({ path: text.slice(start + 3, lineEnd), text: raw2.slice(0, -tail.length) });
  }
  return out;
}
