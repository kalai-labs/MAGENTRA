/**
 * Renders one committed transcript line.
 *
 * Every line here is final — this component is mounted inside <Static>, so Ink
 * prints it once and never touches it again. That's what puts it in the
 * terminal's real scrollback and makes ordinary wheel/PageUp scrolling work.
 *
 * Two consequences of living inside <Static>, both learned the hard way:
 *
 *   · `flexGrow` does NOT reach the right edge. Ink lays a static box out as
 *     an absolutely positioned, content-sized node, so a <Box flexGrow={1}/>
 *     spacer collapses to nothing — which is why the turn footer used to print
 *     as "done.out 20 ↑ · ctx 1.2k". Right alignment is therefore computed
 *     here, in cells, from the terminal width.
 *   · Wrapping is ours too (see markdown.ts), so a long answer keeps its
 *     hanging indent under the ◆ marker instead of falling back to column 0.
 *
 * The grammar:
 *   ▌ what you asked   — green bar, bright bold text. The anchor you scan for.
 *   ◆ magentra speech  — magenta marker on the first line of a turn only.
 *   ┊ ▸ verb  target …metric   — indented rail. Machine work only.
 */

import { Box, Text } from 'ink';
import { glyph, layout, SPEAKER_INDENT, SPEAKER_MARKER, theme } from '../theme.js';
import { secs, tokens } from '../format.js';
import { displayWidth, layoutLine, pad, truncate, truncateStart, type Row } from '../markdown.js';
import type { Line } from '../types.js';

const STYLE = {
  prose: theme.prose,
  muted: theme.muted,
  marker: theme.marker,
  rail: theme.rail,
  code: theme.code,
};

/** Rows from markdown.ts → Ink. One <Text> per row keeps <Static> honest. */
function Rows({ rows, prefixColor }: { rows: Row[]; prefixColor?: string }) {
  return (
    <>
      {rows.map((row, i) => (
        <Text key={i}>
          <Text color={prefixColor ?? theme.rail}>{row.prefix}</Text>
          {row.spans.map((span, j) => (
            <Text
              key={j}
              color={span.color}
              bold={span.bold}
              italic={span.italic}
              strikethrough={span.strikethrough}
              underline={span.underline}
            >
              {span.text}
            </Text>
          ))}
        </Text>
      ))}
    </>
  );
}

/**
 * One rail row, right-aligned by hand: `┊ ▸ verb······target········metric`.
 * The target is truncated from the LEFT so a long path keeps its filename.
 */
function RailRow({
  width,
  glyphChar,
  glyphColor,
  verb,
  verbColor,
  target,
  metric,
  metricColor,
}: {
  width: number;
  glyphChar: string;
  glyphColor: string;
  verb: string;
  verbColor: string;
  target: string;
  metric?: string;
  metricColor?: string;
}) {
  const lead = `${layout.railIndent}${glyph.rail} `;
  const shownMetric = metric ? truncate(metric, layout.metricWidth) : '';
  // The verb cell is measured, not assumed: a verb at or past the column width
  // still needs one separating space, and `pad` does not add one. Getting this
  // wrong shifts the whole right edge by a cell on those rows only, which is
  // exactly the kind of misalignment nobody can find later.
  const verbCell =
    displayWidth(verb) >= layout.verbWidth ? `${verb} ` : pad(verb, layout.verbWidth);
  const fixed = displayWidth(lead) + 2 + displayWidth(verbCell) + displayWidth(shownMetric);
  const targetRoom = Math.max(6, width - fixed - 1);
  const shownTarget = truncateStart(target, targetRoom);
  const gap = Math.max(1, width - fixed - displayWidth(shownTarget));

  return (
    <Text>
      <Text color={theme.rail}>{lead}</Text>
      <Text color={glyphColor}>{glyphChar} </Text>
      <Text color={verbColor}>{verbCell}</Text>
      <Text color={theme.target}>{shownTarget}</Text>
      <Text>{' '.repeat(gap)}</Text>
      {shownMetric ? <Text color={metricColor ?? theme.metric}>{shownMetric}</Text> : null}
    </Text>
  );
}

