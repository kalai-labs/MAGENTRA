/**
 * The slash palette — appears while the composer holds a lone `/token`.
 *
 * Everything it lists comes from the ENGINE's registry (session_started /
 * addons_updated `commands`), which already includes every installed addon as
 * `/<name>` — the engine derives that roster precisely so no frontend ever
 * builds its own and drifts from what will actually dispatch. The TUI merges
 * in only the handful of commands it owns locally (/model, /exit).
 *
 * ↑/↓ move · tab completes into the composer · ↵ runs the selection ·
 * typing keeps filtering. Addons are tagged so a skill reads differently
 * from a built-in.
 */

import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import type { SlashCommandInfo } from '../protocol.js';

export function CommandPalette({
  items,
  selected,
  naming,
}: {
  items: SlashCommandInfo[];
  selected: number;
  /** Mid-sentence mode: helping the user NAME an addon, not dispatch it. */
  naming?: boolean;
}) {
  if (items.length === 0) return null;
  const sel = Math.min(selected, items.length - 1);

  const cmdWidth = Math.max(...items.map((c) => (c.cmd + ' ' + c.args).trim().length)) + 2;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1}>
      {items.map((c, i) => (
        <Box key={c.cmd}>
          <Text color={i === sel ? theme.marker : theme.muted}>{i === sel ? '▸' : ' '} </Text>
          <Text color={theme.verb} inverse={i === sel}>
            {(c.cmd + (c.args ? ` ${c.args}` : '')).padEnd(cmdWidth)}
          </Text>
          {c.addon ? <Text color={theme.speaker}> addon </Text> : <Text>{'       '}</Text>}
          <Text color={theme.muted}>{c.desc}</Text>
        </Box>
      ))}
      <Text color={theme.muted}>
        {naming ? '↑↓ move · tab/↵ insert name · esc dismiss' : '↑↓ move · tab complete · ↵ run · esc dismiss'}
      </Text>
    </Box>
  );
}
