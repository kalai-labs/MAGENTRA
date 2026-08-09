/**
 * First-run folder trust.
 *
 * `magentra` starts wherever the shell is, so before anything else happens the
 * session establishes that this folder is one the user meant to open. It runs
 * ahead of the profile picker on purpose — picking a profile writes an API key
 * into `<ws>/.env`, and that must never land in a folder nobody vouched for.
 *
 * It is stated plainly rather than softened, because saying yes here also
 * turns OVERDRIVE on for the session: the agent will read, write and run
 * commands in this tree without asking each time.
 */

import { Box, Text } from 'ink';
import { glyph, theme } from '../theme.js';
import { truncateStart } from '../markdown.js';

export function TrustGate({ workspace, width }: { workspace: string; width: number }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.verb} paddingX={1}>
      <Text color={theme.verb} bold>
        {glyph.speaker} do you trust this folder?
      </Text>
      <Box marginTop={1}>
        <Text color={theme.target}>{truncateStart(workspace, Math.max(20, width - 8))}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text color={theme.muted}>
          MAGENTRA reads, edits and runs commands in this folder. Terminal sessions
        </Text>
        <Text color={theme.muted}>
          start in OVERDRIVE, so it will not stop to ask before each one.
        </Text>
        <Text color={theme.muted}>Only trust folders whose contents you know.</Text>
      </Box>
      <Box marginTop={1}>
        <Text color={theme.marker}>y</Text>
        <Text color={theme.prose} bold>
          {' '}
          trust this folder
        </Text>
        <Text color={theme.muted}>{'   '}</Text>
        <Text color={theme.danger}>n</Text>
        <Text color={theme.prose}> quit</Text>
      </Box>
      <Text color={theme.muted}>y/↵ trust · n/esc quit · remembered per folder</Text>
    </Box>
  );
}
