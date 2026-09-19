/**
 * The telemetry directory reader both `--report` folds use (PRD-021 Phase 4).
 *
 * A report source is a directory holding PRD-015's store(s) as `telemetry*.jsonl`
 * and, when the attempts were adjudicated, the matching `ledger*.jsonl`. The
 * reports are pure folds over these files: neither executes a task, and neither
 * re-instruments anything — PRD-015 remains the sole telemetry writer.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RunTelemetry } from "../../telemetry/record.js";
import { BenchError, type BenchLedgerRow } from "../types.js";

export interface TelemetrySource {
	dir: string;
	/** The §52 records, in file order. */
	runs: RunTelemetry[];
	/** The bench ledger rows, when the directory carries them. */
	ledger: BenchLedgerRow[];
	files: string[];
}

function jsonl(dir: string, matches: (name: string) => boolean): unknown[] {
	const rows: unknown[] = [];
	for (const entry of readdirSync(dir).sort()) {
		if (!entry.endsWith(".jsonl") || !matches(entry)) continue;
		const text = readFileSync(join(dir, entry), "utf8");
		for (const line of text.split("\n")) {
			if (line.trim().length === 0) continue;
			try {
				rows.push(JSON.parse(line) as unknown);
			} catch {
				throw new BenchError(`${join(dir, entry)}: a line is not valid JSON`, "usage");
			}
		}
	}
	return rows;
}

/** Read one report source. A directory with no telemetry at all is a named error. */
export function readTelemetryDir(dir: string): TelemetrySource {
	if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new BenchError(`telemetry directory ${dir} does not exist`, "usage");
	const files = readdirSync(dir).filter((entry) => entry.endsWith(".jsonl")).sort();
	const runs = jsonl(dir, (name) => name.startsWith("telemetry")) as RunTelemetry[];
	if (files.filter((name) => name.startsWith("telemetry")).length === 0) {
		throw new BenchError(`${dir} holds no telemetry*.jsonl: a report over nothing would print a misleading zero`, "usage");
	}
	return { dir, runs: runs.filter((run) => typeof run?.task_id === "string" && run.usage !== undefined), ledger: jsonl(dir, (name) => name.startsWith("ledger")) as BenchLedgerRow[], files };
}

/** The adjudicated verdict for one run, when the source carries a ledger. */
export function adjudicationFor(source: TelemetrySource, taskId: string): string | null {
	const row = source.ledger.find((candidate) => candidate.telemetry_task_id === taskId) ?? source.ledger.find((candidate) => candidate.task_id === taskId);
	return row?.adjudication.verdict ?? null;
}
