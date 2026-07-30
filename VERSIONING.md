# Versioning

MAGENTRA has its own version tool. The tool reads your commit messages. Then it
decides the next version, writes the changelog, and makes the tag.

You do not choose a version number. The commits choose it.

## The version number

A MAGENTRA version has **three** parts. It is a semantic version:

```
MAJOR . MINOR . PATCH
  1   .   4   .   2
```

| Part      | It increases when…                               | Effect on you         |
| --------- | ------------------------------------------------ | --------------------- |
| **MAJOR** | The behaviour changes, and your old code breaks. | You must change code. |
| **MINOR** | A new feature is available.                      | Your old code works.  |
| **PATCH** | Everything else that ships.                      | Your old code works.  |

**When one part increases, all smaller parts go back to 0.**

The whole scheme is three rules: a break is MAJOR, a `feat` is MINOR, everything
else is PATCH.

The version must be a semantic version because the desktop app updates itself,
and the updater compares versions with semver and nothing else. A version it
reads as equal means "no update". Read
[docs/adr/0008-the-version-is-semver.md](docs/adr/0008-the-version-is-semver.md).

The first release is `0.1.0`. The tool does not bump the first release. It uses
the `VERSION` file exactly.

### Releases before 0.13.1

A version used to have a fourth BUILD part, for example `0.12.1.1`. Those tags
stay in the repository, and the tool still reads them: `0.12.1.1` and `0.12.1`
are the same version to it. Nothing you do needs the old form.

## How a commit changes the version

The tool reads the **type** at the start of each commit subject.

```
feat(cli): add a retry policy
^^^^ ^^^    ^^^^^^^^^^^^^^^^^
type scope  subject
```

| Type       | Part that increases | Changelog section        |
| ---------- | ------------------- | ------------------------ |
| `feat`     | MINOR               | Features                 |
| `fix`      | PATCH               | Bug fixes                |
| `perf`     | PATCH               | Performance              |
| `revert`   | PATCH               | Reverts                  |
| `docs`     | PATCH               | Documentation            |
| `refactor` | PATCH               | Refactoring              |
| `test`     | PATCH               | Tests                    |
| `build`    | PATCH               | Build system             |
| `ci`       | PATCH               | Continuous integration   |
| `chore`    | PATCH               | Chores                   |
| `style`    | PATCH               | Code style               |

Every type ships. There is no type that makes no release, so packaging runs on
every push, and a mistake in a commit type never stops a repair from reaching a
user.

To declare a break, put a `!` before the colon:

```
feat(cli)!: rename the --out flag to --output
```

You can also write a `BREAKING CHANGE:` footer. Tell the user what to do:

```
fix(core): correct the retry count

BREAKING CHANGE: the default retry count is now 3, and not 5.
Set retries: 5 to keep the old behaviour.
```

A break always increases MAJOR. The type does not matter.

### Choose the type by what a user can observe

`refactor` means a user cannot tell the difference. If your change removes a
feature, changes a default, or repairs something a user complained about, it is
not a `refactor` — it is a `feat!`, a `feat`, or a `fix`.

The type decides what the changelog tells your users, and a `refactor` line tells
them nothing happened. Say what happened.

### An example

The version is `0.1.0`. These commits go to `main`, one after the other:

| Commit                         | New version |
| ------------------------------ | ----------- |
| `docs: repair a typo`          | `0.1.1`     |
| `refactor: split a module`     | `0.1.2`     |
| `fix: stop the crash on exit`  | `0.1.3`     |
| `feat: add a retry policy`     | `0.2.0`     |
| `feat!: rename the --out flag` | `1.0.0`     |

### More than one commit in one release

A release can contain many commits. The **largest** bump wins.

One `feat` commit and ten `docs` commits together give a MINOR bump. MINOR is
larger than PATCH.

## The commands

```bash
npm run commit           # Write a correct commit message. Questions and answers
npm run version:current  # Print the version now
npm run version:plan     # Show the next version. Change nothing
npm run version:check    # Check the commit messages of your branch
```

Two commands are for a maintainer only:

