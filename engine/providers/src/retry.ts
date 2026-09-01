export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  /** Called before each backoff sleep — the UI's window into a retry loop. */
  onRetry?: (info: RetryInfo) => void;
}

export interface RetryInfo {
  /** 1-based attempt number of the retry about to happen. */
  attempt: number;
  delayMs: number;
  /** Human-readable cause: "rate limited", "provider server error", ... */
  reason: string;
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

/**
 * Does this error text say the PROMPT was too big for the model's window?
 * Every server words it differently — OpenAI `context_length_exceeded`,
 * Anthropic "prompt is too long", vLLM "maximum context length is N tokens",
 * llama.cpp "exceeds the available context size", LM Studio "context length"
 * — and a gateway may deliver it as an HTTP 400/413 or as an `{"error":…}`
 * chunk inside a 200 SSE stream. The phrasing, not the status, is the signal.
 *
 * Also used to keep the OpenAI-compat field negotiation honest: a 400 saying
 * "max_tokens + prompt exceed the context" names `max_tokens` without
 * rejecting the field.
 */
const CONTEXT_OVERFLOW_RE =
  /context[_ -]?(length|window|size)|maximum context|prompt is too long|input is too long|too many (input )?tokens|(input|prompt) (length|tokens?) (is |are )?(too long|exceed)|exceeds? the (available |model'?s? )?context|reduce (the length of )?the (messages|prompt|input)|request (is )?too large|payload too large|token limit/i;

export function looksLikeContextOverflow(text: string): boolean {
  return CONTEXT_OVERFLOW_RE.test(text);
}

/** True for a provider failure that means the request outgrew the model's window. */
export function isContextOverflowError(err: unknown): boolean {
  const status = statusOf(err);
  if (status === 413) return true;
  // 4xx only: a 5xx whose body happens to mention "context" is a server fault,
  // and compacting the conversation is the wrong reflex for it.
  if (status !== undefined && (status < 400 || status >= 500)) return false;
  const message = err instanceof Error ? err.message : String(err);
  return looksLikeContextOverflow(message);
}

/** HTTP status of a provider failure — ours or an SDK's (both carry .status). */
function statusOf(err: unknown): number | undefined {
  if (err instanceof ProviderHttpError) return err.status;
  const status = (err as { status?: unknown })?.status;
  return typeof status === "number" ? status : undefined;
}

/** Node errno of a network failure (fetch wraps it in `.cause`). */
function netCodeOf(err: unknown): string | undefined {
  const code =
    (err as { code?: unknown })?.code ?? (err as { cause?: { code?: unknown } })?.cause?.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Network failures worth another attempt. Every one of these is a transport
 * hiccup, not an answer: the request never reached a decision, so retrying is
 * the same request, not a second one.
 *
 * The list is long on purpose. A laptop that sleeps, a VPN that reconnects, a
 * local server reloading a model, a proxy that drops idle sockets — each shows
 * up as its own errno, and any one that is missing here surfaces to the user as
 * a hard turn failure that a single retry would have hidden.
 */
const RETRYABLE_NET_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EPIPE",
  // DNS answered "try again" — the classic after a VPN or wifi switch.
  "EAI_AGAIN",
  "ECONNABORTED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETRESET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  // undici's own stalls: the server accepted the connection and then went quiet.
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "ERR_STREAM_PREMATURE_CLOSE",
]);

export function isRetryable(err: unknown): boolean {
  const status = statusOf(err);
  if (status !== undefined) return status === 429 || status === 408 || status >= 500;
  const code = netCodeOf(err);
  return code !== undefined && RETRYABLE_NET_CODES.has(code);
}

/** Short human-readable cause for a retryable failure, for the retry status line. */
export function retryReason(err: unknown): string {
  const status = statusOf(err);
  if (status === 429) return "rate limited";
  if (status === 408) return "provider timeout";
  if (typeof status === "number" && status >= 500) return `provider server error (${status})`;
  const code = netCodeOf(err);
  if (code !== undefined) return "network error";
  return "provider error";
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

  // The one failure the engine can act on itself: it compacts and retries
  // (Session.runTurn). Reaching the user means that was not enough, so name
  // the two levers left.
  if (isContextOverflowError(err))
    return `The request exceeded the model's context window${where}. Run /compact to summarize older history, or set this connection's Context size to the model's real window so auto-compaction fires before the model overflows.`;

  // A wrong base URL answers 401 as readily as a wrong key does: most gateways
  // authenticate before they route. Naming only the key sends people to check
  // the one thing that was fine, so both causes are stated, URL first — it is
  // the one the user cannot see is wrong.
  if (status === 401 || status === 403)
    return `The provider${where} refused this request (HTTP ${status}). Either the base URL is not this API's real endpoint — providers differ (/v1, /v1/openai, /inference/v1, /openai/v1) — or the API key is wrong. Re-run TEST in the connection wizard: it probes the known endpoints and tells you which of the two it is.`;
  if (status === 404)
    return `Model or endpoint not found${where}. Either the model id does not exist on this provider (they often need a fully-qualified id, e.g. "accounts/fireworks/models/glm-5p2") or the base URL is wrong. Re-run TEST in the connection wizard to tell them apart.`;
  if (status === 429) return `Rate limited by the provider${where}. It will retry; if this persists, slow down or check your plan.`;
  if (status === 408 || status === 504) return `The provider timed out${where}. Try again.`;
  if (typeof status === "number" && status >= 500) return `The provider had a server error (${status})${where}. Try again shortly.`;
  // A generic 400/422 is a request the server would not accept as shaped.
  // Keep the server's own words — they name the field — but framed, so the
  // user knows it was the request that was refused, not the connection.
  if (status === 400 || status === 422) {
    const detail = err instanceof Error ? err.message.replace(/^provider returned \d+:\s*/, "") : "";
    return `The provider${where} rejected the request (HTTP ${status})${detail ? `: ${detail.slice(0, 300)}` : "."}`;
  }

  // Node's fetch wraps a network failure in a TypeError whose `.cause` holds
  // the real errno, so check both levels.
  const code =
    (err as { code?: unknown })?.code ??
    (err as { cause?: { code?: unknown } })?.cause?.code;
  if (code === "ECONNREFUSED") return `Can't reach the provider${where} — is the server running?`;
  if (code === "ENOTFOUND") return `Can't resolve the provider host${where} — check the base URL.`;
  if (code === "EAI_AGAIN") return `Temporary DNS failure resolving the provider host${where} — check the network, then try again.`;
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH")
    return `No network route to the provider${where} — on a LAN or VPN address, check that this machine can reach that network.`;
  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") return `Connection to the provider timed out${where}.`;
  if (code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT")
    return `The provider${where} accepted the request and then stopped responding. A local server loading a large model can take a while — try again once it is loaded.`;
  if (code === "ECONNRESET" || code === "ERR_STREAM_PREMATURE_CLOSE")
    return `The provider${where} closed the connection mid-response. Try again.`;

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
      const retryAfterMs = err instanceof ProviderHttpError ? (err.retryAfterMs ?? 0) : 0;
      const delay = Math.max(retryAfterMs, backoff);
      attempt++;
      opts.onRetry?.({ attempt, delayMs: delay, reason: retryReason(err) });
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
