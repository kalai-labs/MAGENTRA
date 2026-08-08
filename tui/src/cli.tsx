#!/usr/bin/env node
/**
 * Entry point — `magentra [path] [--resume [id]] [--gui]`.
 *
 * The workspace is the positional path if given, else where you launched from
 * (INIT_CWD survives npm's chdir in dev). The engine's location resolves in
 * config.ts: packaged = the sibling engine.cjs, dev = ~/.magentra-tui.json.
 *
 * GUI handoff: the OS launchers (linux/mac sh wrappers) test for a TTY before
 * Node ever starts, but the Windows cmd shim cannot — so the packaged TUI
 * itself is the universal fallback: `--gui` or no interactive TTY hands over
 * to the desktop app and exits. Under ELECTRON_RUN_AS_NODE, process.execPath
 * IS the GUI binary; on linux we prefer the sibling `magentra` wrapper so its
 * sandbox detection still runs (loop-safe: that re-entry has no TTY, so the
 * wrapper routes it straight to the GUI branch).
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { render } from 'ink';
import { App } from './app.js';
import { isPackagedRun } from './config.js';

function parseResume(argv: string[]): string | true | undefined {
  const i = argv.indexOf('--resume');
  if (i === -1) return undefined;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}

const argv = process.argv.slice(2);
const resume = parseResume(argv);
const wantsGui = argv.includes('--gui');
const positional = argv.filter((a, i) => !a.startsWith('-') && argv[i - 1] !== '--resume');

const workspace = positional[0] ? resolve(positional[0]) : (process.env.INIT_CWD ?? process.cwd());

if (positional[0] && !existsSync(workspace)) {
  console.error(`magentra: no such directory: ${workspace}`);
  process.exit(1);
}

const hasTty = process.stdin.isTTY === true && process.stdout.isTTY === true;

if (isPackagedRun() && (wantsGui || !hasTty)) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const wrapper = join(dirname(process.execPath), 'magentra');
  const gui = process.platform === 'linux' && existsSync(wrapper) ? wrapper : process.execPath;
  spawn(gui, [], { detached: true, stdio: 'ignore', env }).unref();
  process.exit(0);
}

const { waitUntilExit } = render(<App resume={resume} workspace={workspace} />, {
  exitOnCtrlC: false,
});

await waitUntilExit();
