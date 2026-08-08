/**
 * The engine host connection: spawn MAGENTRA's headless host and speak NDJSON
 * over its stdio, exactly as the desktop app does.
 *
 *   stdout → one CoreEvent JSON object per line
 *   stdin  ← one FrontendRequest JSON object per line
 *
 * Framing mirrors engine/protocol/src/ndjson.ts: split on \n, tolerate a
 * trailing \r, skip blank lines, and never let one unparseable line kill the
 * transport — it surfaces as a non-fatal error event instead.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { CoreEvent, FrontendRequest } from '../protocol.js';
import type { EngineSpawn } from '../config.js';

export type HostHandlers = {
  onEvent: (event: CoreEvent) => void;
  /** Host stderr lines — boot warnings; shown dimly, never fatal by itself. */
  onStderr: (line: string) => void;
  onExit: (code: number | null) => void;
};

export type EngineHost = {
  send: (request: FrontendRequest) => void;
  kill: () => void;
};

export function startHost(spec: EngineSpawn, workspace: string, handlers: HostHandlers): EngineHost {
  // Child cwd = the workspace, matching app/main.js startEngine exactly; the
  // host reads --cwd regardless, but tools that resolve relative to the
  // process dir behave identically to the desktop app this way.
  const child: ChildProcessWithoutNullStreams = spawn(spec.command, spec.args, {
    cwd: workspace,
    env: spec.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      let line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.length === 0) continue;
      try {
        const obj = JSON.parse(line) as unknown;
        if (obj && typeof obj === 'object' && typeof (obj as { type?: unknown }).type === 'string') {
          handlers.onEvent(obj as CoreEvent);
        } else {
          handlers.onEvent({ type: 'error', message: `invalid event frame: ${line.slice(0, 120)}`, fatal: false });
        }
      } catch {
        handlers.onEvent({ type: 'error', message: `unparseable frame: ${line.slice(0, 120)}`, fatal: false });
      }
    }
  });

  let errBuffer = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    errBuffer += chunk;
    let nl: number;
    while ((nl = errBuffer.indexOf('\n')) !== -1) {
      const line = errBuffer.slice(0, nl).trimEnd();
      errBuffer = errBuffer.slice(nl + 1);
      if (line) handlers.onStderr(line);
    }
  });

  child.on('exit', (code) => handlers.onExit(code));
  child.on('error', () => handlers.onExit(null));

  return {
    send(request) {
      child.stdin.write(JSON.stringify(request) + '\n');
    },
    kill() {
      // Closing stdin is the protocol's own shutdown: the host tears down when
      // the pipe ends. The kill is the backstop for a wedged process.
      try {
        child.stdin.end();
      } catch {
        /* already gone */
      }
      setTimeout(() => {
        if (child.exitCode === null) child.kill();
      }, 1500).unref();
    },
  };
}
