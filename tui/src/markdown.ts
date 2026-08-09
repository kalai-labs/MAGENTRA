/**
 * Line layout: one Markdown line + a terminal width → the exact rows to print.
 *
 * This module exists because the transcript cannot delegate wrapping to Ink.
 * Committed lines live inside <Static>, which Ink lays out as an absolutely
 * positioned, content-sized box — so `flexGrow` never reaches the right edge
 * there, and a wrapped continuation does not reliably align under the text it
 * belongs to. Both were visible: the metric column collapsed onto the target
 * ("done.out 20 ↑"), and long answers wrapped back toward the left margin
 * instead of staying under the ◆ marker.
 *
 * Doing the wrap here fixes a third thing that no layout tweak could: the live
 * streaming line and the committed line are now laid out by the SAME function
 * at the SAME width, so a paragraph lands in its final shape while it streams
 * instead of reflowing the moment it commits.
 *
 * Inline marks are tokenised into spans BEFORE wrapping, so a **bold phrase**
 * that straddles a row boundary still renders bold on both rows rather than
 * leaking its asterisks.
 */

/** A run of text with one visual treatment. */
export type Span = {
  text: string;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
};

/** One printed row: a literal prefix (marker or hanging indent) plus content. */
export type Row = { prefix: string; spans: Span[] };

/**
 * Display width. Terminals give emoji and CJK two cells; combining marks and
 * variation selectors none. Good enough for column maths without pulling in a
 * dependency the packaged bundle would have to carry.
 */
export function displayWidth(text: string): number {
  let w = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0x200d || (cp >= 0x0300 && cp <= 0x036f) || cp === 0xfe0f || cp === 0xfe0e) continue;
    if (
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1f9ff) ||
      (cp >= 0x1fa70 && cp <= 0x1faff)
    ) {
      w += 2;
    } else if (cp >= 0x20) {
      w += 1;
    }
  }
  return w;
}

/** Truncate to `max` display cells, ending in … when it had to cut. */
export function truncate(text: string, max: number): string {
  if (max <= 0) return '';
  if (displayWidth(text) <= max) return text;
  let out = '';
  let w = 0;
  for (const ch of text) {
    const cw = displayWidth(ch);
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

/**
 * Keep the END of a path visible when it will not fit — the filename carries
 * far more information than the repository root does.
 */
export function truncateStart(text: string, max: number): string {
  if (max <= 0) return '';
  if (displayWidth(text) <= max) return text;
  const chars = [...text];
  let out = '';
  let w = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const cw = displayWidth(chars[i]!);
    if (w + cw > max - 1) break;
    out = chars[i]! + out;
    w += cw;
  }
  return '…' + out;
}

/** Pad to exactly `width` display cells (never truncates — callers do that). */
export function pad(text: string, width: number): string {
  const gap = width - displayWidth(text);
  return gap > 0 ? text + ' '.repeat(gap) : text;
}

const INLINE =
  /(`[^`]+`|\*\*[^*]+?\*\*|\*[^*\s][^*]*?\*|_[^_\s][^_]*?_|~~[^~]+?~~|\[[^\]]+?\]\([^)]+?\))/g;

/** Inline Markdown → spans. Unmarked text keeps `base`. */
export function inlineSpans(text: string, base: Span): Span[] {
  const out: Span[] = [];
  for (const [i, part] of text.split(INLINE).entries()) {
    if (!part) continue;
    if (i % 2 === 0) {
      out.push({ ...base, text: part });
    } else if (part.startsWith('`')) {
      out.push({ ...base, text: part.slice(1, -1), color: MARK.code });
    } else if (part.startsWith('**')) {
      out.push({ ...base, text: part.slice(2, -2), bold: true });
    } else if (part.startsWith('~~')) {
      out.push({ ...base, text: part.slice(2, -2), strikethrough: true, color: MARK.muted });
    } else if (part.startsWith('*') || part.startsWith('_')) {
      out.push({ ...base, text: part.slice(1, -1), italic: true });
    } else {
      const m = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
      if (m) {
        out.push({ ...base, text: m[1]!, color: MARK.link, underline: true });
        out.push({ ...base, text: ` (${m[2]})`, color: MARK.muted });
      } else {
        out.push({ ...base, text: part });
      }
    }
  }
  return out;
}

