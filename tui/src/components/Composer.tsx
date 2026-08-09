/**
 * The input box.
 *
 * Always live. A turn running in the background never disables the composer —
 * you can type, edit, and submit while the model works; what you send mid-turn
 * steers the run (steer_message). Only a blocking prompt takes the keyboard.
 *
 * It WRAPS rather than scrolling sideways. The old single-row window slid the
 * text under a fixed viewport, which hid everything you had already typed and
 * made a pasted block impossible to check before sending. Wrapping also means
 * a multi-line paste can be shown as the multiple lines it actually is.
 *
 * The hint line doubles as the session meter: model on the left of the right
 * cluster, then the engine's own context/output figures rendered verbatim
 * (context_update / turn_finished), tinted when the engine says contextWarn.
 * OVERDRIVE announces itself here too.
 */

import { Box, Text } from 'ink';
import { glyph, theme } from '../theme.js';
import { tokens } from '../format.js';
import { displayWidth } from '../markdown.js';
import type { Meters } from '../engine/useEngine.js';

type Props = {
  value: string;
  cursor: number;
  busy: boolean;
  width: number;
  model: string;
  meters: Meters;
  overdrive: boolean;
};

/**
 * Visual rows for the composer, each tagged with its offset into `value`.
 *
 * Chunking walks code POINTS, not code units, so a surrogate pair (an emoji)
 * is never split down the middle into two replacement glyphs.
 */
function toRows(value: string, inner: number): Array<{ text: string; start: number }> {
  const rows: Array<{ text: string; start: number }> = [];
  let offset = 0;
  for (const logical of value.split('\n')) {
    if (logical.length === 0) {
      rows.push({ text: '', start: offset });
    } else {
      let chunk = '';
      let chunkStart = offset;
      let cells = 0;
      for (const ch of logical) {
        const w = displayWidth(ch);
        if (cells + w > inner && chunk.length > 0) {
          rows.push({ text: chunk, start: chunkStart });
          chunkStart += chunk.length;
          chunk = '';
          cells = 0;
        }
        chunk += ch;
        cells += w;
      }
      rows.push({ text: chunk, start: chunkStart });
    }
    offset += logical.length + 1; // + the newline itself
  }
  return rows;
}

/**
 * Which row owns the cursor. Exactly one must, and the boundary case is the
 * trap: with the caret at the very end of a full row, both that row (offset ==
 * row length) and the next (offset 0) answer "me", and the block cursor gets
 * painted twice. The LAST row whose start is still <= cursor wins.
 */
function cursorRowIndex(rows: Array<{ text: string; start: number }>, cursor: number): number {
  let found = 0;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]!.start <= cursor) found = i;
    else break;
  }
  return found;
}

const MAX_ROWS = 8;

export function Composer({ value, cursor, busy, width, model, meters, overdrive }: Props) {
  // Cells inside the border: 2 border + 2 padding + the 2-cell marker.
  const inner = Math.max(8, width - 6);

  const all = toRows(value, inner);
  // Keep the row the cursor is on visible when the text outgrows the box.
  const cursorRow = cursorRowIndex(all, cursor);
  const from =
    all.length > MAX_ROWS ? Math.max(0, Math.min(cursorRow - MAX_ROWS + 1, all.length - MAX_ROWS)) : 0;
  const rows = all.slice(from, from + MAX_ROWS);

  const borderColor = overdrive ? theme.verb : busy ? theme.borderActive : theme.border;

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" borderStyle="round" borderColor={borderColor} paddingX={1}>
        {rows.map((row, i) => {
          const onThisRow = from + i === cursorRow;
          const local = Math.max(0, Math.min(cursor - row.start, row.text.length));
          const before = onThisRow ? row.text.slice(0, local) : row.text;
          const under = onThisRow ? (row.text[local] ?? ' ') : '';
          const after = onThisRow ? row.text.slice(local + 1) : '';
          const isFirst = i === 0 && from === 0;
          return (
            <Text key={row.start}>
              <Text color={overdrive ? theme.verb : theme.marker} bold>
                {isFirst ? `${glyph.prompt} ` : '  '}
              </Text>
              <Text color={theme.prose}>{before}</Text>
              {onThisRow ? (
                <Text color={theme.prose} inverse>
                  {under}
                </Text>
              ) : null}
              <Text color={theme.prose}>{after}</Text>
            </Text>
          );
        })}
      </Box>

      <Box paddingX={1}>
        <Text color={theme.muted}>{busy ? '↵ steer · esc interrupt' : '↵ send'} · /help</Text>
        {overdrive ? (
          <Text color={theme.verb} bold>
            {'  '}OVERDRIVE
          </Text>
        ) : null}
        <Box flexGrow={1} />
        <Text color={theme.target}>{model}</Text>
        <Text color={meters.warn ? theme.danger : theme.muted}>
          {' '}
          · ctx {tokens(meters.context)}
        </Text>
        <Text color={theme.muted}> · out {tokens(meters.output)}</Text>
      </Box>
    </Box>
  );
}
