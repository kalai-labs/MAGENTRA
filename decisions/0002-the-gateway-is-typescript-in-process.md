# The gateway is TypeScript, in the same process family as the engine

Python was the first choice, then reconsidered. Recording why it lost matters,
because the reason is not preference.

## The constraint

The gateway must know things only the engine knows: which tools are registered
and with what permission class, which frame types exist on the wire, what keys
the settings schema accepts, which addons ship built in, what the reasoning
levels are. All of it lives in TypeScript under `engine/`, and all of it is
already computed by an index this repo owns —
`engine/core/src/knowledge/graph.ts` and `symbols.ts`, the same index the
`GraphQuery` tool serves to the agent at runtime.

A Node process imports that directly. `.claude/skills/bigpicture/bigpicture.mjs`
already does exactly this:

```js
await import(pathToFileURL(join(ROOT, "engine/core/dist/knowledge/graph.js")).href)
```

A Python process cannot. Its only route to the engine is spawning it and
speaking NDJSON, which reaches the *behaviour* and never the *internals* — so
every fast unit assertion about the permission engine, the token algebra or the
frontmatter parser would have become a slow subprocess test, and the engine's
own graph index would have had to be reimplemented in Python to answer the
dependency question that is the gateway's whole point.

Two smaller costs pointed the same way. The connection system the gateway must
reuse is JavaScript (`app/main/profiles.js`, `tui/src/profiles.ts`); Python
would need a fourth copy of profile reading, when three already exist. And the
`ui` test tier has to spawn Electron regardless.

## The decision

TypeScript, run in Node, in `tools/magentra-gateway/`.

| Choice | Value |
| --- | --- |
| Language | TypeScript (chosen over `.mjs` + `@ts-check`) |
| Execution | `tsx`, so no build step stands in front of the tool |
| Typecheck | `tsc -p tools/magentra-gateway`, its own project |
| HTTP | stdlib `node:http` |
| Storage writes | the existing `writeJsonAtomic` helper |
| Dependencies added | **none** |
| Entry point | `npm run gateway`, `-- --port` supported |

`tsx` rather than a compile step is deliberate: the gateway must start when
`npm run build` is broken, because a broken build is exactly when you need to
look at what the inventory says. Panels that depend on the engine's compiled
index degrade to a "needs a build" notice instead of taking the tool down.

It is dev tooling. It lives beside `tools/version/` and `tools/prompt-lab/`,
never enters the Electron bundle (`build.files` in `app/package.json` does not
reach it), and a contributor who never opens it installs nothing extra.

## Precedent this follows

`tools/prompt-lab/server.mjs` is already a local Node HTTP server on
`127.0.0.1:4319`, serving one `index.html` plus a JSON API over the engine's
prompt registry, started by `npm run prompt-lab`. The gateway copies that
idiom so `tools/` has one local-server pattern rather than two — including its
recorded platform lesson: never invoke the compiler as `npx tsc`, because on
Windows `npx` is `npx.cmd` and `execFile` without a shell cannot spawn it.

## What this forecloses

Python analysis libraries are out of reach for the gateway. Nothing in the four
abilities needs them; if that ever changes, the answer is a Python script that
reads the gateway's JSON export, not a rewrite.
