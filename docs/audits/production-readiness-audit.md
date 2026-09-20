# LeanPi production-readiness audit (PRD-028)

Scope: a **public harness in early alpha**, assessed for *usable public alpha*,
not enterprise/GA perfection. Consequential means core correctness,
reproducibility, money/accounting, failed installs, silent task failure, data
loss; polish is follow-up. Worktree
`.worktrees/production-readiness-audit`, branch `audit/production-readiness`,
source SHA `0205b14` (primary checkout untouched). Node `v22.22.0` (satisfies
`engines.node >=22.19.0`), omp `18.2.2`, Pi `0.85.1`, pass date 2026-09-19.
Every number points at a ledger, a `file:line`, or a command that ran; where a
check did not run, this says so.

## Verdict

**Useful experimental public alpha.** The native-path prompt/tool surface is
real, installs and runs, and the published 4-task result recomputes from its
ledgers. The fresh live evidence, however, **does not establish stable
savings**: on the one task both arms re-ran, LeanPi was slower, failed the
held-out golden and cost more, and its next attempt was interrupted with
unrecorded spend. Fix **cost accounting and recovery** before stronger
stability claims.

This is a **completed audit**, not a production qualification: the fresh 4×2
comparison is **blocked / not demonstrated** (LeanPi ran two `express` attempts,
not a four-task arm). Those are different claims.

## 1. Published claims, recomputed

"Confirmed" = reproduced from the raw ledger with `bench --recompute`
(`bench/out/audit-028-recompute/`).

| Claim (README:29-36, benchmark doc) | Artifact | Verdict |
| --- | --- | --- |
| both arms 4/4 verified solve | `bench/out/omp-vs-leanpi-1-*/ledger.jsonl` | confirmed (4 `complete` per arm) |
| cost/verified success `$0.0129` vs `$0.0274` (0.47) | same `report.json` | confirmed arithmetically; the 0.47 is hand-folded across two independent run dirs, not emitted by the harness |
| total cost `$0.0516` vs `$0.1094` | same | confirmed |
| wall total `373.6 s` vs `678.3 s` (0.55) | same | confirmed, but omp wall folds **complete** attempts only (`metrics.ts:183-190`) |
| output `41,805` vs `66,968` | same | confirmed |
| tool calls `119` vs `169` | same | confirmed |
| `reasoning_tokens` in those rows | `bench/out/omp-vs-leanpi-1-*/telemetry.jsonl` | `0` in all eight published rows, so the cost-accounting fix in §5 does not change any published figure |

Rate card `leanpi.config.yaml:22-24` (`$0.15/$0.60/$0.003` per Mtok) applies to
both arms. Official sources verified 2026-09-19: <https://opencode.ai/docs/go/>
and <https://api-docs.deepseek.com/quick_start/pricing/>. Off-peak input `$0.15`,
cached read `$0.003`, output `$0.60` per Mtok; peak `$0.30/$0.006/$1.20`. Peak is
01:00–04:00 and 06:00–10:00 UTC Mon–Fri; 2026-09-19 was a Saturday, so these runs
are off-peak. These are usage-accounting rates on a subscription/quota product,
**not** a cash invoice; list-price-equivalent savings are not subscription-bill
savings.

## 2. Verification results (this pass)

| Check | Command | Result |
| --- | --- | --- |
| tests (prior full run, reused) | `pnpm test` | 518 passed, 1 failed, 7 skipped — `tests/exploration/explore-governor.test.ts` |
| targeted test after the fix | `npx vitest run tests/bench/adapters.spec.ts` | 8 passed |
| typecheck | `npm run typecheck` | exit 0 |
| lint | `npm run lint` | exit 0 (warnings only) |
| build | `npm run build` | exit 0 |
| bench CLI | `node dist/bench/lane.js --list` | exit 0 |
| recompute | `--recompute` into `bench/out/audit-028-recompute/` | exit 0, reproduces published totals |
| package consumer path | `npm pack --dry-run` + temp install | 712 files, 687.5 kB; `import('leanpi')` succeeds |
| Pi extension CLI | `node_modules/.bin/pi --help` on Node 22 | exit 0; the documented `pi --extension ./dist/index.js` entry point is reachable |

