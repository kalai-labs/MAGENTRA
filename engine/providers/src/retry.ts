export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
}

export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ProviderHttpError";
  }
}

export function isRetryable(err: unknown): err is ProviderHttpError {
  return (
    err instanceof ProviderHttpError &&
    (err.status === 429 || err.status === 408 || err.status >= 500)
  );
}

/**
 * Runs `fn` with exponential backoff on retryable HTTP errors (429/408/5xx),
 * honoring the server's retry-after hint when present. Aborts immediately
 * when the signal fires.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  signal: AbortSignal,
  opts: RetryOptions = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 4;
  const base = opts.baseDelayMs ?? 1000;
  let attempt = 0;
  for (;;) {
    signal.throwIfAborted();
    try {
      return await fn();
    } catch (err) {
      if (!isRetryable(err) || attempt >= maxRetries) throw err;
      const backoff = base * 2 ** attempt * (0.5 + Math.random() / 2);
      const delay = Math.max(err.retryAfterMs ?? 0, backoff);
      attempt++;
      await sleep(delay, signal);
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (!Number.isNaN(seconds)) return seconds * 1000;
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}
