/**
 * What a tool call is CALLED in the transcript.
 *
 * `tool_call_started.description` comes from the tool's own `describeInput`,
 * and most tools do not define one — Read, Glob, Grep, TaskCreate/Update/List
 * and AskUserQuestion all send no description at all. A rail that renders only
 * the description therefore prints a bare verb with an empty target for the
 * most common calls in any session. So the input itself is the fallback, and
 * this is the one place that decides how.
 *
 * The COMMAND wins over the description. For Bash, `describeInput` returns the
 * model's prose ("Run the test suite") while `input.command` is what actually
 * ran (`npm test -- --run parse`). In a terminal the command is the thing the
 * reader needs: it is the difference between watching an agent work and taking
 * its word for it.
 */

/** Fields that identify a call, in the order they best describe one. */
const IDENTIFYING = [
  'file_path',
  'notebook_path',
  'path',
  'pattern',
  'url',
  'query',
  'task_id',
  'name',
  'subject',
  'addon',
  'id',
] as const;

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Collapse to one line — a multi-line command must not break the rail. */
function oneLine(text: string): string {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return '';
  return lines.length === 1 ? lines[0]! : `${lines[0]} …`;
}

/**
 * The target column for a tool call.
 *
 * @param input the frame's `input`, whatever shape the tool declared.
 * @param description the frame's `description`, when the tool supplied one.
 */
export function toolTarget(input: unknown, description?: string): string {
  const rec = input && typeof input === 'object' ? (input as Record<string, unknown>) : null;

  const command = rec ? str(rec.command) : '';
  if (command) return oneLine(command);

  const desc = str(description);
  if (desc) return oneLine(desc);

  if (rec) {
    // Grep and Glob are a pattern plus an optional place to look; showing both
    // is what makes two greps in a row distinguishable.
    const pattern = str(rec.pattern);
    if (pattern) {
      const where = str(rec.path) || str(rec.glob);
      return oneLine(where ? `${pattern}  ${where}` : pattern);
    }
    for (const key of IDENTIFYING) {
      const value = str(rec[key]);
      if (value) return oneLine(value);
    }
    // Nothing recognisable: a compacted dump still beats an empty column.
    try {
      const json = JSON.stringify(rec);
      if (json && json !== '{}') return oneLine(json).replace(/\s+/g, ' ');
    } catch {
      /* circular or otherwise unserialisable — fall through */
    }
  }

  return '';
}
