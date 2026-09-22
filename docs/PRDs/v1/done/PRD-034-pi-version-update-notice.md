# PRD-034 — Pi update banner: on in a source checkout, off in an installed LeanPi

**Status:** DONE
**Complexity:** 2 (LOW) — 3 implementation files, one build/release boundary crossed (dependency bump) but no new module or state; risk override: none.
**Owner:** LeanPi maintainers
**Depends on:** None

## Context

Interactive Pi checks `https://pi.dev/api/latest-version` at startup and, when a
newer release exists, renders an **Update Available** banner:

> New version 0.87.0 is available. Run `pi update`

Pi is not installed globally and is not self-managed here: the launcher runs the
copy this package depends on (`resolvePiCli`, `src/cli/launch.ts`), and the
version is whatever `package.json` pins. So the banner's suggested `pi update`
never moves the version a LeanPi session runs under.

Whether that is noise depends on who is looking at it:

- **A source checkout** — the maintainer's working copy. A newer Pi is exactly
  what they need to hear about, because the response is to bump the pin in
  `package.json`. The banner is the signal.
- **An installed package** — `npm install leanpi` / `npx leanpi`. The operator
  cannot act on it; the version is fixed by the dependency. The banner only asks
  for something they cannot do from the session that showed it.

Pi exposes one documented switch for exactly this check:
`PI_SKIP_VERSION_CHECK` (`@earendil-works/pi-coding-agent` `docs/settings.md`
§"Update check"; `dist/utils/version-check.js:66`). It gates only the
latest-version request — not model-catalog refresh, not package-update checks —
which is why it is the right switch rather than `PI_OFFLINE`.

The published tarball ships `bin`, `dist`, `skills`, `themes` and `vendor` and
never `.git` (`package.json` `files`). A `.git` beside the package root is
therefore the difference between a working copy and an unpacked package, with no
new manifest field or env var to keep in sync.

The pinned Pi was also behind: `package.json` asked for `^0.86.1` while 0.87.0
was current. 0.87.0 carries breaking changes for extension consumers
(`shouldStopAfterTurn` removal, `ContextEditEntry` in the `SessionEntry` union,
`TurnEndEvent`/`AgentBeforeSettleEvent` shape changes, canonical
`SessionManager` context). LeanPi uses none of those APIs (grep clean), so the
bump is mechanical, but it still needed the suite to prove it.

## Solution

1. `src/cli/launch.ts` — new `sourceCheckout(root = packageRoot())` (`existsSync`
   of `.git` beside the package root) and `launchEnv(flags, jevWarned, base,
   root)`, which owns the child environment the launcher already built inline in
   `bin/leanpi.js`. It forwards the `LEANPI_*` session flags and adds
   `PI_SKIP_VERSION_CHECK: "1"` **only when not a source checkout**. Extracting
   it moves a decision out of process plumbing and into the module the file's own
   header says stays testable without spawning anything.
2. `bin/leanpi.js` — the spawn env is now `launchEnv(flags, jevWarned)`.
3. `package.json` — `@earendil-works/pi-agent-core`, `pi-ai`,
   `pi-coding-agent`, `pi-tui` from `^0.86.1` to `^0.87.0`;
   `pnpm-workspace.yaml` `minimumReleaseAgeExclude` widened to admit 0.87.0;
   `pnpm-lock.yaml` regenerated.

Not disabled: Pi's **Package Updates Available** notice for installed
extensions. It is gated by `PI_OFFLINE` only, which also stops model-catalog
refresh; turning it off is a larger behavior change than the ask.

## Acceptance Criteria

- [x] AC-1 [local]: The Pi child gets `PI_SKIP_VERSION_CHECK=1` from an installed
      package and does not get it from a source checkout, with the session flags
      forwarded either way — Evidence: `tests/cli/launch.spec.ts` "skips Pi's
      update banner in an installed package, but leaves it on in a source
      checkout" (red before the fix: `TypeError: (0 , launchEnv) is not a
      function`).
- [x] AC-2 [local]: Through the real entry point, both branches carry the right
      child environment — Evidence: `node bin/leanpi.js --help` under a
      `NODE_OPTIONS=--require` probe that only fires in the Pi child printed
      `{"PI_SKIP_VERSION_CHECK":null}` from the checkout and
      `{"PI_SKIP_VERSION_CHECK":"1"}` from a simulated install (copied `bin` +
      `dist`, real `node_modules`, no `.git`).
- [x] AC-3 [local]: LeanPi runs on 0.87.0 and the suite is green on it —
      Evidence: `node bin/leanpi.js --version` → `0.87.0`; `pnpm test` → 659
      passed, 10 skipped, 111 files (113); `pnpm typecheck` clean; `pnpm lint`
      exit 0 (pre-existing warnings only); `pnpm install --frozen-lockfile`
      resolves 0.87.0 for all four Pi packages.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Banner off in an installed LeanPi | `node bin/leanpi.js` (no `.git` at package root) → `launchEnv` → spawn env → Pi `checkForNewPiVersion` | Pi's `pi.dev` latest-version request and its "Update Available" banner; the extension package-update notice is untouched | AC-1, AC-2 |
| Banner on in a source checkout | same path with `.git` beside the package root | Unchanged Pi behavior — the maintainer still learns a newer Pi is out | AC-1, AC-2 |
| Session flags forwarded | `--no-jev` / `--safety` → `launchEnv` → `LEANPI_NO_JEV` / `LEANPI_SAFETY` | Unchanged behavior, moved into the tested module | AC-1, AC-2 |
| Pi 0.87.0 | `resolvePiCli` → `node_modules/@earendil-works/pi-coding-agent@0.87.0` | 0.86.1 | AC-3 |

## Verification (2026-09-21)

- Focused: `pnpm vitest run tests/cli/launch.spec.ts` → 14 passed; the new case
  fails before `launchEnv` exists.
- Runtime: probe-injected child env read back `PI_SKIP_VERSION_CHECK=null` from
  the checkout and `"1"` from a simulated install; `node bin/leanpi.js --version`
  → `0.87.0`; `--help` still prints Pi's own help.
- Full: `pnpm test` → 659 passed, 10 skipped; `pnpm typecheck` clean;
  `pnpm lint` exit 0.
- Dependency install: `pnpm install --frozen-lockfile` (CI) resolves
  `@earendil-works/{pi-agent-core,pi-ai,pi-coding-agent,pi-tui}@0.87.0`.

**Not proven by the harness:** no live TTY session was booted, so "the banner
renders / does not render" is proven by the switch reaching Pi and Pi's own
`checkForNewPiVersion` honoring `PI_SKIP_VERSION_CHECK`, not by watching the
banner appear and disappear. The installed branch was exercised with a simulated
package root (real `dist`, real `node_modules`, `.git` absent), which is the
property `sourceCheckout` tests, not a real `npm pack` install. The dependency
bump to 0.87.0 was already present in the working tree when this PRD was
written; it was verified here, not authored here.

## Open Questions

None.
