/**
 * The suite and configuration readers (PRD-021 Phase 1).
 *
 * A suite is a directory of task directories — `task.yaml` plus a held-out
 * `golden` — not a plugin API; a configuration is one YAML file, not a
 * configuration framework. Both readers validate at the boundary and name the
 * file and field they rejected, because a silently-defaulted suite field would
 * make every downstream metric measure the wrong task.
 *
 * §55's category list is transcribed here once, in the order the roadmap lists
 * it. `bench --list` prints the coverage table over it and marks the unfilled
 * ones, so the distance to §55's 50–100 tasks is a number the report shows.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { BenchError, type BenchConfigRow, type BenchGolden, type BenchTask, type BenchTaskSource } from "./types.js";

/** The suite's default location inside the package. */
export const SEED_SUITE_DIR = "bench/suites/seed";
/** The configuration matrix's default location inside the package. */
export const CONFIG_DIR = "bench/configs";
/** §55's 50–100 target, printed by `--list` so no report reads as claiming §55. */
export const SUITE_TARGET = { min: 50, max: 100 };

/**
 * ROADMAP §55's categories, in order. The roadmap lists sixteen bullets; PRD-021
 * AC-8 says "15" — the roadmap is authoritative, so sixteen rows are printed and
 * the count is stated over the same list.
 */
export const SUITE_CATEGORIES: readonly { id: string; label: string }[] = [
	{ id: "mechanical-edits", label: "mechanical edits" },
	{ id: "localized-bugs", label: "localized bugs" },
	{ id: "multi-file-bugs", label: "multi-file bugs" },
	{ id: "test-creation", label: "test creation" },
	{ id: "refactoring", label: "refactoring" },
	{ id: "frontend-ui-changes", label: "frontend/UI changes" },
	{ id: "typescript", label: "TypeScript" },
	{ id: "native-cpp", label: "native/C++" },
	{ id: "build-tooling", label: "build tooling" },
	{ id: "dependency-failures", label: "dependency failures" },
	{ id: "unfamiliar-repositories", label: "unfamiliar repositories" },
	{ id: "architecture-changes", label: "architecture changes" },
	{ id: "performance-work", label: "performance work" },
	{ id: "tasks-requiring-mcp", label: "tasks requiring MCP" },
	{ id: "tasks-requiring-web-research", label: "tasks requiring web research" },
	{ id: "tasks-requiring-semantic-runtime-proof", label: "tasks requiring semantic runtime proof" },
];

const CATEGORY_IDS: Record<string, true> = Object.fromEntries(SUITE_CATEGORIES.map((category) => [category.id, true]));
const ADAPTERS: Record<string, true> = { leanpi: true, "stock-pi": true, external: true, omp: true };
const JEV_MODES: Record<string, true> = { enabled: true, disabled: true, "metadata-only": true, redacted: true };
const VENDORS: Record<string, true> = { claude: true, codex: true };

/**
 * Resolve a bench-relative path against the package root: the suite directory,
 * the configuration matrix and the output directory all read from the same rule
 * (absolute paths win, everything else is package-relative).
 */
export function benchPath(dir: string, base = process.cwd()): string {
	return isAbsolute(dir) ? dir : join(base, dir);
}

function asRecord(value: unknown, file: string, field: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new BenchError(`${file}: ${field} must be a mapping`, "suite");
	}
	return value as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, key: string, file: string): string {
	const value = record[key];
	if (typeof value !== "string" || value.trim().length === 0) throw new BenchError(`${file}: ${key} must be a non-empty string`, "suite");
	return value;
}

function optionalString(record: Record<string, unknown>, key: string, file: string): string | null {
	const value = record[key];
	if (value === undefined || value === null) return null;
	if (typeof value !== "string") throw new BenchError(`${file}: ${key} must be a string or null`, "suite");
	return value;
}

function stringList(value: unknown, file: string, field: string): string[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
		throw new BenchError(`${file}: ${field} must be a list of strings`, "suite");
	}
	return value as string[];
}

function readYaml(path: string, kind: "suite" | "config"): Record<string, unknown> {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		throw new BenchError(`${path}: cannot be read (${(error as Error).message})`, kind);
	}
	let parsed: unknown;
	try {
		parsed = parseYaml(text);
	} catch (error) {
		throw new BenchError(`${path}: invalid YAML (${(error as Error).message})`, kind);
	}
	return asRecord(parsed ?? {}, path, "<file>");
}

