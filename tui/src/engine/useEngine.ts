/**
 * The engine connection as React state: spawns MAGENTRA's host, translates
 * CoreEvents into transcript Lines, and exposes the send-side verbs the UI
 * needs. This file is the entire seam between the wire and the components —
 * nothing else in the TUI knows a protocol exists.
 *
 * Translation rules, agreed in the design session:
 *  - text_delta streams live; a Line commits to scrollback at each newline.
 *  - thinking_delta content is never shown; a finished thinking block commits
 *    one `◌ thought` row with its real duration.
 *  - tool calls commit one rail row when they FINISH (started only drives the
 *    activity label), so every committed line is final — <Static> stays honest.
 *  - token meters render engine figures verbatim; no TUI-side arithmetic.
 *
 * PAINTING IS COALESCED, and that is load-bearing. Ink runs on a legacy React
 * root, so updates outside React's own event system are NOT batched: one
 * setState per text_delta meant one full render, one yoga layout and one
 * terminal repaint per delta. Measured on a 2000-delta answer (10 KB of text
 * the engine wrote in 12 ms): 2510 terminal writes, 2.2 MB of escape output —
 * 216x the text — and ~1.6 s before the last character appeared, which is why
 * the terminal felt slower than the desktop app for the same model. Deltas now
 * accumulate in a ref and repaint on a ~30 fps timer instead.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { resolveEngineSpawn, type EngineSpawn } from '../config.js';
import {
  applyProfile,
  describeProfile,
  profilesPath,
  readProfiles,
  workspaceConnected,
  type Profile,
} from '../profiles.js';
import { isTrusted, trustFolder } from '../trust.js';
import { toolTarget } from '../toolLabel.js';
import { startHost, type EngineHost } from './host.js';
import {
  PROTOCOL_VERSION,
  type CoreEvent,
  type FrontendRequest,
  type PermissionDecision,
  type Question,
  type SessionSummary,
  type SlashCommandInfo,
  type TaskItem,
} from '../protocol.js';
import type { ActivityState } from '../components/Activity.js';
import type { Line, LineBody } from '../types.js';

export type PendingPrompt =
  | {
      kind: 'permission';
      id: string;
      tool: string;
      description?: string;
      subject?: string;
      grant?: string;
    }
  | { kind: 'question'; id: string; questions: Question[]; index: number; picked: string[][] };

export type Meters = { context: number; output: number; warn: boolean };

/** Something running outside a turn, from background_notification. */
export type BackgroundJob = { taskId: string; description: string };

export type Engine = {
  lines: Line[];
  /** The in-flight prose line, streaming in the live region. */
  liveText: string;
  /** True while the streaming line is the turn's first spoken line. */
  liveLead: boolean;
  busy: boolean;
  /** When the current turn started, for the activity line's own ticker. */
  startedAt: number;
  activity: ActivityState;
  meters: Meters;
  model: string;
  models: string[];
  overdrive: boolean;
  commands: SlashCommandInfo[];
  /** The session task list, verbatim from task_list_updated. */
  tasks: TaskItem[];
  /** Last few lines of the running command's output — the live tail. */
  tail: string[];
  /** Work running outside a turn (/compact, backgrounded Bash, addon gen). */
  jobs: BackgroundJob[];
  prompt: PendingPrompt | null;
  /** Set when the session cannot continue (fatal error / engine exit). */
  fatal: string | null;
  /**
   * Non-null before anything else happens when this folder has never been
   * trusted: the first-run trust gate. Nothing is spawned and no credentials
   * are written until it is answered.
   */
  trustGate: string | null;
  /** Record trust for this folder, then continue booting. */
  acceptTrust(): void;
  /**
   * Non-null before the engine is spawned, when the workspace has no
   * credentials and saved profiles exist: the startup profile picker.
   */
  picker: Profile[] | null;
  /** Commit picker[i] to the workspace (IDE-identical writes), then boot. */
  pickProfile(index: number): void;
  /** Boot without a profile; the engine reports its own missing-key error. */
  skipPicker(): void;
  /** Non-null when `--resume` or bare `/resume` fetched the saved sessions. */
  sessionPicker: SessionSummary[] | null;
  /** Bare `/resume`: fetch this workspace's sessions and open the picker. */
  openSessionPicker(): void;
  /** Resume sessionPicker[i] via resume_session. */
  pickSession(index: number): void;
  /** Dismiss the session picker and stay in the fresh session. */
  skipSessionPicker(): void;

  sendUser(text: string): void;
  steer(text: string): void;
  slash(command: string, args?: string): void;
  bang(cmd: string): void;
  interrupt(): void;
  setModel(model: string): void;
  toggleOverdrive(): void;
  /** Echo a user-typed command into the transcript without sending a frame. */
  echo(text: string): void;
  /** Commit a local notice block (e.g. the /model catalog). */
  printNotice(text: string): void;
  answerPermission(decision: PermissionDecision): void;
  /** Toggle an option on the current question (multiSelect) or answer it (single). */
  pickOption(index: number): void;
  /** Confirm a multiSelect question's picks and advance. */
  confirmQuestion(): void;
  /** Abandon the whole question round, answering nothing. */
  skipQuestions(): void;
  shutdown(): void;
};

