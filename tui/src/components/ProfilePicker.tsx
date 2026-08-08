/**
 * Startup profile picker — shown only when the launch folder has no
 * credentials and ~/.magentra/profiles.json has saved profiles.
 *
 * Picking one writes the same two files the IDE's "apply a profile" writes
 * (key → .env, connection → .magentra/settings.json), then the engine boots
 * from them. Keys are never displayed.
 */

import { Box, Text } from 'ink';
import { glyph, theme } from '../theme.js';
import { describeProfile, type Profile } from '../profiles.js';

export function ProfilePicker({ profiles, selected }: { profiles: Profile[]; selected: number }) {
  const shown = profiles.slice(0, 9);
  const sel = Math.min(selected, shown.length - 1);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.speaker} paddingX={1}>
      <Box>
        <Text color={theme.speaker} bold>
          {glyph.speaker} connect this folder
        </Text>
      </Box>
      <Text color={theme.muted}>no credentials here yet — pick a saved MAGENTRA profile:</Text>
      <Box flexDirection="column" marginTop={1}>
        {shown.map((p, i) => (
          <Box key={p.id}>
            <Text color={i === sel ? theme.marker : theme.muted}>{i === sel ? '▸' : ' '} </Text>
            <Text color={theme.marker}>{i + 1}</Text>
            <Text color={theme.prose} inverse={i === sel}>
              {' '}
              {p.name}
            </Text>
            <Text color={theme.muted}>  {describeProfile(p)}</Text>
          </Box>
        ))}
        {profiles.length > shown.length ? (
          <Text color={theme.muted}>({profiles.length - shown.length} more — manage profiles in the IDE)</Text>
        ) : null}
      </Box>
      <Text color={theme.muted}>↑↓ move · ↵ select · 1-9 jump · esc continue without</Text>
    </Box>
  );
}
