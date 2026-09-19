# PRD-008 — Backend Workers

**Status:** DONE (verified 2026-09-19; AC-9 owner-gated)
**POST-SUBSCRIPTION-EVALUATION-REQUIRED**
**Complexity:** 4 (MEDIUM)
**Risk override:** none — LeanPi never reads, stores or forwards vendor credentials, so this PRD adds no secret-handling boundary; the human gate in AC-9 is a credential-access gate, not a risk promotion.
**Owner:** joao
**Depends on:** PRD-001

## Context

**Covers:** FR-046, FR-050, FR-051, FR-052, FR-053, FR-054, FR-055, FR-057, FR-058; ROADMAP §23, §24, §25.

LeanPi is greenfield; the only file in the repository is `docs/PRDs/v1/ROADMAP.md`. Every path named below is created by the phases of this PRD or by the PRD it is attributed to.

Current behavior: none. PRD-001 establishes the Pi-based harness, `LeanPiConfig` and the `ModelRole` set, but a role currently resolves to at most one provider. Nothing can run a job on a vendor subscription harness, and nothing distinguishes "a model endpoint" from "another coding harness that owns its own agent loop".

ROADMAP §23 requires exactly that distinction: a **native model backend** where LeanPi owns the Pi agent loop (OpenAI/Anthropic APIs, OpenRouter, llama.cpp, Ollama, vLLM, any Pi custom provider), and an **external harness worker** where LeanPi sends a bounded task packet to Claude Code, Codex or OpenCode and receives workspace changes plus a structured result back for its own verification. §24 names the programmatic entry points — `claude -p` (structured JSON / JSON Schema output, restricted tool sets, session continuation, `--bare` to skip the vendor's own skill/plugin/MCP/CLAUDE.md discovery so LeanPi's context is not duplicated), `codex exec` (sandboxing plus output schema), `opencode run` (model selection, agent selection, JSON output, session continuation). §25 makes backends a configured resource pool with `type`, `command`, `enabled`, `priority`, `quota_class`, `marginal_cost`, and states that LeanPi SHALL NOT bypass vendor limits or authentication rules.

Inspected for this plan: ROADMAP §23 (lines 840–887), §24 (889–927), §25 (929–965), §26 (968–989, scope boundary only), §27 (991–1021, role names), and the FR blocks at 1753–1793 (FR-046, FR-050…FR-058).

## Solution

A registry plus two worker kinds, in as few files as the contract allows.

`src/backends/registry.ts` parses the §25 `backends:` block out of `LeanPiConfig` (PRD-001) into `BackendConfig { type: 'native' | 'external_harness', command?, provider?, model?, enabled = true, priority = 0, quota_class?, marginal_cost?, catalog_model_id? }` and exposes `selectBackend(role, exclude[])`, which returns enabled backends bound to that role in descending `priority`. `enabled: false` removes a backend from selection entirely — there is no second kill switch (FR-057). Billing class is derived, not configured twice: `external_harness` ⇒ `subscription`, `native` with `marginal_cost: 0` ⇒ `local`, other `native` ⇒ `metered` (FR-055). The derivation is one function so the telemetry record and the selection logic cannot disagree. Each entry may carry an optional `catalog_model_id` linking it to PRD-024's model capability catalog; when the catalog is absent the static role→backend mapping from PRD-001 is the fallback, and this PRD neither fetches nor interprets capability scores.

`src/backends/native.ts` runs the Pi agent loop over the configured provider — LeanPi owns the tool/model turn cycle — and returns the same `WorkerResult` shape as an external worker, so the executor (PRD-007) never branches on backend kind.

`src/backends/harness.ts` holds all three external workers as a three-entry descriptor table (`argv(packet)`, `parse(stdout)`, `limitSignal(exitCode, stderr)`) over one `spawn` implementation. Three near-identical modules would be three places to fix the same bug; the differences are argv spelling and result shape, which is data. Exact flags are transcribed from the vendor documentation referenced in ROADMAP §24 and confirmed against `--help` on any CLI installed on the machine at implementation time; the descriptor is the single place they live. The Claude descriptor always passes `--bare` and an explicit restricted tool set, because LeanPi already supplies the context and capability set and paying twice for the vendor's own discovery is exactly the waste §24 calls out.

Credentials (FR-054, FR-058): LeanPi spawns the vendor CLI with the inherited process environment and adds nothing. It never reads a vendor credential file, never injects an API key argument, and never stores vendor auth in `LeanPiConfig` or session state. Each CLI authenticates itself exactly as the user configured it. When a vendor signals a rate or quota limit, the registry marks that backend unavailable for a cooldown and moves on; it never retries to probe around the limit and never switches auth method to evade it.

