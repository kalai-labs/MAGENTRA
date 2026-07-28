"use strict";

const assert = require("node:assert/strict");
const { shouldStartFullScreen } = require("../main/config.js");

assert.equal(shouldStartFullScreen(undefined), true, "a fresh install starts full screen");
assert.equal(shouldStartFullScreen(null), true, "a missing window record starts full screen");
assert.equal(shouldStartFullScreen({ maximized: true }), true, "a saved maximized window still starts full screen");
assert.equal(shouldStartFullScreen({ maximized: false }), true, "every launch opens full screen by default");

process.stdout.write("✓ every launch opens full screen; saved bounds only shape the restored size\n");