```bash
npm run version:apply -- --dry-run   # Show every change. Write nothing
npm run version:apply                # Make the release. The release job uses this
```

`npm run version:plan` is safe. It writes nothing. Use it to see the result of
your work before you send a pull request.

## The release

1. A maintainer merges a pull request into `main`.
2. The **Release** job starts.
3. The version tool reads every commit after the last tag.
4. If no commit changes the version, the job stops. There is no release.
5. If a commit changes the version, the tool:
   - writes the new version to `VERSION`;
   - writes the new version to each target file (see below);
   - adds a new section to the top of `CHANGELOG.md`;
   - makes a commit with the message `chore(release): vX.Y.Z.B [skip ci]`;
   - makes an annotated tag, for example `v0.2.0.0`;
   - pushes the commit and the tag;
   - publishes a GitHub release.

The `[skip ci]` mark stops the job from starting again for its own commit.

Nothing goes to a package registry. MAGENTRA publishes a tag, a changelog and a
GitHub release only.

## The `VERSION` file

`VERSION` holds the true version. Everything else holds a copy.

Do not edit `VERSION` by hand. The tool writes it.

## Configuration

`version.config.json` controls the tool. You do not need to change the code.

```json
{
  "tagPrefix": "v",
  "releaseBranch": "main",
  "targets": [{ "path": "package.json" }],
  "types": { "feat": { "bump": "minor", "section": "Features" } },
  "scopes": [],
  "subjectMaxLength": 72
}
```

| Field              | Meaning                                                              |
| ------------------ | -------------------------------------------------------------------- |
| `tagPrefix`        | The text before the version in a git tag.                            |
| `releaseBranch`    | The branch that makes releases.                                      |
| `targets`          | The files that hold a copy of the version.                           |
| `types`            | The allowed commit types, and the part that each type increases.     |
| `scopes`           | The allowed scopes. An **empty list allows every scope**.            |
| `subjectMaxLength` | The largest allowed length of a commit subject.                      |

### Targets

A target tells the tool where to write a copy of the version.

```json
"targets": [
  { "path": "package.json" },
  { "path": "packages/*/package.json" },
  { "path": "apps/*/package.json" }
]
```

A `*` stands for one directory name. A target that matches no file is not an
error. Therefore you can name a directory before it exists.

Every target gets the same text. A target used to be able to ask for a shortened
version, because `electron-builder` rejects a four-part one. The version is a
semantic version now, so there is one form and every tool accepts it.

## The version tool

The tool is in `tools/version/`. When it runs, it uses Node.js and git only. It
has **no runtime dependencies**.

Therefore:

- the tool runs immediately after a clone;
- a build is not necessary;
- a broken build does not stop a release;
- the commit hook works for a new contributor at once.

The tool is JavaScript, and the types are in the comments. `// @ts-check` and
TypeScript check them. TypeScript is a development dependency only. The tool
does not need it to run.

```bash
npm run test:version       # Run the tests
npm run typecheck:version  # Check the types
```

| File                  | It does this                                  |
| --------------------- | --------------------------------------------- |
| `lib/version.mjs`     | Reads, writes, compares and bumps a version.  |
| `lib/commits.mjs`     | Reads and checks a commit message.            |
| `lib/plan.mjs`        | Decides the next version.                     |
| `lib/changelog.mjs`   | Writes `CHANGELOG.md`.                        |
| `lib/sync.mjs`        | Writes the version to the target files.       |
| `lib/git.mjs`         | Talks to git.                                 |
| `lib/config.mjs`      | Reads `version.config.json` and `VERSION`.    |

## Questions

**A commit of mine does not have the necessary form. What happens?**
The tool ignores it. The commit does not go into the changelog, and it does not
change the version. `npm run version:plan` shows every ignored commit.

**I made a mistake in my last commit message.**
Run `git commit --amend`. The hook checks the new message.

**The hook stops me, but I must commit now.**
Use `git commit --no-verify`. The CI job checks the message later.

**How do I turn the hook on?**
Run `npm install` one time. It sets `core.hooksPath` to `.githooks`.