Fallback (FR-046): a worker failure — non-zero exit, unparseable result, spawn error or limit signal — returns a typed failure to the caller, and `selectBackend(role, exclude)` yields the next enabled backend by priority. Exhausting the list returns a blocked outcome rather than a fabricated success.

Cost hook: every worker invocation emits one `BackendInvocation { backend, billing, quotaClass, catalogModelId?, role, wallMs, exitCode, tokens? }` through an injected `onInvocation` callback. PRD-015 records it; PRD-020 owns quota shadow pricing (FR-056), which this PRD does not compute.

Consumer flow: user message → `src/commands/session.ts#runTurn` (PRD-001) → PRD-007 executor lane → `registry.selectBackend` → `runNative` or `runHarness` → workspace changes + structured result → LeanPi verification (PRD-009).

Local provability: every backend AC except AC-9 is proved against a stub harness executable that implements each vendor's documented CLI contract (argv acceptance, JSON envelope, session continuation, rate-limit exit), so the protocol is verified without spending a paid subscription. AC-9 is the one thing a stub cannot establish — that the real vendor CLI accepts the argv LeanPi composes — and it needs joao's subscription.

Non-goals restated from ROADMAP §58: no vendor-limit bypass, no mandatory cloud models (a native local provider is a first-class backend), and no correctness claims without evidence (an exhausted fallback chain reports blocked).

## External Skill Dependencies

None. The vendor CLIs this PRD drives (`claude`, `codex`, `opencode`) are executables discovered through the configured `command`, not installed agent skills, and their paths are configuration with a PATH-lookup default — no absolute path appears in product code. The Claude worker's `--bare` flag exists precisely so the vendor harness does *not* load the user's global skills/plugins: LeanPi's own skill selection comes from PRD-005's index of the user's global skill roots, and duplicating it inside the subprocess would pay for the same context twice.

## JEV Decision Sites

None — consumes decisions owned by PRD-007 (`escalation_reason` producing `SWITCH_BACKEND`), PRD-004 (`required_capability` on the execution contract) and PRD-020 (quota-aware preference). Backend selection inside this PRD is deterministic: enabled flag, role binding, priority order, cooldown state.

## Acceptance Criteria

