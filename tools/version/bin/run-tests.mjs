#!/usr/bin/env node
// @ts-check
/**
 * Run the tests of the version tool.
 *
 * This script finds the test files, and gives their exact paths to the test
 * runner of Node.js.
 *
 * A script is necessary because a pattern is not portable:
 *
 *   node --test "test/*.test.mjs"   Node.js 22 and newer only. Node.js 20 does
 *                                   not expand a pattern.
 *   node --test test/*.test.mjs     A Unix shell expands the pattern, but the
 *                                   command shell of Windows does not.
 *   node --test test/               Node.js 22 and newer read this as a file,
 *                                   and not as a directory.
 *
 * An exact path works with every version of Node.js, and on every system.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const directory = join(here, '..', 'test');

const files = readdirSync(directory)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => join(directory, name));

if (files.length === 0) {
  console.error(`No test file is in ${directory}`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], {
  stdio: 'inherit',
});

process.exit(result.status ?? 1);
