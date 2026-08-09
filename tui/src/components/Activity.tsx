/**
 * The live activity line — "what is it doing right now".
 *
 * Sits between the last committed transcript line and the composer while a turn
 * is in flight, then disappears entirely. It carries a spinner, the current
 * step in plain words, a live elapsed counter, and the interrupt affordance.
 *
 * The label matters more than it looks: turns run for tens of seconds, and a
 * spinner that only ever says "working" makes a long run feel hung. So the
 * engine's current step is split into a VERB (what kind of work) and a DETAIL
 * (which file, which command) and the two are coloured like the tool rail
 * below them — the same vocabulary in both places, so the eye does not have to
 * re-learn the line.
 *
 * One timer, not two. The spinner and the elapsed counter used to run on
 * separate 80 ms and 100 ms intervals, which repainted the whole live region
 * about 22 times a second at two beat frequencies. Deriving both from a single
 * tick halves the idle repaint cost and keeps them in phase.
 */

import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { spinnerFrames, theme } from '../theme.js';
import { secs } from '../format.js';
import { truncateStart } from '../markdown.js';

export type ActivityState = { label: string; detail: string };

const TICK_MS = 90;

export function Activity({ startedAt, activity }: { startedAt: number; activity: ActivityState }) {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), TICK_MS);
    return () => clearInterval(id);
  }, []);

  const frame = spinnerFrames[tick % spinnerFrames.length];
  const elapsed = Date.now() - startedAt;

  return (
    <Box>
      <Text color={theme.speaker}>{frame} </Text>
      <Text color={theme.verb}>{activity.label}</Text>
      {activity.detail ? (
        <Text color={theme.target}> {truncateStart(activity.detail, 48)}</Text>
      ) : null}
      <Text color={theme.muted}>{'  '}</Text>
      <Text color={theme.metric}>{secs(elapsed)}</Text>
      <Box flexGrow={1} />
      <Text color={theme.muted}>esc to interrupt</Text>
    </Box>
  );
}
