/**
 * The --resume picker: this workspace's saved sessions, straight from the
 * engine's session_list. Picking one sends resume_session; the engine replays
 * the transcript (session_restored) and the conversation continues where it
 * left off — its stance, model and task list restored engine-side.
 */

import { Box, Text } from 'ink';
import { glyph, theme } from '../theme.js';
import type { SessionSummary } from '../protocol.js';

function when(iso: string): string {
  return iso.slice(0, 16).replace('T', ' ');
}

export function SessionPicker({ sessions, selected }: { sessions: SessionSummary[]; selected: number }) {
  const shown = sessions.slice(0, 9);
  const sel = Math.min(selected, shown.length - 1);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.speaker} paddingX={1}>
      <Text color={theme.speaker} bold>
        {glyph.speaker} resume a session
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {shown.map((s, i) => (
          <Box key={s.id}>
            <Text color={i === sel ? theme.marker : theme.muted}>{i === sel ? '▸' : ' '} </Text>
            <Text color={theme.marker}>{i + 1}</Text>
            <Text color={theme.prose} inverse={i === sel}>
              {' '}
              {s.label ?? s.firstUserMessage ?? '(empty session)'}
            </Text>
            <Text color={theme.muted}>
              {'  '}
              {when(s.updatedAt)}
              {s.model ? ` · ${s.model}` : ''}
            </Text>
          </Box>
        ))}
        {sessions.length > shown.length ? (
          <Text color={theme.muted}>({sessions.length - shown.length} more — /sessions lists all, /resume &lt;id&gt;)</Text>
        ) : null}
      </Box>
      <Text color={theme.muted}>↑↓ move · ↵ resume · 1-9 jump · esc start fresh</Text>
    </Box>
  );
}