function taskSourceOf(record: Record<string, unknown>, file: string): BenchTaskSource {
	const source = asRecord(record.source, file, "source");
	const repo = requiredString(source, "repo", `${file} source`);
	const commit = requiredString(source, "commit", `${file} source`);
	if (!/^[0-9a-f]{40}$/.test(commit)) throw new BenchError(`${file}: source.commit must be a 40-character commit sha`, "suite");
	const fixCommit = optionalString(source, "fix_commit", `${file} source`);
	if (fixCommit !== null && !/^[0-9a-f]{40}$/.test(fixCommit)) throw new BenchError(`${file}: source.fix_commit must be a 40-character commit sha`, "suite");
	return { repo, commit, fix_commit: fixCommit, pinned_via: optionalString(source, "pinned_via", `${file} source`) ?? "unrecorded" };
}

function goldenOf(record: Record<string, unknown>, file: string): BenchGolden {
	const raw = record.golden === undefined ? {} : asRecord(record.golden, file, "golden");
	const kind = raw.kind ?? "upstream-test";
	if (kind !== "upstream-test" && kind !== "none") throw new BenchError(`${file}: golden.kind must be "upstream-test" or "none"`, "suite");
	if (kind === "none") return { kind: "none", files: [], command: "", validated_at: null };
	const files = stringList(raw.files, file, "golden.files");
	return {
		kind: "upstream-test",
		files,
		// A golden with no `files` is a command that already exists at the start
		// revision (the upstream suite's own entry point); with `source.fix_commit`
		// set, the adjudicator first checks the named files out of that commit.
		command: requiredString(raw, "command", `${file} golden`),
		validated_at: optionalString(raw, "validated_at", `${file} golden`),
	};
}

/** Parse one `task.yaml`. Every failure names the file and the field. */
export function parseTask(record: Record<string, unknown>, file: string): BenchTask {
	const id = requiredString(record, "id", file);
	const prompt = requiredString(record, "prompt", file);
	const source = taskSourceOf(record, file);
	const categories = stringList(record.categories, file, "categories");
	if (categories.length === 0) throw new BenchError(`${file}: categories must name at least one §55 category`, "suite");
	for (const category of categories) {
		if (!CATEGORY_IDS[category]) throw new BenchError(`${file}: unknown §55 category "${category}"`, "suite");
	}
	return {
		id,
		prompt,
		source,
		categories,
		setup: stringList(record.setup, file, "setup"),
		golden: goldenOf(record, file),
		notes: optionalString(record, "notes", file) ?? "",
	};
}

/** Every task directory under `dir`, sorted by task id. */
export function loadSuite(dir: string, base = process.cwd()): { dir: string; tasks: BenchTask[] } {
	const root = benchPath(dir, base);
	if (!existsSync(root) || !statSync(root).isDirectory()) throw new BenchError(`suite directory ${root} does not exist`, "suite");
	const tasks: BenchTask[] = [];
	const seen = new Set<string>();
	for (const entry of readdirSync(root).sort()) {
		const taskDir = join(root, entry);
		if (!statSync(taskDir).isDirectory()) continue;
		const file = join(taskDir, "task.yaml");
		if (!existsSync(file)) continue;
		const task = parseTask(readYaml(file, "suite"), file);
		if (seen.has(task.id)) throw new BenchError(`${file}: task id "${task.id}" is declared by more than one task`, "suite");
		seen.add(task.id);
		if (task.id !== entry) throw new BenchError(`${file}: task id "${task.id}" must match its directory "${entry}"`, "suite");
		tasks.push(task);
	}
	if (tasks.length === 0) throw new BenchError(`suite ${root} contains no task directories`, "suite");
	return { dir: root, tasks };
}

/** Parse one `bench/configs/<id>.yaml`. */
export function parseConfigRow(record: Record<string, unknown>, file: string, idFromFile: string): BenchConfigRow {
	const id = requiredString(record, "id", file);
	if (id !== idFromFile) throw new BenchError(`${file}: config id "${id}" must match its filename "${idFromFile}"`, "config");
	const adapter = requiredString(record, "adapter", file);
	if (!ADAPTERS[adapter]) throw new BenchError(`${file}: adapter must be one of ${Object.keys(ADAPTERS).join(" | ")}`, "config");
	const vendor = optionalString(record, "vendor", file);
	if (adapter === "external") {
		if (vendor === null || VENDORS[vendor] !== true) throw new BenchError(`${file}: an external row needs vendor: ${Object.keys(VENDORS).join(" | ")}`, "config");
	} else if (vendor !== null) {
		throw new BenchError(`${file}: vendor is only meaningful for adapter: external`, "config");
	}
	const jev = optionalString(record, "jev", file) ?? "disabled";
	if (!JEV_MODES[jev]) throw new BenchError(`${file}: jev must be one of ${Object.keys(JEV_MODES).join(" | ")}`, "config");
	return {
		id,
		label: optionalString(record, "label", file) ?? id,
		adapter: adapter as BenchConfigRow["adapter"],
		vendor: vendor as BenchConfigRow["vendor"],
		jev: jev as BenchConfigRow["jev"],
		executor_model: requiredString(record, "executor_model", file),
		reviewer_model: optionalString(record, "reviewer_model", file),
		features: stringList(record.features, file, "features"),
		owner_gated: record.owner_gated === true,
		subscription: record.subscription === true || adapter === "external",
		budget_usd: budgetOf(record, file),
	};
}

