import { z } from "zod";
import type { ToolDefinition } from "@magentra/core";

const MAX_REDIRECTS = 5;
const MAX_TEXT_CHARS = 40_000;
const CACHE_TTL_MS = 15 * 60 * 1000;
const USER_AGENT = "Magentra-WebFetch/1.0";

// Module-level 15-minute cache of readable page text, keyed by final URL.
const cache = new Map<string, { ts: number; markdown: string }>();

const inputSchema = z.object({
  url: z.string().describe("The URL to fetch (http/https; http is upgraded to https)."),
  prompt: z.string().describe("What to extract from or answer about the page content."),
});

export const webFetchTool: ToolDefinition<z.infer<typeof inputSchema>> = {
  name: "WebFetch",
  description: `Fetches a URL, converts the page to readable text, and answers your prompt about it using a separate digest model (settings.smallModel when set, else the session model).

- http:// URLs are upgraded to https:// before fetching.
- Same-host redirects are followed automatically; a redirect to a DIFFERENT host is NOT followed — the tool returns the redirect target so you can decide whether to re-call WebFetch with it.
- Page content is cached for 15 minutes, so repeated fetches of the same URL are cheap.
- The answer is produced by a separate digest-model call over the page text; for the raw page, ask for a verbatim excerpt.`,
  permissionClass: "network",
  permissionSubject: (input) => input.url,
  describeInput: (input) => `WebFetch ${input.url}`,
  execute: async (input, ctx, signal) => {
    let start: URL;
    try {
      start = new URL(input.url);
    } catch {
      return { content: `Invalid URL: ${input.url}`, isError: true };
    }
    // Loopback servers (dev servers, local APIs) rarely speak TLS — upgrading
    // them just breaks the fetch, so only remote hosts get the https upgrade.
    const isLoopback = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i.test(start.hostname);
    if (start.protocol === "http:" && !isLoopback) start.protocol = "https:";
    if (start.protocol !== "https:") {
      return { content: `Unsupported URL scheme "${start.protocol}"; only http/https are supported.`, isError: true };
    }

    const cached = getCached(start.toString());
    let markdown: string;
    if (cached !== undefined) {
      markdown = cached;
    } else {
      let fetched: FetchResult;
      try {
        fetched = await fetchReadable(start, signal);
      } catch (err) {
        return { content: `Failed to fetch ${start.toString()}: ${(err as Error).message}`, isError: true };
      }
      if (fetched.kind === "redirect") {
        return {
          content: `The URL redirected to a different host: ${fetched.location}\nWebFetch does not follow cross-host redirects automatically. If you trust it, call WebFetch again with that URL.`,
        };
      }
      markdown = fetched.markdown;
      cache.set(fetched.finalUrl, { ts: Date.now(), markdown });
    }

    const answer = await ctx.session.runInference({
      system:
        "You are given the readable text of a web page and a question about it. Answer the question using only the page content. Be concise and factual; if the page does not contain the answer, say so.",
      user: `Page URL: ${input.url}\n\nPage content:\n${markdown}\n\nQuestion: ${input.prompt}`,
      maxTokens: 1024,
    });
    return { content: answer.trim() || "(the model returned no answer)" };
  },
  inputSchema,
};

type FetchResult =
  | { kind: "ok"; finalUrl: string; markdown: string }
  | { kind: "redirect"; location: string };

async function fetchReadable(start: URL, signal: AbortSignal): Promise<FetchResult> {
  let url = start;
  for (let i = 0; i < MAX_REDIRECTS; i++) {
    const res = await fetch(url, {
      redirect: "manual",
      signal,
      headers: { "user-agent": USER_AGENT, accept: "text/html,text/plain,*/*" },
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) break;
      const next = new URL(loc, url);
      if (next.host !== url.host) return { kind: "redirect", location: next.toString() };
      url = next;
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const body = await res.text();
    return { kind: "ok", finalUrl: url.toString(), markdown: htmlToText(body) };
  }
  throw new Error(`too many redirects (>${MAX_REDIRECTS})`);
}

function getCached(url: string): string | undefined {
  const hit = cache.get(url);
  if (!hit) return undefined;
  if (Date.now() - hit.ts > CACHE_TTL_MS) {
    cache.delete(url);
    return undefined;
  }
  return hit.markdown;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
  "#34": '"',
};

/** Hand-rolled HTML -> readable text: no dependencies. */
export function htmlToText(html: string): string {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(?:br|\/p|\/div|\/li|\/tr|\/h[1-6])\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  text = text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1] === "x" || entity[1] === "X" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity] ?? match;
  });
  text = text
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > MAX_TEXT_CHARS
    ? text.slice(0, MAX_TEXT_CHARS) + `\n[truncated — ${text.length - MAX_TEXT_CHARS} more chars; fetch a more specific page for the rest]`
    : text;
}
