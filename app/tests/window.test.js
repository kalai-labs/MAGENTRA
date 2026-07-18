"use strict";

const assert = require("node:assert/strict");
const { shouldStartMaximized } = require("../main/config.js");

assert.equal(shouldStartMaximized(undefined), true, "a fresh install starts maximized");
assert.equal(shouldStartMaximized(null), true, "a missing window record starts maximized");
assert.equal(shouldStartMaximized({ maximized: true }), true, "a maximized window is restored maximized");
assert.equal(shouldStartMaximized({ maximized: false }), false, "a user-restored window stays restored");

process.stdout.write("✓ fresh launches maximize and later user window choices persist\n");
