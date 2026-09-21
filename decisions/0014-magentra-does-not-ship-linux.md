# MAGENTRA does not ship Linux

Decided 2026-09-21 by the product owner: *"i won't ship linux."* Until that
changes, no Linux binary is built, published or tested.

It was decided while wiring the feature suite into CI. The suite is developed on
Windows — 584 registered, 499 passing there — and had never once been run on
Linux: 16 of its files branch on `process.platform` and 43 assertions name
win32. Gating every push on a platform nobody had seen it pass on would have
made the first red build a fact about the runner rather than about the code.
The owner's answer was not "run it on Linux once first" but "there is no Linux
to run it for", which is a larger and cleaner decision, and this records it.

## What is gone

| Where | What |
| --- | --- |
| `.github/workflows/release.yml` | the `linux` matrix leg — the only thing that ever published an AppImage, `.deb`, `.tar.gz` or `latest-linux.yml` |
| `.github/workflows/ci.yml` | `engine-and-app` moved from `ubuntu-latest` (+ xvfb) to `windows-latest`; the new `tests` job is Windows from the start |
| `app/package.json` | `scripts.dist:linux`, `scripts.dist:all`, and the whole `build.linux` electron-builder target |
| `package.json` | `scripts.dist:linux` |
| `app/scripts/bundle-engine.js` | the Linux ripgrep entry; `--target` now accepts `win\|mac` |
| `tests/features/` | `linux-artifact.test.ts` |
| `tests/gateway/features/` | `linux-artifact.json` |
| `tests/gateway/descriptions/ready/` | `32facbd6…json`, the approved test description whose `featureIds` was `["linux-artifact"]` and which now pointed at nothing |
| `FEATURES.md` | the *Linux artifact* row |
| `README.md` | the `npm run dist:linux` line under *Package* |

Two references were left standing on purpose. `decisions/0012` names
`linux-artifact.test.ts` in its reasoning, and an ADR records what was true when
it was written — this one supersedes it rather than editing it. `tests/README`
names the feature in its history of kind re-declarations, which is likewise a
record of what happened.

## What is deliberately NOT gone

**Linux still works if you build it yourself, and the runtime still knows what
it is.** Nothing was removed from:

- `app/main/updates.js` — `installFormat()` still resolves AppImage, `deb` and
  `tar.gz`, and `installTier()` still moves a read-only AppImage to the
  assisted tier. It costs nothing, it is guarded by `process.platform`, and the
  `update-tier-per-format` record proves it. A self-built copy therefore still
  resolves its own tier instead of crashing on an unknown format.
- `app/main.js`, `app/scripts/launch.js`, `app/scripts/afterPack.js` — the
  ordinary platform branches.
- `tests/lib/featureTest.ts` — `linux` stays in the OS vocabulary
  (decisions/0012); the mechanism outlives any one platform.
- `tty-dispatch` and `sandbox-unaffected` — both describe runtime behaviour on
  Linux, not an artifact, and both still hold.

Removing those would be a portability change. This is a distribution change,
and conflating the two is how a "we don't ship X" decision quietly becomes "we
crash on X".

## The one test this forced

`no-node-modules-at-runtime`'s fourth check iterated `["linux", "win", "mac"]`
over `build.<platform>.extraResources`. It now iterates `["win", "mac"]`. That
is not a weakened assertion — it is the same assertion over the targets that
exist. It would have gone red otherwise, correctly, which is the suite working.

## Putting it back

Revert the commit that carries this file. Every deletion above is in it, and
the `linux-artifact` record and its test come back with their prose intact —
which is why they were deleted rather than hollowed out or left failing. There
is no `retired` state in the schema and `deferred` is derived by rule and
cannot be hand-set (decisions/0008), so git history is the honest store for a
feature that is not currently a feature.

Before adding `ubuntu-latest` back to any matrix, run the feature suite on
Linux by hand once. It has still never been done.