const TARGET_MAX = 60;
const METRIC_MAX = 22;

/**
 * Live shell output. `TAIL_ROWS` is what shows under the spinner while a
 * command runs; `COMMIT_ROWS` is how much of it is kept in the transcript
 * afterwards, so a chatty build log leaves a readable trace without burying
 * the conversation. `OUTPUT_CAP` bounds what is held per call — a command that
 * prints megabytes must not grow the process.
 */
const TAIL_ROWS = 3;
const COMMIT_ROWS = 10;
const OUTPUT_CAP = 32_000;

/** One repaint per frame at ~30 fps, however many deltas arrive in between. */
const PAINT_MS = 33;

const IDLE_ACTIVITY: ActivityState = { label: 'working', detail: '' };

function clip(text: string, max: number): string {
  const one = (text ?? '').split('\n')[0]!.trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** Blank lines carry nothing in a tail and cost a whole row, so they go. */
function significantLines(text: string): string[] {
  return text.split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim() !== '');
}

function lastLines(text: string, count: number): string[] {
  const lines = significantLines(text);
  return lines.length > count ? lines.slice(-count) : lines;
}

function countLines(text: string): number {
  return significantLines(text).length;
}

/**
 * @param resume `--resume` behaviour: a session id resumes it directly;
 * `true` lists this workspace's saved sessions in a startup picker;
 * `undefined` starts fresh.
 * @param workspace absolute directory this session operates on — resolved by
 * cli.tsx (positional arg, else the launch directory).
 */
