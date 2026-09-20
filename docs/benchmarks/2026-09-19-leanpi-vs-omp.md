# LeanPi vs omp — measured run, 2026-09-19

Both harnesses solved the same four upstream bug-fix tasks on the same model.
LeanPi did it for **47% of omp's cost** (`$0.0129` vs `$0.0274` per verified
success) and **55% of its wall time**, with 30% fewer tool calls and 47% fewer
total context tokens.

The measured LeanPi configuration is LeanPi's *native-backend* path: Pi's own
agent loop under LeanPi's Ponytail prefix, five-tool surface and permission
guard. LeanPi's task compiler, JEV control plane and skill disclosure **did not
run** — by design (see [What was not measured](#what-was-not-measured)). This is
a prompt-and-tool-surface comparison, not a test of the control plane.

## Headline

| Metric (4 tasks) | LeanPi | omp | LeanPi / omp |
| --- | --- | --- | --- |
| Verified solve rate (held-out golden) | 4/4 | 4/4 | 1.00 |
| Effective cost, total | $0.0516 | $0.1094 | **0.47** |
| Cost per verified success | $0.0129 | $0.0274 | **0.47** |
| Wall time, total | 373.6 s | 678.3 s | **0.55** |
| Wall time, median per task | 69.6 s | 113.2 s | 0.61 |
| Uncached input tokens | 94,862 | 310,003 | 0.31 |
| Cached input tokens | 4,095,360 | 7,581,312 | 0.54 |
| Output tokens | 41,805 | 66,968 | 0.62 |
| Tool calls | 119 | 169 | 0.70 |

ROADMAP §4 asks for ≥90–95% of a baseline's solve rate at ≤25% of its cost.
Against omp on this suite: solve rate **100%**, cost **47%** — target met on
quality, missed on cost (the stretch target is 10%). Four tasks, one run each;
see [Caveats](#caveats) before treating either number as a property of the
harnesses rather than of this sample.

## Per-task results

Cells are `LeanPi / omp`.

| Task | verdict | input tok | cached tok | output tok | cost | wall | tool calls |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `express-send-transfer-encoding-etag` | complete / complete | 28,249 / 39,390 | 305,408 / 453,888 | 4,265 / 4,731 | $0.0077 / $0.0101 | 35s / 42s | 14 / 15 |
| `flask-ipv6-server-name-parsing` | complete / complete | 14,461 / 60,084 | 792,192 / 1,981,440 | 8,376 / 17,300 | $0.0096 / $0.0253 | 69s / 153s | 29 / 55 |
| `preact-suspense-hook-state-loss` | complete / complete | 39,283 / 170,117 | 2,326,400 / 4,463,872 | 19,740 / 36,622 | $0.0247 / $0.0609 | 199s / 410s | 52 / 75 |
| `slugify-counter-duplicate-slug` | complete / complete | 12,869 / 40,412 | 671,360 / 682,112 | 9,424 / 8,315 | $0.0096 / $0.0131 | 71s / 74s | 24 / 24 |

The gap is one effect, visible in every row: **omp spends more requests and more
context to reach the same fix**. Its base context is larger (31.4k tokens for a
one-line prompt against LeanPi's 23.0k, measured directly), and on the two
harder tasks it also takes roughly twice the tool calls.

## Method

- **Harness under test:** this working tree (`leanpi@0.1.0`, Ponytail prefix
  `4.9.0`) via the PRD-021 bench lane, `adapter: leanpi`, config row
  `bench/configs/leanpi-flash.yaml`.
- **Baseline:** `omp/18.2.2` as installed, driven as
  `omp --print --mode json --no-session --auto-approve --model deepseek-v4.1-flash --cwd <workspace> <prompt>`
  (config row `bench/configs/omp.yaml`, adapter added for this benchmark).
  omp keeps its own system prompt, tool surface and skill discovery — the
  baseline is omp as a user gets it, not a stripped omp.
- **Model:** `opencode-go/deepseek-v4.1-flash` for both arms, same endpoint
  (`https://opencode.ai/zen/go/v1`), same account.
- **Pricing:** one rate card for both arms, the model catalog's list price —
  $0.15/Mtok input, $0.60/Mtok output, $0.003/Mtok cached input. Cross-check:
  the harness priced omp's express attempt at `$0.010109`; omp's own accounting
  reported `$0.010109` for the same turn.
- **Adjudication:** held out. After the attempt is sealed, the fix commit's test
  files are checked out into the workspace and the upstream command runs
  (`runGolden`); exit 0 is the only "complete". Neither harness sees the test
  files or the fix commit during its turn, and neither harness's own claim of
  success is used.
- **Approvals:** omp ran with `--auto-approve`; LeanPi ran under a bench-only
  user permission profile (`edit/shell/network/package_install: allow`) in a
  throwaway `XDG_CONFIG_HOME`. Without these, a headless turn cannot edit a file
  and the run would measure approval prompts.
- **Per-attempt ceiling:** 45 minutes. A killed turn is recorded as an attempt
  with the tokens it spent and judged by the golden like any other.
- **Workspaces:** one blobless clone per attempt at the task's pinned parent
  revision, `setup` run inside it, deleted afterwards.
- **Artifacts:** `bench/out/omp-vs-leanpi-1-leanpi/` and
  `bench/out/omp-vs-leanpi-1-omp/` (ledger, §52 telemetry, report). Every number
  above derives from those two ledgers; `bench --recompute <runDir>` reproduces
  them.

### Why two run directories

The two arms ran as separate invocations, sequentially, on the same suite and
the same pinned revisions. The first combined run (`bench/out/omp-vs-leanpi-1/`)
is retained but **not** the source of any number here: its LeanPi arm was
invalidated by the cache artifact below, and its omp arm aborted when an attempt
hit the then-30-minute ceiling.

## Suite

`bench/suites/validated/` — the four seed tasks whose goldens were verified
fail-before / pass-after on this machine:

| Task | golden | fails at parent | passes at fix |
| --- | --- | --- | --- |
| `express-send-transfer-encoding-etag` | `npx mocha … test/res.send.js` | yes | yes |
| `flask-ipv6-server-name-parsing` | `.venv/bin/python -m pytest tests/test_basic.py -q` | **unverified** | yes (runs) |
| `preact-suspense-hook-state-loss` | `npx vitest run compat/test/browser/suspense.test.jsx` | yes | yes |
| `slugify-counter-duplicate-slug` | `npx ava test.js` | yes | yes |

The other six seed tasks were excluded because their goldens do not discriminate
on this machine — they were captured commands, not measured passes
(`validated_at: null` in every seed task before this run):

| Task | why excluded |
| --- | --- |
| `chalk-numeric-force-color-level` | ava/emittery crashes under Node 20 both before and after the fix |
| `undici-decompress-backpressure` | golden fails at the fix commit too (needs an upstream build step) |
| `nlohmann-bjdata-default-draft-marker` | `ctest` finds no tests; setup only configures, never builds |
| `hono-jsx-dom-matching-head-lookup` | `npm install` fails building `sharp` from source |
| `vite-code-frame-crlf-positions` | `npm install` cannot resolve `workspace:*`; with pnpm the golden still needs `vite` built |
| `zod-instanceof-properties-shape` | npm rejects `workspace:*`, pnpm rejects the npm `workspaces` field |

Validation evidence: `docs/benchmarks/2026-09-19-golden-validation.json` — one
row per seed task with the setup result and the before/after golden exit, from a
pass that ran every task's clone, setup and golden twice (at the parent
revision and at the fix commit). `express`, `preact` and `slugify` carry
`validated_at: "2026-09-19"` with measured fail-before/pass-after. **`flask`'s
retained validation row has `setup_ok: false` (no before/after recorded), so its
fail-before is not proven by that artifact**; the benchmark runs do show its
golden passing after the fix (both arms `complete`). A future run should
re-validate flask's setup or label it unverified.

## Correction applied mid-benchmark

The first LeanPi arm measured **$0.8160** total — 16× the corrected $0.0516, and
~10× omp's input tokens. That was an artifact of this benchmark's own
configuration, not of LeanPi:

- OpenCode Go rejects a request without an `x-opencode-session` header and keys
  its prompt cache off that header.
- The header was first configured as `!uuidgen`. Pi resolves `!command` header
  values **per request**, so every request carried a new session id and no
  request ever hit the prompt cache (`cacheRead=0` on all five calls of a
  five-call probe).
- omp, which manages one session id per invocation, hit the cache from its
  second call on (`input=226, cacheRead=31,360`).

With the header bound to a stable value, LeanPi's cache behaviour matches omp's
(`call 2: input=198, cacheRead=22,912`), and the LeanPi arm was re-run from
scratch. Cached input is priced at $0.003/Mtok against $0.15 uncached, so the
artifact was worth a factor of ~16 on the arm it hit. Any future run of this
benchmark must keep the session header stable per run.

## What was not measured

`registerTurnLanesIfOwned()` registers the compiler and executor lanes **only
when every executor role resolves to an external harness** (`ownsExecutionLoop`,
pinned by `tests/executor/turn.spec.ts`). With a native backend — this
benchmark's configuration, and the only one in which a LeanPi session can boot
through `createLeanPiSession()` — Pi's own loop is the executor, so:

- no execution contract is compiled;
- the JEV control plane never fires (`jev_tokens: 0` on all four attempts): no
  PRD gate, no complexity/review-risk classification, no capability routing;
- skill disclosure never selects a skill, because selection runs inside
  `compileTask()`;
- verification, the proof gate and the reviewer lane record `not_run`, so the
  LeanPi arm claims no success of its own and its false-completion rate is
  undefined (0 reported successes).

So the measured delta is attributable to LeanPi's static prefix, its five-tool
surface and its permission guard against omp's larger prompt and wider tool
surface — not to the task compiler. Benchmarking the control plane needs an
external-harness executor row, which today cannot boot through the bench lane:
`createLeanPiSession()` resolves the session model from the `balanced` role and
an `external_harness` role has no registered Pi model.

## Defects found and fixed to make the run possible

All four are in this working tree:

1. **`src/index.ts` — a session could not boot outside its own project.**
   `activate()` re-read `leanpi.config.yaml` from `cwd` for permission state, so
   a session booted on an injected config (the bench, the SDK) died with
   "no model roles configured" in any directory without that file. The session's
   role map is now passed into `loadPermissionState()`.
2. **`src/index.ts` — native backends could not send provider headers.**
   `registerBackends()` forwarded only `baseUrl`/`apiKey`/`api`, so any provider
   requiring a header (OpenCode Go's `x-opencode-session`) was unreachable.
   `backends.<name>.headers` is now passed through to Pi, which resolves each
   value with the same env-name / `!command` rule it uses for the key.
3. **`src/bench/adapters.ts` — the `leanpi` row could not record a native
   attempt.** It threw `telemetry-join` whenever the turn produced no contract,
   which is every native-backend turn. It now records what the session actually
   did (tokens, tool calls, wall time) and still claims no success.
4. **`src/bench/adapters.ts` — a killed baseline attempt aborted the whole run.**
   The omp parser required the terminal `agent_end` event; a turn killed at the
   ceiling produced none, so one slow attempt discarded the run. It now falls
   back to the streamed `message_end` events and records the attempt.

New in this tree: the `omp` adapter and its config row, `bench/configs/*.yaml`
for both arms, `bench/suites/validated/`, and a root `leanpi.config.yaml`
(secret-free; the key and session id resolve from the environment).

## Caveats

- **n = 4, one attempt per arm per task.** No repeats, so no variance estimate.
  A single slow or lucky trajectory moves the cost ratio materially — on
  `preact` alone omp spent 56% of its total cost.
- **Task mix is narrow:** four small-to-medium bug fixes with upstream tests, no
  greenfield work, no multi-file refactor, no task where planning should pay off.
  The six excluded tasks were the harder/heavier half of the seed suite.
- **Both harnesses ran with approvals disabled**, which is not how either is used
  interactively.
- **omp ran with its full installed surface** (user skills, plugins, rules);
  LeanPi's bundled skill pack was never loaded because selection never ran. Part
  of the prompt-size difference is that asymmetry, and it is the asymmetry a user
  actually experiences with default installs of each.
- **Cost is list-price arithmetic over reported tokens**, not a billed invoice.
  OpenCode Go is a subscription plan; the dollar figures are a comparable unit of
  account, cross-checked against omp's own accounting.
- LeanPi's wall-time advantage partly reflects doing fewer tool calls; both arms
  ran sequentially on the same machine, but system load was not otherwise
  controlled.

## Reproducing

```sh
npm run build
export XDG_CONFIG_HOME=/path/to/bench-profile          # permissions.json + credentials.json
export LEANPI_OPENCODE_SESSION="$(uuidgen)"            # stable for the whole run
node dist/bench/lane.js --suite bench/suites/validated --configs leanpi-flash --run-id <id>-leanpi
node dist/bench/lane.js --suite bench/suites/validated --configs omp        --run-id <id>-omp
node dist/bench/lane.js --recompute bench/out/<id>-leanpi
```

---

## Addendum — independent audit, 2026-09-19 (`docs/audits/production-readiness-audit.md`)

The published figures still recompute from their ledgers (`bench --recompute`)
and are not retracted. An independent audit added the following, which a reader
should weigh before quoting this table:

- A fresh matched re-run of the `express` task (audit-prefixed dirs) did **not**
  reproduce the LeanPi advantage: LeanPi was slower (`50.7 s` vs `39.2 s`), the
  golden stayed **incomplete**, and its cost was higher even after the accounting
  correction (`$0.0110` vs omp's `$0.0107`; a second LeanPi `express` attempt
  cost `$0.0175`). `n=1`, so this is not a refutation, but the ratio is not
  robust at the task level.
- The omp arm re-ran fresh over all four tasks and came in **28.22% cheaper on
  both bases** than published (`$0.0196` vs `$0.0274` per verified success;
  `$0.0785` vs `$0.1094` total). Both arms had four verified successes, so the
  two reductions must be identical. Consistent with a small sample where the
  published `preact` attempt alone was 39% of the total.
- The LeanPi arm's second attempt (`flask`) was **interrupted by the audit after
  >11 minutes** with one open provider socket and no completed record; its usage
  and cost are **unknown**. The cause is not proven from an open socket. The
  benchmark's native path has no per-attempt deadline; separately, `runNative`
  takes no `timeoutMs` (`src/backends/native.ts`, `src/backends/registry.ts:334-336`).
- No fresh 4×2 comparison exists: LeanPi produced one recorded attempt, omp four.
- Accounting correction: Pi's `Usage.output` already includes `Usage.reasoning`,
  so the native adapter was double-charging reasoning for rows where
  `reasoning_tokens > 0`. Published rows have `reasoning_tokens = 0` and are
  unaffected; the two fresh LeanPi `express` rows are corrected in
  `bench/out/audit-028-summary.json`. Fix + regression:
  `src/bench/adapters.ts:115-125`, `tests/bench/adapters.spec.ts`.
- Measurement caveats: omp wall time folds **completed attempts only**
  (`src/bench/metrics.ts:183-190`), and every telemetry row carries `calls: []`,
  so per-call cost is unauditable from the artifact. "Uncached input tokens" is
  non-cached input (`input_tokens` excludes `cached_input_tokens`), not total input.

Raw audit evidence: `bench/out/audit-028-preflight/`,
`bench/out/audit-028-refresh/`, `bench/out/audit-028-recompute/`,
`bench/out/audit-028-summary.json`.

---

## Addendum — reasoning cost, 2026-09-19 (`docs/reports/reasoning-cost-2026-09-19.md`)

The figures above are not retracted — they recompute from their ledgers — but two
statements about the measured configuration no longer hold, and the LeanPi arm's
prompt was larger than this document accounts for:

- **The published LeanPi arm carried this machine's whole skill catalog.** Pi's
  resource loader built its own `<available_skills>` block into the system
  prompt of every request, because skill disclosure never ran on a native
  backend (`compileTask()` is the only caller of `selectSkills`). Measured on the
  published revision's build line: 82,343 bytes, `<available_skills>` starting at
  byte 5,589 of an 87,932-byte prompt — ~20.6k tokens per request, resent on every
  provider call. The fix (below) takes the same prompt to 5,365 bytes with no
  skills block, so the LeanPi column of the table above describes a superseded
  build. It also means the "prompt-and-tool-surface" comparison was made with
  LeanPi shipping a personal catalog omp does not have — an asymmetry in LeanPi's
  favour on tokens that no longer exists.
- **"skill disclosure never selects a skill" is superseded.** A native-backend
  turn now runs the same selection the contract path runs, and discloses ≤3
  pointers. On this machine that selection is the documented lexical fallback
  (JEV resolves no credential here), which for the `express` task picked three
  unrelated skills — the cost win is real, the *relevance* of the disclosure is
  not established.
- **Reasoning is the arm's dominant cost, and nothing controlled it.** 88% of the
  output tokens in a measured full-suite attempt are reasoning, and output is 4×
  input and 200× cached input on this rate card. The vendor honours DeepSeek's
  `thinking` field, not OpenAI's `reasoning_effort`; the tree now declares that
  dialect and spends no thinking on a turn that compiled no contract.

