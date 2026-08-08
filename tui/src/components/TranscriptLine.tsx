/**
 * Renders one committed transcript line.
 *
 * Every line here is final — this component is mounted inside <Static>, so Ink
 * prints it once and never touches it again. That's what puts it in the
 * terminal's real scrollback and makes ordinary wheel/PageUp scrolling work.
 *
 * The grammar:
 *   ❯ user input          — green marker, then dimmed echo. Full-bleed.
 *   ◆ magentra speech     — magenta marker on the first line of a turn only.
 *   ┊ ▸ verb  target  m   — indented rail. Machine work only.
 */

import { Box, Text } from 'ink';
import { glyph, layout, theme } from '../theme.js';
import { col, secs, tokens } from '../format.js';
import { MarkdownLine } from './Markdown.js';
import type { Line } from '../types.js';

/** The `  ┊ ` gutter that prefixes every machine-activity row. */
function Rail() {
  return (
    <Text color={theme.rail}>
      {layout.railIndent}
      {glyph.rail}{' '}
    </Text>
  );
}

/** Pushes the following child to the right edge. */
function Spacer() {
  return <Box flexGrow={1} />;
}

export function TranscriptLine({ line }: { line: Line }) {
  switch (line.kind) {
    case 'banner':
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Box>
            <Text color={theme.speaker} bold>
              {glyph.speaker}{' '}
            </Text>
            <Text color={theme.banner} bold>
              magentra
            </Text>
            <Text color={theme.muted}> · {line.model}</Text>
          </Box>
          <Text color={theme.muted}>
            {'  '}
            {line.cwd} · {line.sessionId}
          </Text>
          <Text color={theme.muted}>{'  '}type a request · /help for commands</Text>
        </Box>
      );

    case 'user':
      return (
        <Box>
          <Text color={theme.marker} bold>
            {glyph.prompt}{' '}
          </Text>
          <Text color={theme.userText}>{line.text}</Text>
        </Box>
      );

    // A message sent into a running turn. Same marker as ordinary input, but
    // tagged on the right so it is clear it joined the work mid-flight.
    case 'steer':
      return (
        <Box>
          <Text color={theme.marker} bold>
            {glyph.prompt}{' '}
          </Text>
          <Text color={theme.userText}>{line.text}</Text>
          <Spacer />
          <Text color={theme.muted}> steering</Text>
        </Box>
      );

    // Magentra speaking — Markdown, styled per line. Only the first line of a
    // turn is marked; the rest indent to align under it, so a turn reads as
    // one utterance.
    case 'prose':
      return (
        <Box>
          {line.lead === false ? (
            <Text>{'  '}</Text>
          ) : (
            <Text color={theme.speaker} bold>
              {glyph.speaker}{' '}
            </Text>
          )}
          <MarkdownLine text={line.text} code={line.code} />
        </Box>
      );

    case 'reasoning':
      return (
        <Box>
          <Rail />
          <Text color={theme.muted}>{glyph.reason} </Text>
          <Text color={theme.muted}>reasoning</Text>
          <Spacer />
          {line.ms > 0 ? <Text color={theme.muted}>{secs(line.ms)}</Text> : null}
        </Box>
      );

    case 'tool': {
      const failed = line.status === 'fail';
      return (
        <Box>
          <Rail />
          <Text color={failed ? theme.danger : theme.marker}>
            {failed ? glyph.fail : glyph.tool}{' '}
          </Text>
          <Text color={failed ? theme.danger : theme.verb}>{col(line.verb, layout.verbWidth)}</Text>
          <Text color={theme.target}>{line.target}</Text>
          <Spacer />
          <Text color={failed ? theme.danger : theme.metric}> {line.metric}</Text>
        </Box>
      );
    }

    // A subagent header: the rail rows that follow with a `·`-prefixed verb
    // belong to this agent's nested session.
    case 'agent': {
      const failed = line.status === 'fail';
      return (
        <Box>
          <Rail />
          <Text color={failed ? theme.danger : theme.speaker}>
            {failed ? glyph.fail : glyph.tool}{' '}
          </Text>
          <Text color={failed ? theme.danger : theme.speaker}>{col('agent', layout.verbWidth)}</Text>
          <Text color={theme.target}>{line.text}</Text>
        </Box>
      );
    }

    case 'done':
      return (
        <Box>
          <Text color={theme.muted}>
            done{line.stopReason !== 'end_turn' ? ` (${line.stopReason})` : ''}.
          </Text>
          <Spacer />
          <Text color={theme.muted}>
            out {tokens(line.outputTokens)} {glyph.up} · ctx {tokens(line.contextTokens)}
          </Text>
        </Box>
      );

    case 'interrupted':
      return <Text color={theme.danger}>interrupted.</Text>;

    case 'notice':
      return <Text color={theme.muted}>{line.text}</Text>;

    case 'error':
      return (
        <Box>
          <Text color={theme.danger}>{glyph.fail} </Text>
          <Text color={theme.danger}>{line.text}</Text>
        </Box>
      );

    case 'blank':
      return <Text> </Text>;
  }
}
