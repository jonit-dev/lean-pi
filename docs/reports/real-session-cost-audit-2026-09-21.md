# LeanPI: real-session token and cost audit

**Status:** Session audit complete. A Codex-versus-LeanPI pilot ran on DeepSeek v4.1 Flash. It supplies a preliminary cost observation, but one task, an underspecified acceptance requirement and incomplete inference-parity evidence prevent a reliable savings claim. The earlier stock-Pi pilot is excluded from the requested comparison; its cleanup is deferred.
**Session window:** September 20–21, 2026.
**Usage snapshot:** September 21, 2026, 19:18 UTC. The underlying logs are live.

## Verdict

**Cost per successfully completed task remains unproven.** Real sessions show inexpensive model usage and genuine reductions in large tool outputs. They do **not yet establish how much total cost LeanPI saves to reach the same verified task outcome compared with using the same model without LeanPI**.

The primary metric is:

```text
cost per verified completion = cost of all task attempts / verified completions
```

The numerator includes model usage, classification, retries, rework, compaction and delegated review. Failed attempts remain in it. If no task is verified complete, the metric is undefined: report spending and “no verified completion.” Token counts and compression ratios are secondary explanations, not the score.

The strongest real-session evidence is two independently verified tool-output reductions: **89,350 bytes became 1,424 bytes**, a **98.4% reduction for those two results**. This is not a 98.4% reduction in session tokens or bills. The largest measurement problems are omitted classifier costs, incomplete accounting for delegated agents, and native-session outcome fields that do not measure task success.

The requested same-model pilot recorded **$0.006977 for LeanPI, including JEV, versus $0.009612 for Codex**. LeanPI passed the upstream golden test; Codex produced unique slugs but used a different suffix that failed one exact assertion. Because the prompt did not specify that suffix, this is an acceptance-contract limitation, not clean evidence that Codex failed the user's stated goal. Both patches passed a separate post-hoc uniqueness check. Details and original outcomes are preserved below; no winner is declared.

All session and trial dollar amounts below are **locally recorded or calculated usage-value estimates, not invoices or subscription charges**.

For cash cost per task, OpenCode Go needs separate accounting: its public documentation lists a $10 monthly subscription and dollar-valued usage limits. DeepSeek V4.1 Flash is currently $0.15 / $0.60 / $0.003 per million uncached-input / output / cached-input tokens off peak, with double those rates during weekday 01:00–04:00 and 06:00–10:00 UTC. The historical local records use the off-peak rates uniformly; they have not been reconciled against time-dependent provider debits. Keep those recorded totals intact rather than relabeling them as actual charges. Cash cost per completed task requires the billing-period subscription allocation, any overages and auxiliary services, divided by verified completions. Lower usage can preserve quota without reducing that month's fixed bill. [OpenCode Go pricing and usage limits, checked September 21, 2026](https://opencode.ai/docs/go/#usage-limits).

## 1. What was inspected

The audit read native Pi JSONL transcripts, each project's own `.leanpi/telemetry.jsonl` and `.leanpi/decisions.jsonl`, and the production code that emits those records. Existing benchmark fixtures and this audit's OpenCode runs are excluded from the session totals.

| Project | Session files | Assistant records | Uncached input tokens | Cached input tokens | Output tokens, including reasoning | Recorded model cost |
|---|---:|---:|---:|---:|---:|---:|
| `lean-pi` | 57 | 652 | 1,490,586 | 41,531,776 | 416,660 | $0.598179 |
| `rpg-engine/rpg-api` | 14 | 261 | 676,616 | 13,213,952 | 121,075 | $0.213779 |
| `threenative/threenative-engine` | 3 | 287 | 352,728 | 35,163,264 | 225,680 | $0.293807 |
| **Total** | **74** | **1,200** | **2,519,930** | **89,908,992** | **763,415** | **$1.105765** |

These are **project-folder totals**, including startup errors and smoke prompts; they are not 74 independently completed coding tasks. One additional empty-cost startup session under an alternate `rpg-api` path is excluded. All sampled assistant records use `opencode-go/deepseek-v4.1-flash`.

