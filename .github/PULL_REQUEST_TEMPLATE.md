## What this changes

<!-- One or two sentences a reviewer reads first: the problem, and the claim the
change makes about it. -->

## Why

<!-- The evidence or the reasoning that made this necessary. Link the issue or
PRD acceptance criterion this closes, if there is one. -->

## Evidence

<!-- What proves it works: the command you ran and its output, the test that
fails before and passes after, or the screenshot. "Tests pass" on its own is not
evidence for a behavior change. -->

## Checklist

- [ ] `pnpm typecheck`, `pnpm lint` and `pnpm test` pass
- [ ] The change is surgical: every changed line traces to the ask above
- [ ] A test that fails before and passes after, where the change is behavioral
- [ ] Docs updated where behavior, config or commands changed
