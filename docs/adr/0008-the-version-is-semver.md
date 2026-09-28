# The version is semver

MAGENTRA versioned as `MAJOR.MINOR.PATCH.BUILD` so that every commit, including
a comment repair, got its own version and was therefore traceable. The desktop
app must self-update, and every updater in the ecosystem compares versions with
semver. A four-part version is not semver, so `app/scripts/dist.js` truncated it
to its three-part prefix at packaging time. Two different releases then reported
the same version to the updater — release `v0.12.1.1` shipped binaries that
called themselves `0.12.1`, exactly like `v0.12.1.0` before it — and the
comparison `semver.eq(latest, current)` answered "no update available". The
update mechanism was silently dead for every BUILD-only release.

We drop the BUILD part. The version is semver, and the whole scheme is three
rules: a break is MAJOR, a `feat` is MINOR, everything else is PATCH. The types
that used to bump BUILD — `docs`, `refactor`, `test`, `build`, `ci`, `chore`,
`style` — bump PATCH instead, so every recognised commit still moves the version
and every push to `main` still releases. The truncation in `dist.js` goes away
with the problem it existed to solve.

PATCH for a documentation repair is not what semver means by PATCH. That costs
nothing here: the package is private, nothing consumes MAGENTRA through a version
range, and the version's only reader is the updater, which needs monotonicity and
nothing else. Keeping every commit releasable is worth more than the purity.

## Consequences

- Per-commit traceability leaves the version number. The build carries its git
  commit instead, which is what a reader actually needs to locate the source.
- Migration is lossless: `VERSION` drops its BUILD part and becomes `0.13.0`,
  which is precisely what every already-installed build reports, because
  packaging truncated it to that anyway. The next `fix` is `0.13.1` and the next
  `feat` is `0.14.0`, both correctly greater. No version is reused or skipped.
- Every push to `main` still produces a release, so packaging stays exercised
  continuously and mislabelling a commit type never costs a release.
- Users are therefore offered updates for documentation repairs too. The update
  notice is a passive chip in the inspector footer, not a dialog, so a frequent
  release cadence costs attention rather than interrupting work.
- Because a release is published on nearly every push, a failed packaging job
  would leave `/releases/latest` pointing at a release with no channel file,
  which breaks the update check for every client at once. The release is
  therefore created as a draft and published only after its binaries are
  attached.