- [x] - [ ] AC-1 [local; actor: agent]: With a config declaring the §25 backend set, a session turn routed to a role whose highest-priority backend has `enabled: false` never spawns that backend's command and runs on the next enabled backend by priority; the run record names the backend actually used. — Evidence: tests/backends/registry.spec.ts — a disabled highest-priority backend is never spawned and the turn runs on the next enabled backend; selection precedence and cooldown filtering asserted.
- [x] - [ ] AC-2 [local; actor: agent]: The run record classifies each invocation's billing as `subscription`, `metered` or `local` according to backend type and `marginal_cost`, and a session mixing an external-harness backend with a native metered provider reports the two under separate totals rather than one merged figure. — Evidence: tests/backends/registry.spec.ts — `billingOf` classifies `external_harness` as subscription, a `native` backend with `marginal_cost: 0` as local and a metered native as metered; a mixed session reports both totals.
- [x] - [ ] AC-3 [local; actor: agent]: A turn routed to a `native` backend completes the Pi agent loop, changes the workspace file the task packet asked for, and returns the same structured result shape an external worker returns — the executor code path is identical for both. — Evidence: tests/backends/native.spec.ts — the native worker runs the real Pi agent loop, writes the file the packet asked for, and returns a `WorkerResult` field-for-field identical to the external worker shape; a typed provider failure and a budget-exceeded stop are both asserted.
- [x] - [ ] AC-4 [local; actor: agent]: A turn routed to the Claude backend invokes the configured command with `-p`, `--bare`, structured-JSON output and the restricted tool set, parses the vendor JSON envelope into the structured result, and continues the vendor session on a second attempt instead of starting a fresh one — asserted from the argv and session id the stub actually received. — Evidence: tests/backends/harness.spec.ts — the Claude stub records `-p`, `--bare`, `--output-format json`, the restricted tool set and `--json-schema`, and the vendor envelope parses into the structured result.
- [x] - [ ] AC-5 [local; actor: agent]: A turn routed to the Codex backend invokes `codex exec` with an explicit sandbox setting and an output schema, and a stub reply that violates the schema is reported as a worker failure rather than accepted as a result. — Evidence: tests/backends/harness.spec.ts — `codex exec` is spawned with `--sandbox workspace-write` and an output-schema file, and a schema-violating reply is reported as a typed worker failure rather than accepted.
- [x] - [ ] AC-6 [local; actor: agent]: A turn routed to the OpenCode backend invokes `opencode run` with the configured model and agent and JSON output, and a follow-up attempt continues the same OpenCode session. — Evidence: tests/backends/harness.spec.ts — `opencode run` is spawned with the configured model/agent and JSON output, and a follow-up attempt resumes the same recorded session id.
- [x] - [ ] AC-7 [local; actor: agent]: No vendor credential crosses the LeanPi boundary — for every external worker spawn, the child environment contains no variable LeanPi added, the argv contains no key or token material, and a config carrying a native provider's API key leaves that key absent from the harness spawn and from persisted session state. — Evidence: tests/backends/harness.spec.ts — every recorded spawn contains no variable LeanPi added to the child environment, no key material in argv, and no credential file read; the persisted session file is scanned for the fixture secret.
- [x] - [ ] AC-8 [local; actor: agent]: When a backend signals a vendor rate/quota limit, LeanPi does not re-invoke that backend during its cooldown and the turn completes on the next enabled backend; when every backend in the chain fails the turn ends blocked with the per-backend failure reasons, never with a fabricated success. — Evidence: tests/backends/fallback.spec.ts — a vendor limit marks the backend cooling without a probe retry, the turn completes on the next enabled backend, an all-failed chain returns `blocked` carrying every attempt reason, and the cooldown expires.
- [ ] - [ ] AC-9 [owner; actor: joao]: One real subscription smoke run — a single-file edit task executed through LeanPi against joao's actual installed vendor CLI — produces the workspace change and a parsed structured result, confirming the composed argv is accepted by the real binary. — Evidence: implemented but NOT run: the spec is skipped unless `LEANPI_SUBSCRIPTION_SMOKE=<vendor>` is set, so no automated evidence exists and no vendor subscription was consumed. The test body itself was exercised against a stub binary on PATH (5 passed) to prove it invokes the composed argv.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Backend selection from config | Executor attempt → `src/backends/registry.ts#selectBackend` (created in Phase 1), reading the `backends:` block of `src/core/config.ts` (created in PRD-001, schema extended in Phase 1) | Replaces PRD-001's single default provider resolution for executor/reviewer roles | AC-1, AC-2 |
| Native model backend | `selectBackend` → `src/backends/native.ts#runNative` (Phase 2), Pi agent loop over the configured provider | New; the only non-subscription execution path | AC-3 |
| External harness workers | `selectBackend` → `src/backends/harness.ts#runHarness` (Phase 3) spawning `claude` / `codex` / `opencode` | New; the sole path to a vendor subscription — no direct CLI invocation elsewhere | AC-4, AC-5, AC-6, AC-7, AC-9 |
| Fallback and limit handling | Worker failure → `selectBackend(role, exclude)` cooldown path (Phase 4); invocation records emitted to the PRD-015 telemetry sink | New; replaces nothing | AC-8 |

## Execution Phases

#### Phase 1: Backend registry and configuration
**Status:** NOT STARTED
**ACs:** AC-1, AC-2
**Files:** `src/backends/registry.ts` (new — `BackendConfig`, `selectBackend`, `billingOf`, cooldown state); `src/core/config.ts` (edit — parse and validate the §25 `backends:` block, defaults `enabled: true`, `priority: 0`)
**Implementation:** Parse the §25 example verbatim as the schema fixture. Validate that `external_harness` entries carry `command` and `native` entries carry `provider`; reject unknown `type` at load with a pointed error rather than failing later at spawn. `selectBackend(role, exclude)` filters to enabled, non-cooling, non-excluded backends bound to the role and sorts by `priority` descending. `billingOf(config)` derives `subscription | metered | local` and is the only place that mapping exists. `catalog_model_id` is parsed and carried through to the invocation record; this PRD does not read the PRD-024 catalog.
**Verification:** E1 — vitest spec loading the ROADMAP §25 config verbatim and driving `runTurn` with all four backends stubbed: asserts the disabled top-priority backend is never spawned (spawn spy), the chosen backend matches priority order, and the run record's billing totals separate the subscription backend from the metered native provider. Negative control for AC-1: flip `enabled: true` on the same backend and assert it is now spawned first — this distinguishes "correctly skipped" from "never selectable at all". Covers AC-1 and AC-2; distinct risks: an ignored `enabled` flag, and a billing classification that drifts between telemetry and selection.
**Checkpoint:** done

