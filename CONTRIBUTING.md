# Contributing

LeanPi is MIT-licensed and takes contributions under the same terms — no CLA,
no copyright assignment. By opening a pull request you agree to license your
contribution under [`LICENSE`](LICENSE).

## Setup

Requires `git` and Node `>=22.19.0` (`.nvmrc` pins 22). pnpm is what the lockfile
is written with; npm works too.

```sh
git clone https://github.com/jonit-dev/lean-pi.git
cd lean-pi
pnpm install
pnpm build
```

Running it takes an optional JEV key — see [`docs/usage.md`](docs/usage.md). The test suite
does not: it boots stub backends and points `$XDG_CONFIG_HOME` at a temporary
directory (`tests/setup/machine-isolation.ts`) so it never reads your own
`~/.config/leanpi/leanpi.config.yaml`.

## Gates

Every one of these must pass before a pull request is reviewable.

```sh
pnpm typecheck     # tsc --noEmit
pnpm lint          # oxlint (warnings are tolerated, errors are not)
pnpm test          # vitest run — the full acceptance suite
```

Three specs depend on the machine's own `$HOME` rather than on a fixture — a
signed-in vendor CLI, the installed skill library — and therefore assert nothing
portable. They are skipped unless explicitly asked for: `LEANPI_REAL_HOME=1`
(the executor lane's vendor chain), `LEANPI_REAL_SKILLS=1` (skill disclosure) and
`LEANPI_PRD_REAL_SKILLS=1` (PRD authoring). CI runs without them. Anything that
needs a credential, a subscription or the network is gated the same way.

## What a change is expected to look like

The rules in [`AGENTS.md`](AGENTS.md) are the short version and they are
enforced in review rather than by tooling:

- **Surgical.** Every changed line traces to the request. Do not reformat,
  refactor or "improve" adjacent code. Unrelated dead code gets mentioned in the
  PR, not deleted in it.
- **Minimum that solves the ask.** No unrequested features, no single-use
  abstractions, no speculative config, no handling for impossible cases. If 200
  lines could be 50, they are 50.
- **Evidence over assertion.** A behavioral change arrives with the check that
  proves it: a test that fails before and passes after, or the command output
  that demonstrates the behavior. A claim of "done" with no artifact behind it
  is not reviewable here.
- **Tests defend observable contracts.** A test earns its place only where a
  plausible bug would fail it. Assertions on wiring, field copies, defaults or
  source text are not tests and will be asked for a rewrite.

## Commits and pull requests

Write commit subjects as `type(scope): the claim the change makes`, imperative
and specific — for example `fix(cli): "Invalid API key" was the provider's, not
JEV's`. A body explaining *why* is welcome; a body restating the diff is noise.

A pull request should state the problem, what changed, and the evidence that it
works. Use the template. Keep one concern per pull request: a rename and a bug
fix are two.

## Larger work

Non-trivial features are planned before they are written, with the PRDs in
[`docs/PRDs/`](docs/PRDs/) rather than freehand: a PRD states the acceptance
criteria first, and a pull request that claims criteria links them to evidence.
Finished PRDs move to [`docs/PRDs/v1/done/`](docs/PRDs/v1/done/) in the commit
that finishes them.

## Reporting bugs and security issues

Ordinary bugs and feature requests go to
[issues](https://github.com/jonit-dev/lean-pi/issues) — the templates ask for the
one thing that makes a report actionable, which is how to reproduce it. Security
reports do **not** go to the public tracker; see [`SECURITY.md`](SECURITY.md).

Participation is covered by [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