Cached tokens account for about **97.3% of input-token events**. These are repeated inputs across requests, not unique source-code tokens. Both the cheap model and provider caching explain the small cost; neither alone proves a LeanPI-specific improvement.

### Attribution and arithmetic

Pi's session directory is shared with plain Pi, so its directory name alone does not prove LeanPI usage. For the detailed RPG examples below, native user-turn token totals match project-local LeanPI telemetry exactly. The release-fix session has four matching turns at RPG telemetry lines 14, 15, 19 and 21. Explicit compact artifact records provide additional direct LeanPI evidence.

The session IDs do not match directly because the extension creates a separate `SessionManager` for its own records. That is a traceability gap, not evidence that the stores describe unrelated work. See [extension session-manager creation](../../src/index.ts).

Cost was calculated by summing `usage.cost.input`, `output`, `cacheRead` and `cacheWrite` **once**. `cost.total` is null on the nonzero-cost native records examined. The detailed examples were independently recomputed using the recorded rate card:

```text
model_cost = (uncached_input × 0.15 + output × 0.60 + cache_read × 0.003) / 1,000,000
```

Cache-write usage is zero in these examples. Reasoning is already included in output and must not be added again. Native costs and LeanPI telemetry costs describe overlapping calls and must not be summed together.

## 2. Concrete real-work examples

| Session | Observable work | Assistant records | Recorded model cost | What the evidence establishes |
|---|---|---:|---:|---|
| RPG API, September 21 at 18:45 UTC | Fix a pre-deployment review's findings | 77 | $0.081365 | Four user-turn usage totals match LeanPI telemetry. The final response reports local commits `4077530a1` and `5e4ae4c50`. |
| RPG API, September 21 at 02:22 UTC | Coding work followed by external Codex review | 92 | $0.065379 | Includes a verified compacted output. The session ends waiting for the external reviewer, so this price is not the complete workflow's cost. |
| Threenative, September 21 at 02:36 UTC | Native UI cadence instrumentation and verification | 166 | $0.177135 | A native turn matches LeanPI telemetry. The final response reports commit `8e2f1d1fb` and measured cadence improvements. |

The audit inspected the recorded work; it did not rerun those historical changes' test suites. A final response claiming completion is weaker evidence than independently passing a benchmark's acceptance tests.

Session evidence:

1. [RPG release-fix transcript](/home/joao/.pi/agent/sessions/--home-joao-projects-rpg-engine-rpg-api--/2026-09-21T18-45-46-714Z_01a0c549-da5a-70b6-a971-b89c7dcbd057.jsonl), final response at line 174.
2. [RPG delegated-review transcript](/home/joao/.pi/agent/sessions/--home-joao-projects-rpg-engine-rpg-api--/2026-09-21T02-22-31-235Z_01a0c1c5-a743-740d-9f0e-09c32fdd2029.jsonl), compact output at line 173; external `codex exec` activity from line 174; waiting response at line 217.
3. [Threenative transcript](/home/joao/.pi/agent/sessions/--home-joao-projects-threenative-threenative-engine--/2026-09-21T02-36-25-463Z_01a0c1d2-61f6-73eb-9871-31fca9e7160b.jsonl), final response at line 371.

## 3. Which savings mechanisms actually showed up?

### Large tool-output compaction: demonstrated, with limited observed coverage

Across the three project directories, 1,399 recorded tool results contained three explicit compact-output replacements:

| Project / transcript location | Original bytes | Emitted compact bytes | Reduction | Verification |
|---|---:|---:|---:|---|
| `lean-pi`, session `01a0c24c…`, line 159 | 43,192 | 718 | 98.34% | Retained raw artifact size and SHA-256 both verified. |
| RPG API, session `01a0c1c5…`, line 173 | 46,158 | 706 | 98.47% | Retained raw artifact size and SHA-256 both verified. |
| RPG API, session `01a0c01e…`, line 11 | 38,755 | 709 | 98.17% | Original size is recorded in the transcript; raw artifact was not found at the expected current location. |

This proves that LeanPI sometimes sends much less tool-result text. It does not measure exact tokenizer savings, subsequent re-expansion, repeated-context savings, or total task cost.

