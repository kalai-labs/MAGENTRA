# Changelog

This file lists every release. The version tool writes it. Do not edit it by hand.

The version has three parts: MAJOR.MINOR.PATCH. To learn what the parts mean,
read [VERSIONING.md](VERSIONING.md).

Releases up to 0.13.0.0 carry a fourth BUILD part. See
[docs/adr/0008-the-version-is-semver.md](docs/adr/0008-the-version-is-semver.md).

<!-- new-release -->

## 0.20.0 — 2026-09-25

### Features

- agentic harness improvements ([95148d2](https://github.com/kalai-labs/MAGENTRA/commit/95148d27ef1abd39ede7bcb9709ec5355d313867))

[Compare with v0.19.4](https://github.com/kalai-labs/MAGENTRA/compare/v0.19.4...v0.20.0)

## 0.19.4 — 2026-09-25

### Bug fixes

- written fix plan ([028231a](https://github.com/kalai-labs/MAGENTRA/commit/028231a4c6a2927382ba0c92e07016388ff9e1ef))
- t00 and t01 ([a8c9150](https://github.com/kalai-labs/MAGENTRA/commit/a8c9150ecde2b068fbbef7959dd72a7880795855))
- field-test fixes t02 to t13 ([3592fa8](https://github.com/kalai-labs/MAGENTRA/commit/3592fa8d8dfeaae82ff2d7811b41c9c497d38e6e))
- fixed overall issues I've seen during a long run ([4fdaee5](https://github.com/kalai-labs/MAGENTRA/commit/4fdaee5659035cbc65c6ea3b81956e9b10a5d5aa))
- update on how we build things and harness ([96d7af4](https://github.com/kalai-labs/MAGENTRA/commit/96d7af40c33fc991cfa6747d0b8942f991d38e2a))

[Compare with v0.19.3](https://github.com/kalai-labs/MAGENTRA/compare/v0.19.3...v0.19.4)

## 0.19.3 — 2026-09-22

### Continuous integration

- wait for the packaged Windows smoke run ([91b8c11](https://github.com/kalai-labs/MAGENTRA/commit/91b8c112f6d2f7b154079eeb8b4911d2d9dad078))

[Compare with v0.19.2](https://github.com/kalai-labs/MAGENTRA/compare/v0.19.2...v0.19.3)

## 0.19.2 — 2026-09-22

### Bug fixes

- release issue ([fe445ad](https://github.com/kalai-labs/MAGENTRA/commit/fe445ad13be1b16b76cc44694856f01ea3824d72))

[Compare with v0.19.1](https://github.com/kalai-labs/MAGENTRA/compare/v0.19.1...v0.19.2)

## 0.19.1 — 2026-09-21

### Tests

- fix on tests ([43a1183](https://github.com/kalai-labs/MAGENTRA/commit/43a118355bc0ddcc32bfb58ee55116100230ef4a))
- fix on tests ([986c726](https://github.com/kalai-labs/MAGENTRA/commit/986c726b5f1eb0921e91704b21f741904e7fd16b))
- update ([8f5ffd4](https://github.com/kalai-labs/MAGENTRA/commit/8f5ffd4a72ee3d76378622919027cf4431a83ebe))
- added new tests ([d2f8f3e](https://github.com/kalai-labs/MAGENTRA/commit/d2f8f3ede99d46c440a16e998a485f0d63567a03))

### Build system

- stop shipping Linux binaries ([f5c335b](https://github.com/kalai-labs/MAGENTRA/commit/f5c335b75719a41823f17086b2eeb7d31703731a))

### Continuous integration

- gate every push on the feature suite ([526cab5](https://github.com/kalai-labs/MAGENTRA/commit/526cab53566f8b10be81beaf2c89f810f351ac2d))

[Compare with v0.19.0](https://github.com/kalai-labs/MAGENTRA/compare/v0.19.0...v0.19.1)

## 0.19.0 — 2026-09-20

### Features

- k-works ([079962a](https://github.com/kalai-labs/MAGENTRA/commit/079962a2f7b24a42b0ea587c2ab46b82155825fc))
- added the gateway ([1b5a0f7](https://github.com/kalai-labs/MAGENTRA/commit/1b5a0f7ea68209eebc9f970ad5c620c8935330d7))
- test descriptions added ([888c90f](https://github.com/kalai-labs/MAGENTRA/commit/888c90f916b620b9bd1b1c065ad57543f5ffcc8c))

### Bug fixes

- fix ([31947e4](https://github.com/kalai-labs/MAGENTRA/commit/31947e4d1aaa5938734e3ea29f2103627d073658))
- **app:** consume F11 so one press is not handled twice ([64b6846](https://github.com/kalai-labs/MAGENTRA/commit/64b6846e815dc7e96058a1ff9251755400c80191))
- **protocol:** decode a multi-byte character split across stdin chunks ([a2a958b](https://github.com/kalai-labs/MAGENTRA/commit/a2a958b776267b53540c5667934b78873b2f53b1))
- **core:** announce an addon as loaded only when its turn starts ([99987bb](https://github.com/kalai-labs/MAGENTRA/commit/99987bb509982a73e532fbeb2454347cda8ceff7))
- **core:** anchor the TS export regex to its own line for symbol lines ([7711ed5](https://github.com/kalai-labs/MAGENTRA/commit/7711ed54700670e3dacb95f3c519ed9a96638d3a))
- **build:** mark reset-all deletions as self-writes in the prompt lab ([8b03048](https://github.com/kalai-labs/MAGENTRA/commit/8b03048dcd54f62c8be1ea08ecc5a962dfaf77df))

### Documentation

- **docs:** record phase 1 of the feature suite in tests/README ([8618655](https://github.com/kalai-labs/MAGENTRA/commit/861865538e484b089ce1f8fc8d7f76b7325f13be))
- **docs:** record phase 2 of the feature suite in tests/README ([f41e1a5](https://github.com/kalai-labs/MAGENTRA/commit/f41e1a5aec141c8bf1d51729feaeb56c43da1b6c))
- **docs:** restore the backslash in the phase 2 symbol-index note ([0ba1414](https://github.com/kalai-labs/MAGENTRA/commit/0ba14148d4d65b11bff17e4ea34684911ba35cfa))
- **docs:** record the parity check's scope decision in tests/README ([a16dcdb](https://github.com/kalai-labs/MAGENTRA/commit/a16dcdb3c26f7fd1d5a1f5e1cb130be3714b4f28))
- **docs:** record why packaged-artifact tests are opt-in ([3c31c9b](https://github.com/kalai-labs/MAGENTRA/commit/3c31c9b5b833b00635a33f4c8cfce2332520833d))
- **docs:** hand over the llm track and the open decisions ([f71cd1f](https://github.com/kalai-labs/MAGENTRA/commit/f71cd1f78b47d967585766d0f093ddb1f8616ede))

### Refactoring

- deleted existing tests to build all tests carefully afterwards ([047ad71](https://github.com/kalai-labs/MAGENTRA/commit/047ad715f392e9ae200264eeace5ddc3e70ec418))

### Tests

- new test added ([e2bc213](https://github.com/kalai-labs/MAGENTRA/commit/e2bc213d90142d065c3d416886cba5de29ae34fd))
- new tests added ([9892b84](https://github.com/kalai-labs/MAGENTRA/commit/9892b8442219faedcdfce5b5e0edc5d7ec629479))
- drive the desktop app over a socket and run one UI at a time ([09ffadd](https://github.com/kalai-labs/MAGENTRA/commit/09ffaddee333bb22f87fe15b60349b1f11ff87af))
- new tests added ([71d8902](https://github.com/kalai-labs/MAGENTRA/commit/71d8902346f07e7c7ed7827178c2d8baa629bfc0))
- update ([054abf1](https://github.com/kalai-labs/MAGENTRA/commit/054abf10c79a0a8786c32589beb98ee2ebb90624))
- update ([a6e6a25](https://github.com/kalai-labs/MAGENTRA/commit/a6e6a25253d9c4adb98e3aa55877be61dbba2379))
- update ([dd728b6](https://github.com/kalai-labs/MAGENTRA/commit/dd728b61f42c6516c422bf70d45a806167ffd0ca))
- **app:** pin the default base URL mirror in both halves ([74172e1](https://github.com/kalai-labs/MAGENTRA/commit/74172e1e628c8eb8e1abd2620523d5376b3e4c3d))
- **app:** pin the vision key variable mirror and its resolution ([128a96d](https://github.com/kalai-labs/MAGENTRA/commit/128a96d79415123307293563dc3d27ef6a92041d))
- **protocol:** pin the reasoning-effort ladder mirror and wire map ([00cbfc5](https://github.com/kalai-labs/MAGENTRA/commit/00cbfc58c1deb40d7aaf45a3d773361b0108cc28))
- **protocol:** pin the token algebra mirror against the renderer ([2ccb84c](https://github.com/kalai-labs/MAGENTRA/commit/2ccb84c1811bef7acaafdc4560f8923c2092d890))
- **core:** pin the local-endpoint rule mirror and keyless LAN boot ([fd7e4d3](https://github.com/kalai-labs/MAGENTRA/commit/fd7e4d30205161e15b7142a204e94936ddbab874))
- **tools:** pin the image-type mirror in source, Read and the picker ([222723b](https://github.com/kalai-labs/MAGENTRA/commit/222723bed31707e96f3081d8900d9e37c2c19182))
- **app:** pin the theme list mirror in the running main and renderer ([cbfe24b](https://github.com/kalai-labs/MAGENTRA/commit/cbfe24b38f8bfc20d3a21f79e9529871a7d0ad85))
- **providers:** pin the effort clamp ladder and the one-retry re-send ([b96e9a3](https://github.com/kalai-labs/MAGENTRA/commit/b96e9a3ad63175ca0cc091b506b167ea519fa6c0))
- **providers:** pin usage normalization against a real SSE server ([ba3b24b](https://github.com/kalai-labs/MAGENTRA/commit/ba3b24beb48982fec0e663393c2e35617ac66d3a))
- **core:** pin the single-consumer event queue and its steal ([b9ef97f](https://github.com/kalai-labs/MAGENTRA/commit/b9ef97fd5b167c82899c909f7fbbf4a6289fa5d2))
- **core:** pin absent-means-cleared for vision and baseUrl frames ([bb12865](https://github.com/kalai-labs/MAGENTRA/commit/bb128656fab8059ed847d48ffa589461fc200e5c))
- **protocol:** pin NDJSON resilience to bad lines, CRLF and chunks ([e16dd43](https://github.com/kalai-labs/MAGENTRA/commit/e16dd435dfeb52131cb6d6ba8ed452a2cfd65345))
- **protocol:** pin the wire round trip for every event and request ([d2a38cf](https://github.com/kalai-labs/MAGENTRA/commit/d2a38cf4ac631765148fb73f3e61e9b246754c9b))
- **tools:** pin TaskCreate on a real store, with the direct-tool helper ([a685f3d](https://github.com/kalai-labs/MAGENTRA/commit/a685f3d053d4f3bc218340451a61d93df1e7cd79))
- **tools:** pin TaskGet's echoed id forms and dependency lists ([7f9ce90](https://github.com/kalai-labs/MAGENTRA/commit/7f9ce900451ba3095c9451fe241593b263661c50))
- **tools:** pin TaskList's READY and BLOCKED tags against completion ([0ed0e1f](https://github.com/kalai-labs/MAGENTRA/commit/0ed0e1f34ab424a7e49de9afe3d5a41eafb9d33c))
- **tools:** pin TaskUpdate's partial patches, edges and deletion ([7fad21b](https://github.com/kalai-labs/MAGENTRA/commit/7fad21b3c9433c527b2aacc7f0bbc19144f4ed05))
- **tools:** pin AskUserQuestion's bounds, positional keys and blocking ([61b9deb](https://github.com/kalai-labs/MAGENTRA/commit/61b9deb9efd7cb3197700494f1f658a23568e7e9))
- **build:** pin the version tool's semver core ([75c120c](https://github.com/kalai-labs/MAGENTRA/commit/75c120c0c3e66f5c7d71cef02d7ee3c4e5d34e86))
- **build:** pin the conventional-commit check against the real config ([5b23a3f](https://github.com/kalai-labs/MAGENTRA/commit/5b23a3faaa1ac41d3caf8665e3ba55e130b6f381))
- **build:** pin changelog rendering and marker-safe prepending ([28e3e03](https://github.com/kalai-labs/MAGENTRA/commit/28e3e037ce9cc1933bffed2117b3f157e452ca8a))
- **build:** pin the release plan against real temp git repositories ([adb22dc](https://github.com/kalai-labs/MAGENTRA/commit/adb22dc31ce2bd74b303de8424624a51d2b9e411))
- **providers:** pin the multimodal content array on the real wire ([2e569af](https://github.com/kalai-labs/MAGENTRA/commit/2e569aff1b9e0dfc85448ddf3fb7e95e2add385b))
- **tools:** pin the Addon tool's header, substitution and roster error ([8f5fb69](https://github.com/kalai-labs/MAGENTRA/commit/8f5fb696f7e99ebf79c798c2edfab0268f9588b7))
- **tui:** pin the protocol copy against the engine, red on payload ([f4eb986](https://github.com/kalai-labs/MAGENTRA/commit/f4eb98622e15aa75a7412b33b6f7a88f4cdd89e1))
- **core:** pin that no addon body rides in the standing system prompt ([5c99e67](https://github.com/kalai-labs/MAGENTRA/commit/5c99e6736a2a2c673855a72b7d68bd93678c0f46))
- **core:** pin the addon roster and /name commands in session_started ([f8dd49b](https://github.com/kalai-labs/MAGENTRA/commit/f8dd49b947c5d109a738f38552901f2c00d47439))
- **core:** pin the /addons listing's origins and bundle counts ([c90fee3](https://github.com/kalai-labs/MAGENTRA/commit/c90fee3bbc41b4865375f0dc8f2c22a53316d3c5))
- **core:** pin the slash-command input guard on malformed frames ([cfdee07](https://github.com/kalai-labs/MAGENTRA/commit/cfdee0717c4d71c31b4cbbbb0d5f9c4e980ab1d2))
- **core:** pin every setting's timing note and the live rebuild ([223c242](https://github.com/kalai-labs/MAGENTRA/commit/223c242b54ce0801b94469eecdf1f0c540e52035))
- **core:** pin one slash registry for /help, the palette and installs ([a8fb01c](https://github.com/kalai-labs/MAGENTRA/commit/a8fb01c0c1ea545e3a45279afed66923a049e9db))
- **host:** pin bootstrapEngine's key, endpoint, warnings and assembly ([47f02f5](https://github.com/kalai-labs/MAGENTRA/commit/47f02f5ea286942f6244f3a4145b67d6d1a9336c))
- **core:** pin /name invocation, unknown names and the busy refusal ([00d0c65](https://github.com/kalai-labs/MAGENTRA/commit/00d0c65272d071e790690cf99acd2c548fa1ea26))
- **core:** pin system prompt assembly order and disabled sections ([07158ac](https://github.com/kalai-labs/MAGENTRA/commit/07158ac26cf6b740481cd6d6b59b0d94491be4e7))
- **tools:** pin the 27-tool registry contract and run the readers ([c344b1a](https://github.com/kalai-labs/MAGENTRA/commit/c344b1adc2d81766ed13225838cf79b84b13538b))
- **core:** read the latest /name invocation from the live history ([2db2dbc](https://github.com/kalai-labs/MAGENTRA/commit/2db2dbc51136cca723814ff1560eeb6c052649a4))
- **core:** let the scripted engine fixture take an addon roster ([ea30363](https://github.com/kalai-labs/MAGENTRA/commit/ea30363a3592c7f3a42016ca4d8bcfe36e770404))
-  phase 1 ([e4d4d2e](https://github.com/kalai-labs/MAGENTRA/commit/e4d4d2e15ac8e9c357377336947885d6cec0b253))
- **core:** prove bundled-files lists sibling paths and inlines nothing ([3255218](https://github.com/kalai-labs/MAGENTRA/commit/32552188212a66d1ea895883ecd7b19a2c54fdf3))
- **core:** prove both addon layouts load and bare folders are skipped ([0783a63](https://github.com/kalai-labs/MAGENTRA/commit/0783a63c2aaf9758ad220833c9ba7092edd4cf21))
- **core:** prove addon precedence by name across the three tiers ([8e7aa30](https://github.com/kalai-labs/MAGENTRA/commit/8e7aa307045ebb3d10a1c0d71bff258cfae58f35))
- **core:** prove the magentron built-in ships with its cost declared ([12d7781](https://github.com/kalai-labs/MAGENTRA/commit/12d778107ca68e294e69d750847f022f1bc7f360))
- **tools:** prove Read numbers, refuses, extracts, never sends images ([f3a8549](https://github.com/kalai-labs/MAGENTRA/commit/f3a8549feb79a86ba7f3a45e3d2de859499c6929))
- **tools:** prove Write guards freshness, makes dirs and emits a diff ([35ac92e](https://github.com/kalai-labs/MAGENTRA/commit/35ac92efe57f6909cf865ff14b7d67bfd4359c3a))
- **tools:** prove Edit needs a Read and tells 0 from many matches ([ca9d772](https://github.com/kalai-labs/MAGENTRA/commit/ca9d772d6944d3c95551927e15fff387404dd3c1))
- **core:** prove the freshness store goes stale on size or mtime ([f1be4df](https://github.com/kalai-labs/MAGENTRA/commit/f1be4df8f2d80d7ddefde69d34aa48eb6dc4c3ad))
- **tools:** prove Glob hides .magentra by segment and sorts by mtime ([317554f](https://github.com/kalai-labs/MAGENTRA/commit/317554f1c10b8e8aa8ecbc17770e1b8e619ea6b0))
- **tools:** prove all five GraphQuery ops answer from the graph ([cf68871](https://github.com/kalai-labs/MAGENTRA/commit/cf6887187d773278c6c919514a15190e57758c93))
- **core:** prove the import graph is cached, refreshed and versioned ([edb40db](https://github.com/kalai-labs/MAGENTRA/commit/edb40db94ef5b18af2f93218e782b51167177b1f))
- **core:** prove project settings merge over global with sources ([697ca27](https://github.com/kalai-labs/MAGENTRA/commit/697ca278c03b7b39ce572db863b10ce74ef99fe5))
- **core:** prove key resolution order and the global-only secret file ([54b56c0](https://github.com/kalai-labs/MAGENTRA/commit/54b56c07065da265d98e48cadb657d030a64136e))
- **protocol:** prove live overrides and a disabled prompt cancels ([aa0a8b2](https://github.com/kalai-labs/MAGENTRA/commit/aa0a8b2e523eee26c59b8f8bd9353ea6737022ed))
- **core:** prove the symbol index locates, reuses and scores ([b0d80fa](https://github.com/kalai-labs/MAGENTRA/commit/b0d80fa54a6a7ddd2999eff83ef7e3e98e2238a4))
- **core:** prove sessions list, rename, archive and delete ([4a89fcb](https://github.com/kalai-labs/MAGENTRA/commit/4a89fcb49c34dbdba757988fdae82372b6e852ae))
- **core:** prove dangling tool_use blocks are repaired on replay ([5cf93f4](https://github.com/kalai-labs/MAGENTRA/commit/5cf93f43e6a247b2fcfb12f489ecf6b715df3446))
- **tui:** prove a profile writes .env and settings as the IDE does ([2f567a5](https://github.com/kalai-labs/MAGENTRA/commit/2f567a5117b49dd8777196005d9eed1e3863ed8f))
- **build:** prove syncTargets reaches all eight manifests byte-safely ([9954d70](https://github.com/kalai-labs/MAGENTRA/commit/9954d7057afa37c0c38b74cecd50012de4620b4d))
- **providers:** prove field rejections are dropped or renamed once ([56dd7f4](https://github.com/kalai-labs/MAGENTRA/commit/56dd7f4b5d3fc80957ad0fd20544e07a4567d8c2))
- **build:** prove a lab edit lands as an override file read live ([1252aeb](https://github.com/kalai-labs/MAGENTRA/commit/1252aeb2c485c8060ee5a22584cc68738c567f08))
- **build:** prove promote edits the literal in place and reverts ([7517306](https://github.com/kalai-labs/MAGENTRA/commit/7517306c3d0c04ca4e95d609a7c3869bae854c57))
- **build:** prove the lab never echoes its own writes to the browser ([8ae268e](https://github.com/kalai-labs/MAGENTRA/commit/8ae268e5a9a449ef8b9cf942f628d08c295016db))
- **tui:** scope the parity compiler check past background tasks ([14d27f6](https://github.com/kalai-labs/MAGENTRA/commit/14d27f6ab5c75bea450fe1daa9bee3af2d1bed92))
- **core:** prove context accounting sums the three input classes ([a473ae0](https://github.com/kalai-labs/MAGENTRA/commit/a473ae077f57262d1d3493906e2a9c8b32cb1307))
- **core:** prove the rate card and the per-model cost report ([95057bd](https://github.com/kalai-labs/MAGENTRA/commit/95057bde9e7e354ad8d2ee4596d0f3316c19f3de))
- **protocol:** prove one definition of the token algebra ([e425e61](https://github.com/kalai-labs/MAGENTRA/commit/e425e61eac3b159637200e31e2a1ec96cd6ce9d2))
- **providers:** prove usage normalization on both wire shapes ([9c027a2](https://github.com/kalai-labs/MAGENTRA/commit/9c027a228197453f18c689278c4f69f927caddf9))
- **tools:** prove the deletion scope split and its permission path ([206ef81](https://github.com/kalai-labs/MAGENTRA/commit/206ef81d550f7ee23866d4e65b9abcfbca7e759e))
- **core:** prove the overdrive prompt section contract ([76f3cad](https://github.com/kalai-labs/MAGENTRA/commit/76f3cad8a43c5a13f91b853f5e022120d2b1c371))
- **core:** prove the reuse gate reminds and never blocks ([834df89](https://github.com/kalai-labs/MAGENTRA/commit/834df897098fef4e5727f83e5ac17bdc25956389))
- **core:** prove the session report's numbers and its command ([ee5a5be](https://github.com/kalai-labs/MAGENTRA/commit/ee5a5be2fb18d1797fe5f64b5f963730959b1a21))
- **core:** prove the five permission stances and their order ([1f87765](https://github.com/kalai-labs/MAGENTRA/commit/1f8776536a7e9bfa18df51f9565fdcb8a0459f12))
- **core:** prove overdrive asks for nothing but a deny rule ([85dd75f](https://github.com/kalai-labs/MAGENTRA/commit/85dd75fb45958eac4077e23b4807c412bf9f122e))
- **core:** prove the command shape behind an always-allow grant ([73feb11](https://github.com/kalai-labs/MAGENTRA/commit/73feb11b40757b703bebae010d7c7c9ffea688ed))
- **core:** prove the .magentra and .env* protection ([83c94ad](https://github.com/kalai-labs/MAGENTRA/commit/83c94ad375c825f98ca588ef3330b483315f1121))
- **tools:** prove the bash predicate and the process tree kill ([a4de388](https://github.com/kalai-labs/MAGENTRA/commit/a4de3889c5270cd579f7ee0a26378651f987698b))
- **tools:** prove the bash tool's tracked working directory ([a1dc95f](https://github.com/kalai-labs/MAGENTRA/commit/a1dc95f47bbdfa99f0c63f75e2a097bb72a9bd38))
- **tools:** prove the grep tool's modes, limits and errors ([90756fa](https://github.com/kalai-labs/MAGENTRA/commit/90756faea8d112c1fcbd98920464e828fea7ae7d))
- **tools:** prove exit-worktree refuses to lose work ([394cb4e](https://github.com/kalai-labs/MAGENTRA/commit/394cb4e9106882758dacb6440f0b1cbcad3a3eac))
- **core:** prove the runtime evidence floor and its reminder ([c4f16b3](https://github.com/kalai-labs/MAGENTRA/commit/c4f16b3209ccfcf435c821439635af19648fbec6))
- **core:** prove the self-check rung's two closings ([a691aeb](https://github.com/kalai-labs/MAGENTRA/commit/a691aeb6a97119be940da9eb6bbf326a57dba70f))
- **core:** prove an honest gap outranks a manufactured green ([865ede9](https://github.com/kalai-labs/MAGENTRA/commit/865ede9deff73d27e86b6b9b7d67bdf501fa2252))
- **core:** prove the pre-turn snapshot in overdrive ([111eec7](https://github.com/kalai-labs/MAGENTRA/commit/111eec7c9b997de147b0b7610513eddb35eda302))
- **build:** withhold packaged-artifact tests unless they are asked for ([5d33656](https://github.com/kalai-labs/MAGENTRA/commit/5d33656a17efe67129b8197295d55032c8bd36c5))
- **host:** prove the NDJSON wire the app spawns ([b0ad99e](https://github.com/kalai-labs/MAGENTRA/commit/b0ad99e63a1aa17e0a045ee5d452accba53db08f))
- **core:** prove the hook lifecycle and its exit codes ([9695969](https://github.com/kalai-labs/MAGENTRA/commit/9695969ff164cdef1901a3e078747562839ab6f5))
- **core:** prove the deletion guard outranks broad grants ([afdb2cd](https://github.com/kalai-labs/MAGENTRA/commit/afdb2cd6a345591528ff8a14adf19ea9168582f4))
- **tui:** prove the packaged and dev engine boot paths ([b50c918](https://github.com/kalai-labs/MAGENTRA/commit/b50c9186e8c20087f2705ce5632361a4dde948ef))
- **tui:** prove the tty dispatch hands off to the gui ([a724152](https://github.com/kalai-labs/MAGENTRA/commit/a7241528ee839d91371e876a200ac322b52ffd89))
- **tui:** prove the workspace and resume argument parsing ([7855662](https://github.com/kalai-labs/MAGENTRA/commit/7855662c98237f8a85635e7b0aba68fe369d23e6))
- **tools:** prove the version tool's git reads never write ([992eda8](https://github.com/kalai-labs/MAGENTRA/commit/992eda8ed55f29bf5974a792f3a563bc0a87890e))
- **tools:** prove the commit-message hook rejects bad subjects ([29d8c3c](https://github.com/kalai-labs/MAGENTRA/commit/29d8c3c414531c28f4e044420ce30e4e16798450))
- **tools:** prove Prompt Lab refuses to serve an unbuilt engine ([de6a134](https://github.com/kalai-labs/MAGENTRA/commit/de6a1340c72c0bba7d1df416264251eeabeb9eae))
- **tools:** prove the catalog reflects the real prompt registry ([56b79e6](https://github.com/kalai-labs/MAGENTRA/commit/56b79e690efb0e7ddb700442dfaae0122a009374))
- **app:** prove the mac artifact config and the windows truth ([413c9b6](https://github.com/kalai-labs/MAGENTRA/commit/413c9b622bc87a52373fe88a5ae1c4e331f26c30))
- **app:** prove the windows artifact builds, launches and is asInvoker ([fc338d3](https://github.com/kalai-labs/MAGENTRA/commit/fc338d3268d048813ae8a4337f5e16ee57ebf8c5))
- fix the failed tests on mac ([4fe2a45](https://github.com/kalai-labs/MAGENTRA/commit/4fe2a458375311bb6ce4e8c117e29a25fa66e627))
- test fixes ([438b921](https://github.com/kalai-labs/MAGENTRA/commit/438b9214df489bcece6367ce465455768b8f75b3))

[Compare with v0.18.0](https://github.com/kalai-labs/MAGENTRA/compare/v0.18.0...v0.19.0)

## 0.18.0 — 2026-09-09

### Features

- new context feature ([e7cb971](https://github.com/kalai-labs/MAGENTRA/commit/e7cb9718d25cae27a309b76665f398c3c315d1dc))

### Bug fixes

- added missing scripts ([5ff1b69](https://github.com/kalai-labs/MAGENTRA/commit/5ff1b6909f0966d32d1903b6ca1f2f4156088d97))

[Compare with v0.17.4](https://github.com/kalai-labs/MAGENTRA/compare/v0.17.4...v0.18.0)

## 0.17.4 — 2026-09-05

### Bug fixes

- **build:** repair bundle build; add GLM-5 Terminal-Bench results ([7808279](https://github.com/kalai-labs/MAGENTRA/commit/78082790e441f16b0dfe18f528d97762fdc18f00))
- **build:** key must reach native harbor agents; add perf-debug brief ([d7a50cf](https://github.com/kalai-labs/MAGENTRA/commit/d7a50cf82495657534667cdbba052930a0212334))
- **build:** job names must be unique on resume; add Terminus 2 control ([1ac05ca](https://github.com/kalai-labs/MAGENTRA/commit/1ac05caf0b6a7fad54bdf692b4b92bdd240cfe4e))
- **engine:** compact at the user's context window, recover overflow ([273f1dc](https://github.com/kalai-labs/MAGENTRA/commit/273f1dc630a70fce92518c83a1c6cc82b31e42c6))
- **engine:** size the compaction summarizer from the context window ([5e0ae76](https://github.com/kalai-labs/MAGENTRA/commit/5e0ae76ef81c65ad4b48d9e286b6cb3f1b123cc8))

### Performance

- improvement in general to the harness - Prompt and Bugfix ([93ec4de](https://github.com/kalai-labs/MAGENTRA/commit/93ec4de53f8355cb3dc60557c7e0183672bae1ec))

### Documentation

- **docs:** retire the 52.4% target in the perf-debug brief ([b586f6b](https://github.com/kalai-labs/MAGENTRA/commit/b586f6b6888f7136702ad83e0b8c51db69084f46))
- **docs:** converged harness-performance state ([006f731](https://github.com/kalai-labs/MAGENTRA/commit/006f73110469baadc6aeb6c3f3ee7408254423f9))
- **docs:** delete four superseded benchmark documents ([3e85bc9](https://github.com/kalai-labs/MAGENTRA/commit/3e85bc9f8cd06de2ed4a673e881247c8b647d7b4))
- **docs:** note the context-limit silent death and cutoff loop ([184c3cb](https://github.com/kalai-labs/MAGENTRA/commit/184c3cbfc58a142f03cd358217ed1ff5650b4c5c))

### Chores

- **build:** ignore LaTeX intermediates under docs/paper ([01f3a1a](https://github.com/kalai-labs/MAGENTRA/commit/01f3a1a26fc86bcfb5827f369020d9f6a4f0eecf))

[Compare with v0.17.3](https://github.com/kalai-labs/MAGENTRA/compare/v0.17.3...v0.17.4)

## 0.17.3 — 2026-08-09

### Bug fixes

- new tui enhancements ([b3d4c97](https://github.com/kalai-labs/MAGENTRA/commit/b3d4c977887fbb28ff1c8c249bd9b6cb7a143c25))

[Compare with v0.17.2](https://github.com/kalai-labs/MAGENTRA/compare/v0.17.2...v0.17.3)

## 0.17.2 — 2026-08-08

### Bug fixes

- **app:** console-subsystem exe so the magentra command gets a real TTY ([0410e32](https://github.com/kalai-labs/MAGENTRA/commit/0410e32880c72186daf33d800c6e731502182a5c))

[Compare with v0.17.1](https://github.com/kalai-labs/MAGENTRA/compare/v0.17.1...v0.17.2)

## 0.17.1 — 2026-08-08

### Bug fixes

- **app:** per-user install boot rescue + console handles for magentra ([03def73](https://github.com/kalai-labs/MAGENTRA/commit/03def737cc575bac5fc234b2d24040c1ba5e1066))

[Compare with v0.17.0](https://github.com/kalai-labs/MAGENTRA/compare/v0.17.0...v0.17.1)

## 0.17.0 — 2026-08-08

### Features

- new feature , tui of magentra ([3951177](https://github.com/kalai-labs/MAGENTRA/commit/39511773a4c4b196729360c786fea81776c5f561))

[Compare with v0.16.10](https://github.com/kalai-labs/MAGENTRA/compare/v0.16.10...v0.17.0)

## 0.16.10 — 2026-08-07

### Documentation

- magentra docs ([ebb1019](https://github.com/kalai-labs/MAGENTRA/commit/ebb101934d317eba99a4d29a615200b57ccd2f84))

[Compare with v0.16.9](https://github.com/kalai-labs/MAGENTRA/compare/v0.16.9...v0.16.10)

## 0.16.9 — 2026-08-02

### Bug fixes

- prompt enhancement ([4607baa](https://github.com/kalai-labs/MAGENTRA/commit/4607baa44ff862bc2525bad17195e482527cd201))

[Compare with v0.16.8](https://github.com/kalai-labs/MAGENTRA/compare/v0.16.8...v0.16.9)

## 0.16.8 — 2026-08-02

### Bug fixes

- fix at prompt lab ([5e98391](https://github.com/kalai-labs/MAGENTRA/commit/5e9839109c9fb73d38503b996f18fe2dff9d0682))

[Compare with v0.16.7](https://github.com/kalai-labs/MAGENTRA/compare/v0.16.7...v0.16.8)

## 0.16.7 — 2026-08-01

### Bug fixes

- bugfix at addons ([f129cc0](https://github.com/kalai-labs/MAGENTRA/commit/f129cc02598897ebd8c57a812e09b83491bde80f))

[Compare with v0.16.6](https://github.com/kalai-labs/MAGENTRA/compare/v0.16.6...v0.16.7)

## 0.16.6 — 2026-08-01

### Performance

- improved prompt lab ([cefddef](https://github.com/kalai-labs/MAGENTRA/commit/cefddef9cbf82d53b43d12c327d83882459114e9))

[Compare with v0.16.5](https://github.com/kalai-labs/MAGENTRA/compare/v0.16.5...v0.16.6)

## 0.16.5 — 2026-08-01

### Performance

- improvement on addon handling ([35f5626](https://github.com/kalai-labs/MAGENTRA/commit/35f562691e2b3c014cb9635d921006813b79f55d))

[Compare with v0.16.4](https://github.com/kalai-labs/MAGENTRA/compare/v0.16.4...v0.16.5)

## 0.16.4 — 2026-08-01

### Performance

- improvmeent on addons ([8f90bfa](https://github.com/kalai-labs/MAGENTRA/commit/8f90bfa9cc32153b1d4bda4531d25f86c3484c3b))

[Compare with v0.16.3](https://github.com/kalai-labs/MAGENTRA/compare/v0.16.3...v0.16.4)

## 0.16.3 — 2026-08-01

### Performance

- optimized building addons feature ([f5fa7b7](https://github.com/kalai-labs/MAGENTRA/commit/f5fa7b7b4d36c395572745b6f5f220caaa1a8028))

[Compare with v0.16.2](https://github.com/kalai-labs/MAGENTRA/compare/v0.16.2...v0.16.3)

## 0.16.2 — 2026-08-01

### Bug fixes

- on two tools ([97fcf2c](https://github.com/kalai-labs/MAGENTRA/commit/97fcf2c7cba9e5849b90ca6b493e96556d4cd617))

[Compare with v0.16.1](https://github.com/kalai-labs/MAGENTRA/compare/v0.16.1...v0.16.2)

## 0.16.1 — 2026-08-01

### Bug fixes

- fixing vision things ([417945f](https://github.com/kalai-labs/MAGENTRA/commit/417945f1774fcc837f7351aba7b2201e31652bc3))
- vision fix ([b824f64](https://github.com/kalai-labs/MAGENTRA/commit/b824f64758dfbf2d98333cce845e6e5736266460))
- auto compact to 1m ([b2efefe](https://github.com/kalai-labs/MAGENTRA/commit/b2efefe3c2a02a6e467306145395084749149f28))

[Compare with v0.16.0](https://github.com/kalai-labs/MAGENTRA/compare/v0.16.0...v0.16.1)

## 0.16.0 — 2026-07-31

### Features

- new vision feature ([edf264b](https://github.com/kalai-labs/MAGENTRA/commit/edf264bae43a0dcfa78b7527e2aa5e6e9e2fb744))

[Compare with v0.15.1](https://github.com/kalai-labs/MAGENTRA/compare/v0.15.1...v0.16.0)

## 0.15.1 — 2026-07-30

### Refactoring

- new addon ([7c08b7d](https://github.com/kalai-labs/MAGENTRA/commit/7c08b7dddf5428daa363ad72cf0971def461efb2))

[Compare with v0.15.0](https://github.com/kalai-labs/MAGENTRA/compare/v0.15.0...v0.15.1)

## 0.15.0 — 2026-07-30

### Features

- addon as a new feature and deletion of atlas ([67ad5df](https://github.com/kalai-labs/MAGENTRA/commit/67ad5dfa974dd969ef4df44be70dd3dc53f7b54f))

[Compare with v0.14.0](https://github.com/kalai-labs/MAGENTRA/compare/v0.14.0...v0.15.0)

## 0.14.0 — 2026-07-30

### Features

- new update mechanism ([7668706](https://github.com/kalai-labs/MAGENTRA/commit/7668706de53658273df7db2b88d719d0ffed8627))

### Documentation

- docs for update mechanism ([e721cb2](https://github.com/kalai-labs/MAGENTRA/commit/e721cb2d58f7576d6ebab8d922cb03669012d7d6))

[Compare with v0.13.0.1](https://github.com/kalai-labs/MAGENTRA/compare/v0.13.0.1...v0.14.0)

## 0.13.0.1 — 2026-07-30

### Continuous integration

- better prompt engineering ([9ea9b31](https://github.com/kalai-labs/MAGENTRA/commit/9ea9b31ea62a9807da9c2d41b6cba62baecca93d))

[Compare with v0.13.0.0](https://github.com/kalai-labs/MAGENTRA/compare/v0.13.0.0...v0.13.0.1)

## 0.13.0.0 — 2026-07-30

### Features

- rescale of the app ([6a47f44](https://github.com/kalai-labs/MAGENTRA/commit/6a47f449c57442b826106e23f4982f84e546f890))

[Compare with v0.12.1.1](https://github.com/kalai-labs/MAGENTRA/compare/v0.12.1.1...v0.13.0.0)

## 0.12.1.1 — 2026-07-30

### Documentation

- new docs ([bee4980](https://github.com/kalai-labs/MAGENTRA/commit/bee49804926aab5573657f83c45c3c94de1a30b2))

### Refactoring

- removed unused features part 1 ([5ebbb37](https://github.com/kalai-labs/MAGENTRA/commit/5ebbb37f7b7c7c100f41afff60011cedbceb9e3f))
- deleted unused features part 2 ([be3b850](https://github.com/kalai-labs/MAGENTRA/commit/be3b850e6fad25a69ab4cd445b78e44363768c8b))
- stale docs removed ([e52f74e](https://github.com/kalai-labs/MAGENTRA/commit/e52f74e5a649a54feaade507bf49938dd767e116))
- stale docs removed part 2 ([cba8d3e](https://github.com/kalai-labs/MAGENTRA/commit/cba8d3ed38eddc71e6651e88c00728d1b14f252b))
- cleanings ([bd994d3](https://github.com/kalai-labs/MAGENTRA/commit/bd994d37c2b349434772ac89084aae0625ac9b3c))
- cleaning continued ([c855ecf](https://github.com/kalai-labs/MAGENTRA/commit/c855ecfdee2472a9e8df9f782029bd7e960b98e1))

[Compare with v0.12.1.0](https://github.com/kalai-labs/MAGENTRA/compare/v0.12.1.0...v0.12.1.1)

## 0.12.1.0 — 2026-07-29

### Bug fixes

- fixes at prompt lab and prompts ([8bebf70](https://github.com/kalai-labs/MAGENTRA/commit/8bebf7099aa74b6232e13f250240235808cef05e))

### Refactoring

- fix ([76b6363](https://github.com/kalai-labs/MAGENTRA/commit/76b6363817013b0870de3f23e89e5115c93e326a))
- big refactors on prompt engineering ([6dbf65c](https://github.com/kalai-labs/MAGENTRA/commit/6dbf65c35f1f2951d2cc5cd37934ef3010aff9a8))
- refactor ([be42fed](https://github.com/kalai-labs/MAGENTRA/commit/be42fed19ccec3ae7dd9880bb6b0d292a95bc257))

[Compare with v0.12.0.0](https://github.com/kalai-labs/MAGENTRA/compare/v0.12.0.0...v0.12.1.0)

## 0.12.0.0 — 2026-07-28

### Features

- removed readability mode ([018a194](https://github.com/kalai-labs/MAGENTRA/commit/018a194d72fb6659ca35667c43b638c2c4b27739))

[Compare with v0.11.1.0](https://github.com/kalai-labs/MAGENTRA/compare/v0.11.1.0...v0.12.0.0)

## 0.11.1.0 — 2026-07-28

### Bug fixes

- bugfix ([2e9c678](https://github.com/kalai-labs/MAGENTRA/commit/2e9c678c742fa0e69c1f858a02b4868e1dc48573))

[Compare with v0.11.0.0](https://github.com/kalai-labs/MAGENTRA/compare/v0.11.0.0...v0.11.1.0)

## 0.11.0.0 — 2026-07-28

### Features

- new readability method ([29dfb51](https://github.com/kalai-labs/MAGENTRA/commit/29dfb510f8fd6c05aba1213a5e01bbc62a62bfc5))

### Refactoring

- removed careful mode ([95fd94f](https://github.com/kalai-labs/MAGENTRA/commit/95fd94f41a987c8cef92335f40c4277d01c34756))

[Compare with v0.10.1.0](https://github.com/kalai-labs/MAGENTRA/compare/v0.10.1.0...v0.11.0.0)

## 0.10.1.0 — 2026-07-28

### Bug fixes

- fix at windows full screen bug ([f5c9d48](https://github.com/kalai-labs/MAGENTRA/commit/f5c9d483480b513d7afd5357262925c65ae7a440))

[Compare with v0.10.0.0](https://github.com/kalai-labs/MAGENTRA/compare/v0.10.0.0...v0.10.1.0)

## 0.10.0.0 — 2026-07-28

### Features

- new overdrive mode ([aecc68b](https://github.com/kalai-labs/MAGENTRA/commit/aecc68b39304826f68f8b8eabf1d29d494b47032))
- **core:** add CAREFUL MODE plan-and-approve gate for OVERDRIVE ([b2cfab7](https://github.com/kalai-labs/MAGENTRA/commit/b2cfab707826762f2090e1176c0b5c6375687235))

### Bug fixes

- **tools:** skip the .magentra state dir in Glob unless asked ([493f21d](https://github.com/kalai-labs/MAGENTRA/commit/493f21dab2bf0a68bf766e45b8543eaea840a726))
- fix and improvements on careful mode ([d363293](https://github.com/kalai-labs/MAGENTRA/commit/d363293be36ce12e07e5feb3f976930aff65d1ef))
- new section to careful mode ([b26c506](https://github.com/kalai-labs/MAGENTRA/commit/b26c5061a2873be0d447a0dced4eb79c7c63ee9a))
- fixed the connection issues ([2dee9ff](https://github.com/kalai-labs/MAGENTRA/commit/2dee9fffe1f6b30abd0ef2062677fb46d4eb85c5))
- token counting fix ([8b0a0e7](https://github.com/kalai-labs/MAGENTRA/commit/8b0a0e7184d047630a19ed12d66b736d8b5381b5))
- fix on the careful mode ([072e8d8](https://github.com/kalai-labs/MAGENTRA/commit/072e8d8dd69ca1c7a427a151278fe250825ab641))
- bugfixes ([43c6da2](https://github.com/kalai-labs/MAGENTRA/commit/43c6da247add306ce459e855ffff3e177bc38bbc))
- fix at careful mode ([04dc4cd](https://github.com/kalai-labs/MAGENTRA/commit/04dc4cd5f0ba26f026dc859e8143da11376fcb82))

### Documentation

- record CAREFUL MODE status and the open issues ([7cc3e6a](https://github.com/kalai-labs/MAGENTRA/commit/7cc3e6a2a3e4d729187f536b49983f820d4331ad))

### Refactoring

- removed brandings ([344999c](https://github.com/kalai-labs/MAGENTRA/commit/344999c4283e1e23742498d04f5bdbf6c48dde6e))
- brand removals ([282a4e4](https://github.com/kalai-labs/MAGENTRA/commit/282a4e4ec5e0366fe5f34c432eefe2748fdcdc85))
- improvements on careful mode ([f0fe125](https://github.com/kalai-labs/MAGENTRA/commit/f0fe125fcca4c22b6d7e6165059d9a5e3a809b30))

### Chores

- track the bigboycoding skill alongside its checks ([7ddf5bd](https://github.com/kalai-labs/MAGENTRA/commit/7ddf5bd721bbb8adcedb8bcc52febd50e7b28ad1))

[Compare with v0.9.0.0](https://github.com/kalai-labs/MAGENTRA/compare/v0.9.0.0...v0.10.0.0)

## 0.9.0.0 — 2026-07-25

### Features

- new feature, concurrent tabs ([342ba4f](https://github.com/kalai-labs/MAGENTRA/commit/342ba4fcec1bc904940e35894242ea47f625a86b))
- new multi-tab concurrent feature ([6eb8825](https://github.com/kalai-labs/MAGENTRA/commit/6eb88256cbe3559bc508501635ead9684a0f0930))

### Bug fixes

- bugfixes at </think> ([ba46bae](https://github.com/kalai-labs/MAGENTRA/commit/ba46baee9fc1ab2598946a45dfb7ed72e6832860))
- the max output token fix ([b3ca511](https://github.com/kalai-labs/MAGENTRA/commit/b3ca5119083aba8101d2eb1f3cb7aba11eda7701))
- fix at concurrency ([2a64922](https://github.com/kalai-labs/MAGENTRA/commit/2a6492272c435fef6315ce702830a30c52ed99ff))
- fix at multi screen feature ([ac40b29](https://github.com/kalai-labs/MAGENTRA/commit/ac40b29061ce452a3e44a3be4f40f7ef28df3346))
- fixes at concurrent tabs ([da477b2](https://github.com/kalai-labs/MAGENTRA/commit/da477b2296b7f9a2ae9a4f04a3c1e104e232e6e8))
- fixes at concurrent tabs ([033a82f](https://github.com/kalai-labs/MAGENTRA/commit/033a82f4d9b01f3dfc3ce39a9d9a02e9901838b4))
- fixing issues at multi-tab concurrent workflows ([a0587ad](https://github.com/kalai-labs/MAGENTRA/commit/a0587ad12bba62fe057bedc8fd903d16379e6bf4))
- fixed bugs at ui ([f3ca96c](https://github.com/kalai-labs/MAGENTRA/commit/f3ca96c7e597273c78b29aea0023e9f62223d2d0))

### Documentation

- cleaned up skills to build them again afterwards ([73adbe0](https://github.com/kalai-labs/MAGENTRA/commit/73adbe03b8f45fa4990d322fc27b2bf72a967129))

[Compare with v0.8.0.0](https://github.com/kalai-labs/MAGENTRA/compare/v0.8.0.0...v0.9.0.0)

## 0.8.0.0 — 2026-07-22

### Features

- new attach file ability ([6f11758](https://github.com/kalai-labs/MAGENTRA/commit/6f117583fe92b36823e90b33bd275d4bb023706b))

### Bug fixes

- removed hardcoded things ([b2b2a53](https://github.com/kalai-labs/MAGENTRA/commit/b2b2a53ee245fe27541ed453b691dc50e35838b0))
- bug fixed from ui ([7be8c06](https://github.com/kalai-labs/MAGENTRA/commit/7be8c06c1106f2c73a317406ae0a6f5eb738ac9c))
- fixed ui bugs ([1b780b2](https://github.com/kalai-labs/MAGENTRA/commit/1b780b25cd4835733ab398c02066bd8630ff9cdd))

[Compare with v0.7.1.0](https://github.com/kalai-labs/MAGENTRA/compare/v0.7.1.0...v0.8.0.0)

## 0.7.1.0 — 2026-07-22

### Bug fixes

- fix at CI distribution script ([a03030c](https://github.com/kalai-labs/MAGENTRA/commit/a03030c8ec17af75262c28accaab151238b93128))

[Compare with v0.7.0.0](https://github.com/kalai-labs/MAGENTRA/compare/v0.7.0.0...v0.7.1.0)

## 0.7.0.0 — 2026-07-22

### Features

- new features ([4da668b](https://github.com/kalai-labs/MAGENTRA/commit/4da668b7c883f6080e94ea6fad6b98288376fef9))
- api provider profiles can now be saved ([1657dc9](https://github.com/kalai-labs/MAGENTRA/commit/1657dc92da02e652cf9352d1ddaedc1d4778cc8a))
- new /session feature and others ([bafd0cd](https://github.com/kalai-labs/MAGENTRA/commit/bafd0cd047e032755cb922ffc71ae24946b18b8e))

### Bug fixes

- enriched the non-overdrive mode permissions ([fa50d49](https://github.com/kalai-labs/MAGENTRA/commit/fa50d494fef6ee7bbe75621547920a1471c3c929))
- fix on stuff ([078d7e4](https://github.com/kalai-labs/MAGENTRA/commit/078d7e4678add4234e99f62034c1d584fbca8f6b))

### Refactoring

- refactoring how skills work, or built ([0f041fe](https://github.com/kalai-labs/MAGENTRA/commit/0f041fe0cf09fcd1e1fb6865c7de6e22f39a04f2))

### Tests

- tested skills ([9c7902c](https://github.com/kalai-labs/MAGENTRA/commit/9c7902c7fb943a98c659319212885b84bab71d8c))

### Code style

- new theme 'matrix' added ([6c623ce](https://github.com/kalai-labs/MAGENTRA/commit/6c623cef9d6a9a9bf958aadcbf5ef303068f8e2f))
- new styles added ([fcbd14c](https://github.com/kalai-labs/MAGENTRA/commit/fcbd14c26bc1ad97f041b6ba25c2c95794c06c88))

[Compare with v0.6.0.0](https://github.com/kalai-labs/MAGENTRA/compare/v0.6.0.0...v0.7.0.0)

## 0.6.0.0 — 2026-07-20

### Features

- new feature OVERDRIVE ([64ebb20](https://github.com/kalai-labs/MAGENTRA/commit/64ebb20e17415c87c5b04eb29f194df38588bef7))

[Compare with v0.5.3.1](https://github.com/kalai-labs/MAGENTRA/compare/v0.5.3.1...v0.6.0.0)

## 0.5.2.1 — 2026-07-18

### Code style

- how to connect local llms ([000755e](https://github.com/kalai-labs/MAGENTRA/commit/000755ef772e8986084d867b5dd72a28b8056ced))

[Compare with v0.5.2.0](https://github.com/kalai-labs/MAGENTRA/compare/v0.5.2.0...v0.5.2.1)

## 0.1.0.0 — 2026-07-14

The first release.

### Features

- add versioning mechanism to MAGENTRA ([7739e43](https://github.com/kalai-labs/MAGENTRA/commit/7739e43a4e2ec225f0d73dda6d18fca89bfc804c))

### Bug fixes

- **release:** run the version tests on Node 20 ([ca4d0dc](https://github.com/kalai-labs/MAGENTRA/commit/ca4d0dca090203e079d2d7d034cae6492d767182))
