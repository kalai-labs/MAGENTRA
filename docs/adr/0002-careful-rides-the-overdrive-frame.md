# CAREFUL rides the OVERDRIVE frames instead of getting its own

> **Superseded — 2026-07-30.** CAREFUL MODE was removed from the product. This record is kept for the reasoning; the code it describes no longer exists.

CAREFUL MODE needed to reach the frontend and back. The symmetric choice was to
mirror OVERDRIVE — a `set_careful` request and a `careful_changed` event, exactly
as `set_overdrive` and `overdrive_changed` already exist. We instead added an
optional `careful` field to those two existing frames.

Two reasons. First, the engine and the app are joined only by bare string
literals over NDJSON: `engine/` is typechecked and `app/` is not, so every new
frame type is a pair of literals that can be renamed on one side while
everything still compiles and every test still passes. Two fewer strings is two
fewer silent breakages. Second, it matches the domain: CAREFUL is a *modifier*
of OVERDRIVE, not a stance beside it. Carrying both states on one frame makes it
structurally impossible for a frontend to hold them out of step.

## Consequences

- `careful` is optional on both frames and absent means **unchanged**, never
  "off". A frontend or engine that predates the field cannot disarm the mode
  just by toggling OVERDRIVE — `tabs.js`'s per-pane OVERDRIVE button relies on
  exactly this, deliberately omitting the field.
- The renderer must therefore test `typeof event.careful === "boolean"` rather
  than reading it truthily, and `applySafetySettings` re-sends the frame when
  *either* value changes.
- The two states are always reported together, so `overdrive_changed` is now the
  single sync point for the whole stance. Anything that changes one and not the
  other still emits both.