There is no package `bin`; the public consumer entry points are the Pi extension
invocation and the library `createLeanPiSession()` (README §Run it). `pnpm 11`
install friction (`minimumReleaseAge` / ignored-builds) is a **secondary**
developer-tooling note: the documented `npm install && npm run build` path works
and is not blocked by it. The README previously said "developed, tested and measured on Node 20" against
`engines.node >=22.19.0`; that wording has been corrected to Node 22 in this
pass.

## 3. Findings

Three actionable serious findings; measurement limitations follow.

### S1 — Cost accounting: production telemetry is never fed (money)

**Fixed.** `feedInvocation` (`src/telemetry/collect.ts`) projects PRD-008's
invocation record — backend, model, billing, role, wall time and the token
breakdown — into the run's collector; the executor lane constructs its
`BackendRegistry` with that sink whenever a run is in flight
(`src/commands/turn-lanes.ts`), and both run owners set the collector for the
run's duration before the lanes execute (`src/index.ts`). `runNative` now reports
the breakdown Pi already counted (`stats.tokens`), so a compiled run's record
carries real usage, real calls and a priced cost rather than zeros. Covered by
`tests/telemetry/run-record.spec.ts` ("bills a backend invocation into the run's
calls, usage and wall time").

Still open, and named rather than implied: a **native, no-contract turn** still
writes no record — Pi's own loop is the executor there and LeanPi never sees the
provider's usage. That path needs its own sink (Pi's `message_end`/`agent_end`
events) before `/cost` is complete for the default configuration.

`RunCollector.add()` (`src/telemetry/collect.ts:160-171`) is never called from
`src/` outside telemetry. The interactive turn creates a fresh collector and
emits immediately (`src/index.ts:502-508`); the programmatic `runTurn` wrapper
does the same (`src/index.ts:633-652`). `BackendRegistry.onInvocation`
(`src/backends/registry.ts:180,261-263`) is omitted by every production
construction (`src/commands/turn-lanes.ts:91`, `src/commands/surface.ts:107`,
`src/review/commands.ts:98`). Consequence, stated precisely:

- a **native, no-contract** turn writes **no record at all** (`src/index.ts:622-625`);
- a **compiled** turn writes a record whose `usage.*`, `calls`, and cost are
  **all zero**, because its collector was never fed.

Static evidence only — no live consumer-path repro was run this pass:
`rg -n 'collector\.add|noteToolCall|recordJevDecision' src/ | rg -v telemetry/`
returns definitions and tests only. Impact: `/cost` and any real-session cost
figure is wrong by omission. Action: wire the existing `onInvocation` seam to
the run's collector (the adapter is the missing piece).

### S2 — Recovery/deadline: the benchmark native path is unbounded, and one attempt was interrupted with unknown spend (recovery)

**Fixed.** Three gaps, three answers: `runNative` takes a `timeoutMs` deadline and
aborts the loop on it, reporting the attempt as blocked rather than as a provider
failure (`src/backends/native.ts`, `nativeStop`); the LeanPi bench adapter gets the
same per-attempt ceiling through `bench.leanpiTimeoutMs`
(`LEANPI_TIMEOUT_MS_DEFAULT`, `src/bench/adapters.ts`); and an attempt that is
killed or interrupted writes its partial §52 record, with the runner recording an
`error` ledger row for an operator interrupt so the spend lands in the run's total
instead of nowhere (`AttemptHooks`, `src/bench/runner.ts`). The fourth bound is one
layer down and was found the hard way: Pi's `execute` schema makes `timeout`
optional with **no default** (`pi-coding-agent/dist/core/tools/bash.js:12-28`), so
an agent-issued `npx eslint … && npm test` sat for 14 minutes with zero CPU time
and voided a suite run. LeanPi's baseline `execute` definition now fills in a
`COMMAND_TIMEOUT_SECONDS_DEFAULT` (900 s) when the model names none
(`src/core/tools.ts`), a model-supplied bound still wins, and
`tests/bootstrap.spec.ts` pins it.

