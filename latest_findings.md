# Latest findings — the connection mechanism

Date: 2026-07-27. Branch: `dev_3`.

Scope of the review: every path a connection travels. The setup wizard, the
Settings → Connection card, global profiles, the `.env` writer, engine bootstrap,
both providers, the retry layer, and the state files under `~/.magentra` and
`<workspace>/.magentra`.

Six real gaps. All six are fixed. Each one below states the failure a user saw,
not only the code that was wrong.

---

## 1. The app and the engine disagreed on what "local" means

**The failure.** A keyless `http://192.168.1.20:1234/v1` — LM Studio on the
machine in the next room — saved without complaint. The engine then refused to
boot: *"No API key found."* Nothing in the app said why.

**The cause.** Two separate implementations of the same predicate. The app knew
loopback, `.localhost`, `.local`, the private ranges and `host.docker.internal`.
The engine knew only `localhost`, `127.0.0.1` and `[::1]`. The app decided the
connection was complete; the engine decided it needed a key.

**The fix.** Both predicates now cover the LAN. `isLocalBaseUrl` in
`engine/core/src/crew/providerFactory.ts:47`, mirrored in `app/main/config.js`.
The app cannot import from the engine — the engine ships as a bundled child
process — so the two copies stay deliberate, and the parity is now asserted by
the check.

## 2. The saved key was chosen by file order, not by provider

**The failure.** A workspace switched between an OpenAI-compatible endpoint and
Anthropic keeps both key lines in its `.env`. Reveal, "keep the saved key" and
TEST took the first `*_API_KEY` line in the file. That could be the other
provider's key, sent to this provider's URL, and reported as a bad key.

**The fix.** `savedWorkspaceKey` (`app/main.js:1549`) resolves by the active
provider's variable name, with the legacy names and an explicit `apiKeyEnv` pin
in the engine's own order. `hasCredentials` (`app/main.js:365`) now asks the
question the engine will ask, across both settings layers. The old test was "is
any `*_API_KEY` line present", which was worse than useless: a leftover line for
the other provider read as configured, so the engine booted, found nothing it
could use, and died — instead of the wizard opening.

## 3. TEST passed and SAVE stored a different URL

**The failure.** TEST walks the known API path shapes and reports the one that
answered. The wizard wrote that URL back into the field. The Settings →
Connection card did not. So TEST said "link established" and the engine 404'd on
the first prompt, with nothing in between to explain it.

**The fix.** The card adopts the discovered URL, exactly as the wizard does
(`app/renderer/modules/setup.js`).

## 4. A 400 on an optional body field killed the whole turn

**The failure.** "OpenAI-compatible" is a family resemblance, not a
specification. Older vLLM and llama.cpp builds and some gateways reject
`stream_options`. OpenAI's reasoning models reject `max_tokens` and demand
`max_completion_tokens`. Either one ended the turn.

**The fix.** The provider learns from the endpoint's own rejections. A 400 or 422
naming `stream_options`, `max_tokens` or `num_ctx` drops or renames that field,
re-sends once, and remembers for the life of the provider
(`engine/providers/src/openai-compat.ts:49`). An unfamiliar API costs one extra
request, once. Nothing that changes what the model can do is negotiable —
`tools` is never dropped, because a silently tool-less agent looks like a broken
model rather than an unsupported endpoint.

Retry now also covers `EAI_AGAIN` (a VPN or wifi switch), `EHOSTUNREACH`,
`ENETUNREACH`, `ECONNABORTED`, and undici's header and body timeouts. Each has a
message that names the real cause.

## 5. State files were written non-atomically

**The failure.** `settings.json` has two writers: the engine (`/settings`,
`set_model`) and the app (saving a connection, the model, the web-search
toggle). The app also SIGKILLs the engine three seconds into a shutdown. A file
truncated mid-write reads as unparseable, every reader treats that as "no
settings", and the workspace presents as having lost its endpoint and key. The
three knowledge caches (`graph.json`, `symbols.json`, `codeindex.json` — the
last one is megabytes) had the same exposure, and four separate savers each
hand-rolled the same write-then-rename.

**The fix.** One atomic writer per half of the app. The engine's
`writeFileAtomic` gained an optional mode, so a file that can hold `apiKey` is
0600 on every write rather than only on creation. The app got `writeJsonAtomic`
plus `readWorkspaceSettings` / `updateWorkspaceSettings`, which replaced six
ad-hoc read-modify-write copies in `app/main.js`.

## 6. Changing the connection killed the conversation

**The failure.** Saving a connection or applying a profile respawned the engine.
The conversation, the session id, the task list and the OVERDRIVE/CAREFUL stance
died with the process. Trying a second provider on the same problem cost the work
that defined the problem. The model picker had already solved this for itself —
`set_model` changes the model on the running session — and the comment beside it
said why.

**The fix.** A `set_connection` frame re-points the live session
(`engine/core/src/runtime/engine.ts:1412`). Same session id, same messages, same
stance. Details that are load-bearing:

- The frame carries the key, because the engine read `.env` once, at boot. It
  travels inside `connection`, so the existing stdin-log redaction covers it with
  no new rule.
- The swap writes the in-memory settings and this process's key env var too.
  Three other consumers resolve the connection independently — crew endpoints,
  the backpack embedder, and the host named in provider error messages.
  Rebuilding only the chat provider would leave all three on the previous API.
