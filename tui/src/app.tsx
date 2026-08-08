/**
 * Root component — a pure MAGENTRA protocol client.
 *
 * Layout is deliberately two-part:
 *
 *   <Static>      committed transcript, printed once and then owned by the
 *                 terminal. Wheel, Shift+PageUp and terminal search operate on
 *                 real scrollback, and quitting leaves the session readable.
 *
 *   live region   streaming prose line + activity + blocking prompt + composer.
 *                 The only thing that repaints.
 *
 * All intelligence is the engine's. The TUI translates events into lines,
 * forwards input as frames, and renders the engine's own token figures — it
 * computes nothing itself.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Static, Text, useApp, useInput, useStdin, useStdout } from 'ink';
import { Activity } from './components/Activity.js';
import { CommandPalette } from './components/CommandPalette.js';
import { Composer } from './components/Composer.js';
import { LiveLine } from './components/LiveLine.js';
import { ProfilePicker } from './components/ProfilePicker.js';
import { Prompt } from './components/Prompt.js';
import { SessionPicker } from './components/SessionPicker.js';
import { TaskStrip } from './components/TaskStrip.js';
import { TranscriptLine } from './components/TranscriptLine.js';
import { useEngine } from './engine/useEngine.js';
import { theme } from './theme.js';
import type { SlashCommandInfo } from './protocol.js';

/** The only commands the TUI dispatches itself; everything else is the engine's. */
const LOCAL_COMMANDS: SlashCommandInfo[] = [
  { cmd: '/model', args: '[n|id]', desc: 'list the endpoint models, or switch live (set_model)' },
  { cmd: '/exit', args: '', desc: 'quit the tui' },
];

