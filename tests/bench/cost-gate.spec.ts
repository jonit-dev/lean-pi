/**
 * PRD-038 — the pre-publish cost-regression gate.
 *
 * The gate's decision is a pure function over `summarize.py`'s output and a
 * recorded baseline, so it is unit-tested here; the expensive part (running the
 * benchmark) is exercised only when the gate is armed. These cases are the
 * distinct failure modes the gate must catch: a ratio that drifts past
 * tolerance, a pass rate that drops, and an unprovable metric.
 *
 * The second half drives the real CLI over the committed run — spawn, python3,
 * summarize.py, baseline read, exit code — because the pure function passing
 * says nothing about whether the shipped script reads the run or always exits 0.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { compareToBaseline } from "../../bench/cost/gate.mjs";

/** A summarize.py-shaped result with both arms complete and passing. */
function summary(leanCost: number | null, leanPassrate: number | null, stockCost: number | null = 0.011991) {
	return {
		parity_verified: false,
		comparison_eligible: false,
		arms: {
			leanpi: { cost_per_verified_completion: leanCost, passrate: leanPassrate, verified: 5, cost_complete: leanCost !== null },
			"stock-pi": { cost_per_verified_completion: stockCost, passrate: 1.0, verified: 5, cost_complete: stockCost !== null },
		},
	};
}

const BASELINE = {
	tolerance: 0.15,
	passrate_tolerance: 0.2,
	ratio: 0.00815 / 0.011991, // 0.6797
	leanpi_passrate: 1.0,
};

describe("PRD-038 — compareToBaseline", () => {
	it("passes when the ratio holds within tolerance and the pass rate is unchanged", () => {
		// Same ratio as the baseline: a 5% drift in LeanPi's absolute cost still
		// leaves the ratio inside the 15% band, which is the whole point of gating
		// on the ratio rather than the absolute figure.
		const result = compareToBaseline(BASELINE, summary(0.00815 * 1.05, 1.0));
		expect(result.ok).toBe(true);
		expect(result.failures).toEqual([]);
		expect(result.checks.map((check) => check.name)).toEqual(["completeness", "ratio", "passrate"]);
	});

	it("fails when LeanPi gets more expensive relative to stock Pi", () => {
		// ratio 0.85 > 0.6797 * 1.15 = 0.7817
		const result = compareToBaseline(BASELINE, summary(0.0102, 1.0));
		expect(result.ok).toBe(false);
		expect(result.failures.join(" ")).toMatch(/ratio/);
		expect(result.checks.find((check) => check.name === "ratio")?.ok).toBe(false);
	});

	it("tolerates one trial's pass-rate noise but fails a real break", () => {
		// n=5 makes a single failure a 20-point dip; the baseline's
		// `passrate_tolerance` absorbs exactly that and nothing more.
		expect(compareToBaseline(BASELINE, summary(0.005, 0.8)).ok).toBe(true);
		const broken = compareToBaseline(BASELINE, summary(0.005, 0.6));
		expect(broken.ok).toBe(false);
		expect(broken.failures.join(" ")).toMatch(/passrate/);
	});

	it("fails rather than guessing when an arm's cost is unprovable", () => {
		const result = compareToBaseline(BASELINE, summary(null, 1.0));
		expect(result.ok).toBe(false);
		expect(result.failures.join(" ")).toMatch(/completeness/);
	});

	it("honours an explicit tolerance override", () => {
		const measured = summary(0.0095, 1.0); // ratio 0.792, just over the default limit
		expect(compareToBaseline(BASELINE, measured).ok).toBe(false);
		expect(compareToBaseline(BASELINE, measured, { tolerance: 0.2 }).ok).toBe(true);
	});
});

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const GATE = join(ROOT, "bench/cost/gate.mjs");
const OUT_DIR = join(ROOT, "bench/out");
const RECORDED_RUN = "cost-followup-20260922";

