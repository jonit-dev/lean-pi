/**
 * Fixtures for the PRD-lane suite (PRD-012).
 *
 * The PRD body is written in the repository's own PRD convention — nine §11.1
 * sections, `- [ ] AC-n … — Verify: `cmd`` items and `#### Phase N:` blocks with
 * `**ACs:**` / `**Depends on:**` — so the parser is exercised against the format
 * the lane actually consumes rather than a private one.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { compileRecordOf, compileTask } from "../../src/compiler/index.js";
import type { CompileRecord, ExecutionContract } from "../../src/compiler/contract.js";
import { createArtifactStore, type ArtifactStore } from "../../src/context/artifacts.js";
import { loadConfig } from "../../src/core/config.js";
import type { JevMode, LeanPiConfig } from "../../src/core/types.js";
import { scoutTask } from "../../src/scout/index.js";
import type { EvidenceRecord } from "../../src/verify/evidence.js";
import type { PrdState } from "../../src/prd/state.js";
import { createPrdState, writePrdState } from "../../src/prd/state.js";

export const AC1_COMMAND = "npx vitest run tests/prd/cache.spec.ts";
export const AC2_COMMAND = "npx vitest run tests/prd/metrics.spec.ts";
export const AC3_COMMAND = "npx vitest run tests/prd/docs.spec.ts";

/** Unique strings that must never reach another unit's context or a packet. */
export const MARKERS = {
	body: "MARKER-PRD-BODY-ONLY",
	unit1: "MARKER-UNIT-1-ONLY",
	unit2: "MARKER-UNIT-2-ONLY",
	unit3: "MARKER-UNIT-3-ONLY",
} as const;

export const FIXTURE_PRD_BODY = `# PRD-101 — Cache lane fixture

**Status:** NOT STARTED

## Problem Statement

The cache is rebuilt on every turn. ${MARKERS.body} This paragraph is PRD body
text and must never appear in an executor packet.

## Goals

- Serve a warm cache across turns.

## Non-Goals

- Distributed caching.

## Functional Requirements

- FR-1: the cache survives a turn boundary.

## Architecture Constraints

- One process, one cache instance.

## Acceptance Criteria

- [ ] AC-1 Plan the cache layout — Verify: \`${AC1_COMMAND}\`
- [ ] AC-2 Measure the hit rate — Verify: \`${AC2_COMMAND}\`
- [ ] AC-3 Document the eviction policy — Verify: \`${AC3_COMMAND}\`

#### Phase 1: cache core
**Status:** NOT STARTED
**ACs:** AC-1
**Files:** \`src/cache/core.ts\`
**Implementation:** ${MARKERS.unit1} build the store.

#### Phase 2: metrics
**Status:** NOT STARTED
**ACs:** AC-2
**Depends on:** unit-1
**Files:** \`src/cache/metrics.ts\`
**Implementation:** ${MARKERS.unit2} count hits.

#### Phase 3: docs
**Status:** NOT STARTED
**ACs:** AC-3
**Depends on:** unit-2
**Files:** \`docs/cache.md\`
**Implementation:** ${MARKERS.unit3} write the policy down.

## Verification Requirements

- Each criterion names its own command.

## Dependencies

- None outside the repository.

## Unresolved Risks

- Eviction policy is unspecified until Phase 3.
`;

/** The fixture PRD written into `docs/PRDs/v1/` with its state under `.leanpi/prd/`. */
export function stagedPrd(
	cwd: string,
	options: { artifactStore: ArtifactStore; skillSource?: "installed" | "builtin-fallback"; minCodingIndex?: number },
): { state: PrdState; prdPath: string } {
	const prdPath = join(cwd, "docs", "PRDs", "v1", "PRD-101-cache-lane-fixture.md");
	mkdirSync(dirname(prdPath), { recursive: true });
	writeFileSync(prdPath, FIXTURE_PRD_BODY);
	const artifactRef = options.artifactStore.store(FIXTURE_PRD_BODY, "prd", prdPath);
	const state = createPrdState({
		prdId: "PRD-101",
		prdPath,
		body: FIXTURE_PRD_BODY,
		artifactRef,
		skillSource: options.skillSource ?? "installed",
		requiredCapability: { min_coding_index: options.minCodingIndex ?? 20 },
	});
	writePrdState(cwd, state);
	return { state, prdPath };
}

export function artifactStoreFor(sessionDir: string): ArtifactStore {
	return createArtifactStore({ sessionDir });
}

