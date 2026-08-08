/**
 * The live activity line.
 *
 * Sits between the last committed transcript line and the composer while a turn
 * is in flight, then disappears entirely. It carries a spinner, what the run is
 * currently doing, a live elapsed counter, and the interrupt affordance.
 *
 * The activity label matters more than it looks: turns run for tens of seconds,
 * and a spinner that only ever says "working" makes a long run feel hung. The
 * label is set per-beat by the generator, so it names the actual current step.
 */

import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { spinnerFrames, theme } from '../theme.js';
import { secs } from '../format.js';

export function Activity({ elapsed, activity }: { elapsed: number; activity: string }) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % spinnerFrames.length), 80);
    return () => clearInterval(id);
  }, []);

  return (
    <Box>
      <Text color={theme.marker}>{spinnerFrames[frame]} </Text>
      <Text color={theme.muted}>{activity} </Text>
      <Text color={theme.metric}>{secs(elapsed)}</Text>
      <Box flexGrow={1} />
      <Text color={theme.muted}>esc to interrupt</Text>
    </Box>
  );
}
