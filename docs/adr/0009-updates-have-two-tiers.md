# Updates have two tiers, decided by install format

MAGENTRA ships unsigned, and it will keep shipping unsigned. That is not a gap
waiting to be filled; it is the constraint the update mechanism is built on.
Squirrel.Mac validates the replacement bundle's code signature against the
running app, so an unsigned macOS build can never replace itself, no matter how
the updater is written. Windows NSIS is the opposite case: `electron-updater`
skips the publisher check when the channel file carries no `publisherName`, and
files it downloads carry no Mark-of-the-Web, so SmartScreen never sees the
update path. Signing would only soften the *first* install there.

So capability follows the install format, and an install belongs to one of two
tiers for its whole life:

| Format                  | Tier        |
| ----------------------- | ----------- |
| Windows NSIS            | self-update |
| Linux AppImage/writable | self-update |
| Windows portable        | assisted    |
| macOS dmg               | assisted    |
| Linux deb, tar.gz       | assisted    |

The **self-update** tier asks first, then downloads with progress and installs
on quit. Nothing reaches the network before the user clicks once.

The **assisted** tier opens the browser on the exact asset for that format, not
on the releases page. The app knows its own format, and the asset URL is
determined by the version, so the user never picks from a list of eight files.

The assisted tier is a peer, not a fallback. Roughly a third of installs live
there permanently, so it does not sit in a `catch` block.

## Consequences

- The one-click requirement is met on NSIS and AppImage only. Elsewhere one
  click starts the correct download and the user performs the install gesture.
- Windows `portable` must be detected by `PORTABLE_EXECUTABLE_DIR`, not by
  `process.platform === "win32"`. Without that test a portable user is handed
  the NSIS installer, which silently installs a second copy that then diverges
  from the one they keep launching.
- An AppImage is only self-updating while its own file is writable. One placed
  under `/opt` is not, so writability is probed and a failure moves that install
  to the assisted tier for that session rather than erroring.
- The check uses the releases feed, never `api.github.com`, which allows 60
  unauthenticated requests per hour per IP. One office behind one NAT would
  exhaust that.
- The asset name cannot be built from `process.arch`. electron-builder renames
  `${arch}` per target, so one x64 build is `x86_64` in an AppImage, `amd64` in a
  deb and `x64` in a tarball. Deriving it the obvious way produced a 404 for two
  of the three formats. `tests/updates.test.js` pins the names a real
  `dist:linux` writes, because nothing else would catch the drift.
- Some platforms have no artifact at all: only an arm64 dmg and an x64 Linux
  build are published. There the click opens the release page. A confidently
  wrong file name would be worse than an honest list.

## Recovery

Two invariants replace a migration runner.

Config keys are **additive only** — never renamed, never repurposed. Every
version therefore reads every other version's state, which is what makes going
back safe without migration code.

A bad release is **retracted, never deleted**: flipping it to prerelease on
GitHub removes it from `/releases/latest`, which is the path clients resolve, so
they are offered the previous version instead. Deleting it would instead break
clients mid-download.

A genuinely breaking state change is forbidden. Add a new key.