/**
 * Colours this module needs by name. Set once at startup from theme.ts so the
 * layout core stays free of the palette (and unit-testable without Ink).
 */
export const MARK = { code: '', link: '', muted: '' };
export function configureMarks(marks: { code: string; link: string; muted: string }): void {
  MARK.code = marks.code;
  MARK.link = marks.link;
  MARK.muted = marks.muted;
}

/**
 * Greedy word wrap over spans. Breaks at spaces; a single word wider than the
 * line is hard-split so nothing ever runs off the edge.
 */
export function wrapSpans(spans: Span[], width: number): Span[][] {
  if (width < 1) width = 1;
  const rows: Span[][] = [];
  let row: Span[] = [];
  let used = 0;

  const push = (span: Span, text: string) => {
    const last = row[row.length - 1];
    if (last && sameStyle(last, span)) last.text += text;
    else row.push({ ...span, text });
    used += displayWidth(text);
  };

  for (const span of spans) {
    // Keep separators attached to the token so a break can consume them.
    for (const token of span.text.split(/(\s+)/)) {
      if (!token) continue;
      const isSpace = /^\s+$/.test(token);
      let w = displayWidth(token);

      if (isSpace) {
        // A run of spaces at a break point disappears with the break.
        if (used + w > width) {
          rows.push(row);
          row = [];
          used = 0;
          continue;
        }
        push(span, token);
        continue;
      }

      if (used + w <= width) {
        push(span, token);
        continue;
      }

      if (used > 0) {
        rows.push(row);
        row = [];
        used = 0;
      }

      // Word longer than a whole line: hard-split across rows.
      let rest = token;
      while (displayWidth(rest) > width) {
        let take = '';
        let tw = 0;
        for (const ch of rest) {
          const cw = displayWidth(ch);
          if (tw + cw > width) break;
          take += ch;
          tw += cw;
        }
        push(span, take);
        rows.push(row);
        row = [];
        used = 0;
        rest = rest.slice(take.length);
      }
      w = displayWidth(rest);
      if (w > 0) push(span, rest);
    }
  }

  if (row.length > 0 || rows.length === 0) rows.push(row);
  return rows;
}

function sameStyle(a: Span, b: Span): boolean {
  return (
    a.color === b.color &&
    !!a.bold === !!b.bold &&
    !!a.italic === !!b.italic &&
    !!a.strikethrough === !!b.strikethrough &&
    !!a.underline === !!b.underline
  );
}

export type BlockStyle = {
  /** Base treatment for the line's text. */
  base: Span;
  /** Printed before the first row (bullet, quote bar, ◆ marker …). */
  firstPrefix: string;
  /** Printed before every later row, aligning them under the first. */
  contPrefix: string;
  /** Colour for the prefix glyph itself. */
  prefixColor?: string;
  /** A rule line renders as a repeated character rather than text. */
  rule?: boolean;
};

export type LineStyle = {
  prose: string;
  muted: string;
  marker: string;
  rail: string;
  code: string;
};

/**
 * Decide a line's block shape. `marker` is the caller's leading gutter (the ◆
 * on a turn's first line, or the two spaces that align every later line under
 * it); block prefixes nest inside it.
 */
