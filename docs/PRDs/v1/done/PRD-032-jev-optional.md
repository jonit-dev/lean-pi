# PRD-032 — JEV optional, with a yellow startup warning

**Status:** DONE
**Complexity:** 1 (LOW)
**Owner:** joao
**Depends on:** None

## Context

`leanpi` refuses to start without a JEV key. `requireJev()`
(`src/cli/bootstrap.ts:308`) throws `MissingJevKeyError`, and `bin/leanpi.js:79`
turns that into `process.exit(2)` before a session exists. `--no-jev` is the only
way through. Inside the TUI, the `session_start` handler (`src/index.ts:668`)
blocks the first turn on `ui.input("LeanPi needs a JEV API key…")`.

This contradicts the project's own stated non-goal (`INDEX.md`: *"no JEV
requirement for basic operation"*). Every JEV site already has a deterministic
fallback — the harness works without a key, it just routes worse and spends more
tokens.

Inspected: `src/cli/bootstrap.ts` (`requireJev`, `startupBanner`, `jevLine`),
`bin/leanpi.js`, `src/index.ts` (`session_start`), `src/jev/credentials.ts`,
`src/commands/jev.ts` (`/jev key set`), `tests/cli-bootstrap.spec.ts`,
`tests/extension-surface.spec.ts`.

## Solution

Missing key becomes a warning, not a refusal.

1. `requireJev()` stops throwing. No key → `{ source: "not configured" }`.
   `MissingJevKeyError` and its `bin` catch branch are deleted (this change
   orphans them).
2. One new export, `jevWarning(source): string[] | null` — the three lines below
   when `source` starts with `"not configured"` and is not the `--no-jev` or
   `jev.mode` variant, `null` otherwise. Deliberate opt-outs get no warning: the
   operator already answered the question.
3. `bin/leanpi.js` prints it under the banner in yellow (SGR 33, gated on
   `process.stderr.isTTY` like the banner), then sets `LEANPI_JEV_WARNED=1` on
   the spawned child.
4. `src/index.ts` `session_start`: the blocking `ui.input` prompt is deleted. If
   no key resolves, JEV is not disabled, and `LEANPI_JEV_WARNED` is unset (the
   extension was loaded into `pi` directly, not through `leanpi`), the same lines
   go out as one `ctx.ui.notify(…, "warning")`. `/jev key set <key>` remains the
   in-session way to configure it.

The warning, verbatim:

```
JEV not configured — LeanPi routes on heuristics and spends more tokens per task.
  Get a key: https://typesafe.ai
  Set it:    leanpi --jev-key <key>   |   export JEV_API_KEY=<key>   |   /jev key set <key>
```

**Assumption (still open):** `https://typesafe.ai` is the signup URL. The repo only
records the API endpoint (`api.typesafe.ai/v1/systemone`) and the docs host
(`docs.typesafe.ai`). If the real signup page differs, it is a one-line change in
`jevWarning`.

Risk: none to routing — `autoConfigure()` already falls back to the
cheapest-first ladder when JEV has no confident answer (`src/cli/bootstrap.ts:45`),
so a keyless first run writes a config rather than failing.

## Acceptance Criteria