The fresh LeanPi refresh row for `express` is followed by a `flask` attempt that
was **manually stopped after >11 minutes**: one open provider socket, no child
process, no completed ledger/telemetry row. The cause of the stall **cannot be
proven** from an open socket, and an in-memory session not being written does
not by itself prove a hang. What is established: the benchmark's native branch
held a single stalled call with **no per-attempt deadline**; the interrupted
attempt's usage and cost are **unknown** and in no total; and, separately by
inspection, `runNative` (`src/backends/native.ts:56`,
`src/backends/registry.ts:334-336`) receives no `timeoutMs` while only
`runHarness` has one (`src/backends/harness.ts:277,398`). That last point is a
static code gap, not a reproduced hang on `runNative` — the benchmark's
no-contract branch calls `runTurn` with Pi's own loop, not `runNative`.

Action: give the benchmark native path and `runNative` a wall-clock ceiling and
record interrupted-attempt spend.

### S3 — Silent-success-shaped path after a partial provider error (static)

**Fixed.** The classification is now its own function and the transcript plays no
part in it: `nativeStop` (`src/backends/native.ts`) answers `provider_failure`
whenever a provider error is set, `deadline`/`budget` when the stop was ours (an
abort leaves an error message behind too, and reporting that as a provider
failure would send the registry to another backend for nothing), and `completed`
otherwise. `tests/backends/native.spec.ts` pins the four cases; the end-to-end
provider-failure case stays covered by the existing 400 test.

`runNative` returns `failure: "provider"` only when `providerError && summary.length === 0`
(`src/backends/native.ts:177-185`); if the provider errors **after** emitting
assistant text, control reaches the OK return (`:186-192`) and the registry
accepts any outcome that changed a file (`src/backends/registry.ts:282-289`), so
a partial turn that edits a file can be classified `completed`. Static reading
only — no fault injection was run. Action: return `failure: "provider"`
whenever `providerError` is set.

### S4 — JEV was never credentialed in any measurement (money, control plane)

LeanPi reads no `.env`: `resolveCredential` is config → stored credential →
`process.env.JEV_API_KEY` (`src/jev/credentials.ts`). The key existed in the
project's `.env` and works (verified live: `HTTP 200`, `model: jev-1.13.0`), while
every cost and audit run took the deterministic fallback — `bench/cost/run-pair.sh`
required `OPENCODE_API_KEY`, never passed `JEV_API_KEY`, and redirected
`XDG_CONFIG_HOME` away from any stored credential. Consequence: **no run in this
repository has ever contained a real JEV decision**, so "JEV's decisions" have
never been measured at all.

Fixed: a project `.env` is a credential source (`source: "env file"`), read
without publishing the key into `process.env` — a spawned vendor CLI inherits that
environment and FR-054 says no LeanPi credential crosses the boundary — and the
cost driver loads `.env` and warns when the key is absent
(`tests/jev-credentials.spec.ts`).

### S5 — The compiler never ran on a native backend (the control plane was off)

`registerTurnLanesIfOwned` registered the compiler only when
`ownsExecutionLoop(config)` — i.e. only when the executor roles are external
harnesses — because "Pi's own loop is the executor". That predicate answers who
*executes*, not who *decides*: on the configuration this machine and the benchmark
both use, a turn had no contract, so there was no complexity classification, no
executor class, no compiled reasoning effort (the only reasoning control that
costs money on this endpoint), no PRD dispatch, no review-risk decision and no
proof gate. JEV's only reach left was an unranked skill disclosure (see S4).

Fixed: the compiler registers on every path, the executor lane stays
ownership-gated so a task is not run twice, and `runTurn` spends the compiled
decision — the class resolves the session's model, the effort its thinking level,
and a class the loop cannot serve is refused rather than fatal. Two follow-ups
from a later adversarial review of this fix landed with it: the compiler's lane
registration now supersedes instead of stacking (the bench boots a session per
task, so stacked lanes meant task N paid N compilations), and the compiled effort
is capped by the operator's declared `thinkingLevel` rather than overriding it —
otherwise the one switch that changes the bill on this endpoint would have been
unreachable. Turning thinking **off** stays the operator's call: class-gated
`off` was tried, and the evidence against it is in the cost report.

### Measurement and follow-up limitations (not product defects)

