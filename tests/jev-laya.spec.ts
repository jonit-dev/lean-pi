/**
 * PRD-042 Phase 2 — AC-3, AC-4, AC-7, AC-9: the Laya runtime lifecycle.
 *
 * AC-3 and AC-4 are integration claims and are exercised through the real
 * boundary: a real child process running the real vendored `vendor/laya/server.py`
 * in `--fake` mode, answering real HTTP over a real socket, driven by the real
 * `createJevClient`. `--fake` is what makes that possible without torch, a GPU or
 * a multi-GB download; it does not stub the transport, the script or the process.
 *
 * AC-7 and AC-9 are about the install path, which is a sequence of `execFile`
 * calls — there the injected `LayaDeps` seam is the subject, not a shortcut.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearSites,
	createJevClient,
	ensureLayaRuntime,
	layaProvider,
	layaStatus,
	loadConfig,
	registerSite,
	startLayaServer,
	LayaRuntimeError,
	type JevQuestion,
	type JevResult,
} from "../src/index.js";
import { tempDir } from "./helpers/fixtures.js";
import { fakeRuntime, stubDeps } from "./helpers/laya.js";

function hasPython3(): boolean {
	try {
		execFileSync("python3", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

const PYTHON3 = hasPython3();

const CHOICE: JevQuestion = { id: "route", kind: "Choice", text: "Which route?", options: { quick: "cheap", strong: "expensive" } };
const NOUL: JevQuestion = { id: "needs_review", kind: "Noul", text: "Does this need review?" };

function config(cwd: string) {
	return loadConfig(cwd, {
		configPath: null,
		backends: { local: { type: "native", baseUrl: "http://127.0.0.1:1/v1" } },
		models: { quick: { backend: "local", model: "m" } },
		jev: { provider: "laya", mode: "enabled" },
	});
}

function registerFixtureSites(): void {
	registerSite({
		id: "fixture.choice",
		questions: [CHOICE],
		returnType: ["Choice"],
		consequence: "normal",
		telemetryTag: "fixture.choice",
		fallback: ({ questions }): JevResult[] =>
			questions.map((question) => ({ kind: "Choice", questionId: question.id, choice: "fallback", probabilities: {}, confidence: 1 })),
	});
	registerSite({
		id: "fixture.noul",
		questions: [NOUL],
		returnType: ["Noul"],
		consequence: "normal",
		telemetryTag: "fixture.noul",
		fallback: ({ questions }): JevResult[] => questions.map((question) => ({ kind: "Noul", questionId: question.id, value: 0, confidence: 1 })),
	});
}

describe("PRD-042 Phase 2 — Laya runtime lifecycle", () => {
	let cwd: string;
	let home: string;

	beforeEach(() => {
		clearSites();
		cwd = tempDir("leanpi-laya-");
		home = mkdtempSync(join(tmpdir(), "leanpi-laya-home-"));
	});

	afterEach(() => {
		clearSites();
		rmSync(home, { recursive: true, force: true });
	});

	it.skipIf(!PYTHON3)("AC-3: the vendored server answers typed questions over HTTP, and stops on dispose", async () => {
		registerFixtureSites();
		const { deps, spawned, exited } = fakeRuntime();
		const provider = layaProvider({ home, autoSetup: false }, deps);
		const client = createJevClient({ config: config(cwd), cwd, provider });

		const [choice] = await client.ask("fixture.choice", [CHOICE], { task: "pick" });
		expect(choice).toMatchObject({ kind: "Choice", questionId: "route" });
		expect(choice.kind === "Choice" ? choice.choice : null).toBe("quick");
		expect(client.credentialSource()).toBe("laya");
		expect(spawned).toHaveLength(1);

		const [noul] = await client.ask("fixture.noul", [NOUL], { task: "review?" });
		expect(noul).toMatchObject({ kind: "Noul", questionId: "needs_review" });
		expect(spawned).toHaveLength(1); // resolve() is memoized: one server for the session

		// The server is really gone: the process is dead and a request to its
		// endpoint falls back rather than hanging.
		const [pid] = spawned;
		await client.dispose();
		expect(exited.length).toBeGreaterThan(0);
		expect(() => process.kill(pid!, 0)).toThrow();

		const [afterDispose] = await client.ask("fixture.choice", [CHOICE], { task: "pick" });
		expect(afterDispose.kind === "Choice" ? afterDispose.choice : null).toBe("fallback");
	});

	it.skipIf(!PYTHON3)("AC-5/AC-6: the adapter turns a below-threshold answer into an accepted one", async () => {
		// One fixture site at `high` consequence: threshold 0.85. The fake server
		// reports entropy confidence 0.2 and top-option probability 0.9, so the same
		// canned answer is rejected or accepted depending only on the adapter.
		registerSite({
			id: "fixture.high",
			questions: [CHOICE],
			returnType: ["Choice"],
			consequence: "high",
			telemetryTag: "fixture.high",
			fallback: ({ questions }): JevResult[] =>
				questions.map((question) => ({ kind: "Choice", questionId: question.id, choice: "fallback", probabilities: {}, confidence: 1 })),
		});

		const adapting = fakeRuntime();
		const adapted = createJevClient({
			config: config(cwd),
			cwd,
			provider: layaProvider({ home, autoSetup: false }, adapting.deps),
		});
		const [accepted] = await adapted.ask("fixture.high", [CHOICE], { task: "pick" });
		expect(accepted.kind === "Choice" ? accepted.choice : null).toBe("quick");
		expect(accepted.confidence).toBeGreaterThanOrEqual(0.85);
		expect(adapted.fallbackCount()).toBe(0);
		await adapted.dispose();

		// The negative control: the same script with the adapter off serves the raw
		// entropy confidence, `accept()` rejects it, and the site falls back.
		const raw = fakeRuntime(["--no-adapt"]);
		const passthrough = createJevClient({
			config: config(cwd),
			cwd,
			provider: layaProvider({ home, autoSetup: false }, raw.deps),
		});
		const [rejected] = await passthrough.ask("fixture.high", [CHOICE], { task: "pick" });
		expect(rejected.kind === "Choice" ? rejected.choice : null).toBe("fallback");
		expect(passthrough.fallbackCount()).toBe(1);
		await passthrough.dispose();
	});

	it("AC-4: a configured endpoint is used as-is, spawns nothing, and an unreachable one falls back", async () => {
		registerFixtureSites();
		const { deps, spawned } = fakeRuntime();

		// A reachable external server: start one by hand, then point the provider at it.
		const external = await startLayaServer({ home, autoSetup: false, port: 0 }, deps);
		const provider = layaProvider({ endpoint: external.endpoint }, deps);
		const client = createJevClient({ config: config(cwd), cwd, provider });
		const [answer] = await client.ask("fixture.choice", [CHOICE], { task: "pick" });
		expect(answer.kind === "Choice" ? answer.choice : null).toBe("quick");
		expect(spawned).toHaveLength(1); // only the hand-started server
		await external.stop();

		// An unreachable external endpoint: no spawn at all, and the site falls back.
		const before = spawned.length;
		const unreachable = createJevClient({
			config: config(cwd),
			cwd,
			provider: layaProvider({ endpoint: "http://127.0.0.1:1/v1/systemone" }, deps),
		});
		const [fellBack] = await unreachable.ask("fixture.choice", [CHOICE], { task: "pick" });
		expect(fellBack.kind === "Choice" ? fellBack.choice : null).toBe("fallback");
		expect(spawned).toHaveLength(before);
	});

	it("AC-7: ensureLayaRuntime installs once and the second call execs nothing", async () => {
		const runs: Array<{ command: string; args: string[] }> = [];
		let installed = false;
		const deps = stubDeps({
			async run(command, args, options) {
				runs.push({ command, args });
				if (args[0] === "-c") return { code: installed ? 0 : 1, stdout: "", stderr: "" };
				if (args.includes("venv")) {
					installed = true;
					return { code: 0, stdout: "", stderr: "" };
				}
				return { code: 0, stdout: "", stderr: "" };
			},
		});

		const first = await ensureLayaRuntime({ home }, deps);
		expect(first.installed).toBe(true);
		expect(first.python).toBe(join(home, "venv", "bin", "python"));
		const creates = runs.filter((entry) => entry.args.includes("venv"));
		expect(creates).toHaveLength(1);
		expect(creates[0]!.command).toBe("uv");

		const before = runs.length;
		const second = await ensureLayaRuntime({ home }, deps);
		expect(second.installed).toBe(false);
		expect(runs.length - before).toBe(1); // the probe only
	});

	it("AC-9: a failing install produces one actionable error and no runtime", async () => {
		const deps = stubDeps({
			async run(_command, args): Promise<LayaRunResult> {
				if (args[0] === "-c") return { code: 1, stdout: "", stderr: "" };
				return { code: 1, stdout: "", stderr: "uv: command not found" };
			},
			which: () => false,
		});
		await expect(ensureLayaRuntime({ home }, deps)).rejects.toBeInstanceOf(LayaRuntimeError);
		await expect(ensureLayaRuntime({ home }, deps)).rejects.toThrow(/python3 -m venv exited 1/);
	});

	it("AC-9: a session whose runtime cannot start still answers every site from its fallback", async () => {
		registerFixtureSites();
		const deps = stubDeps({
			async run(_command, args): Promise<LayaRunResult> {
				if (args[0] === "-c") return { code: 1, stdout: "", stderr: "" };
				return { code: 1, stdout: "", stderr: "network unreachable" };
			},
			which: () => false,
		});
		const provider = layaProvider({ home }, deps);
		const client = createJevClient({ config: config(cwd), cwd, provider });

		const [answer] = await client.ask("fixture.choice", [CHOICE], { task: "pick" });
		expect(answer.kind === "Choice" ? answer.choice : null).toBe("fallback");
		expect(client.fallbackCount()).toBe(1);
		const status = await client.status();
		expect(status.configured).toBe(false);
		expect(status.degraded.length).toBeGreaterThan(0);
	});

	it("AC-7/AC-9: autoSetup false refuses to download and says how to install", async () => {
		const runs: Array<{ command: string; args: string[] }> = [];
		const deps = stubDeps({}, runs);
		await expect(ensureLayaRuntime({ home, autoSetup: false }, deps)).rejects.toThrow(/autoSetup is off/);
		// The probe is the only exec: nothing was created, nothing was downloaded.
		expect(runs.every((entry) => entry.args[0] === "-c")).toBe(true);
		expect(await layaStatus({ home, autoSetup: false }, deps)).toMatchObject({ installed: false });
	});

	it("AC-4: layaStatus reports an external server without probing a runtime", async () => {
		const deps = stubDeps();
		expect(await layaStatus({ endpoint: "http://127.0.0.1:9/v1/systemone" }, deps)).toMatchObject({
			installed: true,
			running: true,
			detail: "external server",
		});
	});
});
