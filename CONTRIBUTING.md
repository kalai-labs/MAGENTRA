# Contributing to MAGENTRA

Thank you for your help. This page tells you how to make a change.

Read it one time. After that, the tools tell you what to do.

## Start

You need [Node.js](https://nodejs.org) 20 or newer, and git.

```bash
git clone https://github.com/kalai-labs/MAGENTRA.git
cd MAGENTRA
npm install
```

`npm install` turns on the commit hook. The hook checks your commit message
before git accepts it. Run `npm install` one time only.

## Make a change

```bash
git switch -c my-change     # 1. Make a branch
# ... edit the files ...    # 2. Do the work
git add -A                  # 3. Stage your work
npm run commit              # 4. Commit
```

**Step 4 is the important step.** `npm run commit` asks you some questions. Then
it writes a correct commit message. You do not need to remember any rule.

```
1. What is the type of this change?
   1. feat      minor  Features
   2. fix       patch  Bug fixes
   3. perf      patch  Performance
   ...
Type > 2

2. What part of the code changed? (optional)
Scope > cli

3. Describe the change in one line.
Subject > stop the crash on exit

4. Does this change break the behaviour of a user?
Breaking (y/N) > n

Commit message
  fix(cli): stop the crash on exit

Commit? (Y/n) >
```

You can also write the message yourself:

```bash
git commit -m "fix(cli): stop the crash on exit"
```

The hook checks it. If the message is wrong, the hook tells you why, and it
tells you the allowed types.

## Why the commit message is important

The commit message decides the next version of MAGENTRA. There is no other
input. A `fix` gives a new PATCH version. A `feat` gives a new MINOR version.

To see the result of your work:

```bash
npm run version:plan
```

This command changes nothing. It shows the next version and the new changelog.

To learn the complete rules, read [VERSIONING.md](VERSIONING.md).

## The form of a commit message

```
type(scope)!: subject

body

BREAKING CHANGE: description
```

- `type` — necessary. For example `feat`, `fix` or `docs`.
- `(scope)` — optional. The part of the code that changed. For example `cli`.
- `!` — optional. Use it when your change breaks the behaviour of a user.
- `subject` — necessary. One line. Start with a small letter. Do not end with a
  full stop.

Good:

```
feat(core): add a retry policy
fix: stop the crash on exit
docs: correct the install command
feat(cli)!: rename the --out flag to --output
```

Not good:

```
Fixed the bug.          (No type. A capital letter. A full stop.)
update                  (No type. The subject says nothing.)
feat:add a flag         (No space after the colon.)
```

## Send a pull request

```bash
git push origin my-change
```

Then open a pull request on GitHub.

**The title of the pull request must also be a correct commit message.** A
maintainer squashes your commits into one commit. The title becomes the message
of that commit.

To check your work before you push:

```bash
npm run version:check
```

## What the CI job does

| Job                 | It checks this                                     |
| ------------------- | -------------------------------------------------- |
| **Version tool**    | The tests of the version tool pass, on Node 20, 22 and 24. |
| **Types**           | The types of the version tool are correct.         |
| **Commit messages** | Your commits and your title have the correct form. |
| **Next version**    | It shows the next version on the summary page.     |

## After the merge

A maintainer merges your pull request into `main`. The **Release** job then
starts. It decides the new version, writes the changelog, and makes the tag.

You do not need to do anything.

## The version tool

The tool is in `tools/version/`. It has no runtime dependencies.

```bash
npm run test:version       # Run the tests of the tool
npm run typecheck:version  # Check the types of the tool
```

If you change the tool, add a test.

## Licence

MAGENTRA uses the [Apache Licence 2.0](LICENSE).

When you send a pull request, you agree that your work goes into MAGENTRA under
this licence. Section 5 of the licence says this. You do not need to sign
another agreement.

## Behaviour

Read the [Code of Conduct](CODE_OF_CONDUCT.md). It applies to everybody.
