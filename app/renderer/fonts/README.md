# Bundled fonts

Both faces ship with the app so the interface renders identically on every
machine, with no network fetch and nothing to install. This is what lets the
strict Content-Security-Policy in `index.html` set `font-src 'self'`.

Both are licensed under the **SIL Open Font License, Version 1.1** — the full
text is in [`OFL-1.1.txt`](./OFL-1.1.txt), which the licence requires to be
distributed alongside the fonts. The OFL permits bundling and redistribution
with software, including commercially, provided the fonts are not sold on their
own and the licence and copyright notices travel with them.

| File | Family | Copyright |
| --- | --- | --- |
| `inter-var.woff2`, `inter-var-italic.woff2` | Inter | Copyright (c) 2016–2020 The Inter Project Authors (<https://github.com/rsms/inter>) |
| `jetbrains-mono-var.woff2` | JetBrains Mono | Copyright (c) 2020 The JetBrains Mono Project Authors (<https://github.com/JetBrains/JetBrainsMono>) |

Reserved Font Names apply: a modified build of either face must be renamed
before redistribution.

Mathematics is rendered as native MathML rather than through a web font, so no
additional font — and no third-party library — is needed for it.
