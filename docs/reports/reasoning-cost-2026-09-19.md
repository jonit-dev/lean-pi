# Reasoning cost — where the benchmark's money went, and what changed (2026-09-19)

Follow-up to `docs/audits/production-readiness-audit.md` (PRD-028). The audit
found that production cost accounting was never fed and that the native
benchmark path is unbounded. This is the other half of the same question: what
the money on that path was spent on, and what the tree now does about it.

**The change has two parts and the evidence separates them.** Removing this
machine's skill catalog from every request is a pure input saving: it changes
what the model *reads*, not what it decides. Declaring `thinkingLevel: off` is a
spending policy, and on the four-task suite it saved 4% while losing a solve —
the reasoning it removed came back as 65 extra tool calls.

Measured with the permission profile the benchmark requires:

| configuration | `express`, 3 pairs | validated suite, 1 pair |
| --- | --- | --- |
| catalog fix + `thinkingLevel: off` | **×0.56** (−44%), 6/6 solved | **×0.96** (−4%), **3/4 solved** vs baseline 4/4 |
| catalog fix alone | — | **×1.02** (+2%), 4/4 solved (see [the isolating pair](#the-four-task-suite-catalog-fix-alone-the-pair-that-isolates-it)) |

The first series is where the headline number came from and it is not the whole
story; the second is why the shipped config no longer declares `off`; the third
is the one the goal turns on, and **the goal is not met** — the catalog fix is a
quality-neutral input saving measured in bytes and priced at 13% of this suite's
baseline, not a 50% cut, and at one pair per configuration the suite total is
dominated by a single task's thinking swing. Before any
of it, the measurement was broken: **no run in this series, or in the cost series
before it, set the permission profile the benchmark requires, so every `edit` and
`shell` call was refused and those arms measured a read-only agent.** The
published benchmark's own method says the profile is required, and with it
restored the baseline arm solves the whole suite — which is what the earlier
series' 0/4 could not do.

## F0 — the first series could not edit, so it measured no quality

`BUILTIN_DEFAULTS` (`src/permissions/rules.ts:38`) resolves `edit` and `shell` to
`ask`. A headless session has no UI, so `installPermissionGuard`'s `ask` becomes
a refusal (`src/permissions/guard.ts:134`). The published benchmark's method
section says exactly this and says what it did about it: LeanPi "ran under a
bench-only user permission profile (`edit/shell/network/package_install: allow`)
in a throwaway `XDG_CONFIG_HOME`".

Neither this series' drivers nor the cost series before them did that. Measured
directly, in the benchmark's own conditions:

| `XDG_CONFIG_HOME` | `edit:lib/response.js` | `shell:npm test` |
| --- | --- | --- |
| unset (what every earlier run had) | `ask` → refused | `ask` → refused |
| `bench/profiles/bench` (added here) | `allow` | `allow` |

The evidence that this mattered, not just in principle — both retained from
checkouts of the same task, before the clones were dropped:

- `bench/out/cost-probe-skill/patches.txt` — an earlier-series run whose only
  change is the adjudicator's staged golden. The agent wrote nothing.
- `bench/out/cost-r1-base/patches.txt` — the same task, same arm, with the
  profile: a correct `lib/response.js` patch (compute the length, set
  `Content-Length` only when no `Transfer-Encoding`) and a **`complete`**
  verdict. The fix matches upstream's shape.

And at suite scale: `cost-s1-base`, the baseline arm on the four-task validated
suite with the profile, is **4/4 complete for $0.055814** — which is the
published benchmark's LeanPi arm ($0.0516 for the same four tasks, same model,
same rate card) reproduced on this build. The same arm without the profile was
0/4 at $0.209356–$0.336909. The profile is the difference, and it costs the arm
6× less to *succeed* than it cost to fail.

So: every cost number in the earlier series describes an agent that could read
and think but not write. Those numbers are internally comparable (all arms were
equally blocked) and they are retained as evidence, but they are not a
measurement of LeanPi, and **the 0/4 solve rate that the audit and the handoff
both took as a property of the model or the harness is a property of the missing
profile.**

## F1 — every request carried this machine's whole skill catalog

`createLeanPiSession()` let Pi's resource loader build its own
`<available_skills>` block, and PRD-005's selection only ever ran inside
`compileTask()` — which a native backend never reaches. Measured on the
baseline revision (`ed05f8d`):

```
prompt 87,932 bytes, "<available_skills>" at byte 5,589, block 82,343 bytes
```

~20.6k tokens, in the system prompt of **every** provider call. This tree:
**5,365 bytes, no skills block**.

## F2 — the compiler's reasoning effort never reached the session

`EFFORT_BY_COMPLEXITY` (`src/compiler/index.ts:70`) computes
`contract.reasoning.effort`; three status commands read `thinkingLevel`; nothing
ever *set* it, so every turn ran at the session's level. `runTurn` now applies
it — after `setModel()`, which resets the level.

## F3 — the endpoint ignores `reasoning_effort` and honours `thinking`

Direct probes against the benchmark's endpoint (`deepseek-v4.1-flash`), one
prompt, `max_tokens` 6,000:

| request | completion tokens | reasoning tokens | answer chars |
| --- | --- | --- | --- |
| (nothing) | 114 | 63 | 113 |
| `reasoning_effort: minimal` | 132 | 71 | 154 |
| `reasoning_effort: low` | 156 | 95 | 154 |
| `reasoning_effort: high` | 140 | 75 | 162 |
| `thinking: {type: disabled}` | 267 | **0** | 699 |

Those probes did **not** demonstrate useful effort control: across four settings
reasoning moved 63→95 tokens, which at n=1 per setting is not a signal. What they
did show is that `thinking` — DeepSeek's field, which Pi sends only when the
model declares that dialect — is read as "do not think" and `reasoning_effort` is
not. On a harder prompt (a Transfer-Encoding parser, same 4,000-token cap) the
difference was not a matter of degree: the default run spent all 4,000 tokens
reasoning and emitted no answer, while the `thinking: disabled` run answered in
188.

Pi detects the dialect from the provider id and base URL, and a native backend
carries the operator's own name for it, so `backends.<name>.compat` is now
forwarded to the registered models. Pi's own bundled catalog declares
`thinkingFormat: deepseek` for the sibling models on this vendor; the model this
benchmark uses is not in the catalog, which is why it must be declared.

## F4 — the spending policy is the operator's, not a constant

`runTurn` applies the compiled effort. When the compiler decided nothing there is
no decision, so `backends.<name>.thinkingLevel` applies, and when the operator
declared none the session's own level stands. That is the mechanism this work
adds; whether to *use* it is a separate question, and the answer from the
four-task suite is no — see
[the suite result](#the-four-task-suite-and-why-the-thinking-policy-is-reverted).

An earlier revision of this work hardcoded `off` for every uncompiled turn. That
was reverted twice over: it silently overrode an operator's chosen level, and the
evidence now says the policy itself does not pay. A config value outside Pi's
vocabulary is a named error (`core/config.ts`), not a level Pi would silently
clamp.

## F5 — the compiler never ran on the path that spends the money

The largest finding in this report, and it is not about tokens: **on a native
backend the compiler lane was never registered.** `registerTurnLanesIfOwned`
registered `compiler` + `executor` only when `ownsExecutionLoop(config)` — true
only when the executor roles are external harnesses — and otherwise registered
the skill lane alone, on the reasoning that "Pi's own loop is the executor".

That reasoning covers the *executor*, not the *decisions*. With the compiler out,
a native turn had no contract at all, which means, on the configuration this
machine and the benchmark both use:

- no complexity classification, so no executor class (JEV's routing lever);
- no `reasoning.effort`, so the only reasoning control with money in it on this
  endpoint never fired — `runTurn` applied a compiled effort *if* a contract
  existed, and none ever did;
- no PRD dispatch, no review-risk decision, no proof gate;
- JEV's only remaining reach was the skill disclosure — unranked, because of the
  credential bug above.

So the benchmark compared `Pi + static prefix + permission guard + an unranked
three-pointer skill block` against omp and called it LeanPi. The control plane —
the thing the ROADMAP's cost thesis is made of — was switched off by a predicate
meant to say "who runs the loop".

**Fixed:** the compiler registers on every path (the executor lane still only
when LeanPi owns the loop, or the task would run twice), and `runTurn` now spends
the compiled decision — the class resolves the session's model, the effort
resolves its thinking level. The classes keep Pi's graded ladder, and the
operator's declared `thinkingLevel` becomes a *ceiling* on the compiled effort
(`cappedThinkingLevel`) rather than a default the classifier overrides: on this
endpoint the wire control is binary (`thinking: {type: enabled|disabled}`,
`openai-completions.js:686-696`), so `low` and `high` are the same request and
`off` is the only value with money in it — which makes it the operator's switch,
not the classifier's. A class-gated `off` was implemented and then withdrawn: see
F6. The disclosure on this path stays a pointer (name, description, path), because
the block is re-sent on every provider call; the one-shot compiled prompt still
gets bodies.

## F6 — class-gated `off` was tried and is not the win

With the compiler finally running, its classification *can* decide to spend
nothing on reasoning — the only decision with money in it on this endpoint. It was
wired that way for a few hours (`LOW` complexity → `off`) and withdrawn on the
evidence:

- **Blanket `off` is worse per verified solve, not better.** `cost-s1`: $0.055814
  over 4 solves = **$0.01395** per verified success, against $0.053362 over 3 =
  **$0.01779** — a 27.5% regression on the metric the product is defined by. The
  lower *total* is bought with a lost solve.
- **The classifier picked the wrong task.** On a clean workspace the heuristic
  bands the suite as `express`/`flask`/`preact` → MEDIUM and `slugify` → LOW, so a
  class-gated `off` spends nothing on `slugify` — the one task whose cost *rose*
  under `off` ($0.006212 → $0.008480) — while `express`, the demonstrated 46% win,
  keeps thinking. An adversarial review of the branch reached the same conclusion
  independently.
- **What the evidence supports** is `express`-shaped work: 26–50% on repeated
  `express` pairs, and 5.1% of a suite if only that task were affected. Turning
  `flask` off as well makes the suite *costlier* even if a retry recovers it.

So thinking stays on, per class, with the operator's `off` as the ceiling, and the
next experiment is the one that would earn the policy: **an eligible turn gets a
thinking-off attempt, and ordinary verification failing triggers exactly one retry
with thinking on** — no held-out golden spent on the decision, the golden still
adjudicating at the end.

**How to measure it (per the review, and adopted):** three arms — forced-on,
heuristic effort gate + retry, live-JEV effort gate + retry — same model, same
dialect, same disclosure, same verification; 10 repeats per task per arm on
`validated`; scored by **total cost / verified successes**, all retry and JEV
spend included. Falsified if spend per golden-verified solve is not lower, or if
ordinary verification accepts cheap attempts that the held-out golden rejects.

## What shipped (this pass)

| file | change |
| --- | --- |
| `src/index.ts` | `skillsOverride` → no Pi skill block; `compat` forwarded to registered models; the skills registry passed into the lanes |
| `src/commands/turn-lanes.ts` | `skillLane()` — PRD-005's selection for backends LeanPi does not own the loop for |
| `src/commands/session.ts` | compiled effort applied after `setModel`, else the backend's declared level; a compiled contract's skill slot wins over the lane's |
| `src/core/types.ts`, `src/core/config.ts` | `backends.<name>.compat`, `backends.<name>.thinkingLevel`, validated |
| `leanpi.config.yaml` | `compat: {thinkingFormat: deepseek}` for the measured endpoint; `thinkingLevel` documented but left unset, on the suite evidence |
| `bench/profiles/bench/leanpi/permissions.json` | the profile the benchmark requires, committed so a run cannot silently omit it |
| `bench/cost/run-pair.sh`, `bench/cost/fold.py`, `bench/cost/series.json` | the alternating pair driver, the fold, and the record of which runs are which arm |
| `bench/suites/cost-express/` | one relative symlink to the validated `express` task, for cheap repeats that cannot drift from the task they sample |
| `tests/cost-wiring.spec.ts` | five red-green tests: no catalog in the request, JEV asked and only pointers disclosed, compiled effort over the declared level, no invented level, the dialect's `thinking` control on the wire |
| `src/commands/turn-lanes.ts` | the compiler registers on every path; only the executor lane is ownership-gated (F5) |
| `src/commands/session.ts` | the compiled class resolves the session's model, and the compiled effort its thinking level, for turns nobody pinned |
| `src/compiler/index.ts`, `src/commands/session.ts` | the classes carry Pi's graded effort; the operator's declared `thinkingLevel` is a **ceiling** on it, not a default it replaces (`cappedThinkingLevel`), so `off` is a switch an operator actually has |
| `src/jev/credentials.ts` | a project's `.env` is a credential source, read without publishing it to `process.env` |
| `src/backends/native.ts`, `src/backends/registry.ts` | `runNative` honours a wall-clock deadline, any provider error is a failure even after partial text, and the invocation record carries the model and the token breakdown |
| `src/bench/adapters.ts`, `src/bench/runner.ts` | a per-attempt ceiling for LeanPi turns (`bench.leanpiTimeoutMs`), a partial record for a killed or interrupted attempt, and a ledger row marked `error` when the operator interrupts a run |
| `src/core/tools.ts` | every shell command is bounded (`COMMAND_TIMEOUT_SECONDS_DEFAULT`); a hung agent-issued command had voided a suite run |
| `src/index.ts` | the interactive loop spends the compiled route too: the class selects Pi's model, the effort its thinking level |
| `src/bench/adapters.ts` | the attempt's row now carries JEV's own token spend, read from the run's decision log, so the control plane's cost is inside the number |

## Method

- **Two arms, alternating, one pair at a time.** Baseline = a second worktree at
  `ed05f8d` with its own `dist/`; treatment = this tree. Each run gets a fresh
  provider session id, so prompt-cache state is symmetric, and both arms read the
  same suite bytes, fixtures and permission profile.
- **The permission profile is part of the method, not the environment.**
  `bench/cost/run-pair.sh` exports it; a run that omits it measures a read-only
  agent (F0).
- **Two suites**: the validated four-task suite, and single-task runs of its
  `express` task through `bench/suites/cost-express/` — a directory holding one
  relative symlink to the validated task, so the cheap sample cannot drift from
  the task it samples.
- **No means.** Per-task cost here is heavy-tailed, so every figure is a median
  with its range, pairs are reported as within-pair ratios, and the fold refuses
  partial runs and mismatched task sets (`bench/cost/fold.py`).
- **The earlier series is labelled, not deleted.** Its runs are the evidence for
  F0 and for the fact that the wiring moved the numbers even when the agent could
  not edit.

## Results

### With the permission profile (the measurement that counts)

`express`, one task, alternating arms:

| pair | A `ed05f8d` | C this tree | ratio | verdicts (A / C) | wall (A / C) |
| --- | --- | --- | --- | --- | --- |
| `cost-r1` | $0.012061 | $0.006084 | ×0.50 | complete / complete | 355 s / 1,068 s |
| `cost-r2` | $0.009601 | $0.005386 | ×0.56 | complete / complete | 344 s / 1,484 s |
| `cost-r3` | $0.009808 | $0.007215 | ×0.74 | complete / complete | 622 s / 343 s |
| **median** | **$0.009808** | **$0.006084** | **×0.56** | 6/6 complete | — |

**Median reduction 44% (×0.56), range 26–50%.** That is short of the 50% target at
the median and meets it in the best pair; the honest statement is "about 40–45%
cheaper on this task, with both arms solving it", not the 70% the blocked series
showed. Every C run has zero reasoning tokens; every A run has 3,058–5,506.

Both arms solve the task in every pair, and every component moves in the same
direction — the pair that carries the whole argument, `cost-r1`, line by line:

| arm | cost | tool calls | uncached in | cached in | out | reasoning | wall | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A `ed05f8d` | $0.012061 | 22 | 35,715 | 615,296 | 8,096 | 5,506 | 355 s | **complete** |
| C this tree | **$0.006084** | 26 | 13,710 | 262,016 | 5,402 | **0** | 1,068 s | **complete** |

Uncached input −62% (the catalog), cached input −57%, output −33% (all of it
reasoning), and the reasoning stream is gone entirely.

The patch each arm wrote is the same upstream fix — compute the length
unconditionally, set `Content-Length` only when there is no `Transfer-Encoding`
(`bench/out/cost-r1-base/patches.txt` and `…-treat/patches.txt`, `lib/response.js`
in both). So the cheaper arm did not buy its cost with a worse patch on this
task. The clones are dropped after the patch is recorded, which is also why an
agent edit to a held-out golden file is not recoverable here: the adjudicator
checks that file out over the workspace before grading.

What it did buy it with is **time and turns**: 26 tool calls against 22, and
1,068 s against 355 s, most of it running the whole `test/` directory
(`git stash` / `timeout 240 npx mocha … test/` / `git stash pop`) rather than the
one test the task names. The repeat says the same (25 calls, 1,484 s) — but the
*third* pair's baseline did the same thing, so see the caveat in
[Quality](#quality-what-is-and-is-not-established) before reading that as an
effect of the change.

### The four-task suite, and why the thinking policy is reverted

Same conditions, one pair, validated suite — the arm that carries `thinkingLevel:
off`:

| arm | total | express | flask | preact | slugify | verdicts | tool calls | wall |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A `ed05f8d` | $0.055814 | $0.006141 | $0.015427 | $0.028034 | $0.006212 | **4/4 complete** | 133 | 449 s |
| C this tree (`thinkingLevel: off`) | $0.053362 | $0.003304 | $0.010309 | $0.031269 | $0.008480 | **3/4 complete** (`flask` failed its golden) | 198 | 1,020 s |

**×0.96 — 4% cheaper, and one solve lost.** The mechanism is visible in the same
row: 198 tool calls against 133, and 2.3× the wall time. Reasoning tokens went to
zero, and the turns that replaced them cost what the reasoning did. On the two
small tasks the saving is real (`express` ×0.54, `flask` ×0.67); on `preact`, the
one task with real state to hold, the no-thinking arm spent *more* ($0.031269
against $0.028034) and 94 tool calls against 60.

That is the answer to the goal's second half: **on this suite, disabling thinking
does not buy 50%, and it does not preserve quality.** The catalog fix is a
different matter — it removes input bytes and changes nothing the model decides —
and the pair that isolates it is `cost-t1`.

### The four-task suite, catalog fix alone (the pair that isolates it)

`thinkingLevel` unset, so the level is Pi's own default and the prompt bytes are
the only thing that differs from A. Same conditions, one pair:

| arm | total | express | flask | preact | slugify | verdicts | tool calls | wall |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A `ed05f8d` | $0.060851 | $0.009036 | $0.014045 | $0.028381 | $0.009389 | **4/4 complete** | 136 | 345 s |
| B catalog fix alone | $0.061876 | $0.006262 | $0.024957 | $0.025570 | $0.005087 | **4/4 complete** | 143 | 764 s |

**×1.02 — no saving at suite level, and the quality is intact.** The fix does
what it claims on the input side, in the same pair, priced at the same rate card:

| | A `ed05f8d` | B catalog fix | Δ |
| --- | --- | --- | --- |
| uncached input | 125,450 | 104,018 | −17% |
| cached input | 5,308,544 | 3,765,376 | −29% |
| reasoning | 27,195 | 37,990 | +40% |
| the two input rows priced | — | — | **−$0.0078 of $0.0609 (13%)** |

The total does not follow the input rows, because the treatment arm is not only
the catalog fix: this tree also declares the endpoint's thinking dialect
(`compat.thinkingFormat: deepseek` in `leanpi.config.yaml`), and with the level
unset that makes Pi send an explicit enable where the baseline sends no control
at all. In this pair that landed on one task — `flask`, 22,707 reasoning tokens
against the baseline arm's 7,050 here and 8,995 in its other run, on the same 55
tool calls: **+$0.0109, larger than the −$0.0089 the other three tasks saved
together.** Three of the four tasks are cheaper (express ×0.69, preact ×0.90,
slugify ×0.54); the suite total is that one task's thinking, and attributing it is
one sample against two.

So the goal's 50% is **not met**, and one pair cannot resolve the 13% the input
rows price out — the swing inside a single arm (×0.54 to ×1.78 per task here) is
larger than the whole effect. The catalog fix ships as a **quality-neutral input
saving, measured in bytes and priced at ~13% of this suite's baseline**, not as a
suite-level ratio. A pair with `compat` left out — which is what its own comment
in the config prescribes when the point is to change nothing but the prompt — is
the run that would price the fix on its own; it is not in this series.

### Without the profile (retained, and not a measurement of LeanPi)

The earlier series, same arms, no `XDG_CONFIG_HOME`. Every arm was refused on
every write, so these numbers describe read-only agents:

| suite | arm | n | median | min | max |
| --- | --- | --- | --- | --- | --- |
| `express` | A `ed05f8d` | 10 | $0.011158 | $0.008557 | $0.017773 |
| `express` | B skills fix + effort wiring | 8 | $0.005238 | $0.004291 | $0.007991 |
| `express` | C this tree | 5 | $0.003346 | $0.002643 | $0.005646 |
| validated (4 tasks) | A `ed05f8d` | 2 | $0.273133 | $0.209356 | $0.336909 |
| validated (4 tasks) | B skills fix + effort wiring | 1 | $0.143514 | — | — |
| validated (4 tasks) | C this tree | 1 | $0.069227 | — | — |

Paired `express` ratios (eight pairs, alternating): median ×0.35, range ×0.19–0.55.
The blocked treatment ran 18–31 s of wall time against the blocked baseline's
33–95 s; with the profile the same arms ran 1,068 s and 355 s. That gap is the
confound in one number: the blocked arms were not doing the task.

Two things the blocked series still establishes, because they are properties of
the *request* rather than of the agent's behaviour: the catalog is out of every
prompt (F1), and `thinking: {type: disabled}` reaches the wire and zeroes the
reasoning stream (F3). The cost deltas around them are not usable.

## Quality: what is and is not established

- **On `express`, both arms solve the task and write the same upstream fix**
  (`lib/response.js`: compute the length unconditionally, set `Content-Length`
  only when there is no `Transfer-Encoding`), and both were adjudicated `complete`
  by the held-out golden. One pair, so this is parity on one task, not a
  regression test for the change.
- **The four-task suite is 4/4 for the baseline in both runs that could edit**
  (`cost-s1-base`, `cost-t1-base`) and 4/4 for the catalog fix alone
  (`cost-t1-treat`). The arm carrying `thinkingLevel: off` is the one that lost a
  solve (`cost-s1-treat`, 3/4: `flask` failed its golden) — one sample per
  configuration, so this is a signal against `off`, not a solve-rate estimate.
- **One task per arm can outweigh the change.** `cost-t1`: `flask`'s reasoning
  went 7,050 → 22,707 on identical tool calls, +$0.0109 against the −$0.0089 the
  other three tasks saved; the one difference the treatment adds there is the
  `compat.thinkingFormat` declaration. Task-level spread inside an arm
  (×0.54–×1.78) is wider than the effect being measured, which is why no
  suite-level ratio here is quoted as the fix's own number.
- **The cost win came with wall time, and wall time is the noisiest axis here.**
  `cost-r1`: 355 s → 1,068 s with 22 → 26 tool calls. `cost-r2`: 344 s → 1,484 s
  with 18 → 25 calls. But `cost-r3`'s *baseline* ran 622 s and verified against
  `test/res.sendFile.js` and `test/res.download.js` as well as the named test.
  Both arms verify beyond the named test in some runs and not others, so "the
  cheaper arm bought it with breadth" is not supported by this sample — the cost
  axis is the stable one, and a wall-time claim needs its own design.
- **The disclosure was never JEV-ranked — and that was a wiring bug, not a
  missing credential.** The machine had a working key in the project's `.env`
  (verified against the service: `HTTP 200`, `model: jev-1.13.0`), but LeanPi
  reads no `.env` of its own — resolution is config → stored credential →
  `process.env.JEV_API_KEY` — and the bench driver never passed it, while
  redirecting `XDG_CONFIG_HOME` away from any stored key. So every run here took
  the lexical fallback, and for `express` it picked `postmortem-writing`,
  `openapi-spec-generation`, `autoresearch` — three unrelated skills. Both halves
  are fixed: `.env` is now a credential source (`source: "env file"`, read
  without publishing it into `process.env`, which a spawned vendor CLI would
  inherit), and `bench/cost/run-pair.sh` loads it and warns when it is absent.
  **Every "JEV is inert" statement in this report describes that bug, not the
  control plane.**
- **`thinkingLevel: off` is a bet on this endpoint, and it is now the operator's
  bet.** The task that thinking is supposed to help with — multi-step reasoning
  under uncertainty — is exactly the kind this suite does not exercise (four
  small, well-scoped bug fixes with a named test).

## Dead ends

- **`backends.reasoning: false`** — the flag stops Pi sending a thinking control;
  the provider reasons anyway (`cost-j-noreason`: 137,993 reasoning tokens over
  four tasks).
- **Loading full skill bodies in the lane** (`cost-m1`, 4 tasks, $0.198396) —
  three bodies in the cacheable prefix cost about what Pi's whole catalog did.
  The lane discloses pointers: description + path.
- **Single-run config experiments** — a compacted prompt (`cost-c-compact`,
  $0.008522) and a `minimal` effort (`cost-e-minimal`, $0.009524) both land inside
  the baseline's own `express` range ($0.008557–$0.017773), i.e. they measured
  nothing. At this variance n=1 cannot separate a 30% win from a 50% one; that is
  why every figure here is a pair or a median over repeats.
- **JEV-driven context selection (PRD-023) without JEV** — measured offline
  against the preact workspace: 5 test files, 2,310 tokens, and it missed the
  file the golden fix touches. Reverted; it needs JEV credentials to be evaluated
  at all.

## Open questions

1. **JEV was never credentialed *in these runs*** (a driver bug, fixed — see
   Quality). The reruns below separate the classifier's judgement from the
   heuristic it falls back to: `cost-w2-fallback` (compiler with deterministic
   fallbacks) against `cost-w2-jev` (compiler with JEV live), same tree, same
   suite. An uncredentialed LeanPi still classifies — that is the point of the
   fallback — so the question the pair answers is whether JEV's classification
   spends less than the heuristic's for the same solves.
2. **The bench adapter cannot see the disclosure.** `src/bench/adapters.ts:150`
   hardcodes `capabilities: {skills_disclosed: [], …}` and `jev_decisions: []` on
   every native row, so the ledger shows none even when one happened
   (`src/telemetry/emit.ts:68` fills them from the contract on the production
   path). The evidence here is the spec and the run's decision log.
3. **`skills.maxLoaded` counts bundled skills against the same slots** (PRD-026
   floor), so on a tie the bundled pack can take all three.
4. **The audit's fresh LeanPi rows are confounded the same way as this series.**
   Its "LeanPi 0/2, slower and costlier" comparison against omp's 4/4 was made
   without the permission profile, while omp ran with `--auto-approve`. See the
   correction note added to `docs/audits/production-readiness-audit.md`.

## Reproduction

```sh
git worktree add ../cost-baseline ed05f8d && (cd ../cost-baseline && npm run build)
export OPENCODE_API_KEY=...            # the endpoint's key
npm run build                          # this tree
bench/cost/run-pair.sh "$PWD/bench/suites/cost-express" r1   # one task, ~6-25 min a run
bench/cost/run-pair.sh "$PWD/bench/suites/validated" s1      # four tasks
bench/cost/fold.py bench/cost/series.json
```

`run-pair.sh` exports `XDG_CONFIG_HOME=$PWD/bench/profiles/bench` (permissions),
gives each run a fresh `LEANPI_OPENCODE_SESSION`, and runs one arm at a time.
Every figure in this report folds from `bench/out/<run>/telemetry.jsonl` and
nothing else.