The artifact store's default threshold is **32,768 bytes**. This mechanism still works when the optional RTK executable is absent: the RTK fallback returns the artifact store's already-compacted result. `rtk` was not on this environment's PATH during the audit. See [artifact capture](../../src/context/artifacts.ts), [RTK fallback](../../src/rtk/reducer.ts), and [tool-result integration](../../src/index.ts).

Verified raw artifacts:

- [LeanPI 43,192-byte artifact](/home/joao/projects/lean-pi/.leanpi/artifacts/01a0c24c-1851-7511-b76a-0e5804d675df/artifacts/bash/68636f4a6f214b9f9f35f5958160daf2f1598a0dcf1fc990c6ac0d3af37f200b)
- [RPG 46,158-byte artifact](/home/joao/projects/rpg-engine/rpg-api/.leanpi/artifacts/01a0c1c5-a78f-7132-b836-71c826c3500d/artifacts/bash/f4ee3a78e73a430e48d51e8b1d733c6117fa059f483849d584da952f8a00b4c2)

### Routing: cheap model observed; adaptive cost benefit not established

Every recorded executor in the three project telemetry files was DeepSeek Flash. The native compiler does apply model/effort selection, but the more advanced `selectRoute` path belongs to LeanPI's own executor lane, which native Pi execution bypasses. No sampled native telemetry record contains `route_cost`.

Therefore, the data establishes inexpensive model use. It does not establish savings from switching model classes or adaptive routing. Historical OMP records also contain substantial use of the same Flash model, so cheap-model access is not unique to LeanPI.

See [native model selection](../../src/index.ts), [lane ownership](../../src/commands/turn-lanes.ts), and [executor routing](../../src/executor/lane.ts).

### Skill selection and automatic context compaction: do not confuse code with measured benefit

Skill selection is wired into the native prompt. This audit did not measure a matched full-catalog baseline, so it assigns no savings percentage to that feature.

Pi's host automatic context compaction remains enabled independently of LeanPI's manual `/compact-refs` command. LeanPI's unwired compaction counter cannot establish whether host compaction occurred. The inspected project transcripts had no explicit compaction entries; that observation is narrower than claiming automatic compaction is disabled.

## 4. Cost and outcome accounting gaps

### JEV classification cost is omitted from production telemetry

| Project | Decision-log rows | JEV input tokens | Estimated input cost at the repository's $0.042/M rate | JEV cost recorded in run telemetry |
|---|---:|---:|---:|---:|
| `lean-pi` | 358 | 2,014,346 | $0.084603 | $0 |
| RPG API | 116 | 936,271 | $0.039323 | $0 |
| Threenative | 30 | 162,184 | $0.006812 | $0 |
| **Total** | **504** | **3,112,801** | **$0.130738** | **$0** |

These logs also contain 495,787 output tokens and 62 fallback decisions. The estimate uses the repository's documented **input-only** JEV rate; it is not a check of the provider's current invoice. Zero-token fallback records do not prove that a remote failed request incurred no charge.

The production decision sites do not feed `recordJevDecision`; the observed writer integration is in the benchmark adapter. There is a second accounting issue to address when wiring it: the collector currently combines JEV input and output, while the documented rate is input-only.

Evidence: each project's `.leanpi/decisions.jsonl` and `.leanpi/telemetry.jsonl`; [JEV rate contract](../../src/jev/client.ts), [collector projection](../../src/telemetry/collect.ts), and [cost calculation](../../src/telemetry/pricing.ts).

### Native task-success and retry counters are not trustworthy outcome measures

All **92** sampled project telemetry records report `success: false`, with verification/proof not run. The native execution path does not populate the executor outcome required by `verdictOf`; this does **not** mean all 92 tasks failed.

Retry, escalation, compaction and repeated-read counters also lack production wiring. Their zeros are not evidence that the corresponding behavior never happened. Native transcript totals exceed emitted telemetry totals, so the telemetry is not a complete replacement for the transcripts when auditing spending.

See [native verdict](../../src/index.ts) and [usage/counter collection](../../src/telemetry/collect.ts).

### Delegated-agent work needs its own cost attribution

The 02:22 RPG session invokes an external Codex review and ends waiting for it. Its **$0.065379** Flash estimate excludes that reviewer's usage. Consequently, a low parent-session total cannot establish a low end-to-end task cost.

