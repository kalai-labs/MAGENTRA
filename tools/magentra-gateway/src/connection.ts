/**
 * Stage 2 of the gate — SPEC §4.2, decisions/0005.
 *
 * No test runs without a connection, whether or not it involves a model.
 * Optimising the non-model tiers to run without one was rejected: a model is
 * involved somewhere in nearly every path worth testing, and two different
 * preconditions for one suite is a rule nobody remembers.
 *
 * This file is a WRAPPER, not a fourth implementation. `tui/src/profiles.ts`
 * is already the second copy of this logic (after `app/main/profiles.js`) and
 * the gateway is the third consumer; decisions/0005 records promoting it into
 * the engine as debt rather than doing it silently here. Everything below
 * delegates: no profile file is parsed, no `.env` line is written, and no
 * connection precondition is decided anywhere but in that file.
 *
 * PRESENCE, NOT REACHABILITY. `workspaceConnected()` asks whether the engine
 * could boot here as it stands — a key in the environment, a key line in
 * `<ws>/.env`, or a `.magentra/settings.json` naming a connection (keyless
 * local servers have no key line at all). There is no network probe, so the
 * suite still runs offline and a dead endpoint surfaces as a test failure
 * rather than as a gate failure.
 */

import {
  applyProfile,
  clearWorkspaceConnection,
  describeProfile,
  environmentKeyVar,
  profilesPath,
  readProfiles,
  readWorkspaceConnection,
  workspaceConnected,
  type Profile,
  type WorkspaceConnection,
} from "../../../tui/src/profiles.js";

/** What the picker shows. Never the key: `describeProfile` is the TUI's own redaction. */
export interface ProfileOffer {
  readonly id: string;
  readonly name: string;
  /** `model · host` plus `· keyless` where there is no key — from `describeProfile`. */
  readonly summary: string;
  /**
   * Whether this profile's endpoint and model are what the workspace currently
   * names. Compared on `baseUrl` + `model` only — the two fields that identify
   * where a turn is sent — and NOT on provider, which would mean copying
   * `applyProfile`'s `anthropic` / `openai-compatible` mapping out of the file
   * that owns it.
   *
   * It says "matches", not "was applied": a folder connected by the IDE, or
   * hand-edited, or pointed at a profile since deleted, matches nothing, and
   * that is the honest answer rather than a guess.
   */
  readonly matchesWorkspace: boolean;
}

function offer(p: Profile, current: WorkspaceConnection | undefined): ProfileOffer {
  return {
    id: p.id,
    name: p.name,
    summary: describeProfile(p),
    matchesWorkspace:
      current !== undefined &&
      (p.baseUrl ?? "") === (current.baseUrl ?? "") &&
      (p.model ?? "") === (current.model ?? ""),
  };
}

export type ConnectionState =
  /**
   * §4.2 branch 1 — connected already. Proceed.
   *
   * Carries the profile list and what the workspace currently names, because a
   * gate that shows a picker only while disconnected is a gate you can enter
   * and never leave: applying a profile made the picker vanish, and the only
   * way back was deleting two files by hand. Switching and disconnecting are
   * the same two writes, offered from the same place.
   */
  | {
      readonly kind: "connected";
      readonly workspace: string;
      /** What this folder names, or undefined when presence comes only from the environment. */
      readonly current?: WorkspaceConnection;
      /** Set when a key in the ENVIRONMENT is what makes this connected — no write here can clear that. */
      readonly environmentKeyVar?: string;
      readonly profiles: readonly ProfileOffer[];
      readonly profilesPath: string;
    }
  /** §4.2 branch 2 — not connected, profiles exist. Offer them, as the TUI's startup picker does. */
  | { readonly kind: "choose"; readonly workspace: string; readonly profiles: readonly ProfileOffer[]; readonly profilesPath: string }
  /** §4.2 branch 4 — not connected, no profiles. Refuse, and say where profiles live. */
  | { readonly kind: "refused"; readonly workspace: string; readonly message: string; readonly profilesPath: string };