/** The per-attempt ceiling; absent means "no ceiling", which the report prints as `unlimited`. */
function budgetOf(record: Record<string, unknown>, file: string): number {
	const value = record.budget_usd;
	if (value === undefined || value === null) return 0;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new BenchError(`${file}: budget_usd must be a non-negative number`, "config");
	return value;
}

/** Every configuration row in `dir`, sorted by id. */
export function loadConfigRows(dir: string, base = process.cwd()): BenchConfigRow[] {
	const root = benchPath(dir, base);
	if (!existsSync(root) || !statSync(root).isDirectory()) throw new BenchError(`config directory ${root} does not exist`, "config");
	const rows: BenchConfigRow[] = [];
	for (const entry of readdirSync(root).sort()) {
		if (!entry.endsWith(".yaml")) continue;
		rows.push(parseConfigRow(readYaml(join(root, entry), "config"), join(root, entry), entry.slice(0, -".yaml".length)));
	}
	if (rows.length === 0) throw new BenchError(`config directory ${root} holds no *.yaml rows`, "config");
	return rows;
}

/** The requested rows, in the caller's order; an unknown id is a named error, never a silent skip. */
export function selectConfigRows(rows: readonly BenchConfigRow[], ids: readonly string[]): BenchConfigRow[] {
	return ids.map((id) => {
		const row = rows.find((candidate) => candidate.id === id);
		if (!row) throw new BenchError(`unknown config "${id}"; available: ${rows.map((candidate) => candidate.id).join(", ")}`, "config");
		return row;
	});
}

export interface CoverageRow {
	id: string;
	label: string;
	filled: boolean;
	tasks: string[];
}

/** The §55 coverage table: one row per category, marking the unfilled ones. */
export function coverageOf(tasks: readonly BenchTask[]): CoverageRow[] {
	return SUITE_CATEGORIES.map((category) => {
		const matching = tasks.filter((task) => task.categories.includes(category.id)).map((task) => task.id);
		return { id: category.id, label: category.label, filled: matching.length > 0, tasks: matching };
	});
}

/** `bench --list`: the suite inventory, the §55 coverage table and the distance to the target. */
export function renderSuiteList(suite: { dir: string; tasks: readonly BenchTask[] }): string {
	const lines: string[] = [];
	lines.push(`suite: ${suite.dir}`);
	lines.push(`tasks: ${suite.tasks.length}`);
	lines.push("");
	lines.push("| task | source repository | upstream commit | start revision | golden | §55 categories |");
	lines.push("| --- | --- | --- | --- | --- | --- |");
	for (const task of suite.tasks) {
		const golden = task.golden.kind === "none" ? "rubric" : task.golden.command;
		lines.push(
			`| ${task.id} | ${task.source.repo} | ${task.source.fix_commit ?? task.source.commit} | ${task.source.commit} | ${golden} | ${task.categories.join(", ")} |`,
		);
	}
	lines.push("");
	const coverage = coverageOf(suite.tasks);
	lines.push("§55 coverage:");
	lines.push("");
	lines.push("| §55 category | filled | tasks |");
	lines.push("| --- | --- | --- |");
	for (const row of coverage) {
		lines.push(`| ${row.label} | ${row.filled ? "yes" : "UNFILLED"} | ${row.tasks.join(", ") || "-"} |`);
	}
	lines.push("");
	const filled = coverage.filter((row) => row.filled).length;
	lines.push(
		`§55 categories covered: ${filled}/${coverage.length}; suite size ${suite.tasks.length} against §55's ${SUITE_TARGET.min}–${SUITE_TARGET.max} target — this seed suite does not claim §55.`,
	);
	const unvalidated = suite.tasks.filter((task) => task.golden.kind === "upstream-test" && task.golden.validated_at === null).length;
	lines.push(
		`golden commands not yet executed end-to-end against their upstream revision: ${unvalidated}/${suite.tasks.length} (they are captured commands, not measured passes).`,
	);
	return `${lines.join("\n")}\n`;
}
