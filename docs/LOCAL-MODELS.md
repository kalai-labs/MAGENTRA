# Running Magentra on local models (Ollama & LM Studio)

Magentra can drive a model running entirely on your own machine — no API key, no
internet. Both **Ollama** and **LM Studio** expose an OpenAI-compatible endpoint,
which is the protocol Magentra's `openai-compatible` provider already speaks, so
the only setup is pointing Magentra at the local server and picking a model.

> Tool-calling matters. Magentra is a heavily tool-driven agent (Read, Edit,
> Bash, …). Pick a local model that supports tool/function calling — e.g.
> `qwen3:8b`, `qwen2.5-coder`, `llama3.1`. A model without tool support will chat
> but won't be able to act.

---

## Option A — Ollama

1. **Install Ollama** from https://ollama.com and start it (the desktop app or
   `ollama serve` runs a server at `http://localhost:11434`).
2. **Pull a tool-capable model:**
   ```bash
   ollama pull qwen3:8b
   ```
3. **Point Magentra at it.** In the desktop app's setup wizard, click the
   **OLLAMA** preset. It fills in:
   - Base URL: `http://localhost:11434/v1`
   - Model: `qwen3:8b`
   - No API key (the field is hidden — Ollama needs none)
   - Context size: `4096` (see below)

   Click **IGNITE** and Magentra writes the connection to
   `.magentra/settings.json` in your workspace and starts talking to Ollama.

### Context size

The **Context size** field sets how large a context window the model runs with.
It does two things:

- It becomes Magentra's compaction window — the engine summarizes older history
  as you approach it, so the conversation never overflows the model.
- It is sent to Ollama as `num_ctx`, requesting that the model load with that
  window.

`4096` is a safe default that fits comfortably on most machines. Raise it (e.g.
`8192`, `16384`) if your model and RAM/VRAM allow — larger context lets the agent
hold more of your codebase in view, at the cost of memory and speed. If a session
feels like it's forgetting recent context too soon, increase this value.

> If your Ollama build doesn't honor `num_ctx` from the request, set it
> server-side instead: run Ollama with `OLLAMA_CONTEXT_LENGTH=4096`, or bake it
> into a model via a Modelfile (`PARAMETER num_ctx 4096`). Magentra's own
> compaction still respects the Context size you set either way.

---

## Option B — LM Studio

1. **Install LM Studio** from https://lmstudio.ai.
2. **Download a tool-capable model** from LM Studio's model browser (look for
   models that advertise tool/function calling).
3. **Start the local server:** open LM Studio's **Developer / Local Server** tab,
   load your model, and start the server. It defaults to `http://localhost:1234`.
4. **Point Magentra at it.** In the setup wizard, click the **LM STUDIO** preset:
   - Base URL: `http://localhost:1234/v1`
   - Model: the identifier LM Studio shows for your loaded model (type it into the
     Model field)
   - No API key
   - Context size: `4096`

   Click **IGNITE**.

> LM Studio sets a model's context length when you load it in the Local Server
> tab, not per request — set it there to match the Context size you enter in
> Magentra so compaction and the model agree.

---

## Switching later

You can change the connection any time from **Settings → Connection** in the
desktop app: set the Base URL to a local endpoint (leave the API key blank),
choose a model, and set a Context size. Saving writes the same
`.magentra/settings.json` the wizard does.

## Semantic search (backpack) on local models

Magentra's optional semantic search uses an embeddings model. The hosted default
(`BAAI/bge-m3`) does not exist on a local server, so on a keyless local setup
**embeddings are disabled automatically and search falls back to fast keyword
(BM25) ranking** — which needs no model and works out of the box.

To enable semantic search locally, pull an embedding model and name it in
settings, e.g. for Ollama:

```bash
ollama pull nomic-embed-text
```

then in `.magentra/settings.json`:

```json
{
  "embeddings": { "model": "nomic-embed-text", "enabled": true }
}
```

## Running the engine directly (CLI)

The same works without the desktop app. In your workspace's
`.magentra/settings.json`:

```json
{
  "provider": "openai-compatible",
  "baseUrl": "http://localhost:11434/v1",
  "model": "qwen3:8b",
  "contextWindow": 4096
}
```

No `.env` / API key is required for a `localhost` endpoint. Then run `magentra`
as usual.
