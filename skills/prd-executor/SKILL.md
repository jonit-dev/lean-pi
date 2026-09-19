---
name: prd-executor
description: Execute a PRD by parsing its phases, creating a task list, and spawning parallel agent swarms. Use when you have a PRD ready and want to implement it with maximum parallelization.
---

# PRD Executor

Execute the complete PRD as tracked, dependency-ordered phases with concurrent agents for independent work. Announce `PRD Executor: Initializing`. Obtain the PRD path from the request/context; ask if missing.

## Prepare

Read the entire PRD and applicable repository instructions. Extract every phase, owned file, dependency, implementation step, required test and acceptance criterion. Report title, phase count and achievable parallelism. Build a task graph (diagram if useful): file creation, imported interfaces and tested endpoints create dependencies; separate files are parallelizable only when their contracts are independent. Database migrations block phases that require them.

Before each first wave, identify pending migrations, apply them to the authorized target using the project's migration tooling, and verify required tables/functions and schema-cache visibility. A PRD does not itself authorize production mutations; production changes require existing user authorization. Dependent code must not go live before its migrations.

Create one task per phase with the full phase spec, active status and prerequisite links (`TaskCreate`/`addBlockedBy`/`addBlocks`, or the available task ledger). Keep phase status and evidence current.

## Execute and verify

1. Launch all ready, independent phases concurrently within available capacity. Use the available agent API; assign database/business/UI work to implementers, APIs to endpoint specialists, tests to test specialists and refactors to refactoring specialists when those roles exist.
2. Give each worker the PRD title/goal/path, complete assigned phase, owned files, interfaces/dependencies, required tests/criteria, actual project rules and verification commands. Use fresh bounded context (`fork_turns: "none"` in Codex). Tell workers they share the codebase, must preserve others' edits, inspect existing files/patterns before editing, finish the full phase without placeholders, and report blockers honestly. Repository-specific rules (configuration helpers, DI, logging, controller boundaries, enums) come from its instructions, not a generic template.
3. Wait for the wave, inspect real output/diffs and mark only completed phases done. Run `yarn verify` or the prescribed project equivalent between every wave. Fix incomplete work or failed verification and rerun before releasing dependent phases. Reuse the assigned worker with exact failures and changed requirements.
4. If ownership collided, reconcile both changes, record the hidden dependency and correct the graph. Do not discard others' work. Continue waves until every phase and criterion is complete.
5. Run full integration verification after all phases. Spawn an independent `prd-work-reviewer` (or available equivalent) against the complete PRD, implementation, tests and acceptance checklist. Repair findings and verify closure. Required phase checkpoints, independent reviews and named runtime/visual proofs remain mandatory.

## Evidence and context economy

Read unchanged PRDs/skills once per available context. Resume from the phase ledger, current diff and saved failures; reload missing requirements. Keep full check logs locally; return command, worktree/revision, result, artifact path and relevant failures. Preserve real exit codes. Reuse a successful check only when source (including dirty files), dependencies, configuration and environment match; missing evidence, changed inputs or required independent reruns require a new run. Reviewers inspect artifacts and diffs, not just worker summaries.

Use completion notifications or waits up to 60 seconds, reading only new output. Inspect stalled/failed state before retrying; do not restart discovery or duplicate a full review merely to repeat an unchanged finding.

Report PRD, completed/total phases, waves and peak concurrency; per-phase result/agent/duration; full verification and reviewer results; findings fixed/outstanding; changed files and evidence paths. Never describe partial or unverified work as complete.