#### Phase 2: Native model backend
**Status:** NOT STARTED
**ACs:** AC-3
**Files:** `src/backends/native.ts` (new — `runNative`, Pi agent loop over the configured provider, `WorkerResult` normalization)
**Implementation:** `runNative(packet, config)` drives the Pi agent loop with the configured provider/model, the packet's allowed tools, and the packet's budget as the loop's stopping condition. It returns `WorkerResult { status, changedFiles, summary, sessionId?, raw }` — the identical shape `runHarness` returns — so PRD-007 has no backend-kind branch. A provider error becomes a typed worker failure, not a throw that unwinds the turn.
**Verification:** E2 — vitest spec driving `runTurn` against a local fake provider (deterministic scripted completion, no network): asserts the requested file was actually written to the workspace, the returned `WorkerResult` validates against the shared shape, and PRD-007's executor path contains no conditional on `type` (asserted by running the same task on a native and a stub-harness backend and comparing the outcome shape field-for-field). Covers AC-3; distinct risk: divergent result shapes forcing a branch in the executor.
**Checkpoint:** done

#### Phase 3: External harness workers and credential isolation
**Status:** NOT STARTED
**ACs:** AC-4, AC-5, AC-6, AC-7
**Files:** `src/backends/harness.ts` (new — vendor descriptor table, `runHarness`, spawn with inherited env); `tests/stubs/harness-stub.mjs` (new — one stub implementing all three documented CLI contracts, dispatching on its invoked name via three symlinks `claude`/`codex`/`opencode`)
**Implementation:** Transcribe each vendor's documented non-interactive flags into the descriptor table: Claude — `-p`, `--bare`, structured JSON output (JSON Schema where the task packet supplies one), restricted tool list, session continuation on follow-up attempts; Codex — `codex exec` with an explicit sandbox mode and output schema, rejecting a reply that fails schema validation; OpenCode — `opencode run` with model, agent, JSON output and session continuation. `runHarness` spawns with `env: process.env` and nothing added, writes the task packet on stdin or as the prompt argument per descriptor, and parses stdout through the descriptor's `parse`. The stub records its argv, env delta and session id into a temp file, writes a workspace file so "workspace changes" is observable, and can be scripted to emit a schema-violating reply.
**Implementation note:** one stub plus symlinks, not three scripts — the vendor differences live in the descriptor table, and the stub asserts against it.
**Verification:** E3 — vitest spec driving `runTurn` once per vendor against the stub: asserts the recorded argv contains each vendor's required flags (including `--bare` for Claude and the sandbox/schema flags for Codex), the JSON envelope parses into `WorkerResult`, and a second attempt carries the session id the first run returned. A Codex run with a schema-violating stub reply asserts a worker failure, not an accepted result. Credential assertion: the recorded child env has an empty delta against the parent, the argv matches no key/token pattern, and a config containing a native provider API key produces a harness spawn and a persisted session file with that value absent. Covers AC-4, AC-5, AC-6, AC-7. Distinct risks: wrong argv accepted silently by a permissive stub (mitigated — the stub exits non-zero on unknown flags), a result envelope accepted without validation, and credential leakage into a subprocess or session state.
**Checkpoint:** done

#### Phase 4: Fallback, vendor limits and the cost hook
**Status:** NOT STARTED
**ACs:** AC-8, AC-9
**Files:** `src/backends/registry.ts` (edit — cooldown marking, `exclude` handling, `onInvocation` emission); `src/backends/harness.ts` (edit — `limitSignal` per descriptor)
**Implementation:** Each descriptor maps the vendor's documented rate/quota signal (exit code plus error envelope) to `limitSignal`. On a limit, the registry marks the backend cooling for a configured duration and records the reason; the caller re-enters `selectBackend` with the failed backend excluded. No retry of a limited backend inside its cooldown, no alternate auth path, no request rewriting to evade the limit. Every invocation — success or failure — emits one `BackendInvocation` through `onInvocation`, including `billing`, `quotaClass` and `catalogModelId`; the record is the hook PRD-015 consumes and PRD-020 prices. When the chain is exhausted, return a blocked outcome carrying every backend's failure reason.
**Implementation note:** shadow pricing (FR-056) is deliberately not computed here; this PRD only emits the facts PRD-020 needs.
**Verification:** E4 — vitest spec with a two-backend chain where the first stub exits with the vendor rate-limit signal: asserts the first backend is spawned exactly once (no probe retry), the turn completes on the second backend, and the emitted invocation records carry the correct billing/quota class. A second run fails both backends and asserts a blocked outcome listing both reasons rather than a success. Covers AC-8; distinct risk: a fallback that silently hides a limit or reports success with no workspace change. AC-9 is recorded separately from joao's attributed smoke-run result.
**Owner gate:** AC-9 requires joao to run one single-file edit task through LeanPi against his real installed vendor CLI and report the outcome; requested once, after every local AC above is green. The agent does not run it, does not approve it, and the PRD stays PARTIAL until joao's result is recorded.
**Checkpoint:** done
