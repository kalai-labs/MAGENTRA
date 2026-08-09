/**
 * The blocking prompts — the only two frames the engine stops a turn for.
 *
 * Two ways to answer, always: number keys jump straight to a choice, or arrows
 * move the highlight and ↵ selects it — arrows matching the layout (←/→ on the
 * horizontal permission row, ↑/↓ on vertical option lists). The composer is
 * disabled while one is showing.
 *
 * esc means the same thing in both: stop asking me. On a permission that is a
 * deny; on a question round it settles with whatever was answered so far, and
 * the engine reports the rest as "(no answer)".
 */

import { Box, Text } from 'ink';
import { glyph, theme } from '../theme.js';
import { truncate } from '../markdown.js';
import type { PendingPrompt } from '../engine/useEngine.js';

export function Prompt({
  prompt,
  selected,
  width,
}: {
  prompt: PendingPrompt;
  selected: number;
  width: number;
}) {
  const inner = Math.max(20, width - 6);

  if (prompt.kind === 'permission') {
    const hasAlways = Boolean(prompt.subject);
    const choices = [
      { label: 'allow once', danger: false },
      { label: 'allow session', danger: false },
      ...(hasAlways ? [{ label: `always${prompt.grant ? ` (${prompt.grant})` : ''}`, danger: false }] : []),
      { label: 'deny', danger: true },
    ];
    const sel = Math.min(selected, choices.length - 1);

    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.verb} paddingX={1}>
        <Text>
          <Text color={theme.verb} bold>
            {prompt.tool}
          </Text>
          <Text color={theme.muted}> wants to run</Text>
        </Text>
        {prompt.description ? (
          <Text color={theme.prose} bold>
            {truncate(prompt.description, inner)}
          </Text>
        ) : null}
        {prompt.subject && prompt.subject !== prompt.description ? (
          <Text color={theme.target}>{truncate(prompt.subject, inner)}</Text>
        ) : null}
        <Box marginTop={1}>
          {choices.map((c, i) => (
            <Box key={c.label} marginRight={2}>
              <Text color={c.danger ? theme.danger : theme.marker}>{i + 1}</Text>
              <Text color={c.danger ? theme.danger : theme.prose} bold={i === sel} inverse={i === sel}>
                {' '}
                {c.label}
              </Text>
            </Box>
          ))}
        </Box>
        <Text color={theme.muted}>←→ move · ↵ select · 1-{choices.length} jump · esc deny</Text>
      </Box>
    );
  }

  const q = prompt.questions[prompt.index]!;
  const picks = prompt.picked[prompt.index] ?? [];
  const sel = Math.min(selected, q.options.length - 1);
  // The checkbox column only earns its space when a choice can be toggled.
  const box = (label: string) => (q.multiSelect ? (picks.includes(label) ? '■ ' : '□ ') : '');

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.speaker} paddingX={1}>
      <Text>
        <Text color={theme.speaker} bold>
          {glyph.speaker} {q.header}
        </Text>
        {prompt.questions.length > 1 ? (
          <Text color={theme.muted}>
            {'  '}
            {prompt.index + 1}/{prompt.questions.length}
          </Text>
        ) : null}
      </Text>
      <Text color={theme.prose} bold>
        {truncate(q.question, inner)}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {q.options.map((opt, i) => (
          <Box key={opt.label} flexDirection="column">
            <Text>
              <Text color={i === sel ? theme.marker : theme.muted}>{i === sel ? '▸' : ' '} </Text>
              <Text color={theme.marker}>{i + 1} </Text>
              <Text color={picks.includes(opt.label) ? theme.marker : theme.muted}>
                {box(opt.label)}
              </Text>
              <Text color={theme.prose} bold={i === sel} inverse={i === sel}>
                {opt.label}
              </Text>
            </Text>
            {opt.description ? (
              <Text color={theme.muted}>
                {'      '}
                {truncate(opt.description, Math.max(10, inner - 6))}
              </Text>
            ) : null}
          </Box>
        ))}
      </Box>
      <Text color={theme.muted}>
        {q.multiSelect
          ? '↑↓ move · space/number toggle · ↵ confirm · esc skip'
          : '↑↓ move · ↵ select · number jumps · esc skip'}
      </Text>
    </Box>
  );
}
