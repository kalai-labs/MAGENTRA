"use strict";
// Stub for react-devtools-core inside the bundled terminal UI (tui.mjs).
//
// ink's reconciler gates devtools behind `process.env['DEV'] === 'true'`, but
// the BRACKET access dodges esbuild's `define` fold of process.env.DEV, so the
// devtools module still enters the bundle — and its STATIC import of
// react-devtools-core (an optional peer that is never installed) would become
// an eager top-level external that crashes ESM linking on every launch.
// Aliasing it to this no-op keeps the bundle self-contained; connectToDevTools
// is the only member ink touches, and only when DEV=true, which a shipped
// build never sets. Same pattern as ripgrep-shim.cjs next door.
module.exports = { connectToDevTools() {} };
module.exports.default = module.exports;
