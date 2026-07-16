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
 * Turn any provider failure into a message a non-technical user can act on.
 * Both providers surface an HTTP status (OpenAI-compat via {@link
 * ProviderHttpError}, the Anthropic SDK via `err.status`), and network
 * failures carry a Node `code` (ECONNREFUSED, ENOTFOUND). Everything else
 * falls through to the raw message. `host` (the endpoint) sharpens the text
 * where it helps.
 */
export function friendlyProviderError(err: unknown, host?: string): string {
  const where = host ? ` (${host})` : "";
  const status =
    err instanceof ProviderHttpError
      ? err.status
      : typeof (err as { status?: unknown })?.status === "number"
        ? (err as { status: number }).status
        : undefined;

  if (status === 401 || status === 403) return `API key rejected by the provider${where}. Check the key in Settings → Connection.`;
  if (status === 404) return `Model or endpoint not found${where}. Check the model id and base URL.`;
  if (status === 429) return `Rate limited by the provider${where}. It will retry; if this persists, slow down or check your plan.`;
  if (status === 408 || status === 504) return `The provider timed out${where}. Try again.`;
  if (typeof status === "number" && status >= 500) return `The provider had a server error (${status})${where}. Try again shortly.`;

  // Node's fetch wraps a network failure in a TypeError whose `.cause` holds
  // the real errno, so check both levels.
  const code =
    (err as { code?: unknown })?.code ??
    (err as { cause?: { code?: unknown } })?.cause?.code;
  if (code === "ECONNREFUSED") return `Can't reach the provider${where} — is the server running?`;
  if (code === "ENOTFOUND") return `Can't resolve the provider host${where} — check the base URL.`;
  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") return `Connection to the provider timed out${where}.`;

  return err instanceof Error ? err.message : String(err);
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
