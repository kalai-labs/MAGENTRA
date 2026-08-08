/**
 * The engine connection as React state: spawns MAGENTRA's host, translates
 * CoreEvents into transcript Lines, and exposes the send-side verbs the UI
 * needs. This file is the entire seam between the wire and the components —
 * nothing else in the TUI knows a protocol exists.
 *
 * Translation rules, agreed in the design session:
 *  - text_delta streams live; a Line commits to scrollback at each newline.
 *  - thinking_delta content is never shown; a finished thinking block commits
 *    one `◌ reasoning` row with its real duration.
 *  - tool calls commit one rail row when they FINISH (started only drives the
 *    activity label), so every committed line is final — <Static> stays honest.
 *  - token meters render engine figures verbatim; no TUI-side arithmetic.
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

export type Engine = {
  lines: Line[];
  /** The in-flight prose line, streaming in the live region. */
  liveText: string;
  /** True while the streaming line is the turn's first spoken line. */
  liveLead: boolean;
  busy: boolean;
  activity: string;
  meters: Meters;
  model: string;
  models: string[];
  overdrive: boolean;
  commands: SlashCommandInfo[];
  /** The session task list, verbatim from task_list_updated. */
  tasks: TaskItem[];
  prompt: PendingPrompt | null;
  /** Set when the session cannot continue (fatal error / engine exit). */
  fatal: string | null;
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
  clearLocal(): void;
  /** Echo a user-typed command into the transcript without sending a frame. */
  echo(text: string): void;
  /** Commit a local notice block (e.g. the /model catalog). */
  printNotice(text: string): void;
  answerPermission(decision: PermissionDecision): void;
  /** Toggle an option on the current question (multiSelect) or answer it (single). */
  pickOption(index: number): void;
  /** Confirm a multiSelect question's picks and advance. */
  confirmQuestion(): void;
  shutdown(): void;
};

const TARGET_MAX = 46;
const METRIC_MAX = 34;

