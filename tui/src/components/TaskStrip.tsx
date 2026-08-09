/**
 * The live task checklist, straight from the engine's task_list_updated.
 *
 * Deliberately speaks a DIFFERENT visual language from the tool rail: the rail
 * (┊ ▸ yellow-verb … metric) means "a function call that happened and is
 * final", while this is live status that mutates. So: no rail, no verb column,
 * no right-aligned metric — a checklist with its own glyph set, the idiom
 * Claude Code uses for its todo widget.
 *
 *   ✓ read the failing test        done      — muted + strikethrough
 *   ● wiring the resolver cache    current   — green mark, bright text
 *   ○ re-run the suite             pending   — muted
 *
 * Long lists collapse from both ends (oldest done first, farthest pending
 * last) so the block never eats the live region.
 */

import { Box, Text } from 'ink';
import { glyph, theme } from '../theme.js';
import { truncate } from '../markdown.js';
import type { TaskItem } from '../protocol.js';

const MAX_ROWS = 6;

export function TaskStrip({ tasks, width }: { tasks: TaskItem[]; width: number }) {
  if (tasks.length === 0) return null;
  const room = Math.max(16, width - 8);

  const done = tasks.filter((t) => t.status === 'completed');
  const currentIdx = tasks.findIndex((t) => t.status === 'in_progress');

  // Keep rows around the current item: collapse surplus done rows above and
  // surplus pending rows below into one summary line each.
  let rows: (TaskItem | { collapsed: string })[] = [...tasks];
  if (tasks.length > MAX_ROWS) {
    const keepFrom = Math.max(0, Math.min(currentIdx === -1 ? 0 : currentIdx - 1, tasks.length - (MAX_ROWS - 1)));
    const keepTo = Math.min(tasks.length, keepFrom + (MAX_ROWS - 1));
    rows = [
      ...(keepFrom > 0 ? [{ collapsed: `${glyph.taskDone} ${keepFrom} earlier` }] : []),
      ...tasks.slice(keepFrom, keepTo),
      ...(keepTo < tasks.length ? [{ collapsed: `${glyph.taskTodo} ${tasks.length - keepTo} more` }] : []),
    ];
  }

  return (
    <Box flexDirection="column" marginLeft={2}>
      <Text color={theme.muted}>
        tasks {done.length}/{tasks.length}
      </Text>
      {rows.map((row, i) => {
        if ('collapsed' in row) {
          return (
            <Text key={`c${i}`} color={theme.muted}>
              {'  '}… {row.collapsed}
            </Text>
          );
        }
        if (row.status === 'completed') {
          return (
            <Text key={row.id} color={theme.muted}>
              {'  '}
              {glyph.taskDone}{' '}
              <Text color={theme.muted} strikethrough>
                {truncate(row.subject, room)}
              </Text>
            </Text>
          );
        }
        if (row.status === 'in_progress') {
          return (
            <Text key={row.id}>
              {'  '}
              <Text color={theme.marker} bold>
                {glyph.taskNow}{' '}
              </Text>
              <Text color={theme.prose} bold>
                {truncate(row.activeForm ?? row.subject, room)}
              </Text>
            </Text>
          );
        }
        return (
          <Text key={row.id} color={theme.muted}>
            {'  '}
            {glyph.taskTodo} {truncate(row.subject, room)}
          </Text>
        );
      })}
    </Box>
  );
}
