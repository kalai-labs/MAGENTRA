# Prompt Lab

A local console for every prompt the engine sends — the system prompt, the
in-turn reminders, the end-of-turn rungs, all tool descriptions, the subagent
roles, and the background inference calls.

```bash
npm run prompt-lab                 # http://127.0.0.1:4319
npm run prompt-lab -- --port 5000  # different port
npm run prompt-lab -- --dir ./experiments/short   # a separate override set
```

## How it works

Every prompt is declared once, next to the code that uses it, with
`definePrompt` from `@magentra/protocol`. The default text stays in the source,
so the repository is still readable on its own; the registry adds an id, a group,
and a one-line note saying where the prompt is injected.

Editing a prompt in the browser writes one plain text file:

```
~/.magentra/prompts/<prompt-id>.txt
```

The engine re-reads those files live (250 ms cache), so an edit lands on the
**next turn** — no restart, no rebuild. Deleting a file, clearing the box, or
pressing *Reset to default* restores the shipped text. Typing the default back
by hand deletes the file too, so "edited back" and "never edited" are one state.

`MAGENTRA_PROMPTS_DIR` points a session at a different override set, which is how
you A/B two prompt configurations against the same task.

## Editing

Typing records a draft and writes nothing. Save with the **Save** button or
**⌘S / Ctrl+S**; switching to another prompt saves the current one first, and
closing the tab with unsaved work warns. The editor is only rebuilt when the
selection changes, so the caret never moves under you.

An override file changed by something *other* than the lab pushes a live-reload
event. If you have unsaved work when that happens the reload is refused rather
than silently discarding your edit — save or reset first.

## Review notes

`findings.json` holds notes keyed by prompt id. Each renders in the editor as a
card with a severity (`must` / `improve` / `ok`), the problem, the code evidence
behind it, how a mature reference harness words the same thing, and a suggested
direction. Severity shows as a coloured dot in the sidebar and on the injection
map; **Review notes** in the sidebar lists them worst-first.

The file is read fresh on every request, so you can edit or extend it while the
lab is open — add your own entries as you work through them.

## Adding a prompt

```ts
const MY_PROMPT = definePrompt({
  id: "reminder.my-thing",
  group: "3 · In-turn reminders",
  label: "My thing",
  channel: "reminder",
  where: "Fires when …. Costs one extra round trip.",
  placeholders: ["files"],          // optional {{files}} slots
  text: `<system-reminder>…</system-reminder>`,
});

this.remind(renderPrompt(MY_PROMPT, { files: "a.ts, b.ts" }));
```

Tool descriptions register themselves — `ToolRegistry.register` publishes every
tool's `description` automatically, and `Session.toolSchemas()` resolves the
override at request time.
