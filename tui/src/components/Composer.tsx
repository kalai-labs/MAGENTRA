/**
 * The input box.
 *
 * Always live. A turn running in the background never disables the composer —
 * you can type, edit, and submit while the model works; what you send mid-turn
 * steers the run (steer_message). Only a blocking prompt takes the keyboard.
 *
 * The hint line doubles as the session meter: model on the left of the right
 * cluster, then the engine's own context/output figures rendered verbatim
 * (context_update / turn_finished), tinted when the engine says contextWarn.
 * OVERDRIVE announces itself here too.
 *
 * Long input scrolls horizontally within the box rather than wrapping, keeping
 * the live region a fixed height so the transcript above never jitters.
 */

import { Box, Text } from 'ink';
import { glyph, theme } from '../theme.js';
import { tokens } from '../format.js';
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

export function Composer({ value, cursor, busy, width, model, meters, overdrive }: Props) {
  // Available text cells inside the border: 2 border + 2 padding + marker.
  const inner = Math.max(8, width - 8);

  // Keep the cursor in view by sliding a window over the text.
  const start = Math.max(0, cursor - inner + 1);
  const visible = value.slice(start, start + inner);
  const localCursor = cursor - start;

  const before = visible.slice(0, localCursor);
  const under = visible[localCursor] ?? ' ';
  const after = visible.slice(localCursor + 1);

  const borderColor = overdrive ? theme.verb : busy ? theme.borderActive : theme.border;

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor={borderColor} paddingX={1}>
        <Text color={overdrive ? theme.verb : theme.marker} bold>
          {glyph.prompt}{' '}
        </Text>
        <Text>
          <Text color={theme.prose}>{before}</Text>
          <Text color={theme.prose} inverse>
            {under}
          </Text>
          <Text color={theme.prose}>{after}</Text>
        </Text>
      </Box>

      <Box paddingX={1}>
        <Text color={theme.muted}>
          {busy ? '↵ steer · esc interrupt' : '↵ send'} · /help
        </Text>
        {overdrive ? (
          <Text color={theme.verb} bold>
            {'  '}OVERDRIVE
          </Text>
        ) : null}
        <Box flexGrow={1} />
        <Text color={theme.muted}>{model}</Text>
        <Text color={meters.warn ? theme.danger : theme.muted}>
          {' '}
          · ctx {tokens(meters.context)}
        </Text>
        <Text color={theme.muted}> · out {tokens(meters.output)}</Text>
      </Box>
    </Box>
  );
}