/**
 * The TUI's message, with the sentence SPEC §4.2 quotes.
 *
 * `tui/src/engine/useEngine.ts:764` commits only the first clause — it prints
 * `no credentials in this folder and no saved profiles (<path>)` and then boots
 * anyway, because a TUI with no connection is still a usable terminal. SPEC
 * §4.2 quotes the longer form and the gateway REFUSES rather than proceeding,
 * so the longer form is what is used here.
 */
function refusalMessage(): string {
  return (
    `no credentials in this folder and no saved profiles (${profilesPath()})` +
    ` — define one in the MAGENTRA UI first.`
  );
}

/**
 * Branches 1, 2 and 4 of §4.2. Checked at startup, mirroring the TUI, and
 * re-checked whenever the gate state is recomputed — applying a profile writes
 * two files, and the lamp must go green without a restart.
 */
export function checkConnection(workspace: string): ConnectionState {
  const profiles = readProfiles();

  if (workspaceConnected(workspace)) {
    const current = readWorkspaceConnection(workspace);
    const envVar = environmentKeyVar();
    return {
      kind: "connected",
      workspace,
      ...(current !== undefined ? { current } : {}),
      ...(envVar !== undefined ? { environmentKeyVar: envVar } : {}),
      profilesPath: profilesPath(),
      profiles: profiles.map((p) => offer(p, current)),
    };
  }

  if (profiles.length > 0) {
    return {
      kind: "choose",
      workspace,
      profilesPath: profilesPath(),
      profiles: profiles.map((p) => offer(p, undefined)),
    };
  }

  return { kind: "refused", workspace, message: refusalMessage(), profilesPath: profilesPath() };
}

export class UnknownProfileError extends Error {}

/**
 * §4.2 branch 3 — the one write this stage makes, on explicit user action only.
 *
 * Delegates to `applyProfile`, which writes the same two files the IDE writes:
 * the key into `<ws>/.env`, the connection into `<ws>/.magentra/settings.json`.
 * A folder connected by the gateway is therefore indistinguishable from one
 * connected by the IDE or the TUI.
 */
export function applyProfileToWorkspace(workspace: string, profileId: string): ConnectionState {
  const profile: Profile | undefined = readProfiles().find((p) => p.id === profileId);
  if (profile === undefined) {
    throw new UnknownProfileError(`no saved profile with id "${profileId}" in ${profilesPath()}`);
  }
  applyProfile(workspace, profile);
  return checkConnection(workspace);
}

/**
 * The inverse write, on explicit user action only — clearing this folder's
 * connection so a different one can be chosen.
 *
 * Delegates to `clearWorkspaceConnection`, which removes the key line from
 * `<ws>/.env` and the connection keys from `<ws>/.magentra/settings.json` and
 * leaves both files, and everything else in them, standing.
 *
 * A key held in the environment survives this, by construction — the returned
 * state still reads `connected` and names the variable, rather than reporting a
 * success the user cannot see.
 */
export function disconnectWorkspace(workspace: string): ConnectionState {
  clearWorkspaceConnection(workspace);
  return checkConnection(workspace);
}

/** One line for the startup log — what the TUI commits as a notice at the same point. */
export function describeConnection(state: ConnectionState): string {
  switch (state.kind) {
    case "connected": {
      const where = state.environmentKeyVar !== undefined ? ` [${state.environmentKeyVar} in the environment]` : "";
      // No `current` means this folder names nothing and presence comes from the
      // environment alone — saying "settings name a connection" there would be a
      // plain lie about where the endpoint came from.
      const what = state.current?.model ?? state.current?.baseUrl ?? "no connection named in this folder";
      return `connection: present — ${what}${where}`;
    }
    case "choose":
      return `connection: absent — ${state.profiles.length} saved profile(s) offered (${state.profilesPath})`;
    case "refused":
      return `connection: ${state.message}`;
  }
}
