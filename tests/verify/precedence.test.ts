/**
 * E3 (AC-5, AC-7): the aggregate is one-way and exhaustive.
 *
 * The negative control for AC-5 is the same fixture with only the failing
 * command replaced by a passing one: the pair proves the measurement drove the
 * outcome rather than a constant. The table in AC-7 rejects a permissive
 * `default` arm by driving every member of the status union through the fold.
 */
import { describe, expect, it } from "vitest";
import { aggregate, type VerificationStatus } from "../../src/verify/aggregate.js";
import { registerVerifier, verifierOutcome } from "../../src/verify/descriptors.js";
import { EvidenceStore, type EvidenceRecord, type EvidenceStatus } from "../../src/verify/evidence.js";
import { verifyTask } from "../../src/verify/index.js";
import { execShell, type ShellExec, type ShellRunResult } from "../../src/verify/run.js";
import { contractOf, gitInit, jevStub, tempWorkspace, writeFiles, TSC } from "./support.js";

// PRD-022 registers these four kinds through the same map; a run with the
// facility absent must produce `unavailable`, never a pass.
registerVerifier("browser_test", {
	run: async (descriptor) => verifierOutcome(descriptor, "unavailable", { reason: "no browser facility in this session" }),
});

function recordOf(status: EvidenceStatus): EvidenceRecord {
	return {
		kind: "typecheck",
		status,
		workspaceHash: "hash-current",
		startedAt: "2026-01-01T00:00:00.000Z",
		exitCode: status === "pass" ? 0 : null,
		artifactRef: null,
		criterion: ["AC-1"],
		scope: "src/**/*.ts",
	};
}

/** Every member of `EvidenceStatus`, and what a mandatory record of that status aggregates to. */
const STATUS_TABLE: Array<[EvidenceStatus, VerificationStatus]> = [
	["pass", "pass"],
	["fail", "deterministic_failure"],
	["error", "deterministic_failure"],
	["not_run", "incomplete"],
	["unavailable", "incomplete"],
];

/** Runs the real typecheck for tsc commands; answers everything else as a pass. */
function hybridExec(commands: string[]): ShellExec {
	return (command, cwd, timeoutMs): Promise<ShellRunResult> => {
		commands.push(command);
		if (command.includes(".bin/tsc")) return execShell(command, cwd, timeoutMs);
		return Promise.resolve({ exitCode: 0, stdout: "", stderr: "", timedOut: false, spawnError: null });
	};
}

describe("deterministic failure outranks any semantic answer (AC-5)", () => {
	it("returns deterministic_failure beside a favorable JEV answer and an executor claim, and pass only when the check passes", async () => {
		const root = tempWorkspace();
		writeFiles(root, { "src/bad.ts": "export const bad: number = 'not a number';\n", "src/good.ts": "export const good: number = 1;\n" });
		gitInit(root);
		const contract = contractOf({
			required: ["typecheck", "affected_tests"],
			criteria: [{ id: "AC-1", verifiers: ["typecheck", "affected_tests"], scope: "tests/verify/*.test.ts" }],
		});
		const touchedPaths = ["src/bad.ts", "src/good.ts"];
		const run = (typecheckTarget: string) => {
			const commands: string[] = [];
			return verifyTask(contract, root, {
				store: new EvidenceStore(),
				// The most permissive answer this site can give: the full suite too.
				jev: jevStub("BROADER_SUITE_REQUIRED"),
				exec: hybridExec(commands),
				commands: { typecheck: `${TSC} --noEmit --strict ${typecheckTarget}` },
				touchedPaths,
				diff: { files: [typecheckTarget] },
				assertions: [{ source: "executor", text: "tests pass" }],
				timeoutMs: 60_000,
			});
		};

		const failing = await run("src/bad.ts");
		expect(failing.records.find((record) => record.kind === "typecheck")?.status).toBe("fail");
		expect(failing.assertions.map((assertion) => assertion.text)).toEqual(["tests pass"]);
		expect(failing.status).toBe("deterministic_failure");

		// Negative control: only the failing check changes.
		const passing = await run("src/good.ts");
		expect(passing.records.map((record) => record.kind).sort()).toEqual(["full_suite", "git_status", "targeted_test", "typecheck"]);
		expect(passing.records.every((record) => record.status === "pass")).toBe(true);
		expect(passing.status).toBe("pass");
	});

	it("aggregates a mandatory unavailable facility to incomplete, not pass (AC-7)", async () => {
		const root = tempWorkspace();
		gitInit(root);
		const result = await verifyTask(contractOf({ required: ["browser_test"] }), root, { touchedPaths: [] });

		const record = result.records.find((entry) => entry.kind === "browser_test");
		expect(record?.status).toBe("unavailable");
		expect(result.status).toBe("incomplete");
	});
});

describe("the aggregate is exhaustive over the status union (AC-7)", () => {
	it.each(STATUS_TABLE)("aggregates a mandatory %s record to %s", (status, expected) => {
		expect(aggregate([recordOf(status)])).toBe(expected);
		// The identical record set with this record replaced by a fresh pass is a pass.
		expect(aggregate([recordOf("pass")])).toBe("pass");
	});

	it("treats a stale mandatory record as a deterministic failure without re-running anything", () => {
		expect(aggregate([recordOf("pass")], [recordOf("pass")])).toBe("deterministic_failure");
		expect(aggregate([recordOf("pass"), recordOf("unavailable")])).toBe("incomplete");
		expect(aggregate([recordOf("unavailable"), recordOf("fail")])).toBe("deterministic_failure");
		expect(aggregate([])).toBe("pass");
	});
});
