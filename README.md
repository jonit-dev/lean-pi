# LeanPi

**Cost-aware task compiler and coding runtime built on [Pi](https://github.com/badlogic/pi-mono).**

LeanPi's objective is not to use fewer tokens. It is:

> Minimize effective cost per **verified** successful coding task while preserving
> the completion quality expected from leading coding harnesses.

It does that with five ideas: a **task compiler** that decides what a task needs
before any expensive model sees it, **progressive capability disclosure** (only
the relevant skills/MCP/LSP enter context), **cost-aware multi-model routing**,
**separate executor and reviewer lanes**, and **evidence-driven completion** —
deterministic verification plus a proof gate, so "done" is a claim backed by
artifacts rather than a model's word.

The full specification is [`docs/PRDs/v1/ROADMAP.md`](docs/PRDs/v1/ROADMAP.md);
the PRD index with per-PRD status is [`docs/PRDs/v1/INDEX.md`](docs/PRDs/v1/INDEX.md).

---

## Benchmark TL;DR

Measured 2026-09-19 against **omp** (oh-my-pi), same model
(`opencode-go/deepseek-v4.1-flash`), same endpoint, both priced from one rate
card. Four upstream bug-fix tasks whose goldens were verified fail-before /
pass-after on the machine that ran them; **both arms 4/4**.

| metric (4 tasks) | LeanPi | omp | ratio |
| --- | --- | --- | --- |
| verified solve rate (held-out upstream test) | 4/4 | 4/4 | 1.00 |
| effective cost per verified success | **$0.0129** | $0.0274 | **0.47** |
| wall time, total | **373.6 s** | 678.3 s | **0.55** |
| uncached input tokens | 94,862 | 310,003 | 0.31 |
| output tokens | 41,805 | 66,968 | 0.62 |
| tool calls | 119 | 169 | 0.70 |

Solve rate is decided by a held-out adjudicator: after the attempt is sealed, the
upstream fix commit's test files are checked out and the project's own test
command runs. Neither harness sees those files during its turn, and neither
harness's self-reported success is used.

**Read this before quoting the number.** The measured LeanPi configuration is its
native-backend path — Pi's agent loop under LeanPi's Ponytail prefix, five-tool
surface and permission guard. LeanPi's task compiler, JEV control plane and skill
disclosure do not run on a native backend (Pi's loop *is* the executor there), so
this compares prompts and tool surfaces, not the control plane. One run, four
tasks; no variance estimate.

Methodology, suite validation, excluded fixtures, caveats and the four harness
defects this benchmark surfaced: **[`docs/benchmarks/2026-09-19-leanpi-vs-omp.md`](docs/benchmarks/2026-09-19-leanpi-vs-omp.md)**.
Raw evidence: [`docs/benchmarks/2026-09-19-golden-validation.json`](docs/benchmarks/2026-09-19-golden-validation.json),
plus the ledgers under `bench/out/`.

---

## Run it

Requires `git`; developed, tested and measured on Node 20.

```sh
npm install
npm run build
```

Two entry points, one code path:

```sh
# 1. As a Pi extension (interactive)
npx pi --extension ./dist/index.js

# 2. As a library (the same activate() path the tests exercise)
node -e "import('./dist/index.js').then(async (m) => {
  const session = await m.createLeanPiSession();
  await session.runTurn('summarize this repository');
  console.log(session.session.messages.at(-1).content);
})"
```

Configuration lives in `leanpi.config.yaml` beside the working directory:
`backends` (native OpenAI-compatible endpoints and `external_harness` CLIs),
`models` (the six roles `quick`/`balanced`/`strong`/`specialist`/`review_quick`/
`review_strong`), `jev`, `capabilities`, `permissions`, `limits`. Credentials are
resolved from the environment by name — no key is ever written into the repo.

Annotated example: [`leanpi.config.yaml`](leanpi.config.yaml).

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
| `skills/` | the bundled skill pack |
| `tests/` | the suite: every PRD's acceptance criteria, run with `npm test` |

```sh
npm test        # acceptance criteria, end to end (469 tests)
npm run lint
npm run typecheck
```
