# A connection change re-points the live session

Changing where inference happens used to kill the engine process and start a new
one. That is a correct way to apply a new endpoint and a terrible way to try one:
the conversation, the session id, the task list and the OVERDRIVE stance
all died with the process. Trying a second provider on the same problem cost the
work that defined the problem.

The model picker had already solved this for its own case — `set_model` changes
the model on the running session — and the comment next to it said why: "a
restart would drop the current conversation." The connection was left as the one
thing that still demanded one.

So `set_connection` carries a whole connection (provider shape, endpoint, key,
model, context window, TLS opt-in) and the engine rebuilds its provider in place.
A restart is now reserved for the case that genuinely needs one: there is no
engine running.

## Decisions a reader would otherwise undo

- **The frame is the session's connection truth, and it is written into the
  environment.** The key does not go into the provider alone. It is set as the
  env var `resolveApiKeySource` reads, because three other consumers resolve the
  connection independently — the chat provider and the host
  named in provider error messages. Rebuilding only the chat provider leaves
  those three pointed at the previous API, which is worse than not switching at
  all: one provider's key sent to another's URL.

- **The engine persists nothing on a swap.** The app writes `.env` and
  `.magentra/settings.json` *before* it sends the frame, and that is what a later
  restart boots from. A second writer inside the engine would race the first over
  the same file.

- **A keyless endpoint actively clears the key.** Switching to a local server
  deletes every key variable this process knows and the stored settings key, so
  the previous provider's credential stops being sent to a machine on the user's
  network. "No key configured" and "no key sent" have to mean the same thing.

- **`settings.baseUrl` is never handed to the Anthropic client.** For an
  Anthropic session that key names an OpenAI-compatible *embeddings* host (see
  One mapping — `endpointSpecFromSettings` — decides how
  settings become an endpoint, and boot and the swap both go through it, so the
  two can never disagree about that.

- **`/settings` on a connection key is the same swap.** Five keys (`provider`,
  `baseUrl`, `apiKey`, `apiKeyEnv`, `allowInsecureTls`) rebuild the provider
  through `applySettingLive`, and `SETTING_TIMING` reports "session" for them.
  That map's note is the only thing telling the user whether their change took
  effect; leaving it at "restart" would have made it a lie.

- **The UI must know which happened.** The IPC result carries `live`. A live swap
  leaves the composer usable and does not wait for a `session_started` that is
  never coming; a spawn locks it until the engine links, exactly as before. The
  status line says "switched on the live session — your chat is kept" rather than
  "engine restarted", because on a preserved conversation that read as "your chat
  is gone".

- **Mid-turn is allowed.** Every provider call reads the field at call time, so an
  in-flight request finishes on the provider it started with and the next one uses
  the new endpoint. This is the same behaviour `set_model` already had; refusing
  mid-turn would mean the switch silently waits for a turn the user may be
  switching *because* it is going badly.

## What proves it

`node .claude/skills/bigboycoding/connection-check.mjs` — 90 invariants over key
resolution, endpoint construction, the live swap (including that the session id
and messages survive, that nothing is persisted, and that a keyless swap clears
the key), and the provider's field negotiation.
