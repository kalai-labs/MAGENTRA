/**
 * The change vocabulary, written for whoever sends changes — an agent most of
 * all. One copy: `npm run -s brain-editor -- help changes` prints it, GET
 * /api/guide serves it, and the README points here. model.ts parseChanges()
 * is what enforces it; the test checks every op it names is one parseChanges
 * accepts, with exactly these fields.
 */

import { CHANGE_OPS } from "./model.ts";

export interface FieldGuide {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
  readonly meaning: string;
}

export interface OpGuide {
  readonly op: (typeof CHANGE_OPS)[number];
  readonly does: string;
  readonly fields: readonly FieldGuide[];
  readonly example: Readonly<Record<string, unknown>>;
}

const f = (name: string, type: string, required: boolean, meaning: string): FieldGuide => ({ name, type, required, meaning });

export const CHANGE_GUIDE = {
  summary:
    "Send a list of changes as JSON. They are applied in order, as one save, to a staged copy of the brain; the save is written only when the whole brain still compiles, the built engine still loads it, and every edited text compiles back to exactly what you sent. Otherwise nothing is written and the refusal says why.",
  workflow: [
    "1. Read: `show --json` gives every prompt, tool, knob and the brain's `revision`.",
    "2. Plan: `plan changes.json --expect <revision> --json` writes nothing and returns `ok`, `refusal`, `files` (before/after), `newProblems`, `newWarnings`, `heldBy` and `summary`.",
    "3. Apply: `apply changes.json --expect <revision> --json`. In the shipped brain/, add `--acknowledge <test,...>` naming every test in the plan's `heldBy` (only tool access and knob values are held; prompt and tool texts are not); those tests fail until the owner updates what they expect, so only acknowledge what you were asked to change.",
    "4. For a new profile, copy first (`new-profile <dir>`), then pass `--brain <dir>` to every command. A profile folder is held by no test and is never built into the engine.",
    "5. After changing the shipped brain, run `npm run build` so the engine carries it.",
  ],
  refusals: {
    "invalid-change": "The change list itself is wrong (unknown op, field, id or path). Fix the JSON.",
    stale: "The brain changed on disk after you read it. Read it again (`show --json`) and redo the change.",
    "breaks-brain": "The staged brain would have a compiler problem it did not have before. The message quotes the compiler.",
    "breaks-engine": "The built engine would throw on load with the staged brain (for example a parameter text the code reads was removed).",
    mismatch: "A file would not compile back to exactly what you sent. This should not happen; report it.",
    "needs-acknowledge": "The change moves tool access or knob values tests hold in the shipped brain. See `heldBy`.",
    busy: "Another save to the same brain is running. Retry.",
  },
  ops: [
    {
      op: "prompt.update",
      does: "Changes a prompt's text or its details. Only the fields you send change.",
      fields: [
        f("id", "string", true, "The prompt id, e.g. reminder.stall-ask."),
        f("text", "string", false, "The exact text. Every {{slot}} in it must be listed in placeholders; the engine fills only the slots its code names."),
        f("label", "string", false, "The short name (one line)."),
        f("where", "string", false, "When it fires and what it is for (one line). People read it; the model never does."),
        f("channel", "string", false, "system, system-conditional, reminder, tool, side-call, side-call-user or subagent."),
        f("placeholders", "string[]", false, "The {{slot}} names the engine fills, in the order the code declares them."),
        f("order", "integer", false, "System prompt sections only (1-core-system): its place in the system prompt."),
        f("enabled", "boolean", false, "false switches the prompt off (it is sent as blank) but keeps its text; true switches it back on."),
      ],
      example: { op: "prompt.update", id: "reminder.wrapup-nudge", text: "Before you stop, tell the user what changed and how you checked it." },
    },
    {
      op: "prompt.create",
      does: "Adds a prompt file. A new system prompt section (group 1-core-system, with an order) joins the system prompt with no code change; a prompt in any other group is sent only once engine code names it with brainPrompt(\"<id>\").",
      fields: [
        f("id", "string", true, "A dotted lower-case id, e.g. system.house-rules. Not subagent.* or tool.*."),
        f("group", "string", true, "The group folder (1-core-system, 2-conditional-system, 3-in-turn-reminders, 4-end-of-turn-rungs, 5-background-inference, 7-tool-descriptions) or its group string."),
        f("label", "string", true, "The short name (one line)."),
        f("channel", "string", true, "How it reaches the model (see prompt.update)."),
        f("where", "string", true, "When it fires and what it is for (one line)."),
        f("text", "string", true, "The exact text."),
        f("placeholders", "string[]", false, "The {{slot}} names the text uses."),
        f("order", "integer", false, "Required in 1-core-system, unique there; not allowed elsewhere."),
        f("enabled", "boolean", false, "false creates it switched off."),
      ],
      example: { op: "prompt.create", id: "system.house-rules", group: "1-core-system", label: "House rules", channel: "system", where: "Team conventions, sent on every request.", order: 115, text: "## House rules:\n- Prefer small pull requests." },
    },
    {
      op: "prompt.delete",
      does: "Deletes a prompt file. Refused when engine code still names the id.",
      fields: [f("id", "string", true, "The prompt id.")],
      example: { op: "prompt.delete", id: "system.house-rules" },
    },
    {
      op: "tool.update",
      does: "Changes a built-in tool's description and/or its parameter texts. The description is a template: keep its {{slots}}, the tool's code fills them.",
      fields: [
        f("name", "string", true, "A built-in tool name, e.g. Read."),
        f("description", "string", false, "The description template."),
        f("params", "object", false, "Parameter path → its text, or null to remove that text. Paths are dotted (questions.options.label) or (root). Removing a text the tool reads is refused."),
      ],
      example: { op: "tool.update", name: "Read", params: { offset: "The line number to start reading from." } },
    },
    {
      op: "availability.update",
      does: "Offers or withholds a built-in tool for root sessions: normally (main) and while OVERDRIVE is on (overdrive).",
      fields: [
        f("tool", "string", true, "A built-in tool name."),
        f("main", "boolean", false, "true offers it normally; false withholds it."),
        f("overdrive", "boolean", false, "The same, while OVERDRIVE is on."),
      ],
      example: { op: "availability.update", tool: "Agent", main: true, overdrive: true },
    },
    {
      op: "behavior.set",
      does: "Sets one behaviour knob in behavior.json. The value is checked against the knob's type and range.",
      fields: [
        f("key", "string", true, "The dotted key, e.g. finishing.nudgeBudget. `show knobs --json` lists every key with its rule."),
        f("value", "JSON", true, "A boolean, integer, one of the allowed words, or a list of strings, as the key's rule says."),
      ],
      example: { op: "behavior.set", key: "finishing.nudgeBudget", value: 2 },
    },
    {
      op: "behavior.override",
      does: "Sets what OVERDRIVE changes for one knob (overdrive.overrides). Only finishing, stall, reminders, clarify, context, tools and evidence keys can change in OVERDRIVE.",
      fields: [
        f("key", "string", true, "The dotted key, e.g. finishing.selfVerify.maxRounds."),
        f("value", "JSON or null", true, "The OVERDRIVE value, or null to stop overriding the key."),
      ],
      example: { op: "behavior.override", key: "stall.pivots", value: 1 },
    },
    {
      op: "file.write",
      does: "Writes a whole brain file, or deletes it with null. Meant for fixing a file the editor cannot read; the same checks apply.",
      fields: [
        f("path", "string", true, "Brain-relative: prompts/<group-folder>/<id>.md, tools/<Tool>/description.md or params.md, availability.json or behavior.json."),
        f("content", "string or null", true, "The exact file content, or null to delete the file."),
      ],
      example: { op: "file.write", path: "prompts/3-in-turn-reminders/reminder.steering.md", content: "---\nid: reminder.steering\n...\n---\nText\n" },
    },
  ] satisfies readonly OpGuide[],
} as const;
