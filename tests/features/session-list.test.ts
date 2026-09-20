/**
 * `session-list`.
 *
 * A workspace's saved conversations are one JSONL file each under
 * `.magentra/sessions/`. The engine lists them with a label a human can read —
 * the first REAL user message, harness reminders stripped out, or the name the
 * user gave the session — and lets that list be tidied: renamed (a `meta`
 * record is appended, so the name travels with the transcript), archived (moved
 * into `sessions/archive/`) and deleted (the transcript and its task file).
 * Every change re-emits `session_list`.
 *
 * `fs`, as the record declares. A real Engine runs in this process on the
 * repo's scripted provider, over a real workspace directory; the sessions it
 * lists are real transcript files written record by record with the real
 * `Transcript` class, so they are byte-for-byte what the engine itself writes.
 * The one corrupt file is written with `writeFileSync`, because the writer
 * cannot produce a broken line.
 *
 * The frames are the protocol's own (`list_sessions`, `rename_session`,
 * `archive_session`, `delete_session`), the replies are `session_list`,
 * `command_output` and `error` events, and nothing here asserts on anything the
 * scripted provider said — the script exists only so a turn can start and
 * finish, which is what gives the engine a live transcript of its own to refuse
 * to archive or delete.
 */

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Transcript, type TranscriptRecord } from "@magentra/core";
import type { CoreEvent, SessionSummary } from "@magentra/protocol";

import { registerFeatureTests, type TestRun } from "../lib/featureTest.ts";
import { FsTest } from "../lib/fsTest.ts";
import { startScriptedEngine, type FakeTurn, type ScriptedEngine } from "../lib/scriptedEngine.ts";

const FEATURE = "session-list";

/** Verbatim from the record. */
const INVARIANT = "Sessions can be listed, renamed, archived and deleted.";

abstract class SessionListTest extends FsTest {
  readonly featureId = FEATURE;
  readonly invariant = INVARIANT;

  /** A real Engine boots and, in two of these, runs one turn. */
  override readonly timeoutMs: number = 60_000;

  #engine: ScriptedEngine | undefined;
  #workspace: string | undefined;

  override async tearDown(): Promise<void> {
    await this.#engine?.close();
  }

  protected get workspace(): string {
    if (this.#workspace === undefined) throw new Error("the workspace is only there once boot() has run");
    return this.#workspace;
  }

  protected get stateDir(): string {
    return join(this.workspace, ".magentra");
  }

  protected sessionFile(id: string): string {
    return join(this.stateDir, "sessions", `${id}.jsonl`);
  }

  /** The workspace, made before the engine so hand-written transcripts are already on disk at boot. */
  protected makeWorkspace(): string {
    this.redirectHome();
    this.#workspace = this.tempDir("magentra-sessions-");
    return this.#workspace;
  }

  protected async boot(turns: readonly FakeTurn[] = []): Promise<ScriptedEngine> {
    this.#engine = await startScriptedEngine({ workspace: this.workspace, turns: [...turns] });
    return this.#engine;
  }

  /** A saved session, written record by record by the real writer. */
  protected writeSession(id: string, records: readonly Parameters<Transcript["append"]>[0][], opts?: { child?: boolean }): string {
    const transcript = new Transcript(this.stateDir, id, opts ?? {});
    for (const record of records) transcript.append(record);
    return transcript.file;
  }

  protected records(id: string): TranscriptRecord[] {
    return Transcript.read(this.sessionFile(id));
  }

  /** Ask for the listing and take the reply. */
  protected async list(engine: ScriptedEngine): Promise<SessionSummary[]> {
    engine.send({ type: "list_sessions" });
    const event = await engine.waitFor((e): e is Extract<CoreEvent, { type: "session_list" }> => e.type === "session_list");
    return [...event.sessions];
  }

  protected async nextList(engine: ScriptedEngine): Promise<SessionSummary[]> {
    const event = await engine.waitFor((e): e is Extract<CoreEvent, { type: "session_list" }> => e.type === "session_list");
    return [...event.sessions];
  }

  /** The engine's own live session, taken from the event that announces it. */
  protected async activeId(engine: ScriptedEngine): Promise<string> {
    const started = await engine.waitFor((e): e is Extract<CoreEvent, { type: "session_started" }> => e.type === "session_started");
    return started.sessionId;
  }
}

/* ---- checklist 1 ------------------------------------------------------ */

class TheLabelIsTheUsersOwnWords extends SessionListTest {
  readonly id = "a-listed-session-is-labelled-with-the-first-user-message-reminders-stripped";
  readonly whyItExists =
    "the session picker showed the raw first message, so every row opened with the harness's own <system-reminder> context block and a user could not tell one conversation from another";