/** A spawned gate run with an explicitly controlled environment. */
function runGate(args: string[], options: { flag?: boolean; credential?: boolean } = {}) {
	const env: NodeJS.ProcessEnv = { ...process.env };
	// Never inherit the arming flag or a credential: a developer machine with
	// `LEANPI_COST_GATE=1` exported would otherwise launch the paid benchmark here.
	delete env.LEANPI_COST_GATE;
	delete env.OPENCODE_API_KEY;
	if (options.flag) env.LEANPI_COST_GATE = "1";
	if (options.credential) env.OPENCODE_API_KEY = "sk-test";
	const result = spawnSync(process.execPath, [GATE, ...args], { cwd: ROOT, encoding: "utf8", env });
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Temp runs written under `bench/out/` because `--from-run` resolves ids there. */
const tempRuns: string[] = [];
afterEach(() => {
	for (const dir of tempRuns.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A copy of the committed run's input, mutated, without touching the original. */
function mutatedRun(mutate: (input: { attempts: Array<{ arm: string; status: string; cost_usd: Record<string, number | null> }> }) => void): string {
	const id = `cost-gate-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
	const dir = join(OUT_DIR, id);
	tempRuns.push(dir);
	mkdirSync(dir, { recursive: true });
	const input = JSON.parse(readFileSync(join(OUT_DIR, RECORDED_RUN, "summary-input.json"), "utf8"));
	mutate(input);
	writeFileSync(join(dir, "summary-input.json"), JSON.stringify(input, null, 2));
	return id;
}

describe("PRD-038 — the gate CLI over the committed run", () => {
	it("AC-3: exits 0 against the recorded baseline with no spend", () => {
		const result = runGate(["--from-run", RECORDED_RUN]);
		expect(result.status).toBe(0);
		expect(result.stdout).toMatch(/PASS/);
		expect(result.stdout).toContain(RECORDED_RUN);
	});

	it("AC-3: a run whose LeanPi ratio regresses exits 1 naming the ratio check", () => {
		const id = mutatedRun((input) => {
			for (const attempt of input.attempts) {
				if (attempt.arm !== "leanpi") continue;
				for (const component of Object.keys(attempt.cost_usd)) {
					const value = attempt.cost_usd[component];
					if (value !== null) attempt.cost_usd[component] = value * 3;
				}
			}
		});
		const result = runGate(["--from-run", id]);
		expect(result.status).toBe(1);
		expect(result.stderr).toMatch(/ratio/);
	});

	it("AC-3: a run whose LeanPi pass rate breaks exits 1 naming the passrate check", () => {
		// Two failed trials out of five **in each arm**: failing only LeanPi also
		// raises its $/verified, so both arms are failed together to hold the ratio
		// constant and prove the gate reads the pass rate independently of spend.
		const id = mutatedRun((input) => {
			for (const arm of ["leanpi", "stock-pi"]) {
				let mutated = 0;
				for (const attempt of input.attempts) {
					if (attempt.arm !== arm || mutated >= 2) continue;
					attempt.status = "failed";
					mutated += 1;
				}
			}
		});
		const result = runGate(["--from-run", id]);
		expect(result.status).toBe(1);
		expect(result.stderr).toMatch(/passrate/);
		expect(result.stderr).not.toMatch(/ratio/);
	});

	it("AC-3: a single failed trial is tolerated, not treated as a regression", () => {
		// The false-alarm guard: ~1 in 5 trials fails on the model's own variance, so a
		// gate that blocked publishing on one failure would be ignored within a week.
		// Both arms again, so only the pass rate moves.
		const id = mutatedRun((input) => {
			for (const arm of ["leanpi", "stock-pi"]) {
				const first = input.attempts.find((attempt) => attempt.arm === arm);
				if (first) first.status = "failed";
			}
		});
		const result = runGate(["--from-run", id]);
		expect(result.status).toBe(0);
		expect(result.stdout).toMatch(/passrate/);
	});

	it("AC-3: an unprovable cost exits 1 naming the completeness check", () => {
		const id = mutatedRun((input) => {
			for (const attempt of input.attempts) if (attempt.arm === "leanpi") attempt.cost_usd.model = null;
		});
		const result = runGate(["--from-run", id]);
		expect(result.status).toBe(1);
		expect(result.stderr).toMatch(/completeness/);
	});

	it("AC-3: a missing run exits 1 instead of silently passing", () => {
		const result = runGate(["--from-run", `cost-gate-missing-${process.pid}`]);
		expect(result.status).toBe(1);
		expect(result.stderr).toMatch(/summary-input\.json/);
	});

	it("AC-2: with the flag unset it skips, names the flag and exits 0", () => {
		const result = runGate([]);
		expect(result.status).toBe(0);
		expect(result.stdout).toMatch(/skipped/);
		expect(result.stdout).toContain("LEANPI_COST_GATE=1");
	});

	it("AC-2: armed without a credential it fails naming the credential, never silently passes", () => {
		const result = runGate([], { flag: true, credential: false });
		expect(result.status).not.toBe(0);
		expect(result.stderr).toMatch(/OPENCODE_API_KEY/);
	});

	it("AC-4: the gate is wired into prepublishOnly and nowhere a normal commit runs", () => {
		const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
		expect(pkg.scripts.prepublishOnly).toContain("bench:cost-gate");
		expect(pkg.scripts.test).not.toContain("cost-gate");
		for (const file of ["vitest.config.ts", "vitest.bench.config.ts"]) {
			expect(readFileSync(join(ROOT, file), "utf8")).not.toContain("cost-gate");
		}
		const workflows = join(ROOT, ".github/workflows");
		for (const file of readdirSync(workflows)) {
			expect(readFileSync(join(workflows, file), "utf8")).not.toContain("cost-gate");
		}
	});
});