Historical OMP and native-Pi totals cover different tasks, dates, models and completion states. Comparing their raw dollar totals, or repricing Flash tokens at an expensive model's rates, would not measure LeanPI's contribution.

## 5. Fair benchmark design

**Requested comparison: Codex CLI versus LeanPI, both using DeepSeek 4.1 Flash.** The outcome is total cost per externally verified completed task. Replacing Codex with stock Pi was an incorrect change of scope; stock-Pi results do not answer the user's question.

1. **Pair identical tasks and starting files.** Use independent fresh copies, the same task text and deterministic acceptance tests. Confirm each bug exists before the agent starts.
2. **Equalize provider settings.** Match model, API, thinking policy, context limits and rate card. Give every attempt a fresh stable cache/session ID; preserve caching within that attempt. Alternate execution order across repetitions.
3. **Count all work.** Record uncached input, cache reads/writes, output including reasoning, JEV input cost, retries, wall time and any delegated-agent usage. Include failed and timed-out attempts rather than silently dropping them.
4. **Judge correctness first.** Report passing tasks, regressions and false completion claims alongside cost. A cheap failed attempt is not a saving. Aggregate cost per verified completion includes the cost of failures.
5. **Report distributions and scope.** Compare paired costs over multiple tasks and repetitions. A small pilot can expose a settings or accounting problem; it cannot establish a general percentage saving for long RPG development sessions.

### Codex compatibility preflight

The installed **Codex CLI 0.155.1 successfully answered `PONG`** through `https://opencode.ai/zen/go/v1/responses`, configured for `deepseek-v4.1-flash`, with an isolated `CODEX_HOME` and a fresh stable `x-opencode-session`. Exit code was 0 after 2.098 seconds. Codex reported 13,598 input tokens, including 7,040 cached, and 3 output tokens: approximately **$0.001007 of off-peak usage value**, excluded from task attempts. [Sanitized config, events and result](../../bench/out/codex-comparison-20260921/initial-codex-probe.json).

This proves a basic Codex request and usage reporting work; it does not yet prove tool execution, settings parity or a completed coding task. Codex warned that it used fallback metadata for this non-catalog model. It also loaded personal skills despite a fresh `CODEX_HOME`, so isolating that directory alone is not an adequate benchmark control. The paired-task preflight must check optional instructions, actual reasoning settings and acceptance tests before treating results as comparable. Codex's Responses transport and LeanPI's Chat Completions transport must be recorded explicitly.

An offline HTTP listener subsequently captured **Codex `reasoning.effort="medium"` and LeanPI `thinking.type="enabled"`, `reasoning_effort="medium"`**, with the same requested model ID. Codex used `model_supports_reasoning_summaries=true`, `model_reasoning_effort="medium"`, `project_doc_max_bytes=0` and disabled skill instructions. Both captures lacked optional-skill markers. This validates request construction, not the gateway's conversion semantics or exact inference-budget equality; generic `AGENTS.md` references remained in harness text. LeanPI's compiler can override a session-level `off` setting, so a configured label alone is insufficient evidence of effective reasoning. [Whitelisted request metadata](../../bench/out/codex-comparison-20260921/preflight/parity/request-metadata.json).

### Requested Codex-versus-LeanPI pilot: completed, preliminary

Both arms received the same prompt and local-only constraints, independent copies of `slugify-counter-duplicate-slug` at commit `2acf5b3cadf7faed3928536d051104502ae2b667`, the same provider/model, fresh stable session IDs, and a 180-second process-group limit. Execution order was Codex, then LeanPI. No repair attempt or model-based reviewer followed either result. LeanPI used the frozen runtime and production JEV-enabled configuration. Codex used its isolated configuration above. Both preserved the original test file and package manifest during agent execution.

Offline preflight proved that the original source fails the intended assertion at `test.js:270`, while the retained known-good source passes all 25 tests. The hidden golden was installed only after each agent finished. The acceptance command was `node ./node_modules/ava/entrypoints/cli.mjs test.js`; its SHA-256 was `980861781f5c5d735d3b7b6d78eec4f49e02164ed98fecf4e96a04e2756199ea`.