  override async run(t: TestRun): Promise<void> {
    this.makeWorkspace();
    this.writeSession("s_labelled", [
      { kind: "system_prompt", text: "you are a tool" },
      {
        kind: "message",
        message: { role: "user", content: [{ type: "text", text: "<system-reminder>ctx</system-reminder>What is 2+2?" }] },
      },
      { kind: "message", message: { role: "assistant", content: [{ type: "text", text: "4" }] } },
    ]);
    const engine = await this.boot();

    const sessions = await this.list(engine);
    const summary = sessions.find((s) => s.id === "s_labelled");

    t.assert.notEqual(summary, undefined, "the saved session is listed");
    t.assert.equal(summary!.firstUserMessage, "What is 2+2?", "the label is the user's words, not the record");
    t.assert.equal(summary!.firstUserMessage?.includes("system-reminder"), false, "no harness text reaches the picker");
    t.assert.equal(summary!.cwd, this.workspace, "and the row says which folder it belongs to");
    t.assert.equal(typeof summary!.updatedAt, "string");
  }
}

/* ---- checklist 2 ------------------------------------------------------ */

class RenamingAppendsAMetaThatKeepsTheRest extends SessionListTest {
  readonly id = "renaming-appends-a-meta-record-that-keeps-the-previous-stats-and-model";
  readonly whyItExists =
    "the rename appended a bare {label} meta record, which then became the newest snapshot and hid the session's stats, model and overdrive flag from resume — naming a session silently wiped its accounting";

  override async run(t: TestRun): Promise<void> {
    this.makeWorkspace();
    const stats = { turns: 3, contextTokens: 120 };
    this.writeSession("s_rename", [
      { kind: "message", message: { role: "user", content: [{ type: "text", text: "original label" }] } },
      { kind: "meta", data: { stats, model: "glm-5", overdrive: true } },
    ]);
    const engine = await this.boot();
    const before = this.records("s_rename").length;

    engine.send({ type: "rename_session", id: "s_rename", label: "My work" });
    const renamed = await this.nextList(engine);

    const appended = this.records("s_rename");
    t.assert.equal(appended.length, before + 1, "exactly one record was appended");
    const last = appended[appended.length - 1]!;
    t.assert.equal(last.kind, "meta");
    t.assert.deepEqual(last.kind === "meta" ? last.data : undefined, { stats, model: "glm-5", overdrive: true, label: "My work" }, "the name joins the previous snapshot rather than replacing it");
    t.assert.equal(renamed.find((s) => s.id === "s_rename")?.label, "My work", "and the listing shows the new name");

    engine.send({ type: "rename_session", id: "s_rename", label: "   " });
    const error = await engine.waitFor((e): e is Extract<CoreEvent, { type: "error" }> => e.type === "error");

    t.assert.equal(error.message, "Cannot rename: the label is empty.");
    t.assert.equal(error.fatal, false, "an empty name is a refusal, not a crash");
    t.assert.equal(this.records("s_rename").length, before + 1, "nothing was appended for the empty name");
    const after = await this.list(engine);
    t.assert.equal(after.find((s) => s.id === "s_rename")?.label, "My work", "and the name it had still stands");
  }
}

/* ---- checklist 3 ------------------------------------------------------ */

class ArchivingMovesItOutOfTheListing extends SessionListTest {
  readonly id = "archiving-moves-the-transcript-into-archive-and-refuses-the-active-session";
  readonly whyItExists =
    "archive deleted the transcript instead of moving it, so 'tidy the list' destroyed the conversation — and archiving the session the user was sitting in left the engine writing turns into a file that was no longer where it thought it was";

  override async run(t: TestRun): Promise<void> {
    this.makeWorkspace();
    this.writeSession("s_archive", [
      { kind: "message", message: { role: "user", content: [{ type: "text", text: "old work" }] } },
    ]);
    const engine = await this.boot([{ text: "hello back" }]);
    const active = await this.activeId(engine);
    await engine.runTurn("hello");
    await engine.engine.idle();

    const before = await this.list(engine);
    t.assert.equal(before.some((s) => s.id === active), true, "the live session is listed while it is live");
    t.assert.equal(before.some((s) => s.id === "s_archive"), true, "so is the saved one");

    engine.send({ type: "archive_session", id: "s_archive" });
    const after = await this.nextList(engine);

    t.assert.equal(existsSync(this.sessionFile("s_archive")), false, "the transcript left sessions/");
    t.assert.equal(existsSync(join(this.stateDir, "sessions", "archive", "s_archive.jsonl")), true, "and landed in sessions/archive/, not in the bin");
    t.assert.equal(after.some((s) => s.id === "s_archive"), false, "the id is gone from the listing");

    engine.send({ type: "archive_session", id: active });
    const notice = await engine.waitFor(
      (e): e is Extract<CoreEvent, { type: "command_output" }> => e.type === "command_output" && e.text.includes("active session"),
    );
    t.assert.equal(notice.text, "The active session cannot be archived.");
    t.assert.equal(existsSync(this.sessionFile(active)), true, "the live transcript is still where the engine is writing it");
  }
}

/* ---- checklist 4 ------------------------------------------------------ */

class DeletingTakesTheTaskFileWithIt extends SessionListTest {
  readonly id = "deleting-removes-the-transcript-and-its-task-file-and-refuses-the-active-session";
  readonly whyItExists =
    "the session's task file outlived the session it belonged to, so .magentra/tasks/ grew a dead file per deleted conversation — and deleting the live session left the engine appending turns to a transcript nobody could list";

