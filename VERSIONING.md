# Versioning

MAGENTRA has its own version tool. The tool reads your commit messages. Then it
decides the next version, writes the changelog, and makes the tag.

You do not choose a version number. The commits choose it.

## The version number

A MAGENTRA version has **four** parts:

```
MAJOR . MINOR . PATCH . BUILD
  1   .   4   .   2   .   7
```

| Part      | It increases when…                                | Effect on you        |
| --------- | ------------------------------------------------- | -------------------- |
| **MAJOR** | The behaviour changes, and your old code breaks.  | You must change code. |
| **MINOR** | A new feature is available.                       | Your old code works. |
| **PATCH** | A defect is repaired. There is no new feature.    | Your old code works. |
| **BUILD** | Nothing that you can observe changes.             | Nothing.             |

The BUILD part is the difference between MAGENTRA and standard semantic
versioning. It gives a version to every commit, also to a commit that only
changes a comment or a document. Therefore each release is traceable, and a
document repair does not look like a defect repair.

**When one part increases, all smaller parts go back to 0.**

The first release is `0.1.0.0`. The tool does not bump the first release. It
uses the `VERSION` file exactly.

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
| `docs`     | BUILD               | Documentation            |
| `refactor` | BUILD               | Refactoring              |
| `test`     | BUILD               | Tests                    |
| `build`    | BUILD               | Build system             |
| `ci`       | BUILD               | Continuous integration   |
| `chore`    | BUILD               | Chores                   |
| `style`    | BUILD               | Code style               |

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

### An example

The version is `0.1.0.0`. These commits go to `main`, one after the other:

| Commit                         | New version |
| ------------------------------ | ----------- |
| `docs: repair a typo`          | `0.1.0.1`   |
| `refactor: split a module`     | `0.1.0.2`   |
| `fix: stop the crash on exit`  | `0.1.1.0`   |
| `feat: add a retry policy`     | `0.2.0.0`   |
| `feat!: rename the --out flag` | `1.0.0.0`   |

### More than one commit in one release

A release can contain many commits. The **largest** bump wins.

One `feat` commit and ten `docs` commits together give a MINOR bump. MINOR is
larger than BUILD.

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
  "targets": [{ "path": "package.json", "format": "full" }],
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
  { "path": "package.json",             "format": "full"   },
  { "path": "packages/*/package.json",  "format": "full"   },
  { "path": "apps/*/package.json",      "format": "semver" }
]
```

A `*` stands for one directory name. A target that matches no file is not an
error. Therefore you can name a directory before it exists.

There are two formats:

| Format   | The tool writes | Use it for                                       |
| -------- | --------------- | ------------------------------------------------ |
| `full`   | `1.4.2.7`       | npm packages, and every tool that accepts it.    |
| `semver` | `1.4.2`         | A tool that accepts three parts only.            |

Some tools reject a version that has four parts. Two examples are
`electron-builder` and `vsce`. Give those tools the `semver` format.

It is safe to remove the BUILD part. A BUILD change does not change the
behaviour. Therefore the product of the tool is the same.

npm itself accepts a version that has four parts, when the package is private.
This is tested.

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
