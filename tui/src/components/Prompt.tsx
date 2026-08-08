/**
 * The blocking prompts — the only two frames the engine stops a turn for.
 *
 * Minimal by design: numbered choices in the live region, no cards, no
 * previews. Two ways to answer, always: number keys jump straight to a choice,
 * or arrows move the highlight and ↵ selects it — arrows matching the layout
 * (←/→ on the horizontal permission row, ↑/↓ on vertical option lists).
 * The composer is disabled while one is showing; esc denies/skips.
 */

import { Box, Text } from 'ink';
import { glyph, theme } from '../theme.js';
import type { PendingPrompt } from '../engine/useEngine.js';

export function Prompt({ prompt, selected }: { prompt: PendingPrompt; selected: number }) {
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
        <Box>
          <Text color={theme.verb} bold>
            {prompt.tool}
          </Text>
          <Text color={theme.muted}> wants to run</Text>
        </Box>
        {prompt.description ? <Text color={theme.prose}>{prompt.description}</Text> : null}
        {prompt.subject && prompt.subject !== prompt.description ? (
          <Text color={theme.target}>{prompt.subject}</Text>
        ) : null}
        <Box marginTop={1}>
          {choices.map((c, i) => (
            <Box key={c.label} marginRight={2}>
              <Text color={c.danger ? theme.danger : theme.marker}>{i + 1}</Text>
              <Text color={c.danger ? theme.danger : theme.prose} inverse={i === sel}>
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

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.speaker} paddingX={1}>
      <Box>
        <Text color={theme.speaker} bold>
          {glyph.speaker} {q.header}
        </Text>
        {prompt.questions.length > 1 ? (
          <Text color={theme.muted}>
            {'  '}
            {prompt.index + 1}/{prompt.questions.length}
          </Text>
        ) : null}
      </Box>
      <Text color={theme.prose}>{q.question}</Text>
      <Box flexDirection="column" marginTop={1}>
        {q.options.map((opt, i) => (
          <Box key={opt.label}>
            <Text color={i === sel ? theme.marker : theme.muted}>{i === sel ? '▸' : ' '} </Text>
            <Text color={theme.marker}>{i + 1}</Text>
            <Text color={picks.includes(opt.label) ? theme.marker : theme.prose} inverse={i === sel}>
              {' '}
              {picks.includes(opt.label) ? '■' : ' '} {opt.label}
            </Text>
            <Text color={theme.muted}>  {opt.description}</Text>
          </Box>
        ))}
      </Box>
      <Text color={theme.muted}>
        {q.multiSelect
          ? '↑↓ move · space/number toggle · ↵ confirm'
          : '↑↓ move · ↵ select · number jumps'}
      </Text>
    </Box>
  );
}