- A keyless switch actively clears the previous key, from the environment and
  from the stored settings value. "No key configured" and "no key sent" have to
  mean the same thing.
- The engine persists nothing during a swap. The app writes `.env` and
  `settings.json` before it sends the frame; a second writer would race it.
- `settings.baseUrl` is never handed to the Anthropic client. For an Anthropic
  session that key names an OpenAI-compatible *embeddings* host.
- `/settings baseUrl|apiKey|provider|apiKeyEnv|allowInsecureTls` takes the same
  path, so `SETTING_TIMING` now says "session" for those five instead of
  "restart". That note is the only thing telling a user whether their change took
  effect, so leaving it at "restart" would have made it a lie.
- Only a dead or unstarted engine is spawned. The IPC result carries `live`, so
  the UI keeps the composer usable and does not wait for a `session_started` that
  is never coming. The status line says "switched on the live session — your chat
  is kept" instead of "engine restarted".

Full reasoning: `docs/adr/0007-a-connection-change-repoints-the-live-session.md`.

---

## What changed

Engine:

- `engine/protocol/src/types.ts` — `ConnectionSpec` and the `set_connection`
  frame. `generate_skill` reuses the same shape.
- `engine/core/src/crew/providerFactory.ts` — LAN-aware `isLocalBaseUrl`;
  `endpointSpecFromSettings`, the one mapping from settings to an endpoint.
- `engine/host/src/bootstrap.ts` — uses that mapping instead of its own copy.
- `engine/core/src/runtime/engine.ts` — `handleSetConnection`,
  `rebuildProvider`, `applyInsecureTls`, `CONNECTION_SETTING_KEYS`, corrected
  `SETTING_TIMING`.
- `engine/core/src/runtime/session.ts` — `setProvider`.
- `engine/core/src/config/settings.ts` — one atomic `writeSettingsFile`.
- `engine/core/src/util/fsAtomic.ts` — optional mode.
- `engine/core/src/knowledge/{graph,symbols,retrieval,backpack/index}.ts` — four
  hand-rolled savers replaced by `writeFileAtomic`.
- `engine/providers/src/openai-compat.ts` — field negotiation.
- `engine/providers/src/retry.ts` — more transient codes, better messages.

App:

- `app/main/config.js` — `apiKeyEnvVarFor`, `writeJsonAtomic`,
  `workspaceSettingsPath`, `globalSettingsPath`, `readWorkspaceSettings`,
  `readGlobalSettings`, `readEffectiveWorkspaceSettings`,
  `updateWorkspaceSettings`.
- `app/main/profiles.js` — uses the shared atomic writer.
- `app/main.js` — provider-aware key lookup, engine-accurate `hasCredentials`,
  the live-swap path, all settings access through the shared helpers. Removed the
  now-dead `API_KEY_ENV_LINE_RE` and two unused imports.
- `app/renderer/modules/setup.js` — adopts the discovered URL,
  `markConnectionApplied`, honest status text.
- `app/tests/connection.test.js` — provider-aware key vars, atomic settings, a
  corrupt settings file, 0600 on rewrite.

Docs and checks:

- `docs/adr/0007-a-connection-change-repoints-the-live-session.md` — new.
- `FEATURES.md` — six entries.
- `.claude/skills/bigboycoding/connection-check.mjs` — new, 90 invariants. It
  absorbed `api-key-resolution-check.mjs`, which was deleted: one check for the
  whole connection path rather than three slices. Nothing referenced it by name.

## Verification

All of these were run, and all pass:

```bash
npm run build                                              # tsc -b, clean
node app/tests/run-ui-tests.js                             # 27 Electron scenarios
node app/tests/{changes,window,connection}.test.js         # main process
node app/tests/reasoning.test.mjs
npm run test:version                                       # 54 pass
node .claude/skills/bigboycoding/connection-check.mjs      # 90 invariants
node .claude/skills/bigboycoding/{careful-hold,permission,retrieval,glob-state-dir}-check.mjs
```

The connection check covers key resolution, endpoint construction, engine/app
predicate parity, the live swap (session id and messages survive, the engine
persists nothing, a keyless swap clears the key, TLS follows the connection), and
the provider's field negotiation.

## Open, and not mine

`graph-languages-check.mjs` fails on `go: exported func and type are indexed`
(got `Record,Name`, want `Name,Record`). This is pre-existing. Confirmed with
`git stash push -- engine/core/src/knowledge/symbols.ts`: the check passes with
the committed file. The uncommitted `symbols.ts` work sorts symbols by
declaration line, which is what the skeleton reader needs; the check still
expects per-pattern order. The check's expectation is the stale side.

## Known limits, stated rather than hidden

- A native Anthropic gateway with a custom host is still not configurable.
  `settings.baseUrl` already means the embeddings host for an Anthropic session,
  and overloading it further would point chat at the embeddings server. Anthropic
  behind an OpenAI-compatible proxy works today.
- Two concurrent TEST clicks, one with self-signed TLS allowed, share the
  process-wide TLS flag for the overlap. Node's `fetch` takes no per-request
  verification option without a new dependency.
- Atomic writes remove the truncation window on `settings.json`. They do not
  remove a lost update between two writers; the last writer wins, which is what a
  user changing a setting expects.