export function useEngine(resume: string | true | undefined, workspace: string): Engine {
  const [lines, setLines] = useState<Line[]>([]);
  const [liveText, setLiveText] = useState('');
  const [liveLead, setLiveLead] = useState(true);
  const [busy, setBusy] = useState(false);
  const [startedAt, setStartedAt] = useState(0);
  const [activity, setActivityState] = useState<ActivityState>(IDLE_ACTIVITY);
  const [meters, setMeters] = useState<Meters>({ context: 0, output: 0, warn: false });
  const [model, setModelState] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [overdrive, setOverdrive] = useState(false);
  const [commands, setCommands] = useState<SlashCommandInfo[]>([]);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [tail, setTail] = useState<string[]>([]);
  const [jobs, setJobs] = useState<BackgroundJob[]>([]);
  const [sessionPicker, setSessionPicker] = useState<SessionSummary[] | null>(null);
  // Consumed on the FIRST session_started only — /clear re-emits that event
  // and must not re-trigger a resume.
  const resumePending = useRef<string | true | undefined>(resume);
  const [prompt, setPrompt] = useState<PendingPrompt | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);

  const host = useRef<EngineHost | null>(null);
  const nextId = useRef(0);
  const lastKind = useRef<string | null>(null);

  // Stream-side buffers. Refs, not state: they mutate on every delta and only
  // their *renderable* projections (liveText) go through setState.
  const textBuffer = useRef('');
  const spoke = useRef(false);
  /** Inside a ``` fence — the one piece of cross-line Markdown state. */
  const fence = useRef(false);
  const thinkingSince = useRef<number | null>(null);
  const overdriveRef = useRef(false);
  const toolStarts = useRef(new Map<string, { tool: string; target: string }>());
  /** Streamed output per in-flight call id, tail-capped at OUTPUT_CAP. */
  const toolOutput = useRef(new Map<string, string>());
  /** The call whose output the live tail is showing. */
  const tailId = useRef<string | null>(null);
  /** Set by a delta, consumed by the next paint — the tail is throttled too. */
  const tailDirty = useRef(false);
  const promptRef = useRef<PendingPrompt | null>(null);
  const paintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The activity we last pushed to React, so identical deltas don't re-render. */
  const activityRef = useRef<ActivityState>(IDLE_ACTIVITY);
  /** True while the boot-time OVERDRIVE default is the reason it flipped on. */
  const overdriveIsDefault = useRef(false);
  const overdriveDefaultApplied = useRef(false);

  /**
   * The paint scheduler. Deliberately ref-held rather than a useCallback: both
   * `commit` and `drainBuffer` need to arm it, and `drainBuffer` is what it
   * ultimately calls, so a normal dependency chain would be circular.
   */
  const paintRef = useRef<() => void>(() => {});
  const lastPaintAt = useRef(0);
  /**
   * Re-entrancy guard. A drain commits the lines it completes, and `commit`
   * arms the scheduler — so without this a drain that ran longer than a frame
   * could re-enter itself from inside its own loop. Anything committed while a
   * drain is running is flushed by that drain before it returns, so skipping
   * the arm is safe as well as necessary.
   */
  const painting = useRef(false);

  /**
   * Leading-edge throttle, not a plain delay. An idle stream paints the FIRST
   * delta immediately — waiting out a frame before showing the first token
   * would trade the streaming feel away for the batching win — and only a
   * stream already painting within the last frame gets deferred.
   */
  const schedulePaint = useCallback(() => {
    if (paintTimer.current || painting.current) return;
    const since = Date.now() - lastPaintAt.current;
    if (since >= PAINT_MS) {
      paintRef.current();
      return;
    }
    paintTimer.current = setTimeout(() => {
      paintTimer.current = null;
      paintRef.current();
    }, PAINT_MS - since);
  }, []);

  /** Lines committed since the last paint. See the coalescing note up top. */
  const pendingLines = useRef<Line[]>([]);

  const flushLines = useCallback(() => {
    if (pendingLines.current.length === 0) return;
    const batch = pendingLines.current;
    pendingLines.current = [];
    setLines((prev) => [...prev, ...batch]);
  }, []);

  const commit = useCallback(
    (line: LineBody) => {
      // Never two blanks in a row — same rule the fake scheduler enforced.
      if (line.kind === 'blank' && lastKind.current === 'blank') return;
      lastKind.current = line.kind;
      pendingLines.current.push({ ...line, id: nextId.current++ } as Line);
      schedulePaint();
    },
    [schedulePaint],
  );

  /** A fresh session repaints from zero: nothing queued may survive it. */
  const resetLines = useCallback(() => {
    pendingLines.current = [];
    lastKind.current = null;
    setLines([]);
  }, []);

  const setActivity = useCallback((next: ActivityState) => {
    const prev = activityRef.current;
    if (prev.label === next.label && prev.detail === next.detail) return;
    activityRef.current = next;
    setActivityState(next);
  }, []);

  /** Commit every complete line in the buffer; the remainder keeps streaming. */
  const drainBuffer = useCallback(
    (flushAll: boolean) => {
      if (paintTimer.current) {
        clearTimeout(paintTimer.current);
        paintTimer.current = null;
      }
      lastPaintAt.current = Date.now();
      painting.current = true;

      const commitProse = (raw: string) => {
        const text = raw.trimEnd();
        if (text.length === 0) {
          commit({ kind: 'blank' });
          return;
        }
        const isFenceLine = /^```/.test(text.trim());
        // Fence contents are marked at commit time — the delimiter line itself
        // is not code, and toggles the state for the lines that follow it.
        const wasInFence = fence.current;
        const code = wasInFence && !isFenceLine;
        if (isFenceLine) fence.current = !fence.current;
        // Code lines never carry the ◆ marker and never consume the lead — the
        // speaker mark belongs to speech, not to a listing.
        if (isFenceLine) {
          commit({ kind: 'fence', info: text.trim().replace(/^`+/, '').trim(), open: !wasInFence });
        } else if (code) {
          commit({ kind: 'prose', text, lead: false, code });
        } else {
          commit({ kind: 'prose', text, lead: !spoke.current });
          spoke.current = true;
        }
      };

      let buf = textBuffer.current;
      try {
        let nl: number;
        while ((nl = buf.indexOf('\n')) !== -1) {
          commitProse(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
        }
        if (flushAll && buf.trim().length > 0) {
          commitProse(buf);
          buf = '';
        }
      } finally {
        // The guard MUST come down even if a commit threw. Leaving it raised
        // would make schedulePaint a permanent no-op — the stream would keep
        // arriving and the screen would simply stop updating.
        textBuffer.current = buf;
        painting.current = false;
      }
      if (tailDirty.current) {
        tailDirty.current = false;
        const id = tailId.current;
        setTail(id ? lastLines(toolOutput.current.get(id) ?? '', TAIL_ROWS) : []);
      }
      flushLines();
      setLiveText(buf.trimStart());
      setLiveLead(!spoke.current);
    },
    [commit, flushLines],
  );

  // What the frame timer runs. Deltas keep landing in textBuffer and lines in
  // pendingLines meanwhile — nothing is dropped, only the number of RENDERS is
  // bounded.
  paintRef.current = () => drainBuffer(false);

  useEffect(() => {
    return () => {
      if (paintTimer.current) clearTimeout(paintTimer.current);
    };
  }, []);

  /** A thinking block just ended (something else arrived): commit its row. */
  const endThinking = useCallback(() => {
    if (thinkingSince.current === null) return;
    const ms = Date.now() - thinkingSince.current;
    thinkingSince.current = null;
    commit({ kind: 'reasoning', ms });
  }, [commit]);

  const noticeBlock = useCallback(
    (text: string) => {
      commit({ kind: 'blank' });
      for (const line of text.split('\n')) commit({ kind: 'notice', text: line || ' ' });
      commit({ kind: 'blank' });
    },
    [commit],
  );

  const handleEvent = useCallback(
    (event: CoreEvent) => {
      switch (event.type) {
        case 'session_started': {
          // Fresh session (boot, /clear, resume): repaint from zero.
          resetLines();
          toolStarts.current.clear();
          toolOutput.current.clear();
          tailId.current = null;
          tailDirty.current = false;
          setTail([]);
          setJobs([]);
          textBuffer.current = '';
          spoke.current = false;
          fence.current = false;
          thinkingSince.current = null;
          setLiveText('');
          setBusy(false);
          setPrompt(null);
          promptRef.current = null;
          setModelState(event.model);
          setOverdrive(event.overdrive);
          overdriveRef.current = event.overdrive;
          setCommands(event.commands);
          setTasks([]);
          commit({ kind: 'banner', model: event.model, cwd: event.cwd, sessionId: event.sessionId });
          if (event.v !== PROTOCOL_VERSION) {
            commit({ kind: 'error', text: `protocol v${event.v} from engine; this TUI speaks v${PROTOCOL_VERSION}` });
          }
          // --resume: a given id resumes straight away; the bare flag asks for
          // the workspace's saved sessions and opens the picker on the reply.
          if (typeof resumePending.current === 'string') {
            const id = resumePending.current;
            resumePending.current = undefined;
            host.current?.send({ type: 'resume_session', id });
          } else if (resumePending.current === true) {
            host.current?.send({ type: 'list_sessions' });
          } else if (!overdriveDefaultApplied.current) {
            // Terminal sessions in a TRUSTED folder start autonomous. Applied
            // once, and only to a session we started fresh: a resumed session
            // carries its own recorded stance, which the engine restores
            // deliberately and must not be overridden here.
            overdriveDefaultApplied.current = true;
            if (isTrusted(workspaceRef.current) && !event.overdrive) {
              overdriveIsDefault.current = true;
              host.current?.send({ type: 'set_overdrive', enabled: true });
            }
          }
          break;
        }

        case 'turn_started':
          setBusy(true);
          setStartedAt(Date.now());
          setActivity({ label: 'thinking', detail: '' });
          spoke.current = false;
          fence.current = false; // an unclosed fence must not bleed across turns
          setLiveLead(true);
          setMeters((m) => ({ ...m, output: 0 }));
          break;

        case 'text_delta':
          endThinking();
          textBuffer.current += event.text;
          schedulePaint();
          setActivity({ label: 'responding', detail: '' });
          break;

        case 'thinking_delta':
          if (thinkingSince.current === null) {
            drainBuffer(true);
            thinkingSince.current = Date.now();
          }
          setActivity({ label: 'thinking', detail: '' });
          break;

        case 'tool_call_started': {
          endThinking();
          drainBuffer(true);
          // The COMMAND, not the model's prose about it — see toolLabel.ts.
          const target = clip(toolTarget(event.input, event.description), TARGET_MAX);
          toolStarts.current.set(event.id, { tool: event.tool, target });
          // Only the newest call owns the live tail; a nested/parallel call
          // that streams later simply takes it over.
          tailId.current = event.id;
          toolOutput.current.set(event.id, '');
          setTail([]);
          setActivity({ label: event.tool.toLowerCase(), detail: target });
          break;
        }

        // A running command's own stdout/stderr. Buffered per call and painted
        // on the same frame timer as prose — bash.ts already batches these to
        // ~4/sec, but a parallel build plus a stream must still not outpace the
        // terminal.
        case 'tool_output_delta': {
          const prev = toolOutput.current.get(event.id);
          if (prev === undefined) break; // its call already finished
          const next = prev + event.text;
          toolOutput.current.set(event.id, next.length > OUTPUT_CAP ? next.slice(-OUTPUT_CAP) : next);
          if (event.id === tailId.current) {
            tailDirty.current = true;
            schedulePaint();
          }
          break;
        }

        case 'tool_call_finished': {
          const started = toolStarts.current.get(event.id);
          toolStarts.current.delete(event.id);
          commit({
            kind: 'tool',
            verb: (event.subagent ? '·' : '') + event.tool.toLowerCase(),
            target: started?.target ?? '',
            metric: clip(event.resultPreview, METRIC_MAX) || (event.isError ? 'error' : 'ok'),
            status: event.isError ? 'fail' : 'ok',
          });
          // Whatever the command actually said, kept under its row. Tools that
          // never stream (Read, Grep, Edit) collected nothing, so they add
          // nothing — this only fires for shell and workflow work.
          const output = toolOutput.current.get(event.id) ?? '';
          toolOutput.current.delete(event.id);
          if (event.id === tailId.current) {
            tailId.current = null;
            tailDirty.current = false;
            setTail([]);
          }
          const rows = lastLines(output, COMMIT_ROWS);
          if (rows.length > 0) {
            const total = countLines(output);
            if (total > rows.length) {
              commit({ kind: 'output', text: `… ${total - rows.length} earlier lines`, dim: true });
            }
            for (const row of rows) commit({ kind: 'output', text: row });
          }
          break;
        }

        case 'agent_spawned':
          endThinking();
          drainBuffer(true);
          commit({ kind: 'agent', text: clip(event.agentDesc, TARGET_MAX), status: 'ok' });
          break;

        case 'agent_finished':
          if (event.isError) commit({ kind: 'agent', text: 'agent ended in error', status: 'fail' });
          break;

        case 'permission_request': {
          endThinking();
          drainBuffer(true);
          const next: PendingPrompt = {
            kind: 'permission',
            id: event.id,
            tool: event.tool,
            description: event.description,
            subject: event.subject,
            grant: event.grant,
          };
          setPrompt(next);
          promptRef.current = next;
          break;
        }

        case 'question_request': {
          endThinking();
          drainBuffer(true);
          const next: PendingPrompt = {
            kind: 'question',
            id: event.id,
            questions: event.questions,
            index: 0,
            picked: event.questions.map(() => []),
          };
          setPrompt(next);
          promptRef.current = next;
          break;
        }

        case 'task_list_updated':
          setTasks(event.tasks);
          break;

        // Work that runs OUTSIDE a turn: turn_started never fires for it, so
        // ignoring this event made /compact and every backgrounded command look
        // like the session had simply stopped responding.
        case 'background_notification': {
          const description = event.payload?.description ?? event.taskId;
          if (event.kind === 'start') {
            setJobs((js) =>
              js.some((j) => j.taskId === event.taskId) ? js : [...js, { taskId: event.taskId, description }],
            );
            commit({ kind: 'notice', text: `⟳ ${description} — started` });
          } else if (event.kind === 'exit') {
            setJobs((js) => js.filter((j) => j.taskId !== event.taskId));
            const code = event.payload?.code;
            const how = event.payload?.stopped
              ? 'stopped'
              : typeof code === 'number' && code !== 0
                ? `exit ${code}`
                : 'done';
            commit({ kind: 'notice', text: `⟳ ${description} — ${how}` });
          }
          break;
        }

        // A just-installed addon must be invocable immediately: the event
        // carries the refreshed registry, and the engine is the only party
        // allowed to derive `/<name>` entries — adopting it wholesale is the
        // whole contract.
        case 'addons_updated':
          if (event.commands) setCommands(event.commands);
          noticeBlock(
            `addons: ${event.addons.map((a) => `${a.name}${a.builtin ? ' (builtin)' : ''}`).join(', ') || '(none)'}`,
          );
          break;

        case 'context_update':
          setMeters((m) => ({
            context: event.contextTokens,
            output: event.outputTokens ?? m.output,
            warn: event.contextWarn ?? m.warn,
          }));
          break;

        case 'retry_status':
          setActivity({
            label: `retry #${event.attempt}`,
            detail: `in ${Math.round(event.delayMs / 1000)}s — ${event.reason}`,
          });
          break;

        case 'turn_finished':
          endThinking();
          drainBuffer(true);
          if (event.stopReason === 'aborted') {
            commit({ kind: 'interrupted' });
          } else {
            commit({
              kind: 'done',
              stopReason: event.stopReason,
              outputTokens: event.usage.outputTokens,
              contextTokens: event.contextTokens,
            });
          }
          commit({ kind: 'blank' });
          setMeters((m) => ({
            context: event.contextTokens,
            output: event.usage.outputTokens,
            warn: event.contextWarn ?? m.warn,
          }));
          flushLines();
          setBusy(false);
          setActivity(IDLE_ACTIVITY);
          break;

        case 'command_output':
          noticeBlock(event.text);
          break;

        case 'session_report':
          noticeBlock(event.text);
          break;

        case 'session_list':
          // ONLY the picker consumes this. `/sessions` makes the engine emit a
          // session_list AND a command_output listing the same sessions, so
          // rendering both printed the roster twice.
          if (resumePending.current === true) {
            resumePending.current = undefined;
            if (event.sessions.length > 0) setSessionPicker(event.sessions);
            else noticeBlock('no saved sessions in this workspace');
          }
          break;

        case 'overdrive_changed':
          setOverdrive(event.enabled);
          overdriveRef.current = event.enabled;
          if (event.enabled && overdriveIsDefault.current) {
            overdriveIsDefault.current = false;
            noticeBlock('OVERDRIVE is ON — the default for a trusted folder. /overdrive off to disable.');
          } else {
            noticeBlock(`OVERDRIVE ${event.enabled ? 'ON — nothing asks' : 'off'}`);
          }
          break;

        case 'model_catalog':
          setModels(event.models);
          break;

        case 'session_restored': {
          for (const msg of event.messages) {
            if (msg.role === 'user') {
              commit({ kind: 'user', text: msg.text });
              commit({ kind: 'blank' });
            } else {
              if (msg.thinking) commit({ kind: 'reasoning', ms: 0 });
              let lead = true;
              for (const line of msg.text.split('\n')) {
                if (!line.trim()) commit({ kind: 'blank' });
                else {
                  commit({ kind: 'prose', text: line, lead });
                  lead = false;
                }
              }
              for (const call of msg.toolCalls ?? []) {
                commit({
                  kind: 'tool',
                  verb: call.tool.toLowerCase(),
                  target: '',
                  metric: clip(call.result, METRIC_MAX),
                  status: call.isError ? 'fail' : 'ok',
                });
              }
              commit({ kind: 'blank' });
            }
          }
          break;
        }

        case 'cwd_changed':
          noticeBlock(`cwd → ${event.cwd}${event.worktree ? ' (worktree)' : ''}`);
          break;

        case 'error':
          commit({ kind: 'error', text: event.message });
          if (event.fatal) setFatal(event.message);
          break;

        default:
          // Newer or uninteresting event types: tolerated, never crashed on.
          break;
      }
    },
    [commit, drainBuffer, endThinking, flushLines, noticeBlock, resetLines, schedulePaint, setActivity],
  );

  const [picker, setPicker] = useState<Profile[] | null>(null);
  const [trustGate, setTrustGate] = useState<string | null>(null);
  const spawnRef = useRef<EngineSpawn | null>(null);
  const workspaceRef = useRef(workspace);

  const boot = useCallback(() => {
    if (host.current || spawnRef.current === null) return;
    const h = startHost(spawnRef.current, workspaceRef.current, {
      onEvent: handleEvent,
      onStderr: (line) => commit({ kind: 'notice', text: line }),
      onExit: (code) => {
        setBusy(false);
        setFatal(`engine exited${code === null ? '' : ` (code ${code})`}`);
      },
    });
    host.current = h;
  }, [commit, handleEvent]);

  /**
   * Everything that must happen before the workspace has credentials in it:
   * the profile picker, or a note that there is nothing to pick. Runs only
   * once trust is settled — writing an API key into `<ws>/.env` is itself an
   * act of trusting the folder.
   */
  const connectThenBoot = useCallback(() => {
    if (!workspaceConnected(workspaceRef.current)) {
      const profiles = readProfiles();
      if (profiles.length > 0) {
        setPicker(profiles);
        return; // boot happens on pick (or skip)
      }
      commit({
        kind: 'notice',
        text: `no credentials in this folder and no saved profiles (${profilesPath()})`,
      });
    }
    boot();
  }, [boot, commit]);

  // Resolve the engine spawn once. Packaged: the sibling engine.cjs through
  // Electron-as-Node; dev: the ~/.magentra-tui.json checkout (whose actionable
  // error text lands as the fatal banner).
  useEffect(() => {
    try {
      spawnRef.current = resolveEngineSpawn(workspaceRef.current);
    } catch (err) {
      setFatal(err instanceof Error ? err.message : String(err));
      return;
    }

    if (!isTrusted(workspaceRef.current)) {
      setTrustGate(workspaceRef.current);
      return; // nothing spawns, nothing is written, until this is answered
    }

    connectThenBoot();
    // The host is torn down explicitly on ctrl+c / /exit; this covers an
    // unmount from any other cause.
    return () => host.current?.kill();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = useCallback((request: FrontendRequest) => {
    host.current?.send(request);
  }, []);

  /** Send whatever answers the round collected and clear the prompt. */
  const settleQuestions = useCallback(
    (p: Extract<PendingPrompt, { kind: 'question' }>) => {
      const answers: Record<string, string[]> = {};
      p.questions.forEach((_, i) => (answers[`q:${i}`] = p.picked[i] ?? []));
      setPrompt(null);
      promptRef.current = null;
      send({ type: 'question_response', id: p.id, answers });
    },
    [send],
  );

  return {
    lines,
    liveText,
    liveLead,
    busy,
    startedAt,
    activity,
    meters,
    model,
    models,
    overdrive,
    commands,
    tasks,
    tail,
    jobs,
    prompt,
    fatal,
    trustGate,

    acceptTrust: useCallback(() => {
      try {
        trustFolder(workspaceRef.current);
      } catch (err) {
        commit({
          kind: 'error',
          text: `could not record trust: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      setTrustGate(null);
      connectThenBoot();
    }, [commit, connectThenBoot]),

    picker,

    pickProfile: useCallback(
      (index: number) => {
        const profile = picker?.[index];
        if (!profile) return;
        try {
          applyProfile(workspaceRef.current, profile);
        } catch (err) {
          commit({ kind: 'error', text: `could not write connection: ${err instanceof Error ? err.message : String(err)}` });
          return;
        }
        commit({
          kind: 'notice',
          text: `profile "${profile.name}" (${describeProfile(profile)}) → .env + .magentra/settings.json`,
        });
        setPicker(null);
        boot();
      },
      [boot, commit, picker],
    ),

    skipPicker: useCallback(() => {
      setPicker(null);
      boot();
    }, [boot]),

    sessionPicker,

    openSessionPicker: useCallback(() => {
      // Reuses the --resume path end to end: mark the reply as picker data,
      // ask the engine, and session_list opens the picker when it lands.
      resumePending.current = true;
      host.current?.send({ type: 'list_sessions' });
    }, []),

    pickSession: useCallback(
      (index: number) => {
        const s = sessionPicker?.[index];
        if (!s) return;
        setSessionPicker(null);
        host.current?.send({ type: 'resume_session', id: s.id });
      },
      [sessionPicker],
    ),

    skipSessionPicker: useCallback(() => setSessionPicker(null), []),

    sendUser: useCallback(
      (text: string) => {
        commit({ kind: 'user', text });
        commit({ kind: 'blank' });
        setBusy(true);
        setStartedAt(Date.now());
        setActivity({ label: 'thinking', detail: '' });
        send({ type: 'user_message', text });
      },
      [commit, send, setActivity],
    ),

    steer: useCallback(
      (text: string) => {
        commit({ kind: 'blank' });
        commit({ kind: 'steer', text });
        commit({ kind: 'blank' });
        send({ type: 'steer_message', text });
      },
      [commit, send],
    ),

    slash: useCallback(
      (command: string, args?: string) => {
        commit({ kind: 'user', text: `/${command}${args ? ` ${args}` : ''}` });
        send({ type: 'slash_command', command, args });
      },
      [commit, send],
    ),

    bang: useCallback(
      (cmd: string) => {
        commit({ kind: 'user', text: `! ${cmd}` });
        send({ type: 'bang_command', cmd });
      },
      [commit, send],
    ),

    interrupt: useCallback(() => send({ type: 'interrupt' }), [send]),

    setModel: useCallback(
      (m: string) => {
        setModelState(m);
        send({ type: 'set_model', model: m });
        noticeBlock(`model → ${m} (takes effect next turn)`);
      },
      [noticeBlock, send],
    ),

    toggleOverdrive: useCallback(() => {
      send({ type: 'set_overdrive', enabled: !overdriveRef.current });
    }, [send]),

    echo: useCallback((text: string) => commit({ kind: 'user', text }), [commit]),

    printNotice: useCallback((text: string) => noticeBlock(text), [noticeBlock]),

    answerPermission: useCallback(
      (decision: PermissionDecision) => {
        const p = promptRef.current;
        if (!p || p.kind !== 'permission') return;
        setPrompt(null);
        promptRef.current = null;
        commit({
          kind: 'notice',
          text: `${p.tool}: ${decision.replace(/_/g, ' ')}`,
        });
        send({ type: 'permission_response', id: p.id, decision });
      },
      [commit, send],
    ),

    pickOption: useCallback(
      (index: number) => {
        const p = promptRef.current;
        if (!p || p.kind !== 'question') return;
        const q = p.questions[p.index]!;
        if (index < 0 || index >= q.options.length) return;
        const label = q.options[index]!.label;

        if (q.multiSelect) {
          const picks = p.picked[p.index]!;
          p.picked[p.index] = picks.includes(label) ? picks.filter((l) => l !== label) : [...picks, label];
          setPrompt({ ...p, picked: [...p.picked] });
          promptRef.current = { ...p };
          return;
        }

        p.picked[p.index] = [label];
        commit({ kind: 'notice', text: `${q.header}: ${label}` });
        if (p.index + 1 < p.questions.length) {
          const next = { ...p, index: p.index + 1 };
          setPrompt(next);
          promptRef.current = next;
        } else {
          settleQuestions(p);
        }
      },
      [commit, settleQuestions],
    ),

    confirmQuestion: useCallback(() => {
      const p = promptRef.current;
      if (!p || p.kind !== 'question') return;
      const q = p.questions[p.index]!;
      if (!q.multiSelect) return;
      commit({ kind: 'notice', text: `${q.header}: ${(p.picked[p.index] ?? []).join(', ') || '(none)'}` });
      if (p.index + 1 < p.questions.length) {
        const next = { ...p, index: p.index + 1 };
        setPrompt(next);
        promptRef.current = next;
      } else {
        settleQuestions(p);
      }
    }, [commit, settleQuestions]),

    // esc on a question card. It used to be wired to confirmQuestion, which
    // returns immediately for a single-select question — so the advertised
    // "esc skips" did nothing at all and the card could not be dismissed. The
    // engine settles a round with whatever it was given and reports the rest
    // as "(no answer)", so answering nothing is a legitimate reply.
    skipQuestions: useCallback(() => {
      const p = promptRef.current;
      if (!p || p.kind !== 'question') return;
      commit({ kind: 'notice', text: 'question skipped' });
      settleQuestions(p);
    }, [commit, settleQuestions]),

    shutdown: useCallback(() => host.current?.kill(), []),
  };
}