- [x] AC-1 [local; actor: agent]: `leanpi` with no key in config, credential store, `$JEV_API_KEY` or `.env` reaches `launchPlan` and spawns Pi instead of exiting 2 — Evidence: E1 (`requireJev` returns `{ source: "not configured" }`, no throw); runtime smoke with isolated `HOME`/`XDG_CONFIG_HOME` and a fake `codex` vendor exited 0 (not 2) with Pi's own output on stderr.
- [x] AC-2 [local; actor: agent]: with no key, startup output carries the three warning lines — token cost, `https://typesafe.ai`, and the `--jev-key`/`JEV_API_KEY` setup — yellow on a TTY and plain otherwise; with a key resolved, no warning is emitted — Evidence: runtime smoke printed the three lines plainly on a pipe and wrapped them in `ESC[33m`…`ESC[0m` under a pty; a stored key (`--jev-key`, then the next run) produced `JEV on (credential store)` and no warning; E1 covers the `jevWarning` cases.
- [x] AC-3 [local; actor: agent]: `--no-jev` and `jev.mode: disabled` start with no "get a key" warning, and `--no-jev` still disables JEV sites in the child — Evidence: runtime smoke `--no-jev` printed no warning and a `not configured (--no-jev)` banner; E1 `jevWarning` opt-out cases; E2 `--no-jev` disables the session control plane.
- [x] AC-4 [local; actor: agent]: a TUI `session_start` with no key issues no `ui.input` prompt and one `warning` notification carrying the same lines — Evidence: E2 first test (`inputs` empty, exactly one notice containing `typesafe.ai`).
- [x] AC-5 [local; actor: agent]: with `LEANPI_JEV_WARNED=1` set (launched through `leanpi`), `session_start` emits no warning — the user sees it once per run — Evidence: E2 second test (zero notices); `bin/leanpi.js` sets the flag in the child env only when it printed the warning.
- [x] AC-6 [local; actor: agent]: `README.md` no longer states the key is required; it describes JEV as optional and token-saving — Evidence: README.md "The JEV key is optional, and it pays for itself."

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Start with no JEV key | `leanpi` → `bin/leanpi.js` `requireJev()` → `launchPlan` + yellow warning on stderr | Deletes the `MissingJevKeyError` throw and its `bin/leanpi.js` exit-2 branch | AC-1 / AC-2 / E1 + smoke |
| Warning inside a directly-loaded extension | `pi --extension dist/leanpi.js` → `session_start` → `ctx.ui.notify(warning)` | Deletes the blocking `ui.input` key prompt and the `declined` bookkeeping it needed; `/jev key set` is the remaining in-session path | AC-4 / AC-5 / E2 |

## Execution Phases

#### Phase 1: `leanpi` starts without a key and says why that costs tokens
**Status:** DONE
**ACs:** AC-1, AC-2, AC-3, AC-6
**Files:**
- `src/cli/bootstrap.ts` — `requireJev` returns `{ source: "not configured" }` instead of throwing; delete `MissingJevKeyError`; add `jevWarning(source)`; update the module header comment, which currently documents the refusal as the design.
- `bin/leanpi.js` — drop the `MissingJevKeyError` import and catch branch; print `jevWarning` under the banner, yellow on TTY; add `LEANPI_JEV_WARNED=1` to the child env when it printed.
- `README.md` — replace "**The JEV key is required.**" (lines ~69-78) with the optional framing; refresh the sample banner line if it shows a configured key.
- `src/index.ts` — drop the `MissingJevKeyError` re-export if one exists.

**Implementation:** `jevWarning` owns the text — `bin` and the extension both read
it, so there is one copy. Yellow is applied at the call site with the existing
`style.color`/`isTTY` gate, not baked into the strings, so a redirected stream
stays plain. `--no-jev` keeps setting `LEANPI_NO_JEV=1`.

**Verification:** E1 — `pnpm test tests/cli-bootstrap.spec.ts`: change the existing
throw assertion (lines 157-162) to assert `source === "not configured"`; add
`jevWarning` cases for no-key, key-present, `--no-jev` and `jev.mode: disabled`.
Red first: the `not configured` assertion fails against today's throwing
`requireJev`. Then `pnpm typecheck && pnpm lint` — typecheck is what catches a
stale re-export of the deleted error class.
**Checkpoint:** done

#### Phase 2: no blocking prompt in the session, warned exactly once
**Status:** DONE
**ACs:** AC-4, AC-5
**Files:**
- `src/index.ts` — `session_start`: delete the `ui.input` prompt, the `declined` bookkeeping it needed, and the two `notify` branches for empty and rejected keys; emit `jevWarning` as a single `warning` notify, guarded on `LEANPI_JEV_WARNED !== "1"`, `jev.getMode() !== "disabled"` and `resolveCredential(...).key === null`.

**Implementation:** `validateKey` stays on the client for `/jev key set`; only the
startup prompt goes. The existing `event.reason !== "startup"` reset of session
state is untouched — unrelated to the credential path.

**Verification:** E2 — extend `tests/extension-surface.spec.ts` (its `fakePi()`
already captures handlers by event name and collects `notices`): emit
`session_start` with no key, assert `ui.input` was never called and one warning
notice carries `typesafe.ai`; repeat with `LEANPI_JEV_WARNED=1` and assert zero
notices. Red first: the no-`input` assertion fails against today's prompt. Then
`pnpm test`.
**Checkpoint:** done
