/**
 * A network that answers from a script and records what it was asked.
 *
 * The connection wizard takes its `fetch` as a parameter — `opts.fetchImpl`,
 * which its own comment says exists for tests — so every branch of its
 * candidate walk is reachable without a socket. Three features test through
 * that seam, which is why this lives here rather than a third time in a test
 * file.
 *
 * It asserts NOTHING. A double that checked its own inputs would be a test of
 * the double; the tests read {@link ScriptedFetch.calls} and assert themselves.
 */

/** What a scripted endpoint answers: a status (with an optional JSON body), or a thrown failure. */
export type Reply = { readonly status: number; readonly body?: unknown } | Error;

export interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
}

export interface ScriptedFetch {
  /** Hand this to `opts.fetchImpl`. */
  readonly fetchImpl: (url: string, init: Record<string, unknown>) => Promise<unknown>;
  readonly calls: Call[];
  /** Requests to a `/models` route, in order. */
  modelCalls(): Call[];
  /** Chat-route probes, in order. */
  probes(): Call[];
  /** Every URL asked, in order — the walk, as it happened. */
  urls(): string[];
}

/** A network error shaped the way undici shapes one: the real cause hangs off `.cause`. */
export function fetchFailure(code: string, address?: string, port?: number): Error {
  const err = new Error("fetch failed");
  (err as { cause?: unknown }).cause = { code, ...(address ? { address } : {}), ...(port ? { port } : {}) };
  return err;
}

/** What an aborted request throws — the shape `describeFetchError` keys off. */
export function abortFailure(): Error {
  const err = new Error("This operation was aborted");
  err.name = "AbortError";
  return err;
}

export function scriptedFetch(answer: (url: string, method: string) => Reply): ScriptedFetch {
  const calls: Call[] = [];
  return {
    calls,
    urls: () => calls.map((c) => c.url),
    modelCalls: () => calls.filter((c) => c.url.endsWith("/models")),
    probes: () => calls.filter((c) => c.url.endsWith("/chat/completions")),
    fetchImpl: async (url: string, init: Record<string, unknown>): Promise<unknown> => {
      const method = typeof init["method"] === "string" ? init["method"] : "GET";
      const headers = (init["headers"] ?? {}) as Record<string, string>;
      calls.push({ url, method, headers: { ...headers }, body: typeof init["body"] === "string" ? init["body"] : undefined });
      const reply = answer(url, method);
      if (reply instanceof Error) throw reply;
      return {
        ok: reply.status >= 200 && reply.status < 300,
        status: reply.status,
        json: async () => reply.body ?? {},
      };
    },
  };
}
