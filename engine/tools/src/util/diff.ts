/** Minimal unified diff (LCS-based) for file_edited events. */
export function unifiedDiff(path: string, before: string, after: string, context = 3): string {
  const a = before.split("\n");
  const b = after.split("\n");

  // LCS is quadratic; for very large files fall back to a whole-file hunk.
  const ops =
    a.length * b.length > 4_000_000
      ? [{ type: "del" as const, lines: a }, { type: "add" as const, lines: b }]
      : diffOps(a, b);

  const hunks: string[] = [];
  let aLine = 1;
  let bLine = 1;
  let hunk: string[] = [];
  let hunkAStart = 1;
  let hunkBStart = 1;
  let hunkALen = 0;
  let hunkBLen = 0;
  let trailingEq = 0;
  let inHunk = false;

  const flush = () => {
    if (!inHunk) return;
    if (trailingEq > context) {
      const drop = trailingEq - context;
      hunk = hunk.slice(0, hunk.length - drop);
      hunkALen -= drop;
      hunkBLen -= drop;
    }
    hunks.push(`@@ -${hunkAStart},${hunkALen} +${hunkBStart},${hunkBLen} @@`, ...hunk);
    hunk = [];
    inHunk = false;
    trailingEq = 0;
  };

  for (const op of ops) {
    if (op.type === "eq") {
      for (const line of op.lines) {
        if (inHunk) {
          hunk.push(` ${line}`);
          hunkALen++;
          hunkBLen++;
          trailingEq++;
          if (trailingEq >= context * 2) {
            flush();
          }
        }
        aLine++;
        bLine++;
      }
    } else {
      if (!inHunk) {
        inHunk = true;
        trailingEq = 0;
        const lead = Math.min(context, aLine - 1, bLine - 1);
        hunkAStart = aLine - lead;
        hunkBStart = bLine - lead;
        hunkALen = lead;
        hunkBLen = lead;
        for (let i = lead; i > 0; i--) hunk.push(` ${a[aLine - 1 - i] ?? ""}`);
      } else {
        trailingEq = 0;
      }
      for (const line of op.lines) {
        if (op.type === "del") {
          hunk.push(`-${line}`);
          hunkALen++;
          aLine++;
        } else {
          hunk.push(`+${line}`);
          hunkBLen++;
          bLine++;
        }
      }
    }
  }
  flush();

  if (hunks.length === 0) return "";
  return [`--- a/${path}`, `+++ b/${path}`, ...hunks].join("\n");
}

type Op = { type: "eq" | "del" | "add"; lines: string[] };

function diffOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const lcs: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) lcs.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const ops: Op[] = [];
  const push = (type: Op["type"], line: string) => {
    const last = ops[ops.length - 1];
    if (last && last.type === type) last.lines.push(line);
    else ops.push({ type, lines: [line] });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push("eq", a[i]!);
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      push("del", a[i]!);
      i++;
    } else {
      push("add", b[j]!);
      j++;
    }
  }
  while (i < n) push("del", a[i++]!);
  while (j < m) push("add", b[j++]!);
  return ops;
}
