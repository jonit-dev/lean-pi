# src

A Pi extension, not a harness: behavior is registered through `activate(pi)`. Don't fork or reimplement Pi — extend it.

Every behavior here owns a numbered FR in `docs/PRDs/v1/ROADMAP.md`. New behavior with no FR → say so before writing it.

`src/core/instructions/` is vendored: edit the source skill, then `pnpm sync:ponytail`. Never hand-edit the copy or its lock.