export function App({ resume, workspace }: { resume?: string | true; workspace: string }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  // Ink tests `isActive === false` strictly, so this must be a real boolean.
  const interactive = useStdin().isRawModeSupported === true;
  const engine = useEngine(resume, workspace);

  const [value, setValue] = useState('');
  const [cursor, setCursor] = useState(0);
  const [width, setWidth] = useState(stdout?.columns ?? 80);
  const [elapsed, setElapsed] = useState(0);

  // Highlight index shared by whichever chooser is active (profile picker,
  // permission card, question card). Arrows move it, ↵ selects it; number keys
  // keep working as before. Reset when the ACTIVE CHOOSER changes — keyed by
  // kind/id/question-index, NOT object identity, because a multiSelect toggle
  // recreates the prompt object and must not yank the highlight back to 0.
  const [sel, setSel] = useState(0);
  const chooserKey = engine.picker
    ? 'picker'
    : engine.sessionPicker
      ? 'sessions'
      : engine.prompt
        ? `${engine.prompt.kind}:${engine.prompt.id}:${engine.prompt.kind === 'question' ? engine.prompt.index : 0}`
        : 'none';
  useEffect(() => setSel(0), [chooserKey]);

  // The slash palette has two modes, following the protocol doc's own rule for
  // SlashCommandInfo: at the START of a message `/name` really is dispatched,
  // so the full registry shows and ↵ runs the selection. MID-SENTENCE the user
  // is NAMING something ("use /magentron here"), so only addons are offered
  // and ↵/tab merely insert the name — /clear in the middle of a paragraph is
  // noise, since nothing there will run.
  const [palSel, setPalSel] = useState(0);
  const [palHidden, setPalHidden] = useState(false);
  useEffect(() => {
    setPalSel(0);
    setPalHidden(false);
  }, [value, cursor]);

  const palette = useMemo(() => {
    const none = { mode: 'none' as const, items: [] as SlashCommandInfo[], start: 0 };
    if (palHidden || engine.prompt || engine.picker || engine.fatal) return none;

    // Dispatch position: the whole composer is one leading /token.
    if (/^\/\S*$/.test(value)) {
      const q = value.toLowerCase();
      const merged = [
        ...engine.commands,
        ...LOCAL_COMMANDS.filter((l) => !engine.commands.some((c) => c.cmd === l.cmd)),
      ];
      return { mode: 'dispatch' as const, items: merged.filter((c) => c.cmd.toLowerCase().startsWith(q)).slice(0, 8), start: 0 };
    }

    // Naming position: the word being typed at the cursor starts with '/'.
    const start = value.lastIndexOf(' ', cursor - 1) + 1;
    const token = value.slice(start, cursor);
    if (start > 0 && token.startsWith('/')) {
      const q = token.toLowerCase();
      return {
        mode: 'name' as const,
        items: engine.commands.filter((c) => c.addon === true && c.cmd.toLowerCase().startsWith(q)).slice(0, 8),
        start,
      };
    }
    return none;
  }, [value, cursor, palHidden, engine.commands, engine.prompt, engine.picker, engine.fatal]);
  const paletteItems = palette.items;

  // Recall of previously submitted input, via up/down arrows.
  const [past, setPast] = useState<string[]>([]);
  const [recall, setRecall] = useState<number | null>(null);

  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setWidth(stdout.columns);
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  // Elapsed ticker for the activity line; only runs while a turn is in flight.
  useEffect(() => {
    if (!engine.busy) {
      setElapsed(0);
      return;
    }
    const started = Date.now();
    const id = setInterval(() => setElapsed(Date.now() - started), 100);
    return () => clearInterval(id);
  }, [engine.busy]);

  // Without a tty there is no way to type; say so and leave.
  useEffect(() => {
    if (!interactive) {
      const t = setTimeout(() => {
        engine.shutdown();
        exit();
      }, 100);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interactive]);

  const reset = useCallback(() => {
    setValue('');
    setCursor(0);
    setRecall(null);
  }, []);

  const submit = useCallback((override?: string) => {
    const text = (override ?? value).trim();
    if (!text) return;
    setPast((p) => [...p, text]);
    reset();

    // Bang: shell passthrough, engine-side.
    if (text.startsWith('!')) {
      engine.bang(text.slice(1).trim());
      return;
    }

    if (text.startsWith('/')) {
      const [head, ...rest] = text.slice(1).split(/\s+/);
      const cmd = (head ?? '').toLowerCase();
      const args = rest.join(' ');

      // /model is the one command the TUI owns: the picker reads model_catalog,
      // the switch is the set_model frame. Everything else forwards.
      if (cmd === 'model') {
        engine.echo(text);
        if (!args) {
          const catalog = engine.models.length
            ? engine.models
                .map((m, i) => `${String(i + 1).padStart(3)}  ${m}${m === engine.model ? '  ←' : ''}`)
                .join('\n')
            : '(no model_catalog from this endpoint — pass an id: /model <id>)';
          engine.printNotice(
            `current: ${engine.model}\n${catalog}` +
              (engine.models.length ? '\nswitch with /model <n> or /model <id>' : ''),
          );
          return;
        }
        const byIndex = /^\d+$/.test(args) ? engine.models[Number(args) - 1] : undefined;
        engine.setModel(byIndex ?? args);
        return;
      }

      if (cmd === 'overdrive' && !args) {
        engine.toggleOverdrive();
        return;
      }

      if (cmd === 'clear') {
        // Local repaint happens when the engine's fresh session_started lands.
        engine.slash('clear');
        return;
      }

      // Bare /resume opens the session picker — nobody knows transcript ids by
      // heart. With an id it forwards to the engine like any other command.
      if (cmd === 'resume' && !args) {
        engine.echo(text);
        engine.openSessionPicker();
        return;
      }

      if (cmd === 'exit' || cmd === 'quit') {
        engine.shutdown();
        exit();
        return;
      }

      // Everything else — /help /session /compact /tasks /addons /settings
      // /resume /sessions and any installed addon — is the engine's.
      engine.slash(cmd, args || undefined);
      return;
    }

    if (engine.busy) engine.steer(text);
    else engine.sendUser(text);
  }, [value, engine, exit, reset]);

  useInput(
    (input, key) => {
      if (key.ctrl && input === 'c') {
        engine.shutdown();
        exit();
        return;
      }

      // The startup profile picker owns the keyboard until resolved.
      // Vertical list: ↑/↓ move, ↵ selects, numbers jump straight there.
      if (engine.picker) {
        const count = Math.min(engine.picker.length, 9);
        if (key.escape) {
          engine.skipPicker();
          return;
        }
        if (key.upArrow) {
          setSel((s) => (s + count - 1) % count);
          return;
        }
        if (key.downArrow) {
          setSel((s) => (s + 1) % count);
          return;
        }
        if (key.return) {
          engine.pickProfile(Math.min(sel, count - 1));
          return;
        }
        if (/^[1-9]$/.test(input)) engine.pickProfile(Number(input) - 1);
        return;
      }

      // The --resume session picker. Vertical: ↑/↓ move, ↵ resumes, esc = fresh.
      if (engine.sessionPicker) {
        const count = Math.min(engine.sessionPicker.length, 9);
        if (key.escape) {
          engine.skipSessionPicker();
          return;
        }
        if (key.upArrow) {
          setSel((s) => (s + count - 1) % count);
          return;
        }
        if (key.downArrow) {
          setSel((s) => (s + 1) % count);
          return;
        }
        if (key.return) {
          engine.pickSession(Math.min(sel, count - 1));
          return;
        }
        if (/^[1-9]$/.test(input)) engine.pickSession(Number(input) - 1);
        return;
      }

      // A blocking prompt owns the keyboard until answered.
      if (engine.prompt) {
        if (engine.prompt.kind === 'permission') {
          // Horizontal row of decisions: ←/→ move, ↵ selects.
          const hasAlways = Boolean(engine.prompt.subject);
          const decisions = hasAlways
            ? (['allow_once', 'allow_session', 'allow_always', 'deny'] as const)
            : (['allow_once', 'allow_session', 'deny'] as const);
          if (key.escape) {
            engine.answerPermission('deny');
            return;
          }
          if (key.leftArrow) {
            setSel((s) => (s + decisions.length - 1) % decisions.length);
            return;
          }
          if (key.rightArrow) {
            setSel((s) => (s + 1) % decisions.length);
            return;
          }
          if (key.return) {
            engine.answerPermission(decisions[Math.min(sel, decisions.length - 1)]!);
            return;
          }
          if (/^[1-9]$/.test(input)) {
            const n = Number(input);
            if (n >= 1 && n <= decisions.length) engine.answerPermission(decisions[n - 1]!);
          }
          return;
        }

        // Question card — vertical options: ↑/↓ move; single-select answers on
        // ↵; multiSelect toggles on space (or a number) and confirms on ↵.
        const q = engine.prompt.questions[engine.prompt.index]!;
        const count = q.options.length;
        if (key.escape) {
          engine.confirmQuestion();
          return;
        }
        if (key.upArrow) {
          setSel((s) => (s + count - 1) % count);
          return;
        }
        if (key.downArrow) {
          setSel((s) => (s + 1) % count);
          return;
        }
        if (key.return) {
          if (q.multiSelect) engine.confirmQuestion();
          else engine.pickOption(Math.min(sel, count - 1));
          return;
        }
        if (input === ' ' && q.multiSelect) {
          engine.pickOption(Math.min(sel, count - 1));
          return;
        }
        if (/^[1-9]$/.test(input)) engine.pickOption(Number(input) - 1);
        return;
      }

      // The slash palette: navigation keys act on it while it's showing;
      // ordinary typing falls through so filtering keeps working.
      if (paletteItems.length > 0) {
        const count = paletteItems.length;
        const chosen = paletteItems[Math.min(palSel, count - 1)]!;
        if (key.upArrow) {
          setPalSel((s) => (s + count - 1) % count);
          return;
        }
        if (key.downArrow) {
          setPalSel((s) => (s + 1) % count);
          return;
        }
        if (key.tab || (key.return && palette.mode === 'name')) {
          // Complete, never run: at the start this fills the command in (with a
          // space when it takes args); mid-sentence it inserts the addon NAME
          // into the text and typing continues.
          if (palette.mode === 'dispatch') {
            const completed = chosen.cmd + (chosen.args ? ' ' : '');
            setValue(completed);
            setCursor(completed.length);
          } else {
            const next = value.slice(0, palette.start) + chosen.cmd + ' ' + value.slice(cursor);
            setValue(next);
            setCursor(palette.start + chosen.cmd.length + 1);
          }
          return;
        }
        if (key.return) {
          submit(chosen.cmd);
          return;
        }
        if (key.escape) {
          // Dismiss the palette only — an esc aimed at a popup must not clear
          // half-written text or interrupt the turn running behind it.
          setPalHidden(true);
          return;
        }
      }

      if (key.escape) {
        if (engine.busy) engine.interrupt();
        else reset();
        return;
      }

      if (key.return) {
        submit();
        return;
      }

      if (key.leftArrow) {
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.rightArrow) {
        setCursor((c) => Math.min(value.length, c + 1));
        return;
      }

      if (key.upArrow) {
        if (past.length === 0) return;
        const idx = recall === null ? past.length - 1 : Math.max(0, recall - 1);
        setRecall(idx);
        setValue(past[idx]!);
        setCursor(past[idx]!.length);
        return;
      }
      if (key.downArrow) {
        if (recall === null) return;
        const idx = recall + 1;
        if (idx >= past.length) {
          setRecall(null);
          setValue('');
          setCursor(0);
        } else {
          setRecall(idx);
          setValue(past[idx]!);
          setCursor(past[idx]!.length);
        }
        return;
      }

      if (key.backspace || key.delete) {
        if (cursor === 0) return;
        setValue((v) => v.slice(0, cursor - 1) + v.slice(cursor));
        setCursor((c) => c - 1);
        return;
      }

      if (key.tab || key.meta || key.ctrl) return;
      if (!input) return;

      const printable = [...input].filter((ch) => ch >= ' ').join('');
      if (!printable) return;

      setValue((v) => v.slice(0, cursor) + printable + v.slice(cursor));
      setCursor((c) => c + printable.length);
    },
    { isActive: interactive },
  );

  return (
    <Box flexDirection="column">
      <Static items={engine.lines}>{(line) => <TranscriptLine key={line.id} line={line} />}</Static>

      <Box flexDirection="column">
        <LiveLine text={engine.liveText} lead={engine.liveLead} width={width} />
        {engine.busy && !engine.prompt ? (
          <Activity elapsed={elapsed} activity={engine.activity} />
        ) : (
          <Text> </Text>
        )}
        {engine.busy || engine.tasks.some((t) => t.status === 'in_progress') ? (
          <TaskStrip tasks={engine.tasks} />
        ) : null}
        {engine.picker ? <ProfilePicker profiles={engine.picker} selected={sel} /> : null}
        {engine.sessionPicker ? <SessionPicker sessions={engine.sessionPicker} selected={sel} /> : null}
        {engine.prompt ? <Prompt prompt={engine.prompt} selected={sel} /> : null}
        <CommandPalette items={paletteItems} selected={palSel} naming={palette.mode === 'name'} />
        {engine.fatal ? (
          <Box flexDirection="column">
            {engine.fatal.split('\n').map((l, i) => (
              <Text key={i} color={theme.danger}>
                {l}
              </Text>
            ))}
            <Text color={theme.muted}>ctrl+c to exit</Text>
          </Box>
        ) : null}
        {interactive && !engine.fatal && !engine.picker ? (
          <Composer
            value={value}
            cursor={cursor}
            busy={engine.busy}
            width={width}
            model={engine.model}
            meters={engine.meters}
            overdrive={engine.overdrive}
          />
        ) : null}
        {!interactive ? (
          <Text color={theme.muted}>no tty - run in a terminal to type</Text>
        ) : null}
      </Box>
    </Box>
  );
}
