# PRD-041 — Pi subagents in LeanPi

**Status:** DONE — verified 2026-09-22
**Owner:** LeanPi maintainers
**Dependency:** PRD-040 production audit, stacked PR #4
**Version:** pi-subagents 0.70.1, pinned in package.json

## Problem and decision

LeanPi had no usable subagent delegation. Calling the upstream factory inside LeanPi's extension also produced duplicate tool and /run registrations when the operator had pi-subagents installed globally. The user requested a default maximum of three concurrent children **per delegation run**, configurable through commands.

LeanPi now loads one upstream resource path through Pi's own loader. It reuses an enabled global copy only when its package identity and version match the pin; otherwise it loads the pinned dependency. The CLI passes that path as an extension argument, and the SDK passes it as an additional extension path with the same SettingsManager it uses for loading. Pi merges identical resource paths. LeanPi's own extension installs the limit command and model tool-call clamp, without calling upstream's factory again.

The CLI selects from global resources before Pi's project trust decision. It reads project settings and manifests as data and rejects a known project pi-subagents copy that could otherwise load later. A malformed upstream config, an incompatible or multiple enabled copies, or a configured but missing source fails with an actionable error before loading; selection never installs packages. A physical project copy is conservatively rejected even when a project filter would disable it. The operator can move or remove that copy.

## Operator behavior

- Upstream's config at getAgentDir()/extensions/subagent/config.json gets globalConcurrencyLimit: 3 and asyncByDefault: false only when those keys are absent. Unrelated keys and explicit valid operator values are preserved. getAgentDir() honors PI_CODING_AGENT_DIR; the SDK agentDir option independently controls resource discovery and does not change the process environment.
- /subagents-limit shows active and saved values, accepts a positive safe integer, and resets to three. Upstream captures config once when it starts, so a saved change takes effect after /reload or restart.
- One upstream run has one semaphore. Five held children peak at exactly three by default and two after changing the limit to two. An explicit lower model workflow override is preserved; a higher one is clamped to the operator value. Separate runs do not share a process or session cap.
- Native Pi parent models can call subagent. External-harness parents can use host-owned /run with an available Pi-native child model; their vendor CLI cannot call Pi tools. Foreground children inherit registered in-process providers. Detached async children need their own visible provider.
- Upstream includes the built-in delegate agent. /run delegate accepts a task without a custom agent file. Upstream /subagent-cost reports child usage separately from LeanPi /cost. Trusted direct extension/RPC callers use upstream's API outside the model tool-call clamp.

## Acceptance evidence

| Criterion | Evidence |
| --- | --- |
| CLI and SDK register one upstream copy, with no run suffix or tool conflict | Real CLI entry loader test; global configured-copy SDK test (tests/subagents/cli-entry.spec.ts, duplicate.spec.ts) |
| One configured /run dispatches one child and one terminal card, preserves an unrelated global command and parent continuation | tests/subagents/duplicate.spec.ts: 2 passed |
| Default 3, changed 2, lower override 2, higher override clamped 3, operator 6 negative control | tests/subagents/concurrency.spec.ts: 6 passed at a local provider boundary |
| Command show/set/reset, active versus saved, malformed input and upstream config preservation | tests/subagents/limit.spec.ts: 12 passed |
| Global copy selection, missing/version/multiple rejection, project trust and resource path boundaries | tests/subagents/native-selection.spec.ts: 19 passed after 5 failing then 16 passing, and 3 failing then 19 passing regression cycles |
| Host /run and native SDK turns, including external-parent host command | tests/subagents/run.spec.ts and external-run.spec.ts |
| Actual published layout boots launcher and SDK with active delegation tools and /run | tests/cli/packaging.spec.ts: 1 passed from npm pack tarball, using the installed dependency tree offline |

**Final repository gates:** pnpm build, pnpm typecheck, and pnpm lint passed; pnpm test passed with 924 tests, 10 skipped, 144 test files passed and 2 skipped. The packed-consumer test passed separately before the full suite.

## Delivery boundaries

This change does not create a second scheduler, a session-wide child cap, a vendor-CLI tool adapter, or a child-cost merger. No paid-provider or live vendor-CLI billing proof was run. The local provider fixture exercises actual Pi child requests, command dispatch and overlap. The CLI project-copy guard favors trust over accepting disabled physical copies; the README names the move/remove remedy.
