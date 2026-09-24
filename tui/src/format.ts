/** Small formatters shared by the transcript and the live region. */

/** 4200 -> "4.2s"; 850 -> "0.9s" */
export function secs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** 2600 -> "2.6k"; 840 -> "840" */
export function tokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** The reasoning part of an output figure: " · reasoning ~2.6k" (estimated) or
 *  " · reasoning 2.6k"; empty when there is none. It is inside the output. */
export function reasoning(n: number | undefined, estimated: boolean): string {
  return n ? ` · reasoning ${estimated ? '~' : ''}${tokens(n)}` : '';
}