- **F1-style test gate (moderate).** `detectLspAvailable()`
  (`src/scout/index.ts:218-223`) requires a language-server binary on `PATH`;
  the TypeScript fixture supplies none, so the injected `symbols` port is never
  consulted (`src/exploration/governor.ts:583-591`) and
  `tests/exploration/explore-governor.test.ts` fails. An environment-sensitive
  fixture/LSP expectation, not demonstrated supported-workflow failure. Repro:
  `pnpm exec vitest run tests/exploration/explore-governor.test.ts`.
- **Measurement limitations, not product defects.** `calls: []` in every
  benchmark row (`src/bench/adapters.ts:147`) makes per-call cost unauditable;
  omp wall excludes killed attempts (`src/bench/metrics.ts:183-190`), so
  `time_to_verified_success` is complete-only and no all-attempt latency
  accompanies it; the cross-arm 0.47 is hand-folded across two run dirs
  (`baseline_config_id` null/self) — valid arithmetic, but `--configs
  leanpi-flash,omp` in one invocation would emit it.
- **Minor:** npm install path works (pnpm 11 policy friction is secondary); the
  README says Node 20 while `engines.node` is `>=22.19.0`; telemetry
  `input_tokens` is non-cached input by contract (`collect.ts:22-23`) and
  "uncached input" is easy to misread as total input.

## 4. Session corpus

Locations searched: `.leanpi/sessions/` in the primary checkout (empty);
`~/.pi/agent/sessions` (20 synthetic `/tmp/pi-runtime-*` sessions);
`~/.omp/agent/sessions` (184 `.jsonl`). Seven omp sessions have
`cwd=/home/joao/projects/lean-pi`; all are opencode-driven development-client
sessions (models include `deepseek-v4.1-flash`, `claude-opus-5`), **not**
LeanPi product/harness runs: no LeanPi route, JEV decision or compiled-contract
fields, so they cannot validate LeanPi's accounting. Their aggregate shape
(cache-read dominating uncached input ~30–250×) confirms provider cache
behaviour for long tool-loops, nothing about LeanPi. Only metadata (`cwd`,
model, usage, tool-call counts) was read; no prompt bodies or credential values
are retained. No LeanPi field-session evidence exists.

## 5. Benchmark refresh (live evidence)

Both same-model arms were authenticated on supported existing routes, by
presence only (no credential value read, printed, copied or exported). Command:
`node dist/bench/lane.js --suite bench/suites/validated --configs <row>
--run-id audit-028-*`, model `opencode-go/deepseek-v4.1-flash`, one rate card,
pinned revisions. **No fresh 4×2 comparison exists:** omp completed the suite
fresh (4 attempts); LeanPi produced **two** recorded `express` attempts (both
`incomplete`) and then an interrupted `flask` attempt.

All six recorded fresh attempts (costs as recorded, before the correction below).

| run | arm | task | verdict | cost | wall ms | calls (tools) | in / cached / out (reason) | reported |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| preflight | leanpi | express | incomplete | $0.014671 | 50,658 | 18 | 32,250 / 432,128 / 8,175 (6,053) | false |
| refresh | leanpi | express | incomplete | $0.023792 | 78,234 | 26 | 47,042 / 786,432 / 13,556 (10,404) | false |
| preflight | omp | express | complete | $0.010671 | 39,239 | 14 | 40,198 / 463,616 / 5,417 | true |
| preflight | omp | flask | complete | $0.021677 | 108,232 | 43 | 53,778 / 1,559,424 / 14,886 | true |
| preflight | omp | preact | complete | $0.030410 | 383,288 | 44 | 122,653 / 1,659,008 / 11,725 | false (killed at 45-min ceiling) |
| preflight | omp | slugify | complete | $0.015782 | 106,825 | 29 | 42,927 / 930,560 / 10,919 | true |

- **Known recorded fresh spend:** $0.117003 across the six rows ($0.107128 if
  the two LeanPi rows are re-derived with the corrected formula). The
  interrupted `flask` attempt's spend is **unknown** and added to neither.
- **Fresh omp over the suite:** 4/4 complete, total $0.078540, cost/verified
  success $0.019635, median complete wall 107.5 s.
