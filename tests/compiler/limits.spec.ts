/**
 * PRD-040 E1 — a configured execution budget is honored by the compiler.
 *
 * `limits.executionAttempts` / `limits.semanticReviewRounds` used to be validated
 * and then dropped: `compileTask` always emitted the hardcoded complexity table.
 * An explicit configured ceiling now wins; an absent one keeps the complexity
 * default, and `0` stays a real bound rather than becoming an unbounded loop.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileTask } from "../../src/compiler/index.js";
import { BackendRegistry } from "../../src/backends/index.js";
import { runExecutor } from "../../src/executor/index.js";
import { fakeExec, VERIFY_COMMANDS } from "../executor/helpers.js";
import { packet, unavailableHarness } from "./helpers.js";

describe("PRD-040 E1 — configured limits reach the contract", () => {
	it("honors an explicit executionAttempts and semanticReviewRounds", async () => {
		const h = await unavailableHarness({ limits: { executionAttempts: 1, semanticReviewRounds: 0, isolation: "none" } });
		try {
			const contract = await compileTask("fix the parse bug", packet());
			expect(contract.limits.execution_attempts).toBe(1);
			expect(contract.limits.semantic_review_rounds).toBe(0);
		} finally {
			await h.close();
		}
	});

	it("keeps the complexity default when the ceiling is absent", async () => {
		const h = await unavailableHarness();
		try {
			const contract = await compileTask("fix the parse bug", packet());
			expect(contract.task.execution_complexity).toBe("MEDIUM");
			// MEDIUM's table default; the old code emitted this too, but only because
			// the config default was ignored.
			expect(contract.limits.execution_attempts).toBeGreaterThan(1);
		} finally {
			await h.close();
		}
	});

	it("actually bounds worker retries at the configured ceiling", async () => {
		const h = await unavailableHarness({ limits: { executionAttempts: 1, semanticReviewRounds: 0, isolation: "none" } });
		try {
			const contract = await compileTask("fix the parse bug", packet());
			expect(contract.limits.execution_attempts).toBe(1);
			mkdirSync(join(h.cwd, "src"), { recursive: true });
			let calls = 0;
			const outcome = await runExecutor(contract, {
				registry: new BackendRegistry(h.config),
				cwd: h.cwd,
				config: h.config,
				worker: async () => {
					calls += 1;
					writeFileSync(join(h.cwd, "src", "app.ts"), `export const value = ${calls};\n`);
					return { status: "completed", backend: "local", result: { status: "ok", changedFiles: ["src/app.ts"], summary: "edited" }, attempts: [] };
				},
				// The verifier always fails, so without the configured bound the executor
				// would retry up to the complexity table.
				exec: fakeExec({ pass: false }),
				verifyCommands: VERIFY_COMMANDS,
			});
			expect(calls).toBe(1);
			expect(outcome.status).toBe("blocked");
		} finally {
			await h.close();
		}
	});
});
