import { z } from "zod";
import type { ToolDefinition } from "@magentra/core";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchBackend {
  search(query: string, opts: { signal: AbortSignal }): Promise<SearchResult[]>;
}

/** Decode the handful of HTML entities DuckDuckGo's result markup uses. */
function stripHtml(s: string): string {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos|nbsp|#39);/g, (m, ent: string) => {
      switch (ent) {
        case "amp":
          return "&";
        case "lt":
          return "<";
        case "gt":
          return ">";
        case "quot":
          return '"';
        case "apos":
        case "#39":
          return "'";
        case "nbsp":
          return " ";
        default: {
          const code = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
          return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
        }
      }
    })
    .replace(/\s+/g, " ")
    .trim();
}

/** Resolve a DuckDuckGo result href: results are redirect links of the form
 *  `//duckduckgo.com/l/?uddg=<encoded target>&rut=…`. Returns "" for ad links. */
function resolveDdgUrl(href: string): string {
  if (href.includes("duckduckgo.com/y.js")) return ""; // sponsored result
  const m = /[?&]uddg=([^&]+)/.exec(href);
  if (m) {
    try {
      return decodeURIComponent(m[1]!);
    } catch {
      return "";
    }
  }
  if (href.startsWith("//")) return `https:${href}`;
  return href;
}

/** Parse DuckDuckGo's html.duckduckgo.com results page into SearchResults.
 *  Exported so tests can exercise the parser against fixture markup. */
export function parseDuckDuckGoHtml(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const anchorRe = /<a\b(?=[^>]*class="[^"]*\bresult__a\b[^"]*")[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(html)) !== null) {
    const url = resolveDdgUrl(m[1]!);
    if (url === "") continue;
    // The snippet anchor follows its title anchor inside the same result block.
    const windowAfter = html.slice(anchorRe.lastIndex, anchorRe.lastIndex + 4000);
    const sm = /<a\b[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/.exec(windowAfter);
    results.push({ title: stripHtml(m[2]!), url, snippet: sm ? stripHtml(sm[1]!) : "" });
  }
  return results;
}

/**
 * Free, keyless backend that scrapes DuckDuckGo's no-JavaScript HTML endpoint.
 * Best-effort: DDG may rate-limit or serve a challenge page under heavy use,
 * which surfaces as zero results or an HTTP error — a paid provider (brave/
 * tavily) is the reliable alternative.
 */
export class DuckDuckGoBackend implements SearchBackend {
  async search(query: string, opts: { signal: AbortSignal }): Promise<SearchResult[]> {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: {
        // A browser UA is required; the endpoint serves bots a challenge page.
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        accept: "text/html",
      },
      signal: opts.signal,
    });
    if (!res.ok) throw new Error(`DuckDuckGo returned HTTP ${res.status}`);
    return parseDuckDuckGoHtml(await res.text()).slice(0, 10);
  }
}

export class BraveBackend implements SearchBackend {
  constructor(private readonly apiKey: string) {}

  async search(query: string, opts: { signal: AbortSignal }): Promise<SearchResult[]> {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: { accept: "application/json", "x-subscription-token": this.apiKey },
      signal: opts.signal,
    });
    if (!res.ok) throw new Error(`Brave search returned HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as { web?: { results?: { title?: string; url?: string; description?: string }[] } };
    return (data.web?.results ?? []).map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      snippet: r.description ?? "",
    }));
  }
}

export class TavilyBackend implements SearchBackend {
  constructor(private readonly apiKey: string) {}

  async search(query: string, opts: { signal: AbortSignal }): Promise<SearchResult[]> {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: this.apiKey, query, max_results: 10 }),
      signal: opts.signal,
    });
    if (!res.ok) throw new Error(`Tavily search returned HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as { results?: { title?: string; url?: string; content?: string }[] };
    return (data.results ?? []).map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      snippet: r.content ?? "",
    }));
  }
}

const inputSchema = z.object({
  query: z.string().describe("The search query."),
  allowed_domains: z
    .array(z.string())
    .optional()
    .describe("If set, only results whose hostname matches one of these domains are kept."),
  blocked_domains: z.array(z.string()).optional().describe("Results whose hostname matches one of these domains are dropped."),
});

export const webSearchTool: ToolDefinition<z.infer<typeof inputSchema>> = {
  name: "WebSearch",
  description: `Searches the web and returns titles, URLs, and snippets. Use it to find current information, docs, or pages to follow up on with WebFetch. Restrict or exclude sources with allowed_domains / blocked_domains.

Works out of the box via DuckDuckGo (free, no API key). Optionally set settings.search.provider to "brave" or "tavily" with settings.search.apiKeyEnv naming the env var that holds the API key. Web search can be turned off entirely with settings.search.enabled = false.`,
  permissionClass: "network",
  permissionSubject: (input) => input.query,
  describeInput: (input) => `WebSearch ${input.query}`,
  execute: async (input, ctx, signal) => {
    const { enabled, provider = "duckduckgo", apiKeyEnv } = ctx.session.settings.search;
    if (enabled === false) {
      return {
        content: 'Web search is disabled in settings ("search.enabled" is false). Do not retry; work without web search or ask the user to enable it.',
        isError: true,
      };
    }

    let backend: SearchBackend;
    if (provider === "duckduckgo") {
      backend = new DuckDuckGoBackend();
    } else if (provider === "brave" || provider === "tavily") {
      const key = apiKeyEnv ? process.env[apiKeyEnv] : undefined;
      if (!key) {
        return {
          content: apiKeyEnv
            ? `No API key found for ${provider}: the env var "${apiKeyEnv}" (settings.search.apiKeyEnv) is not set.`
            : `The "${provider}" search provider needs an API key: set "search.apiKeyEnv" to the name of the env var holding it, or remove "search.provider" to use the free DuckDuckGo backend.`,
          isError: true,
        };
      }
      backend = provider === "brave" ? new BraveBackend(key) : new TavilyBackend(key);
    } else {
      return { content: `Unknown search provider "${provider}"; use "duckduckgo", "brave", or "tavily".`, isError: true };
    }

    let results: SearchResult[];
    try {
      results = await backend.search(input.query, { signal });
    } catch (err) {
      return { content: `Search failed: ${(err as Error).message}`, isError: true };
    }

    results = filterByDomain(results, input.allowed_domains, input.blocked_domains);
    if (results.length === 0) return { content: `No results for "${input.query}".` };

    const rendered = results
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
      .join("\n\n");
    return { content: `Results for "${input.query}":\n\n${rendered}` };
  },
  inputSchema,
};

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function domainMatches(host: string, domain: string): boolean {
  const d = domain.toLowerCase().replace(/^\*?\.?/, "");
  return host === d || host.endsWith(`.${d}`);
}

function filterByDomain(
  results: SearchResult[],
  allowed: string[] | undefined,
  blocked: string[] | undefined,
): SearchResult[] {
  return results.filter((r) => {
    const host = hostOf(r.url);
    if (allowed && allowed.length > 0 && !allowed.some((d) => domainMatches(host, d))) return false;
    if (blocked && blocked.some((d) => domainMatches(host, d))) return false;
    return true;
  });
}
