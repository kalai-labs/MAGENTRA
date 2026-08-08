/**
 * The in-flight prose line — live token streaming, as designed.
 *
 * text_delta chunks accumulate here with a block cursor; the moment a newline
 * arrives the completed line commits to <Static> above and this row resets.
 * Only the tail that fits one row renders (no wrapping), so the live region
 * keeps a stable height and settled text never reflows.
 */

import { Box, Text } from 'ink';
import { glyph, theme } from '../theme.js';

export function LiveLine({ text, lead, width }: { text: string; lead: boolean; width: number }) {
  if (!text) return null;
  const room = Math.max(12, width - 5);
  const tail = text.length > room ? `…${text.slice(-(room - 1))}` : text;

  return (
    <Box>
      {lead ? (
        <Text color={theme.speaker} bold>
          {glyph.speaker}{' '}
        </Text>
      ) : (
        <Text>{'  '}</Text>
      )}
      <Text color={theme.prose}>{tail}</Text>
      <Text color={theme.prose} inverse>
        {' '}
      </Text>
    </Box>
  );
}