export function prdConfig(
	cwd: string,
	options: { skillRoots?: string[]; jev?: { mode: JevMode; endpoint?: string; apiKey?: string | null } } = {},
): LeanPiConfig {
	return loadConfig(cwd, {
		configPath: null,
		backends: { local: { type: "native", baseUrl: "http://127.0.0.1:1/v1", enabled: true } },
		models: {
			quick: { backend: "local", model: "stub-quick" },
			balanced: { backend: "local", model: "stub-balanced" },
			strong: { backend: "local", model: "stub-strong" },
			specialist: { backend: "local", model: "stub-specialist" },
		},
		capabilities: { skillRoots: options.skillRoots ?? [], mcpConfigPaths: [] },
		jev: {
			apiKey: options.jev?.apiKey ?? null,
			endpoint: options.jev?.endpoint ?? "",
			model: "jev-latest",
			mode: options.jev?.mode ?? "disabled",
		},
	});
}

/** A real contract and its compile record: `next_stage` is the dispatch input. */
export async function compileFixture(cwd: string, request: string): Promise<{ contract: ExecutionContract; record: CompileRecord }> {
	const contract = await compileTask(request, scoutTask(cwd, request));
	const record = compileRecordOf(contract);
	if (!record) throw new Error("compileTask produced no record");
	return { contract, record };
}

export const PRD_REQUEST = "Replace the caching layer across the repository with a staged redesign";

/** `next_stage: "prd_lane"` — an architectural request the gate sends to this lane. */
export async function prdRecord(cwd: string): Promise<{ contract: ExecutionContract; record: CompileRecord }> {
	return compileFixture(cwd, PRD_REQUEST);
}

/** `prd_required: false` — a localized, unambiguous request. */
export async function quickRecord(cwd: string): Promise<{ contract: ExecutionContract; record: CompileRecord }> {
	return compileFixture(cwd, "Fix the typo in the header logo text");
}

export const HASH_AT_READ = "workspace-hash-1";
const STARTED_AT = "2026-09-19T00:00:00.000Z";

/** A fresh `pass` for one criterion, attributed to it as PRD-009 attributes runs. */
export function freshPass(criterionId: string, workspaceHash: string, artifactRef: string): EvidenceRecord {
	return {
		kind: "targeted_test",
		status: "pass",
		workspaceHash,
		startedAt: STARTED_AT,
		exitCode: 0,
		artifactRef,
		criterion: [criterionId],
		scope: "tests/prd",
	};
}

/** A passing record collected before the workspace changed — never fresh. */
export function stalePass(criterionId: string, artifactRef: string): EvidenceRecord {
	return freshPass(criterionId, "hash-before-the-edit", artifactRef);
}

/** A failing measurement for the criterion, as PRD-009 records a non-zero exit. */
export function failingEvidence(criterionId: string, artifactRef: string): EvidenceRecord {
	return {
		kind: "targeted_test",
		status: "fail",
		workspaceHash: HASH_AT_READ,
		startedAt: STARTED_AT,
		exitCode: 1,
		artifactRef,
		criterion: [criterionId],
		scope: "tests/prd",
	};
}

/** A skill root holding an installed skill, as PRD-005's registry reads it. */
export function writeInstalledSkill(root: string, name: string, marker: string, description = "fixture skill"): string {
	const directory = join(root, name);
	mkdirSync(directory, { recursive: true });
	const path = join(directory, "SKILL.md");
	writeFileSync(path, `---\nname: ${name}\ndescription: ${description}\n---\n\n${marker}\n`);
	return path;
}

/** A skill root holding `prd-manager` plus its `scripts/prd-close.mjs`. */
export function writePrdManagerSkill(root: string, script: string): string {
	writeInstalledSkill(root, "prd-manager", "PRD-MANAGER-MARKER", "closure helper");
	const directory = join(root, "prd-manager", "scripts");
	mkdirSync(directory, { recursive: true });
	const path = join(directory, "prd-close.mjs");
	writeFileSync(path, script);
	return path;
}

/** The closure helper the installed skill ships: it records argv, then moves the PRD. */
export const CLOSING_HELPER = `import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [, , prdPath, ...flags] = process.argv;
writeFileSync(join(here, "invocation.json"), JSON.stringify({ prdPath, flags }));
const target = join(dirname(prdPath), "done", basename(prdPath));
mkdirSync(dirname(target), { recursive: true });
renameSync(prdPath, target);
`;

/** A helper that refuses: `/prd close` must report it and leave the PRD in place. */
export const REJECTING_HELPER = `process.stderr.write("refusing: criteria are not closable\\n");
process.exit(3);
`;
