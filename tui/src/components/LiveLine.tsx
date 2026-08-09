/**
 * The in-flight prose line — live token streaming.
 *
 * text_delta chunks accumulate here; the moment a newline arrives the completed
 * line commits to <Static> above and this row resets.
 *
 * It lays the text out with the SAME function and the SAME width that
 * TranscriptLine uses for the committed line. That is the whole point: the
 * paragraph is already in its final shape while it streams, so committing it
 * changes nothing visually. The previous version painted a single unwrapped
 * row and let the terminal reflow the whole answer at the end of the turn,
 * which read as the text jumping the moment the model stopped talking.
 *
 * Only the last `maxRows` wrapped rows render, so a pathologically long
 * paragraph cannot push the composer off the screen.
 */

import { Box, Text } from 'ink';
import { SPEAKER_INDENT, SPEAKER_MARKER, theme } from '../theme.js';
import { layoutLine } from '../markdown.js';

const STYLE = {
  prose: theme.prose,
  muted: theme.muted,
  marker: theme.marker,
  rail: theme.rail,
  code: theme.code,
};

export function LiveLine({
  text,
  lead,
  width,
  maxRows,
}: {
  text: string;
  lead: boolean;
  width: number;
  maxRows: number;
}) {
  if (!text) return null;

  const all = layoutLine(text, width, lead ? SPEAKER_MARKER : SPEAKER_INDENT, STYLE);
  const clipped = all.length > maxRows;
  const rows = clipped ? all.slice(all.length - maxRows) : all;

  return (
    <Box flexDirection="column">
      {rows.map((row, i) => {
        const isFirstOfAll = !clipped && i === 0;
        return (
          <Text key={i}>
            <Text color={isFirstOfAll && lead ? theme.speaker : theme.rail} bold={isFirstOfAll && lead}>
              {row.prefix}
            </Text>
            {row.spans.map((span, j) => (
              <Text
                key={j}
                color={span.color}
                bold={span.bold}
                italic={span.italic}
                strikethrough={span.strikethrough}
                underline={span.underline}
              >
                {span.text}
              </Text>
            ))}
            {i === rows.length - 1 ? (
              <Text color={theme.prose} inverse>
                {' '}
              </Text>
            ) : null}
          </Text>
        );
      })}
    </Box>
  );
}