  override async run(t: TestRun): Promise<void> {
    this.makeWorkspace();
    this.writeSession("s_delete", [
      { kind: "message", message: { role: "user", content: [{ type: "text", text: "finished work" }] } },
    ]);
    const taskFile = join(this.stateDir, "tasks", "s_delete.json");
    this.writeJson(taskFile, [{ id: "1", text: "something", status: "done" }]);
    const engine = await this.boot([{ text: "hello back" }]);
    const active = await this.activeId(engine);
    await engine.runTurn("hello");
    await engine.engine.idle();

    t.assert.equal((await this.list(engine)).some((s) => s.id === "s_delete"), true, "the session is there to delete");

    engine.send({ type: "delete_session", id: "s_delete" });
    const after = await this.nextList(engine);

    t.assert.equal(existsSync(this.sessionFile("s_delete")), false, "the transcript is gone");
    t.assert.equal(existsSync(taskFile), false, "and so is its task file");
    t.assert.equal(after.some((s) => s.id === "s_delete"), false, "the listing no longer offers it");

    engine.send({ type: "delete_session", id: active });
    const notice = await engine.waitFor(
      (e): e is Extract<CoreEvent, { type: "command_output" }> => e.type === "command_output" && e.text.includes("active session"),
    );
    t.assert.equal(notice.text, "The active session cannot be deleted. Start or resume another session first.");
    t.assert.equal(existsSync(this.sessionFile(active)), true, "the live transcript survives the attempt");
  }
}

/* ---- checklist 5 ------------------------------------------------------ */

class SubagentsAreHiddenAndACorruptHeadIsSurvivable extends SessionListTest {
  readonly id = "a-subagent-transcript-is-never-listed-and-a-corrupt-first-line-costs-only-the-label";
  readonly whyItExists =
    "every subagent a turn spawned appeared in the resumable session list as a conversation of its own, and one unparseable first line threw out of firstUserText and took the whole listing down with it";

  override async run(t: TestRun): Promise<void> {
    this.makeWorkspace();
    this.writeSession("s_parent", [
      { kind: "message", message: { role: "user", content: [{ type: "text", text: "the real conversation" }] } },
    ]);
    const child = this.writeSession(
      "s_child",
      [{ kind: "message", message: { role: "user", content: [{ type: "text", text: "a subagent's brief" }] } }],
      { child: true },
    );
    t.assert.equal(child, join(this.stateDir, "sessions", "subagents", "s_child.jsonl"), "a child transcript is written one directory down");

    // Only writeFileSync can produce this: the writer emits valid JSON lines.
    const corruptPath = join(this.stateDir, "sessions", "s_corrupt.jsonl");
    writeFileSync(corruptPath, '{"kind":"message","message":{"role":"user",\nnot json at all\n', "utf8");
    t.assert.equal(Transcript.firstUserText(corruptPath), undefined, "a damaged head yields no label instead of throwing");

    const engine = await this.boot();
    const sessions = await this.list(engine);

    t.assert.equal(sessions.some((s) => s.id === "s_child"), false, "a subagent is not a resumable session");
    t.assert.equal(sessions.some((s) => s.id === "s_parent"), true, "the real one is");
    const corrupt = sessions.find((s) => s.id === "s_corrupt");
    t.assert.notEqual(corrupt, undefined, "the damaged session is still listed — a label is best-effort, never a reason to drop a row");
    t.assert.equal(corrupt!.firstUserMessage, undefined, "it simply has no label");
  }
}

registerFeatureTests(
  new TheLabelIsTheUsersOwnWords(),
  new RenamingAppendsAMetaThatKeepsTheRest(),
  new ArchivingMovesItOutOfTheListing(),
  new DeletingTakesTheTaskFileWithIt(),
  new SubagentsAreHiddenAndACorruptHeadIsSurvivable(),
);
