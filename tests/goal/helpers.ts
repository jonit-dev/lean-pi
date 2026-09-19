/** Fixtures for the goal-engine suite (PRD-013). */
import { loadConfig } from "../../src/core/config.js";
import type { LeanPiConfig } from "../../src/core/types.js";
import type { GoalJev, GoalState, RemainingWorkItem, RemainingWorkSource } from "../../src/goal/index.js";
import { EvidenceStore, type EvidenceRecord, type EvidenceStatus } from "../../src/verify/evidence.js";
import { tempDir } from "../helpers/fixtures.js";

/** The hash every fixture record is stamped with; a record from another hash is stale by definition. */
export const HASH = "workspace-hash-1";

export function fixtureCwd(prefix = "leanpi-goal-"): string {
	return tempDir(prefix);
}

interface ConfigOverrides {
	goal?: { default_max_turns?: number; default_max_cost?: number };
	jev?: { endpoint: string; apiKey: string; mode: string };
}

export function goalConfig(cwd: string, overrides: ConfigOverrides = {}): LeanPiConfig {
	const base = loadConfig(cwd, {
		backends: { local: { type: "native", baseUrl: "http://127.0.0.1:1/v1" } },
		models: { quick: { backend: "local", model: "fixture" } },
		...(overrides.jev ? { jev: overrides.jev as LeanPiConfig["jev"] } : {}),
	});
	// PRD-013 reads the `goal:` block structurally; PRD-001's loader passes unknown
	// keys through untouched, which is how the integration pass will add them.
	return overrides.goal ? ({ ...base, goal: overrides.goal } as LeanPiConfig) : base;
}

export function record(
	store: EvidenceStore,
	input: { kind: string; status: EvidenceStatus; criterion?: string[]; scope?: string; hash?: string },
): EvidenceRecord {
	return store.record(
		{
			kind: input.kind,
			status: input.status,
			exitCode: input.status === "pass" ? 0 : 1,
			artifactRef: null,
			criterion: input.criterion ?? [],
			scope: input.scope ?? input.kind,
		},
		input.hash ?? HASH,
	);
}

export function newGoal(text: string, overrides: Partial<GoalState> = {}): GoalState {
	return {
		text,
		active: true,
		max_turns: 5,
		max_cost: 2,
		started_at: "2026-09-19T00:00:00.000Z",
		turns_used: 0,
		...overrides,
	};
}

/** A client that fails the test if the deterministic path calls it. */
export function throwingJev(): { jev: GoalJev; calls: () => number } {
	let calls = 0;
	return {
		calls: () => calls,
		jev: {
			ask: async () => {
				calls += 1;
				throw new Error("JEV must not be called on the deterministic path");
			},
		},
	};
}

/** The list PRD-025 hands back: what is actionable, and what is blocked and why. */
export function todos(actionable: RemainingWorkItem[] = [], blocked: RemainingWorkItem[] = []): RemainingWorkSource {
	return { remainingWork: () => ({ actionable, blocked }) };
}
