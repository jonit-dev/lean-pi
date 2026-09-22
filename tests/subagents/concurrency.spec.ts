/**
 * PRD-041 Phase 3 — real concurrency and parent-state proof (AC-6, AC-7, AC-8).
 *
 * The parent is a real `createLeanPiSession`; the model is a local stub. The
 * session's tool call runs the package's real workflow engine, which launches
 * real in-process child Pi sessions that inherit the parent's registered
 * provider. The stub holds child requests open and counts the peak overlap, so
 * the assertion is on observed requests at the provider boundary — not on a
 * config read, an argv, or a mutated object.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify as yaml } from "yaml";
import { createLeanPiSession, listLanes, type LeanPiSession } from "../../src/index.js";
import { setLimit, subagentConfigPath } from "../../src/subagents/index.js";
import { createCommandRegistry } from "../../src/commands/registry.js";
import { registerSubagentsLimitCommand } from "../../src/commands/subagents-limit.js";
import { fixtureRepo, isolateAgentDir, nativeBackend } from "../helpers/fixtures.js";
import { startStubBackend, type StubBackend, type StubStep } from "../helpers/stub-backend.js";

const CHILD_TOOLS = new Set(["bash", "grep", "find", "ls", "glob", "contact_supervisor"]);

function toolNames(body: Record<string, unknown>): string[] {
	const tools = body.tools as Array<{ function?: { name?: string } }> | undefined;
	return (tools ?? []).map((tool) => tool.function?.name ?? "");
}

const isChildRequest = (body: Record<string, unknown>): boolean => toolNames(body).some((name) => CHILD_TOOLS.has(name));

function workflowScript(fanOut: number): string {
	const runs = Array.from({ length: fanOut }, (_, index) => `  { key: "c${index}", agent: "delegate", task: "child task ${index}", async: false }`).join(",\n");
	return `\nconst results = await runs.all([\n${runs}\n]);\nreturn results.map(r => r.output);\n`;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Bound the terminal await: a wedged turn fails the test instead of hanging it. */
