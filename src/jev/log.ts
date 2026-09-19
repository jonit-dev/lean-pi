/**
 * The per-site decision log (PRD-002 Phase 2, FR-020).
 *
 * One JSONL row per resolved site — JEV-answered or fallback. PRD-015 reads this
 * file for telemetry and PRD-021 computes §56 per-site accuracy from it; neither
 * re-instruments the call sites. Rows go through the same redactor as outbound
 * payloads so a secret cannot leak through the record either.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { redactSecrets } from "./privacy.js";
import type { JevUsage } from "./types.js";

export interface DecisionAnswerRow {
	questionId: string;
	kind: string;
	value: string | number | null;
	confidence: number;
}

export interface DecisionRow {
	timestamp: string;
	siteId: string;
	telemetryTag: string;
	modelVersion: string;
	fallbackUsed: boolean;
	/** Why the fallback was taken, when it was. */
	reason?: string;
	/** Site-level confidence: the lowest answer confidence in the batch. */
	confidence: number | null;
	answers: DecisionAnswerRow[];
	tokens: JevUsage;
}

export interface DecisionLog {
	path: string;
	append(row: DecisionRow): void;
	read(): DecisionRow[];
}

export function decisionLogPath(cwd: string): string {
	return join(cwd, ".leanpi", "decisions.jsonl");
}

export function createDecisionLog(path: string): DecisionLog {
	return {
		path,
		append(row) {
			mkdirSync(dirname(path), { recursive: true });
			appendFileSync(path, `${redactSecrets(JSON.stringify(row))}\n`);
		},
		read() {
			if (!existsSync(path)) return [];
			return readFileSync(path, "utf8")
				.split("\n")
				.filter((line) => line.trim().length > 0)
				.map((line) => JSON.parse(line) as DecisionRow);
		},
	};
}

/** Test/telemetry helper: the log is plain JSONL on disk, readable without a session. */
export function readDecisions(cwd: string): DecisionRow[] {
	return createDecisionLog(decisionLogPath(cwd)).read();
}