export function blockOf(text: string, marker: string, s: LineStyle): BlockStyle {
  const heading = /^(#{1,6})\s+(.*)$/.exec(text);
  if (heading) {
    return {
      base: { text: '', color: s.prose, bold: true, underline: heading[1]!.length <= 2 },
      firstPrefix: marker,
      contPrefix: ' '.repeat(displayWidth(marker)),
    };
  }

  if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(text)) {
    return {
      base: { text: '', color: s.rail },
      firstPrefix: marker,
      contPrefix: ' '.repeat(displayWidth(marker)),
      rule: true,
    };
  }

  const quote = /^>\s?(.*)$/.exec(text);
  if (quote) {
    return {
      base: { text: '', color: s.muted, italic: true },
      firstPrefix: marker + '│ ',
      contPrefix: ' '.repeat(displayWidth(marker)) + '│ ',
      prefixColor: s.rail,
    };
  }

  const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(text);
  if (bullet) {
    const nest = bullet[1]!.length;
    const lead = marker + ' '.repeat(nest) + '• ';
    return {
      base: { text: '', color: s.prose },
      firstPrefix: lead,
      // Hanging indent: continuation lines sit under the bullet's TEXT, which
      // is what makes a wrapped list item still read as one item.
      contPrefix: ' '.repeat(displayWidth(lead)),
      prefixColor: s.marker,
    };
  }

  const numbered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(text);
  if (numbered) {
    const lead = marker + ' '.repeat(numbered[1]!.length) + numbered[2]! + '. ';
    return {
      base: { text: '', color: s.prose },
      firstPrefix: lead,
      contPrefix: ' '.repeat(displayWidth(lead)),
      prefixColor: s.marker,
    };
  }

  return {
    base: { text: '', color: s.prose },
    firstPrefix: marker,
    contPrefix: ' '.repeat(displayWidth(marker)),
  };
}

/** The line's text with its block syntax stripped (`## `, `- `, `> ` …). */
export function blockBody(text: string): string {
  const heading = /^(#{1,6})\s+(.*)$/.exec(text);
  if (heading) return heading[2]!;
  const quote = /^>\s?(.*)$/.exec(text);
  if (quote) return quote[1]!;
  const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(text);
  if (bullet) return bullet[2]!;
  const numbered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(text);
  if (numbered) return numbered[3]!;
  return text;
}

/**
 * The whole job: a Markdown line → printable rows, wrapped to `width`.
 *
 * @param marker gutter printed before the first row (e.g. `'◆ '` or `'  '`).
 * @param code   the line is inside a ``` fence: verbatim, hard-wrapped, no
 *               inline parsing — code is full of `*`, `_` and backticks that
 *               mean nothing there.
 */
export function layoutLine(
  text: string,
  width: number,
  marker: string,
  s: LineStyle,
  code = false,
): Row[] {
  if (code) {
    const lead = marker + '│ ';
    const cont = ' '.repeat(displayWidth(marker)) + '│ ';
    const room = Math.max(4, width - displayWidth(lead));
    const rows: Row[] = [];
    let rest = text;
    do {
      const take = truncateHard(rest, room);
      rows.push({
        prefix: rows.length === 0 ? lead : cont,
        spans: [{ text: take, color: s.code }],
      });
      rest = rest.slice(take.length);
    } while (rest.length > 0);
    return rows;
  }

  const block = blockOf(text, marker, s);
  const room = Math.max(4, width - displayWidth(block.firstPrefix));

  if (block.rule) {
    return [{ prefix: block.firstPrefix, spans: [{ text: '─'.repeat(room), color: s.rail }] }];
  }

  const spans = inlineSpans(blockBody(text), block.base);
  const wrapped = wrapSpans(spans, room);
  return wrapped.map((spansForRow, i) => ({
    prefix: i === 0 ? block.firstPrefix : block.contPrefix,
    spans: spansForRow,
  }));
}

function truncateHard(text: string, max: number): string {
  let out = '';
  let w = 0;
  for (const ch of text) {
    const cw = displayWidth(ch);
    if (w + cw > max) break;
    out += ch;
    w += cw;
  }
  return out || text.slice(0, 1);
}