export function TranscriptLine({ line, width }: { line: Line; width: number }) {
  switch (line.kind) {
    // The session header. Deliberately the only place the product name appears.
    case 'banner':
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text>
            <Text color={theme.speaker} bold>
              {glyph.speaker}{' '}
            </Text>
            <Text color={theme.banner} bold>
              magentra
            </Text>
            <Text color={theme.muted}>{'  '}</Text>
            <Text color={theme.target}>{line.model}</Text>
          </Text>
          <Text color={theme.muted}>
            {SPEAKER_INDENT}
            {truncateStart(line.cwd, Math.max(20, width - 4))}
          </Text>
          <Text color={theme.muted}>
            {SPEAKER_INDENT}
            {line.sessionId} · /help for commands
          </Text>
        </Box>
      );

    // What you asked. A green bar plus bright bold text — the single strongest
    // mark in the transcript, because it is the landmark you scroll to find.
    case 'user': {
      const rows = line.text
        .split('\n')
        .flatMap((part) =>
          layoutLine(part, width, `${glyph.bar} `, { ...STYLE, prose: theme.userText }),
        )
        .map((row, i) => (i === 0 ? row : { ...row, prefix: `${glyph.bar} ` }));
      return (
        <Box flexDirection="column">
          {rows.map((row, i) => (
            <Text key={i}>
              <Text color={theme.marker} bold>
                {row.prefix}
              </Text>
              {row.spans.map((span, j) => (
                <Text key={j} color={theme.userText} bold>
                  {span.text}
                </Text>
              ))}
            </Text>
          ))}
        </Box>
      );
    }

    // A message sent into a running turn: same bar, tagged so it is clear it
    // joined the work mid-flight.
    case 'steer': {
      const tag = ' steering';
      const room = Math.max(10, width - displayWidth(tag) - 3);
      return (
        <Text>
          <Text color={theme.marker} bold>
            {glyph.bar}{' '}
          </Text>
          <Text color={theme.userText} bold>
            {pad(truncate(line.text, room), room)}
          </Text>
          <Text color={theme.muted}>{tag}</Text>
        </Text>
      );
    }

    // Magentra speaking. Only the first line of a turn carries the marker; the
    // rest align under it, so a turn reads as one utterance rather than a list.
    case 'prose':
      return (
        <Box flexDirection="column">
          <Rows
            rows={layoutLine(
              line.text,
              width,
              line.lead === false ? SPEAKER_INDENT : SPEAKER_MARKER,
              STYLE,
              line.code,
            )}
            prefixColor={line.lead === false ? theme.rail : theme.speaker}
          />
        </Box>
      );

    // The edges of a ``` block. A labelled rule reads as a listing at a glance,
    // where a bare "```ts" line just looks like the model leaked syntax.
    case 'fence': {
      const lead = `${SPEAKER_INDENT}${line.open ? '┌' : '└'}─`;
      const label = line.open && line.info ? ` ${line.info} ` : '';
      const dashes = Math.max(2, width - displayWidth(lead) - displayWidth(label) - 1);
      return (
        <Text color={theme.rail}>
          {lead}
          {label ? <Text color={theme.muted}>{label}</Text> : null}
          {'─'.repeat(dashes)}
        </Text>
      );
    }

    case 'reasoning':
      return (
        <RailRow
          width={width}
          glyphChar={glyph.reason}
          glyphColor={theme.muted}
          verb="thought"
          verbColor={theme.muted}
          target=""
          metric={line.ms > 0 ? secs(line.ms) : ''}
          metricColor={theme.muted}
        />
      );

    case 'tool': {
      const failed = line.status === 'fail';
      return (
        <RailRow
          width={width}
          glyphChar={failed ? glyph.fail : glyph.tool}
          glyphColor={failed ? theme.danger : theme.marker}
          verb={line.verb}
          verbColor={failed ? theme.danger : theme.verb}
          target={line.target}
          metric={line.metric}
          metricColor={failed ? theme.danger : theme.metric}
        />
      );
    }

    // A subagent header: the rail rows that follow with a `·`-prefixed verb
    // belong to this agent's nested session.
    case 'agent': {
      const failed = line.status === 'fail';
      return (
        <RailRow
          width={width}
          glyphChar={failed ? glyph.fail : glyph.tool}
          glyphColor={failed ? theme.danger : theme.speaker}
          verb="agent"
          verbColor={failed ? theme.danger : theme.speaker}
          target={line.text}
        />
      );
    }

    // Turn footer. A full-width rule with the engine's own figures on it, so
    // one glance separates this turn from the next.
    case 'done': {
      const right = `out ${tokens(line.outputTokens)} ${glyph.up} · ctx ${tokens(line.contextTokens)}`;
      // Only a clean end earns the tick: "✓ max_tokens" read as success and
      // hid a turn that had died at the output wall.
      const clean = line.stopReason === 'end_turn';
      const left = `${clean ? glyph.ok : glyph.fail} ${clean ? 'done' : line.stopReason}`;
      // left + ' ' + rule + ' ' + right must land exactly on the right edge.
      const dashes = Math.max(1, width - displayWidth(left) - displayWidth(right) - 2);
      return (
        <Text>
          <Text color={theme.marker}>{left}</Text>
          <Text color={theme.divider}>{' ' + '─'.repeat(dashes) + ' '}</Text>
          <Text color={theme.muted}>{right}</Text>
        </Text>
      );
    }

    case 'interrupted': {
      const left = `${glyph.stop} interrupted`;
      const dashes = Math.max(1, width - displayWidth(left) - 1);
      return (
        <Text>
          <Text color={theme.danger}>{left}</Text>
          <Text color={theme.divider}>{' ' + '─'.repeat(dashes)}</Text>
        </Text>
      );
    }

    // A line of a command's real output, under its rail row. Verbatim and
    // truncated rather than wrapped: build logs are column-aligned, and
    // rewrapping them destroys the alignment that makes them readable.
    case 'output':
      return (
        <Text>
          <Text color={theme.rail}>{'  │ '}</Text>
          <Text color={line.dim ? theme.rail : theme.muted}>
            {truncate(line.text, Math.max(16, width - 6))}
          </Text>
        </Text>
      );

    // Slash-command output and system notices: machine voice, so it recedes,
    // but still wrapped and indented rather than running off the edge.
    case 'notice':
      return (
        <Box flexDirection="column">
          <Rows
            rows={layoutLine(line.text.trimStart(), width, SPEAKER_INDENT, {
              ...STYLE,
              prose: theme.muted,
            })}
            prefixColor={theme.muted}
          />
        </Box>
      );

    case 'error':
      return (
        <Box flexDirection="column">
          {layoutLine(line.text, width, `${glyph.fail} `, { ...STYLE, prose: theme.danger }).map(
            (row, i) => (
              <Text key={i}>
                <Text color={theme.danger} bold>
                  {row.prefix}
                </Text>
                {row.spans.map((span, j) => (
                  <Text key={j} color={theme.danger}>
                    {span.text}
                  </Text>
                ))}
              </Text>
            ),
          )}
        </Box>
      );

    case 'blank':
      return <Text> </Text>;
  }
}
