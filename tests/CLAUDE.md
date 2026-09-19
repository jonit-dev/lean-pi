# tests

Tests are the PRDs' acceptance criteria, one file per area, mirroring `src/`. A new AC → a new test named after it.

Exercise the production path (`createLeanPiSession()`, real `activate`), not a re-implementation of it.

No network, no real model. Use `helpers/stub-backend.ts`, `helpers/stub-jev.ts`, `helpers/fixtures.ts`.
