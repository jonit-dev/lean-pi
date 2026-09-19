/**
 * The append-only run store (PRD-015 Phase 1).
 *
 * One JSON line per run in `.leanpi/telemetry.jsonl` (`cost.telemetry_path`
 * overrides the location): single-writer append, full scan on read, no
 * database, no index, no ORM. Every line carries `task_id` and `session_id` at
 * the top level and one `calls[]` row per model/backend call — `backend`,
 * `backend_type`, `model`, `inputTokens`, `outputTokens`, `costUsd`,
 * `quotaClass` and the run id — so a consumer can filter by session without
 * parsing a call list.
 *
 * Reading degrades, never throws: a missing file, a truncated final line from a
 * crashed process or a store written by a newer shape yields the rows that do
 * parse. `ponytail:` full-file scan on read, and the whole file is parsed for
 * `/cost`; add a tail-read or per-day file only if a store ever grows past a
 * few MB.
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { RunTelemetry } from "./record.js";
import { TELEMETRY_PATH_DEFAULT, type CostConfig } from "./pricing.js";

export interface RunFilter {
	taskId?: string;
	sessionId?: string;
}

/** The store location for a project: `cost.telemetry_path`, resolved against the cwd. */
export function telemetryPath(cwd: string, cost?: CostConfig): string {
	const declared = cost?.telemetry_path ?? TELEMETRY_PATH_DEFAULT;
	return isAbsolute(declared) ? declared : join(cwd, declared);
}

let warnedWriteFailure = false;

/** Whether the store's last byte is a newline; a crashed write can leave a partial line behind. */
function endsWithNewline(path: string): boolean {
	try {
		const size = statSync(path).size;
		if (size === 0) return true;
		const buffer = Buffer.alloc(1);
		const fd = openSync(path, "r");
		try {
			readSync(fd, buffer, 0, 1, size - 1);
		} finally {
			closeSync(fd);
		}
		return buffer[0] === 10;
	} catch {
		return true;
	}
}

/**
 * Append one run. A failing disk is logged once and swallowed: telemetry must
 * never lose an otherwise-successful task, so it cannot throw into the turn. A
 * truncated tail from a crashed writer is closed off first, so the fragment
 * costs its own line and this run's record still parses.
 */
export function appendRun(cwd: string, record: RunTelemetry, cost?: CostConfig): void {
	const path = telemetryPath(cwd, cost);
	try {
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${existsSync(path) && !endsWithNewline(path) ? "\n" : ""}${JSON.stringify(record)}\n`);
	} catch (error) {
		if (!warnedWriteFailure) {
			warnedWriteFailure = true;
			process.stderr.write(`leanpi: telemetry write to ${path} failed (${String(error)}); continuing without it.\n`);
		}
	}
}

/** Every stored run, optionally narrowed by task or session. Malformed lines are skipped. */
export function readRuns(cwd: string, filter: RunFilter = {}, cost?: CostConfig): RunTelemetry[] {
	return readStore(telemetryPath(cwd, cost)).filter(
		(record) =>
			(filter.taskId === undefined || record.task_id === filter.taskId) &&
			(filter.sessionId === undefined || record.session_id === filter.sessionId),
	);
}

/** The raw rows of a store file; `readRuns` narrows them by task or session. */
function readStore(path: string): RunTelemetry[] {
	if (!existsSync(path)) return [];
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return [];
	}
	const rows: RunTelemetry[] = [];
	for (const line of text.split("\n")) {
		if (line.trim().length === 0) continue;
		try {
			const parsed = JSON.parse(line) as Partial<RunTelemetry>;
			// A truncated line from a crashed write, or a store written by a shape
			// this build does not know, is skipped rather than trusted.
			if (typeof parsed?.task_id !== "string" || typeof parsed.session_id !== "string" || !parsed.cost || !parsed.usage) continue;
			rows.push(parsed as RunTelemetry);
		} catch {
			// A partially-written line is the expected shape of a crash during a write.
		}
	}
	return rows;
}
