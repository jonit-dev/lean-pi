# LeanPi

**Cost-aware task compiler and coding runtime built on [Pi](https://github.com/earendil-works/pi).**

LeanPi's objective is not to use fewer tokens. It is:

> Minimize effective cost per **verified** successful coding task while preserving
> the completion quality expected from leading coding harnesses.

**Mantra: "Tell me your goal, I figure out the rest."** LeanPi detects the
subscriptions and models a machine already has, compiles the task, and picks the
capabilities, models, reasoning effort and proof it needs. It asks only for what
it cannot know — a credential, or a goal it was never told.

It does that with five ideas: a **task compiler** that decides what a task needs
before any expensive model sees it, **progressive capability disclosure** (only
the relevant skills/MCP/LSP enter context), **cost-aware multi-model routing**,
**separate executor and reviewer lanes**, and **evidence-driven completion** —
deterministic verification plus a proof gate, so "done" is a claim backed by
artifacts rather than a model's word.

The full specification is [`docs/PRDs/v1/ROADMAP.md`](docs/PRDs/v1/ROADMAP.md);
the PRD index with per-PRD status is [`docs/PRDs/v1/INDEX.md`](docs/PRDs/v1/INDEX.md).

---

## Run it

Requires `git`; developed and tested on Node 22 (`engines.node >=22.19.0`). The
published 2026-09-19 benchmark used Node 20; the 2026-09-19 audit smoke-tested the
documented path on Node 22.

```sh
npm install
npm run build
npm link          # puts `leanpi` on PATH
leanpi            # run it anywhere
```

**First run configures itself.** With no `leanpi.config.yaml` anywhere above the
working directory, `leanpi` asks the machine what it has — which vendor CLIs are
installed *and* signed in (`claude auth status`, `codex login status`,
`opencode auth list`), which models those CLIs report, and whether Pi already
holds a provider credential — then writes
`~/.config/leanpi/leanpi.config.yaml` with JEV allocating the six roles over
those models from published capability and price data. It is an ordinary file:
edit it, or delete it to have it written again. No credential is ever written
into it.

```
leanpi — tell me your goal, I figure out the rest.
  models   quick opencode-go deepseek-v4.1-flash  ·  balanced codex gpt-6-astra  ·  strong claude opus[1m]
  review   opencode-go deepseek-v4.1-flash → claude opus[1m]
  control  JEV configured (source: env file)
```

While a turn runs, the footer carries the decision it made:
`Auto: opus (1m) (Medium) — MEDIUM complexity — Executor lane`. On a native
backend Pi's own loop is the executor, so LeanPi's verification and proof gate
do not run on that turn and the footer says so — `… — Pi loop — unverified —
/verify` — and `/verify` runs the contract's verifiers and the gate against the
workspace whenever you want the evidence.

LeanPi's commands are ordinary Pi slash commands: `/help` lists them, and
`/status`, `/route`, `/models`, `/context`, `/doctor`, `/config`, `/cost`,
`/skills`, `/mcp`, `/permissions`, `/jev`, `/todo`, `/goal`, `/review`,
`/verify` and `/prd` are all typed into the same prompt as a task.

**The JEV key is optional, and it pays for itself.** The task compiler, the
skill disclosure and the proof gate are JEV decisions; with a key they route on
what a task actually needs. Without one, every site falls back to a
deterministic heuristic — LeanPi still runs, it just routes worse and spends
more tokens per task, and says so on startup:

```sh
leanpi --jev-key <key>          # stored at ~/.config/leanpi/credentials.json (0600)
export JEV_API_KEY=<key>        # or this shell
echo 'JEV_API_KEY=<key>' >> .env  # or this project — read, never exported
leanpi --no-jev                 # or skip the control plane deliberately
```

Tool authorization is per scope (`read`, `edit`, `shell`, `network`, `mcp`,
`external_dir`, `subagent`, `git_destructive`, `package_install`), resolved from
the built-in defaults, your `~/.config/leanpi/permissions.json` and the
project's `permissions:` block, which may only tighten. `/permissions` shows
each scope's decision and where it came from; `/permissions set <scope>
<allow|ask|deny>` changes it for good.

`--safety` overrides all of that for one session, and is off unless passed:

```sh
leanpi --safety low      # every scope allow: nothing prompts, nothing refuses
leanpi --safety medium   # the built-in column: read allow, most ask, destructive deny
leanpi --safety high     # read allow, edit ask, everything else deny
```

A level is the whole policy — your stored scopes and every capability rule are
ignored while it is in force, since a level a forgotten `/permissions set` could
undercut would not be a level.

Tool calls render as Claude Code's compact rows — one line per call, the output
behind `ctrl+o` (`ctrl+shift+o` for the long form), in whatever theme is active.
How much shows is a session-level choice, and a durable one:

```sh
/cc-tools status            # what every switch is set to right now
/cc-tools detail on         # the long form by default, without the keystroke
/cc-tools thinking full     # keep finished thinking expanded, not just live
/cc-tools group off         # one row per call instead of grouped runs
leanpi --ui plain           # Pi's own rendering, for a session or for good
```

`/cc-tools` writes `.pi/settings.json`, so the choice survives the session;
`readOutputMode`, `previewLines`, `bashCollapsedLines` and the rest can be set
there directly. Colours, borders and diff tints follow `themes/leanpi.json` on
their own (`/cc-theme status` shows what they resolved to); the one thing a
theme cannot reach is the syntax highlighting inside a diff, so the first run
seeds `diffTheme` in `~/.pi/settings.json` — and never touches a key you set.

Two other entry points, one code path:

```sh
# As a Pi extension by hand (what `leanpi` does for you)
npx pi --extension ./dist/leanpi.js --no-skills

# As a library (the same activate() path the tests exercise)
node -e "import('./dist/index.js').then(async (m) => {
  const session = await m.createLeanPiSession();
  await session.runTurn('summarize this repository');
  console.log(session.session.messages.at(-1).content);
})"
```

Configuration lives in `leanpi.config.yaml` beside the working directory (or in
`$XDG_CONFIG_HOME/leanpi/`): `backends` (native OpenAI-compatible endpoints and
`external_harness` CLIs), `models` (the six roles `quick`/`balanced`/`strong`/
`specialist`/`review_quick`/`review_strong`), `jev`, `capabilities`,
`permissions`, `limits`. Credentials are resolved from the environment by name —
no key is ever written into the repo.

Annotated example: [`leanpi.config.yaml`](leanpi.config.yaml).

---

## Benchmark TL;DR

Measured 2026-09-19 against **omp** (oh-my-pi), same model
(`opencode-go/deepseek-v4.1-flash`), same endpoint, both priced from one rate
card. Four upstream bug-fix tasks; **both arms 4/4** under the held-out golden.
Three of the four goldens were verified fail-before / pass-after and retained
(`express`, `preact`, `slugify`); `flask`'s fix-side golden passes but its
fail-before is unverified in the retained artifact.

| metric (4 tasks) | LeanPi | omp | ratio |
| --- | --- | --- | --- |
| verified solve rate (held-out upstream test) | 4/4 | 4/4 | 1.00 |
| effective cost per verified success | **$0.0129** | $0.0274 | **0.47** |
| wall time, total | **373.6 s** | 678.3 s | **0.55** |
| uncached input tokens | 94,862 | 310,003 | 0.31 |
| output tokens | 41,805 | 66,968 | 0.62 |
| tool calls | 119 | 169 | 0.70 |

> **Independent audit, 2026-09-19 — read before quoting.** The published table is
> retained and recomputes, but its fresh repeat did **not** reproduce the LeanPi
> advantage — and the reason turned out to be the measurement, not the harness:
> those repeat rows ran without the benchmark's own permission profile, so LeanPi
> could not write a file. Re-run with it, the same arm is **4/4 for $0.055814**.
> The audit's three serious findings (cost accounting never fed, no deadline on
> the native path, a silent-success shape after a partial provider error) are
> fixed, with two more the fix surfaced. Details:
> [`docs/audits/production-readiness-audit.md`](docs/audits/production-readiness-audit.md)
> and [`docs/benchmarks/2026-09-19-leanpi-vs-omp.md`](docs/benchmarks/2026-09-19-leanpi-vs-omp.md#addendum--independent-audit-2026-09-19-docsauditsproduction-readiness-auditmd).

Solve rate is decided by a held-out adjudicator: after the attempt is sealed, the
upstream fix commit's test files are checked out and the project's own test
command runs. Neither harness sees those files during its turn, and neither
harness's self-reported success is used.

**What the omp comparison measures.** Both arms run the same model on the same
endpoint. Until 2026-09-19 LeanPi's task compiler did not run on a native backend
at all (Pi's loop is the executor there, and the lane registration switched off
the *decisions* with the execution), so that table compares prompts and tool
surfaces. The compiler runs on every path now; the numbers above have not been
re-measured against omp since. One run, four tasks, no variance estimate.

### Cost work: what is measured, and where it is

| measurement | result | evidence |
| --- | --- | --- |
| this harness against its own previous revision (`ed05f8d`), validated suite, one pair | **$0.126762 → $0.082834, ×0.65**, both arms **4/4**; cost per verified solve $0.031691 → $0.020709 | `bench/out/cost-z1-{base,treat}/` |
| the stable part of that, on the two tasks whose baseline agrees with its own history | **×0.84 / ×0.88** — the same order as the input rows' 13% | same rows |
| removing this machine's skill catalog from every request | 82,343 bytes (~20.6k tokens) per call; uncached input −17%, cached −29% | `bench/out/cost-t1-*`, F1 in the report |
| blanket `thinkingLevel: off` | suite ×0.96 but **3/4 solved** — 27.5% *worse* per verified solve; withdrawn | `bench/out/cost-s1-*`, F4/F6 |
| JEV's contribution | **not yet measurable**: no run before 2026-09-19 had a credential (the key was in `.env` and nothing read it), and graded effort is a no-op on this endpoint's binary thinking control | S4/S5 in the audit, F5/F6 in the report |

Full write-up, including what is *not* established and the experiment that would
settle the reasoning policy: **[`docs/reports/reasoning-cost-2026-09-19.md`](docs/reports/reasoning-cost-2026-09-19.md)**.

Every run is kept. `bench/out/<run-id>/` holds the ledger, the §52 telemetry, the
report and the patches for each arm; `bench/cost/series.json` records which runs
belong to which comparison, and `bench/cost/fold.py` is the only thing that turns
them into the numbers above (it refuses partial runs and mismatched task sets).

```sh
bench/cost/fold.py bench/cost/series.json     # re-fold every recorded comparison
bench/cost/run-pair.sh bench/suites/validated z2   # one alternating pair, both arms
```

Methodology, suite validation, excluded fixtures and the harness defects the
benchmark surfaced: **[`docs/benchmarks/2026-09-19-leanpi-vs-omp.md`](docs/benchmarks/2026-09-19-leanpi-vs-omp.md)**.
Raw evidence: [`docs/benchmarks/2026-09-19-golden-validation.json`](docs/benchmarks/2026-09-19-golden-validation.json),
plus the ledgers under `bench/out/`.

---

## Benchmarks

The harness is PRD-021: one attempt per (task, configuration) in a throwaway
checkout of a real upstream revision, one §52 telemetry record per attempt, and a
ledger that every reported number is folded from.

```sh
npm run bench -- --list                      # suite inventory, §55 coverage, config matrix
npm run bench -- --suite bench/suites/seed --configs leanpi-flash,omp
npm run bench -- --recompute bench/out/<run-id>   # re-fold a finished run, no re-running
```

Suite: `bench/suites/seed` holds ten tasks pinned to upstream revisions with
held-out goldens; `bench/suites/validated` holds the subset whose goldens have
been proven fail-before/pass-after on this machine. Adapters: `leanpi`,
`stock-pi` (Pi with no LeanPi loaded, as the auditable negative control),
`external` (Claude Code / Codex / OpenCode CLIs, owner-gated) and `omp`.

`bench/rubric.md` is the held-out rubric for tasks with no upstream test.

## Repository layout

| path | what |
| --- | --- |
| `src/` | the runtime: compiler, executor, reviewer, proof, JEV client, telemetry, permissions, capabilities |
| `bench/` | the benchmark harness, suite, configuration matrix and reports |
| `docs/PRDs/` | the roadmap and per-PRD specification and acceptance criteria |
| `docs/benchmarks/` | measured runs and their evidence |
| `docs/reports/` | the cost investigation and the wiring audit behind the numbers |
| `bench/out/` | every recorded run: ledger, §52 telemetry, report, patches |
| `skills/` | the bundled skill pack |
| `tests/` | the suite: every PRD's acceptance criteria, run with `pnpm test` |

```sh
pnpm test        # acceptance criteria, end to end
pnpm run lint
pnpm run typecheck
```

The suite needs no credential, no subscription and no network: it boots stub
backends and points `$XDG_CONFIG_HOME` at a temporary directory, so it never
reads your own `~/.config/leanpi/`. Three specs assert against the machine's own
`$HOME` — a signed-in vendor CLI, the installed skill library — instead of a
fixture, and are skipped unless asked for (`LEANPI_REAL_HOME=1`,
`LEANPI_REAL_SKILLS=1`, `LEANPI_PRD_REAL_SKILLS=1`); CI runs without them.

---

## Development

Node `>=22.19.0` (`.nvmrc` pins 22) and `git`. The lockfile is pnpm's; npm works
too.

```sh
git clone https://github.com/jonit-dev/lean-pi.git
cd lean-pi
pnpm install
pnpm build
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the gates a pull request has to
pass and what the review looks for. [`AGENTS.md`](AGENTS.md) is the same rules
in the form an agent reads.

## License

MIT — see [`LICENSE`](LICENSE). Third-party content vendored into this
repository (the bundled skill pack and the static instruction prefix, both MIT)
is listed with its copyright holders in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## Security

Report vulnerabilities privately, not in the issue tracker — see
[`SECURITY.md`](SECURITY.md) for the reporting channels and the boundaries that
are in scope.
