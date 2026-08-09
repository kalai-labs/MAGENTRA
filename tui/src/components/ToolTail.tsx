/**
 * What the running command is saying, and what is running outside the turn.
 *
 * Both belong in the live region rather than the transcript because both are
 * still changing. The tail is the last few lines of the in-flight tool's
 * stdout/stderr — the terminal equivalent of watching a build scroll past —
 * and it disappears when the call finishes, at which point a bounded copy is
 * committed under the tool's own row.
 *
 * `jobs` covers work that has no turn at all: a manual /compact, a backgrounded
 * Bash command, addon generation. `turn_started` never fires for those, so
 * without this the session simply looked frozen for as long as they ran.
 */

import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import { truncate } from '../markdown.js';
import type { BackgroundJob } from '../engine/useEngine.js';

export function ToolTail({
  tail,
  jobs,
  width,
}: {
  tail: string[];
  jobs: BackgroundJob[];
  width: number;
}) {
  if (tail.length === 0 && jobs.length === 0) return null;
  const room = Math.max(16, width - 6);

  return (
    <Box flexDirection="column">
      {jobs.map((job) => (
        <Text key={job.taskId} color={theme.muted}>
          {'  ⟳ '}
          {truncate(job.description, room)}
        </Text>
      ))}
      {tail.map((line, i) => (
        <Text key={i} color={theme.rail}>
          {'  │ '}
          <Text color={theme.muted}>{truncate(line, room)}</Text>
        </Text>
      ))}
    </Box>
  );
}