async function settleWithin(work: Promise<unknown>, ms: number): Promise<void> {
	let timer: NodeJS.Timeout | undefined;
	try {
		await Promise.race([
			work,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`delegation did not settle within ${ms}ms`)), ms);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

interface DelegationOptions {
	/** Written to the subagent config file before the session boots. */
	operatorLimit?: number;
	/** Top-level workflow override the model emits. */
	overrideLimit?: number;
	fanOut?: number;
	/** Reuse an existing fixture so a persisted config survives to the next session. */
	cwd?: string;
	agentDir?: string;
}

interface DelegationResult {
	peak: number;
	childRequests: number;
	/** Lane names after the session booted, before any child ran. */
	lanesAfterBoot: string[];
	prompt(): Promise<void>;
	/** One ordinary Pi-loop turn after delegation, to prove the session still works. */
	ordinaryTurn(): Promise<void>;
	dispose(): Promise<void>;
}

/**
 * Drive one real delegation and return the peak simultaneous child requests.
 * The stub holds every child request, and the loop releases them as they
 * arrive, so the semaphore is the only thing bounding overlap.
 */
async function delegate(options: DelegationOptions = {}): Promise<DelegationResult> {
	const fanOut = options.fanOut ?? 5;
	let parentCalls = 0;
	let children = 0;
	const native: StubBackend = await startStubBackend([{ text: "x" }], {
		respond: (body): StubStep => {
			if (isChildRequest(body)) {
				children += 1;
				return { text: `child answer ${children}` };
			}
			parentCalls += 1;
			if (parentCalls === 1) {
				const args: Record<string, unknown> = { async: false, workflowScript: workflowScript(fanOut) };
				if (options.overrideLimit !== undefined) args.globalConcurrencyLimit = options.overrideLimit;
				return { toolCalls: [{ id: "call_sub", name: "subagent", args }] };
			}
			return { text: "parent done" };
		},
		hold: (body) => isChildRequest(body),
	});

	const repo = options.cwd !== undefined && options.agentDir !== undefined ? { cwd: options.cwd, agentDir: options.agentDir } : fixtureRepo();
	const restoreAgentDir = isolateAgentDir(repo.agentDir);
	process.env.LEANPI_SAFETY = "low";
	if (options.operatorLimit !== undefined) setLimit(options.operatorLimit, repo.agentDir);
	writeFileSync(
		join(repo.cwd, "leanpi.config.yaml"),
		yaml({
			backends: { local: nativeBackend(native.baseUrl) },
			models: {
				quick: { backend: "local", model: "cheap-fast" },
				balanced: { backend: "local", model: "cheap-fast" },
				strong: { backend: "local", model: "cheap-fast" },
			},
			jev: { mode: "disabled" },
			lsp: { mode: "off" },
		}),
	);
	const session: LeanPiSession = await createLeanPiSession({ cwd: repo.cwd, agentDir: repo.agentDir });
	// The baseline is the parent's lane set after boot: a child must not add or
	// remove any lane, and no child ever re-runs LeanPi's activation.
	const lanesAfterBoot = listLanes().map((lane) => lane.name);

	return {
		get peak() {
			return native.peakConcurrent;
		},
		get childRequests() {
			return children;
		},
		lanesAfterBoot,
		async prompt() {
			let settled = false;
			const turn = session.session.prompt("delegate the work").finally(() => {
				settled = true;
			});
			const deadline = Date.now() + 90_000;
			// Let a full semaphore batch accumulate before releasing it: a release
			// the instant the first child arrives would undercount the true peak.
			let lastHeld = -1;
			let stableSince = Date.now();
			while (!settled && Date.now() < deadline) {
				await sleep(25);
				const held = native.heldCount();
				if (held !== lastHeld) {
					lastHeld = held;
					stableSince = Date.now();
				}
				if (held > 0 && Date.now() - stableSince >= 300) {
					native.release();
					lastHeld = -1;
					stableSince = Date.now();
				}
			}
			native.release();
			await settleWithin(turn, 60_000);
		},
		async ordinaryTurn() {
			await session.session.prompt("an ordinary follow-up");
		},
		async dispose() {
			session.session.dispose();
			await native.close();
			restoreAgentDir();
		},
	};
}

describe("real per-run concurrency (AC-6, AC-7)", () => {
	let active: DelegationResult | undefined;

	beforeEach(() => {
		active = undefined;
	});

	afterEach(async () => {
		await active?.dispose();
		delete process.env.LEANPI_SAFETY;
	});

	it("defaults to exactly 3 concurrent children with 5 requested, from the shipped default config", { timeout: 120_000 }, async () => {
		active = await delegate({ fanOut: 5 });
		await active.prompt();
		expect(active.childRequests).toBe(5);
		expect(active.peak).toBe(3);
	});

	it("honors a lower changed limit of exactly 2", { timeout: 120_000 }, async () => {
		active = await delegate({ fanOut: 5, operatorLimit: 2 });
		await active.prompt();
		expect(active.childRequests).toBe(5);
		expect(active.peak).toBe(2);
	});

	it("respects a lower per-call override and clamps a higher one to the operator max", { timeout: 180_000 }, async () => {
		const lower = await delegate({ fanOut: 5, operatorLimit: 3, overrideLimit: 2 });
		try {
			await lower.prompt();
			expect(lower.childRequests).toBe(5);
			expect(lower.peak).toBe(2);
		} finally {
			await lower.dispose();
		}

		const higher = await delegate({ fanOut: 5, operatorLimit: 3, overrideLimit: 99 });
		try {
			await higher.prompt();
			expect(higher.childRequests).toBe(5);
			expect(higher.peak).toBe(3);
		} finally {
			await higher.dispose();
		}
	});

	it("proves the measurement is not vacuous: above the default, 5 children overlap", { timeout: 120_000 }, async () => {
		active = await delegate({ fanOut: 5, operatorLimit: 6 });
		await active.prompt();
		expect(active.childRequests).toBe(5);
		expect(active.peak).toBeGreaterThan(3);
	});
});

describe("/subagents-limit changes the next session and persists (AC-7)", () => {
	it("writes 2 through the real registry, a new session observes 2, and invalid input leaves the file byte-identical", { timeout: 180_000 }, async () => {
		const repo = fixtureRepo();
		process.env.LEANPI_SAFETY = "low";
		const registry = createCommandRegistry();
		registerSubagentsLimitCommand(registry, { path: subagentConfigPath(repo.agentDir), limit: 3 }, repo.agentDir);

		const set = await registry.dispatch("/subagents-limit 2", { cwd: repo.cwd });
		expect(set.ok).toBe(true);
		expect(set.text).toMatch(/saved as 2/);
		expect(set.text).toMatch(/\/reload|restart/);
		const path = subagentConfigPath(repo.agentDir);
		const written = readFileSync(path, "utf8");
		expect(JSON.parse(written).globalConcurrencyLimit).toBe(2);

		const invalid = await registry.dispatch("/subagents-limit 0", { cwd: repo.cwd });
		expect(invalid.ok).toBe(false);
		expect(readFileSync(path, "utf8")).toBe(written);

		const restart = await delegate({ fanOut: 5, cwd: repo.cwd, agentDir: repo.agentDir });
		try {
			// The config already carries 2; the new session must read it, not reset it.
			expect(JSON.parse(readFileSync(path, "utf8")).globalConcurrencyLimit).toBe(2);
			await restart.prompt();
			expect(restart.childRequests).toBe(5);
			expect(restart.peak).toBe(2);
		} finally {
			await restart.dispose();
			delete process.env.LEANPI_SAFETY;
		}
	});
});

describe("a child run leaves the parent intact (AC-8)", () => {
	it("does not re-activate LeanPi, mark the process as a child, or break an ordinary turn", { timeout: 120_000 }, async () => {
		const childEnvBefore = process.env.PI_SUBAGENT_CHILD;
		const run = await delegate({ fanOut: 5 });
		try {
			await run.prompt();
			expect(run.childRequests).toBe(5);
			// Foreground children run in-process without the LeanPi extension; the
			// parent's process-global lanes are exactly what they were after boot.
			expect(listLanes().map((lane) => lane.name)).toEqual(run.lanesAfterBoot);
			expect(process.env.PI_SUBAGENT_CHILD).toBe(childEnvBefore);
			// The session still answers an ordinary turn through Pi's own loop.
			await run.ordinaryTurn();
		} finally {
			await run.dispose();
		}
	});
});