function clip(text: string, max: number): string {
  const one = text.split('\n')[0]!.trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
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
  const [activity, setActivity] = useState('working');
  const [meters, setMeters] = useState<Meters>({ context: 0, output: 0, warn: false });
  const [model, setModelState] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [overdrive, setOverdrive] = useState(false);
  const [commands, setCommands] = useState<SlashCommandInfo[]>([]);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
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
  const promptRef = useRef<PendingPrompt | null>(null);

  const commit = useCallback((line: LineBody) => {
    // Never two blanks in a row — same rule the fake scheduler enforced.
    if (line.kind === 'blank' && lastKind.current === 'blank') return;
    lastKind.current = line.kind;
    setLines((prev) => [...prev, { ...line, id: nextId.current++ } as Line]);
  }, []);

  /** Commit every complete line in the buffer; the remainder keeps streaming. */
  const drainBuffer = useCallback(
    (flushAll: boolean) => {
      const commitProse = (raw: string) => {
        const text = raw.trimEnd();
        if (text.length === 0) {
          commit({ kind: 'blank' });
          return;
        }
        const isFenceLine = /^```/.test(text.trim());
        // Fence contents are marked at commit time — the delimiter line itself
        // is not code, and toggles the state for the lines that follow it.
        const code = fence.current && !isFenceLine;
        if (isFenceLine) fence.current = !fence.current;
        // Code lines never carry the ◆ marker and never consume the lead — the
        // speaker mark belongs to speech, not to a listing.
        if (code || isFenceLine) {
          commit({ kind: 'prose', text, lead: false, code });
        } else {
          commit({ kind: 'prose', text, lead: !spoke.current });
          spoke.current = true;
        }
      };

      let buf = textBuffer.current;
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        commitProse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
      if (flushAll && buf.trim().length > 0) {
        commitProse(buf);
        buf = '';
      }
      textBuffer.current = buf;
      setLiveText(buf.trimStart());
      setLiveLead(!spoke.current);
    },
    [commit],
  );

  /** A thinking block just ended (something else arrived): commit its row. */
  const endThinking = useCallback(() => {
    if (thinkingSince.current === null) return;
    const ms = Date.now() - thinkingSince.current;
    thinkingSince.current = null;
    commit({ kind: 'reasoning', ms });
    commit({ kind: 'blank' });
  }, [commit]);

  const noticeBlock = useCallback(
    (text: string) => {
      commit({ kind: 'blank' });
      for (const line of text.split('\n')) commit({ kind: 'notice', text: line ? `  ${line}` : ' ' });
      commit({ kind: 'blank' });
    },
    [commit],
  );

  const handleEvent = useCallback(
    (event: CoreEvent) => {
      switch (event.type) {
        case 'session_started': {
          // Fresh session (boot, /clear, resume): repaint from zero.
          setLines([]);
          lastKind.current = null;
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
          }
          break;
        }

        case 'turn_started':
          setBusy(true);
          setActivity('working');
          spoke.current = false;
          fence.current = false; // an unclosed fence must not bleed across turns
          setLiveLead(true);
          setMeters((m) => ({ ...m, output: 0 }));
          break;

        case 'text_delta':
          endThinking();
          textBuffer.current += event.text;
          drainBuffer(false);
          setActivity('responding');
          break;

        case 'thinking_delta':
          if (thinkingSince.current === null) {
            drainBuffer(true);
            thinkingSince.current = Date.now();
          }
          setActivity('thinking');
          break;

        case 'tool_call_started': {
          endThinking();
          drainBuffer(true);
          const target = clip(event.description ?? '', TARGET_MAX) || event.tool;
          toolStarts.current.set(event.id, { tool: event.tool, target });
          setActivity(`${event.tool.toLowerCase()} · ${target}`);
          break;
        }

        case 'tool_call_finished': {
          const started = toolStarts.current.get(event.id);
          toolStarts.current.delete(event.id);
          commit({
            kind: 'tool',
            verb: (event.subagent ? '·' : '') + event.tool.toLowerCase(),
            target: started?.target ?? event.tool,
            metric: clip(event.resultPreview, METRIC_MAX) || (event.isError ? 'error' : 'ok'),
            status: event.isError ? 'fail' : 'ok',
          });
          break;
        }

        case 'agent_spawned':
          endThinking();
          drainBuffer(true);
          commit({ kind: 'agent', text: clip(event.agentDesc, TARGET_MAX + 16), status: 'ok' });
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
          setActivity(`retry #${event.attempt} in ${Math.round(event.delayMs / 1000)}s — ${event.reason}`);
          break;

        case 'turn_finished':
          endThinking();
          drainBuffer(true);
          commit({ kind: 'blank' });
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
          setBusy(false);
          setActivity('working');
          break;

        case 'command_output':
          noticeBlock(event.text);
          break;

        case 'session_report':
          noticeBlock(event.text);
          break;

        case 'session_list':
          if (resumePending.current === true) {
            // The --resume picker's data arrived.
            resumePending.current = undefined;
            if (event.sessions.length > 0) setSessionPicker(event.sessions);
            else noticeBlock('no saved sessions in this workspace');
          } else {
            // Ordinary /sessions output.
            noticeBlock(
              event.sessions
                .map((s) => `${s.id}  ${s.label ?? s.firstUserMessage ?? '(empty)'}${s.model ? ` · ${s.model}` : ''}`)
                .join('\n') || 'no saved sessions in this workspace',
            );
          }
          break;

        case 'overdrive_changed':
          setOverdrive(event.enabled);
          overdriveRef.current = event.enabled;
          noticeBlock(`OVERDRIVE ${event.enabled ? 'ON — nothing asks' : 'off'}`);
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
    [commit, drainBuffer, endThinking, noticeBlock],
  );

  const [picker, setPicker] = useState<Profile[] | null>(null);
  const spawnRef = useRef<EngineSpawn | null>(null);
  const workspaceRef = useRef(workspace);

  const boot = useCallback(() => {
    if (host.current || spawnRef.current === null) return;
    const h = startHost(spawnRef.current, workspaceRef.current, {
      onEvent: handleEvent,
      onStderr: (line) => commit({ kind: 'notice', text: `  ${line}` }),
      onExit: (code) => {
        setBusy(false);
        setFatal(`engine exited${code === null ? '' : ` (code ${code})`}`);
      },
    });
    host.current = h;
  }, [commit, handleEvent]);

  // Resolve the engine spawn once. Packaged: the sibling engine.cjs through
  // Electron-as-Node; dev: the ~/.magentra-tui.json checkout (whose actionable
  // error text lands as the fatal banner). When the workspace has no
  // credentials and saved profiles exist, hold the spawn and offer the picker
  // instead — a new folder becomes usable by choosing a profile, exactly as
  // the IDE's "apply a profile" would have connected it.
  useEffect(() => {
    try {
      spawnRef.current = resolveEngineSpawn(workspaceRef.current);
    } catch (err) {
      setFatal(err instanceof Error ? err.message : String(err));
      return;
    }

    if (!workspaceConnected(workspaceRef.current)) {
      const profiles = readProfiles();
      if (profiles.length > 0) {
        setPicker(profiles);
        return; // boot happens on pick (or skip)
      }
      commit({
        kind: 'notice',
        text: `  no credentials in this folder and no saved profiles (${profilesPath()})`,
      });
    }

    boot();
    return () => host.current?.kill();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = useCallback((request: FrontendRequest) => {
    host.current?.send(request);
  }, []);

  return {
    lines,
    liveText,
    liveLead,
    busy,
    activity,
    meters,
    model,
    models,
    overdrive,
    commands,
    tasks,
    prompt,
    fatal,
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
          text: `  profile "${profile.name}" (${describeProfile(profile)}) → .env + .magentra/settings.json`,
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
        setActivity('working');
        send({ type: 'user_message', text });
      },
      [commit, send],
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

    clearLocal: useCallback(() => {
      setLines([]);
      lastKind.current = null;
    }, []),

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
          text: `  ${p.tool}: ${decision.replace('_', ' ')}`,
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
        commit({ kind: 'notice', text: `  ${q.header}: ${label}` });
        if (p.index + 1 < p.questions.length) {
          const next = { ...p, index: p.index + 1 };
          setPrompt(next);
          promptRef.current = next;
        } else {
          const answers: Record<string, string[]> = {};
          p.questions.forEach((_, i) => (answers[`q:${i}`] = p.picked[i] ?? []));
          setPrompt(null);
          promptRef.current = null;
          send({ type: 'question_response', id: p.id, answers });
        }
      },
      [commit, send],
    ),

    confirmQuestion: useCallback(() => {
      const p = promptRef.current;
      if (!p || p.kind !== 'question') return;
      const q = p.questions[p.index]!;
      if (!q.multiSelect) return;
      commit({ kind: 'notice', text: `  ${q.header}: ${(p.picked[p.index] ?? []).join(', ') || '(none)'}` });
      if (p.index + 1 < p.questions.length) {
        const next = { ...p, index: p.index + 1 };
        setPrompt(next);
        promptRef.current = next;
      } else {
        const answers: Record<string, string[]> = {};
        p.questions.forEach((_, i) => (answers[`q:${i}`] = p.picked[i] ?? []));
        setPrompt(null);
        promptRef.current = null;
        send({ type: 'question_response', id: p.id, answers });
      }
    }, [commit, send]),

    shutdown: useCallback(() => host.current?.kill(), []),
  };
}
