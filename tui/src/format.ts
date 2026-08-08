/** Small formatters shared by the transcript and the live region. */

/** 4200 -> "4.2s"; 850 -> "0.9s" */
export function secs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** 2600 -> "2.6k"; 840 -> "840" */
export function tokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** Pads a verb into its column without ever truncating it. */
export function col(text: string, width: number): string {
  return text.length >= width ? `${text} ` : text.padEnd(width);
}
