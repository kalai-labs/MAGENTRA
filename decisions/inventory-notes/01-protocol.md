# Area: protocol  (engine/protocol/src — 918 lines, read in full)

PROTOCOL_VERSION = 1. The engine↔frontend contract. `tsc` cannot check the
app side of this seam at all: app/ consumes frames by STRING.

## Capability census

30 CoreEvent types (engine→frontend):
  session_started (carries sessionId, cwd, model, reasoningEffort, overdrive,
    commands registry, rateCard incl. contextWindow per model, addons roster)
  turn_started · turn_finished (usage, contextTokens, overdriveSnapshot, contextWarn)
  text_delta · thinking_delta · tool_output_delta (throttled) · retry_status
  tool_call_started/finished (subagent, agentId, agentDesc)
  agent_spawned (background flag) · agent_finished
  permission_request (subject + grant scope) · question_request
  task_list_updated · file_edited (path + diff) · background_notification
  overdrive_changed · command_output · context_update (B(t), D(t), contextWarn)
  session_report · session_list · session_restored (RestoredMessage paint list)
  model_catalog · cwd_changed (worktree) · error (fatal)
  addon_draft · addon_export · addons_updated (+commands)

24 FrontendRequest types (frontend→engine):
  user_message (+images) · steer_message (+images) · interrupt
  permission_response · question_response
  set_deletion_guard · set_overdrive · set_compact_limit · set_model
  set_connection · set_vision
  slash_command · bang_command
  resume_session · delete_session · rename_session · archive_session
  list_sessions · stop_background
  generate_addon (+connection override) · export_addon · install_addon

## Invariants found in the source

- NDJSON: a malformed line yields an `error` frame instead of throwing, so one
  bad frame cannot kill the transport. Handles CRLF and a trailing unterminated
  line. (ndjson.ts)
- Usage's four classes are DISJOINT and additive. Whole prompt =
  input+cacheRead+cacheWrite. OpenAI-compat reports prompt_tokens as the WHOLE
  prompt with cached_tokens a SUBSET, so the adapter must subtract. Collapsing
  the classes loses the price (each bills differently; cache read ~10x cheaper).
- TOKEN ALGEBRA (tokens.ts) — defined exactly once, whole repo:
    B(t) inputTokensOf() = current context, point-in-time, NEVER accumulates,
         output NOT included
    D(t) deliberation output of the current turn, starts at 0, only grows
    T_turn cumulative billed usage — a COST figure, not a window size
    κ = CHARS_PER_TOKEN = 3.5, deliberately below real English (~4) so
         estimates over-count: compacting early is recoverable, overflow is not
    formatTokens thresholds are set so text never reads backwards across one
         token: 9,949→"9.9k", 9,950→"10k"
    contextPercentOf returns 0 for a non-positive window (never NaN/Infinity)
    freeContextOf clamps at 0; `reserved` is explicit so the reserve is never
         ambiguously inside/outside
- REASONING_EFFORTS = off,minimal,low,medium,high,xhigh,max. One vocabulary for
  every provider; each maps to its own knob and CLAMPS an unavailable level to
  the nearest — a request is never refused over a level, never silently sent
  with the wrong one. Absent = the endpoint's default.
- ConnectionSpec.vision ABSENT MEANS CLEARED (same rule as baseUrl). A
  connection saved with no vision model must leave none behind.
- ConnectionSpec: apiKey "" means a keyless local server (Ollama/LM Studio).
- set_connection carries the key INSIDE `connection` so the app's stdin-log
  redaction covers the frame with no extra rule.
- set_vision is its own frame, not a flag on set_connection, because that frame
  rewrites endpoint+key+env and rebuilds the provider — too much machinery, and
  a credential rewrite, to move one boolean.
- SlashCommandInfo.addon distinguishes addon from built-in: interchangeable at
  the START of a message, NOT mid-sentence (there `/` is naming something).
- question_response answers are keyed positionally ("q:<idx>"), question text
  accepted only as a legacy fallback.
- TaskItem carries blocks/blockedBy — a real dependency graph, not a flat list.
- PermissionDecision allow_always grants ONLY the exact literal subject and
  persists to workspace settings; allow_session grants the whole tool until the
  process exits.
- branding.ts is the single source for PRODUCT_NAME/REPO_URL/CLI_NAME/
  STATE_DIR_NAME (".magentra").

## Candidate features (protocol area)
p-01 NDJSON framing survives malformed frames
p-02 Protocol version handshake
p-03 Token algebra defined once (B/D/T_turn, κ, display rounding, free/percent)
p-04 Usage normalization to four disjoint classes
p-05 Reasoning-effort vocabulary with clamping
p-06 ConnectionSpec absent-means-cleared semantics
p-07 Slash-command registry shipped from engine (palette cannot drift)
p-08 Task dependency graph on the wire (blocks/blockedBy)
p-09 Permission grant scoping (subject vs grant, session vs always)
p-10 Branding constants single-sourced
