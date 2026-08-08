/**
 * Line-level Markdown for the transcript.
 *
 * Prose commits one complete line at a time, so this renderer works per line:
 * block shape (heading, bullet, quote, rule) is decided from the line alone,
 * and the one piece of cross-line state — "inside a code fence" — is tracked
 * by the emitter and arrives here as the `code` flag. Nothing committed is
 * ever restyled, which is exactly the property <Static> demands.
 *
 * Inline marks: `code`, **bold**, *italic*, _italic_, ~~strike~~, [text](url).
 * Colours stay inside the existing theme: inline code reads as a string
 * (cyan, like tool targets), headings are bold bright, quotes are muted.
 */

import { Fragment } from 'react';
import { Text } from 'ink';
import { theme } from '../theme.js';

const INLINE =
  /(`[^`]+`|\*\*[^*]+?\*\*|\*[^*\s][^*]*?\*|_[^_\s][^_]*?_|~~[^~]+?~~|\[[^\]]+?\]\([^)]+?\))/g;

/** Inline marks → styled spans. Plain text passes through untouched. */
export function renderInline(text: string, baseColor: string = theme.prose) {
  const parts = text.split(INLINE);
  return (
    <>
      {parts.map((part, i) => {
        if (i % 2 === 0) {
          return part ? (
            <Text key={i} color={baseColor}>
              {part}
            </Text>
          ) : null;
        }
        if (part.startsWith('`')) {
          return (
            <Text key={i} color={theme.target}>
              {part.slice(1, -1)}
            </Text>
          );
        }
        if (part.startsWith('**')) {
          return (
            <Text key={i} color={theme.prose} bold>
              {part.slice(2, -2)}
            </Text>
          );
        }
        if (part.startsWith('~~')) {
          return (
            <Text key={i} color={theme.muted} strikethrough>
              {part.slice(2, -2)}
            </Text>
          );
        }
        if (part.startsWith('*') || part.startsWith('_')) {
          return (
            <Text key={i} color={baseColor} italic>
              {part.slice(1, -1)}
            </Text>
          );
        }
        // [text](url) — the text carries the style; the url stays visible but
        // recedes, since a terminal link isn't clickable everywhere.
        const m = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
        if (m) {
          return (
            <Fragment key={i}>
              <Text color={theme.target} underline>
                {m[1]}
              </Text>
              <Text color={theme.muted}> ({m[2]})</Text>
            </Fragment>
          );
        }
        return (
          <Text key={i} color={baseColor}>
            {part}
          </Text>
        );
      })}
    </>
  );
}

/** One committed prose line, block shape included. */
export function MarkdownLine({ text, code }: { text: string; code?: boolean }) {
  // Inside a fence: verbatim, string-coloured, indented — no inline parsing,
  // because code is full of *, _ and ` that mean nothing markdowny there.
  if (code) {
    return (
      <Text color={theme.target}>
        {'  '}
        {text}
      </Text>
    );
  }

  // The fence delimiters themselves: keep the info string, recede.
  if (/^```/.test(text.trim())) {
    return <Text color={theme.muted}>{'  '}{text.trim()}</Text>;
  }

  // Headings — weight over size, since a terminal has no sizes.
  const h = /^(#{1,6})\s+(.*)$/.exec(text);
  if (h) {
    return (
      <Text color={theme.prose} bold underline={h[1]!.length <= 2}>
        {renderInline(h[2]!, theme.prose)}
      </Text>
    );
  }

  // Horizontal rule.
  if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(text)) {
    return <Text color={theme.rail}>{'─'.repeat(32)}</Text>;
  }

  // Blockquote.
  const q = /^>\s?(.*)$/.exec(text);
  if (q) {
    return (
      <Text color={theme.muted}>
        {'│ '}
        {renderInline(q[1]!, theme.muted)}
      </Text>
    );
  }

  // Bullets (with nesting) and numbered lists.
  const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(text);
  if (bullet) {
    return (
      <Text>
        <Text color={theme.marker}>
          {bullet[1]}
          {'• '}
        </Text>
        {renderInline(bullet[2]!)}
      </Text>
    );
  }
  const numbered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(text);
  if (numbered) {
    return (
      <Text>
        <Text color={theme.marker}>
          {numbered[1]}
          {numbered[2]}
          {'. '}
        </Text>
        {renderInline(numbered[3]!)}
      </Text>
    );
  }

  return <Text>{renderInline(text)}</Text>;
}