| Arm | Model usage value | Classifier usage value | Total per attempt | Agent runtime | Original upstream-golden result |
|---|---:|---:|---:|---:|---|
| Codex CLI 0.155.1 | $0.009612312 | $0 | **$0.009612312** | 68.015 s | One exact-suffix assertion failed |
| LeanPI | $0.005637 | $0.001339884 | **$0.006976884** | 34.092 s | **25 tests passed** |

LeanPI's estimated cost **per attempt was 27.4% lower**: `(0.009612312 - 0.006976884) / 0.009612312 × 100 = 27.4172%`. This percentage describes the single observed pair; savings per equivalent verified completed task remain unproven.

Codex reported 160,084 input tokens, including 152,704 cached, and 13,412 output tokens, including 11,336 reasoning tokens. LeanPI's main telemetry reported 15,505 uncached input, 156,928 cached input, 2,450 non-reasoning output and 2,284 reasoning tokens. Its model cost already includes reasoning; JEV contributes a separate 31,902 input tokens. The LeanPI model-cost field is rounded to six decimal places. These are off-peak usage estimates; runtime excludes fixture copying and external adjudication. Orchestration, compatibility probes and evaluator setup are measurement overhead, excluded from the task-attempt totals rather than claimed to be free.

**Acceptance limitation:** for `foo`, `foo`, `foo 2`, Codex returned `foo`, `foo-2`, `foo-2-1`; the hidden upstream test required `foo`, `foo-2`, `foo-2-2`. The task prompt asked for distinct slugs but did not state the latter exact numbering requirement. After observing this mismatch, a separate diagnostic checked uniqueness and reset behavior over 1,554 sequences of length 1–4. The baseline failed 384; both resulting patches failed zero. This diagnostic is post-hoc and does **not** replace the original golden or retrospectively award a benchmark pass.

Under the original strict golden, cost per verified completion is $0.006977 for LeanPI and undefined for Codex (zero passes). **That is not an interpretable comparison of cost per equivalent completed task.** Before repeating, make the prompt and acceptance contract agree, freeze them, and use new paired attempts. Do not rerun only the losing arm or silently relax its verifier.

Other limits: one small library bug and one trial per arm do not represent RPG-sized tasks; request-level reasoning matches do not attest identical upstream conversion or budgets; LeanPI can adapt reasoning after classification; fresh session IDs do not prove cold provider caches. The normalized summary therefore retains `comparison_eligible: false`.

Evidence: [actual attempt results](../../bench/out/codex-comparison-20260921/result.json), [normalized input](../../bench/out/codex-comparison-20260921/summary-input.json), [summary](../../bench/out/codex-comparison-20260921/summary.json), [offline acceptance preflight](../../bench/out/codex-comparison-20260921/preflight/acceptance.json), and [post-hoc diagnostic](../../bench/out/codex-comparison-20260921/posthoc-uniqueness.json). The local driver and raw logs remain in the same scratch directory. No further paid trials were run after the acceptance ambiguity appeared.

The archived scripts, configurations, compact evidence, solution patches and reusable skill are versioned. **Reproduction limit:** the drivers retain machine-specific paths and require local frozen runtime/fixture copies, which are excluded with dependencies and credential state. The runtime's source revision was not pinned, so this archive does not provide an exact clean-checkout rerun.

### Excluded stock-Pi pilot: wrong baseline

A bounded pilot attempted `slugify-counter-duplicate-slug` on the same frozen fixture (`2acf5b3cadf7faed3928536d051104502ae2b667`), alternating LeanPI / stock Pi / stock Pi / LeanPI. This was not the requested Codex comparison. Its artifacts and costs remain here for accountability, not as evidence for or against LeanPI's advantage over Codex.

**The acceptance runner was broken.** Re-running its command in the first stock-Pi result workspace produced:

```text
./node_modules/.bin/ava test.js
AssertionError [ERR_ASSERTION]: null == true
    at node_modules/ava/lib/worker/main.cjs:8:1
1 uncaught exception
```