- **Fresh LeanPi:** 0/2 verified; both `express` goldens were **incomplete**. On the
  one task both arms re-ran, corrected LeanPi cost ($0.011039 preflight,
  $0.017549 refresh) still exceeds omp's $0.010671, and both LeanPi attempts
  were slower and failed the golden while omp passed.

  **Correction (2026-09-19, `docs/reports/reasoning-cost-2026-09-19.md`):** those
  LeanPi attempts ran without the bench-only permission profile this document's
  own benchmark requires (see `docs/benchmarks/2026-09-19-leanpi-vs-omp.md`,
  "Approvals": `edit/shell/network/package_install: allow` in a throwaway
  `XDG_CONFIG_HOME`), while the omp arm ran with `--auto-approve`. Without the
  profile `edit` and `shell` resolve to `ask` (`src/permissions/rules.ts:38`) and
  a headless session refuses them (`src/permissions/guard.ts:134`), so those
  attempts could not write a file. Re-run with the profile, the LeanPi arm is
  `complete` on `express` ($0.012061) and **4/4 on the whole validated suite for
  $0.055814** — the published LeanPi arm's $0.0516 reproduced. The fresh-LeanPi
  row above measures a read-only agent, not the harness, and the omp comparison
  in this section is not like-for-like.

### Fresh omp vs published omp, recomputed

Both arms have four verified successes, so the per-success and total reductions
**must be identical**. Computed with code:

| basis | published | fresh | reduction |
| --- | --- | --- | --- |
| cost / verified success | $0.027356 | $0.019635 | 28.224% |
| total cost | $0.109425 | $0.078540 | 28.225% |

Consistent with variance in a 4-task, one-attempt sample (omp's `preact` alone
was 56% of the published omp total and 39% of the fresh total), not evidence that
omp improved — the published omp arm was reused from retained ledgers, not
re-measured here.

### Cost-accounting correction

Pi's `Usage.reasoning` is a **subset of `Usage.output`** (SDK
`@earendil-works/pi-ai/dist/types.d.ts:274-277`; `dist/api/openai-completions.js:1194-1201`:
"OpenAI completion_tokens already includes reasoning_tokens"). `messageTokens`
summed `output` + `reasoning` (`src/bench/adapters.ts:286-305`) and the
synthesized call passed both additively to `priceCall`, which charges
output + reasoning (`src/telemetry/pricing.ts:90-96`) — double-charging any row
with `reasoning > 0`. Published rows have `reasoning = 0`, so published totals
are unaffected; the two fresh LeanPi express rows were double-charged.

Fixed at the adapter boundary (`src/bench/adapters.ts:115-125`): the synthetic
call reports `outputTokens - reasoningTokens` as output and keeps
`reasoningTokens` for the record, so cost is charged once. Regression:
`tests/bench/adapters.spec.ts` ("prices native usage without double-charging
reasoning"). Corrected derived costs: express preflight `$0.011039`, express
refresh `$0.017549`; original raw telemetry/ledgers are preserved unchanged and
corrected values live in `bench/out/audit-028-summary.json`.

## 6. Recommendations (ordered)

1. **Wire production cost accounting** (`onInvocation` → collector) and add a
   consumer-path test; keep the Pi reasoning/output relationship non-additive in
   pricing.
2. **Add a deadline/cancellation to the benchmark native path and to
   `runNative`**, and record interrupted-attempt spend instead of dropping it.
3. **Treat any provider error as failure** in `runNative` even when partial text
   exists.
4. **Make measurement unambiguous:** emit `calls` rows, fold all attempts into
   latency (or label "completed only"), and fold both configs in one invocation.
5. **Follow-ups:** the LSP test gate; README Node 22 wording; pnpm 11 install
   note. These are not alpha blockers.

## 7. Scope limits

- Documentation, benchmark artifacts and one benchmark-adapter accounting fix
  only; no product behavior change. The audit-only `pnpm-workspace.yaml` install
  workaround was removed from the deliverable.
- Fresh benchmark evidence is partial: two LeanPi `express` attempts recorded
  (both incomplete), one `flask` attempt interrupted with unknown spend, versus
  four omp attempts. No fresh 4×2.
- Pricing is list-price-equivalent arithmetic, not a billed invoice; the one
  failing test is pre-existing; raw ledgers contain no cloned workspaces, no
  provider prompts and no secrets.
