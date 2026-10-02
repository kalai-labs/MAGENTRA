---
name: WebFetch
---
Fetches a URL, converts the page to readable text, and answers your prompt about it using a separate digest model (settings.smallModel when set, else the session model).

- http:// URLs are upgraded to https:// before fetching.
- Same-host redirects are followed automatically; a redirect to a DIFFERENT host is NOT followed — the tool returns the redirect target so you can decide whether to re-call WebFetch with it.
- Page content is cached for 15 minutes, so repeated fetches of the same URL are cheap.
- The answer is produced by a separate digest-model call over the page text; for the raw page, ask for a verbatim excerpt.