AVA failed during worker initialization, before the task assertions ran. The first three automated `incomplete` verdicts therefore cannot distinguish a faulty solution from a faulty benchmark. Further paid work was stopped; the fourth attempt recorded an interruption.

| Arm / trial | Recorded model cost | Recorded JEV input-cost estimate | Classification |
|---|---:|---:|---|
| LeanPI / 1 | $0.017636 | $0.001316 | Invalid: acceptance-runner crash |
| Stock Pi / 1 | $0.018641 | $0 | Invalid: acceptance-runner crash |
| Stock Pi / 2 | $0.016384 | $0 | Invalid: acceptance-runner crash |
| LeanPI / 2 | $0.004763 | Unknown beyond zero-token fallback records | Interrupted; incomplete cost coverage |

About **$0.059** of model/classifier cost was recorded for these pilot attempts. This is a known amount, not a complete bill, and excludes the audit/orchestration work. This earlier pilot contains **no Codex attempts**. Do not use it to declare a winner in the requested comparison.

Follow-up investigation traced the AVA crash to fixture copying: `cpSync(..., {recursive: true})` turned the `.bin/ava` symlink into an absolute reference to the original fixture, while the copied tests loaded the workspace's separate AVA installation. Running `node ./node_modules/ava/entrypoints/cli.mjs test.js` in each retained result workspace recovered **25 passing tests for LeanPI trial 1 and both stock-Pi trials**. All three used golden-test SHA-256 `980861781f5c5d735d3b7b6d78eec4f49e02164ed98fecf4e96a04e2756199ea`. The interrupted LeanPI workspace passed only its original 24 tests; supplying the same golden test exposed the intended duplicate-slug failure. These recovered outcomes correct the test-runner diagnosis but do not make stock Pi an acceptable substitute for Codex.

The scratch driver's initial display also used inconsistent output-token accounting and must not be treated as a validated calculator. This report uses recorded model-cost components plus separately identified JEV input usage. A production run, stock-Pi adapter and interrupted fallback can expose different output/reasoning semantics; each path must be checked independently.

The raw attempt ledgers and telemetry are retained under [pilot artifacts](../../bench/out/real-session-audit-20260921/out/). The complete scratch directory occupies approximately **1.4 GB**, including copied runtime, fixtures and dependencies. **The user explicitly deferred stock-Pi cleanup.** Compact historical evidence and scripts are versioned; generated copies and credential state remain local and ignored. No stock-Pi benchmark processes remain running. The requested Codex comparison requires a healthy acceptance runner, verified timeout behavior on both adapters, and complete accounting.

### Reusable skill

The requested [fair-agent-benchmarks skill](../../bench/skills/fair-agent-benchmarks/SKILL.md) turns the method into a reusable workflow. It scores cost per externally verified completion, preserves failed-attempt spending, checks matched pairs and cost coverage, and produces one Markdown report. Its [standard-library summary helper](../../bench/skills/fair-agent-benchmarks/scripts/summarize.py) refuses a comparison when costs or parity are incomplete.

Validation passed: skill metadata checks; calculator self-checks covering failed-attempt costs, zero completions, unknown costs, duplicate trials and unmatched pairs; and a forward check using this pilot's actual normalized records. The [pilot summary](../../bench/out/real-session-audit-20260921/cost-per-task-summary.json) retains spending, counts two invalid trials per arm, and correctly leaves both quality pass rates and cost per verified completion undefined. The skill now requires acceptance-runner preflight before paid trials.

```text
$fair-agent-benchmarks compare Codex CLI and LeanPI on DeepSeek v4.1 Flash; score cost per verified task
```

## 6. Recommended priorities

1. **Make the cost total complete:** wire JEV input usage and delegated-agent attribution into the actual native runtime, including failed and interrupted work.
2. **Make outcomes and sessions traceable:** record native completion evidence, populate real retry/compaction counters, and persist the host Pi session ID beside LeanPI's internal ID.
3. **Use the paired benchmark to guide optimization:** retain proven artifact compaction; require measured cost and quality improvements before crediting additional routing or reasoning policies.

**Next action:** state the required collision-numbering behavior explicitly in the task prompt, freeze that acceptance contract, and repeat both Codex and LeanPI from fresh identical inputs before expanding to representative RPG tasks.
