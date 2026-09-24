/** Small formatters shared by the transcript and the live region. */

/** 4200 -> "4.2s"; 850 -> "0.9s"; from a minute on it reads as the desktop's
 *  formatElapsed does: 492000 -> "8m12s", never "492.0s". */
export function secs(ms: number): string {
  const safe = Math.max(0, ms);
  if (safe < 60_000) return `${(safe / 1000).toFixed(1)}s`;
  const total = Math.floor(safe / 1000);
  return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, "0")}s`;
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
