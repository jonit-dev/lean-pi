/**
 * The two questions `leanpi` answers before Pi exists: what may this run use,
 * and is the control plane there. Both were real failures — a user running the
 * command outside this repository got "no model roles configured", and a
 * session with no JEV key ran heuristics while reporting itself as LeanPi.
 */
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { autoConfigure, MissingJevKeyError, requireJev } from "../src/cli/bootstrap.js";
import { allocateRoles, candidateKey, detectModels, ladderAllocation, VENDOR_DEFAULT, type ModelCandidate } from "../src/cli/allocate.js";
import { MODEL_ROLES } from "../src/core/types.js";
import type { JevResult } from "../src/jev/types.js";
import { HARNESS_DESCRIPTORS, runHarness } from "../src/backends/harness.js";
import { parseLeanPiFlags } from "../src/cli/launch.js";
import { statusLine } from "../src/cli/statusline.js";
import { probeVendor } from "../src/backends/subscriptions.js";
import { openPrdLane } from "../src/prd/dispatch.js";
import { loadConfig } from "../src/core/config.js";

/** A machine with the vendor CLIs installed and logged in. */
function machine(options: { vendors: readonly string[] }): { cwd: string; home: string; env: NodeJS.ProcessEnv } {
	const root = mkdtempSync(join(tmpdir(), "leanpi-bootstrap-"));
	const home = join(root, "home");
	const bin = join(root, "bin");
	const cwd = join(root, "project");
	for (const dir of [home, bin, cwd]) mkdirSync(dir, { recursive: true });
	const credentials: Record<string, string> = {
		claude: join(home, ".claude", ".credentials.json"),
		codex: join(home, ".codex", "auth.json"),
		opencode: join(home, ".local", "share", "opencode", "auth.json"),
	};
	// The stub answers its own status command the way the real CLI does, because
	// that is what detection now asks.
	const status: Record<string, string> = {
		claude: '{"loggedIn": true}',
		codex: "Logged in using ChatGPT",
		opencode: "1 credentials",
	};
	for (const vendor of options.vendors) {
		writeFileSync(join(bin, vendor), `#!/bin/sh\necho '${status[vendor] as string}'\n`, { mode: 0o755 });
		const credential = credentials[vendor] as string;
		mkdirSync(join(credential, ".."), { recursive: true });
		writeFileSync(credential, "{}\n");
	}
	// What each vendor says its own model is — the only source of model ids.
	if (options.vendors.includes("codex")) {
		mkdirSync(join(home, ".codex"), { recursive: true });
		writeFileSync(join(home, ".codex", "config.toml"), 'model = "gpt-6-astra"\n');
	}
	if (options.vendors.includes("claude")) writeFileSync(join(home, ".claude.json"), JSON.stringify({ model: "opus" }));
	return { cwd, home, env: { HOME: home, PATH: bin, XDG_CONFIG_HOME: join(home, ".config") } };
}

/** JEV as it answers the allocation site: one Choice per role. */
function jevPicking(choice: (role: string) => string): { ask: (...args: never[]) => Promise<JevResult[]>; fallbackCount: () => number } {
	return {
		ask: (async (_site: string, questions: Array<{ id: string }>) =>
			questions.map((question) => ({
				kind: "Choice" as const,
				questionId: question.id,
				choice: choice(question.id),
				probabilities: {},
				confidence: 0.9,
			}))) as never,
		fallbackCount: () => 0,
	};
}

describe("first run", () => {
	it("writes a config from the subscriptions the machine already has, with JEV allocating the roles", async () => {
		const { cwd, home, env } = machine({ vendors: ["claude", "codex", "opencode"] });

		// JEV holds the capability/price data, so its answer is the one written —
		// including where it contradicts the cheapest-first fallback, which would
		// never put `claude` on `quick`.
		const client = jevPicking((role) => (role === "strong" ? "codex:gpt-6-astra" : "claude:opus"));
		const result = await autoConfigure({ cwd, home, env, client });

		expect(result.created).toBe(true);
		expect(result.path).toBe(join(home, ".config", "leanpi", "leanpi.config.yaml"));
		// It has to be a config LeanPi can actually load — the failure it replaces
		// was a config that parsed and then had no roles.
		const config = loadConfig(cwd, {}, env);
		expect(Object.keys(config.backends).sort()).toEqual(["claude", "codex", "opencode"]);
		expect(config.models.quick?.backend).toBe("claude");
		expect(config.models.strong?.backend).toBe("codex");
		// The ids are the vendors' own, never a table in this repository.
		expect(config.models.quick?.model).toBe("opus");
		expect(config.models.strong?.model).toBe("gpt-6-astra");
		// No credential ever lands in a config file.
		expect(readFileSync(result.path, "utf8")).not.toMatch(/api[_-]?key\s*:/i);
	});

	it("binds every role to the one vendor a single-subscription machine has", async () => {
		const { cwd, home, env } = machine({ vendors: ["codex"] });

		await autoConfigure({ cwd, home, env, client: jevPicking(() => "codex:gpt-6-astra") });

		const config = loadConfig(cwd, {}, env);
		expect(Object.keys(config.backends)).toEqual(["codex"]);
		expect(new Set(Object.values(config.models).map((role) => role.backend))).toEqual(new Set(["codex"]));
		// Read out of `~/.codex/config.toml`, not guessed.
		expect(config.models.balanced?.model).toBe("gpt-6-astra");
	});

	it("never overwrites a config that exists", async () => {
		const { cwd, home, env } = machine({ vendors: ["claude"] });
		const existing = join(cwd, "leanpi.config.yaml");
		writeFileSync(existing, "backends:\n  mine: { type: external_harness, vendor: codex }\nmodels:\n  quick: { backend: mine, model: gpt-5-codex }\n");

		const result = await autoConfigure({ cwd, home, env });

		expect(result.created).toBe(false);
		expect(result.path).toBe(existing);
		expect(readFileSync(existing, "utf8")).toContain("mine");
	});

	it("says what to do when nothing is signed in, instead of writing a config that cannot run", async () => {
		const { cwd, home, env } = machine({ vendors: [] });

		const result = await autoConfigure({ cwd, home, env });

		expect(result.created).toBe(false);
		expect(result.summary).toContain("no vendor CLI");
		expect(result.summary).toMatch(/claude, codex, opencode/);
	});
});

describe("the control plane is not optional", () => {
	it("refuses to start with no JEV key, and names every way to set one", () => {
		const { cwd, home, env } = machine({ vendors: ["codex"] });

		let thrown: unknown;
		try {
			requireJev({ cwd, home, env });
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(MissingJevKeyError);
		const message = (thrown as Error).message;
		expect(message).toContain("--jev-key");
		expect(message).toContain("JEV_API_KEY");
		expect(message).toContain(".env");
		expect(message).toContain("--no-jev");
	});

	it("accepts the key from the project's .env, which is never exported", () => {
		const { cwd, home, env } = machine({ vendors: ["codex"] });
		writeFileSync(join(cwd, ".env"), "JEV_API_KEY=jev-from-dotenv\n");

		expect(requireJev({ cwd, home, env }).source).toContain("env file");
		expect(env.JEV_API_KEY).toBeUndefined();
	});

	it("stores a key given on the command line, readable only by its owner", () => {
		const { cwd, home, env } = machine({ vendors: ["codex"] });

		const check = requireJev({ cwd, home, env, setKey: "jev-from-flag" });

		expect(check.stored).toBeDefined();
		expect(statSync(check.stored as string).mode & 0o777).toBe(0o600);
		// And the next run finds it without the flag.
		expect(requireJev({ cwd, home, env }).source).toContain("credential store");
	});

	it("starts the degraded harness only when asked", () => {
		const { cwd, home, env } = machine({ vendors: ["codex"] });

		expect(requireJev({ cwd, home, env, allowMissing: true }).source).toContain("--no-jev");
	});
});

describe("LeanPi's own flags", () => {
	it("never reach Pi", () => {
		const flags = parseLeanPiFlags(["--no-jev", "--jev-key", "secret", "-m", "sonnet", "--print", "hello"]);

		expect(flags.allowMissingJev).toBe(true);
		expect(flags.jevKey).toBe("secret");
		expect(flags.rest).toEqual(["-m", "sonnet", "--print", "hello"]);
	});

	it("accepts the inline form", () => {
		expect(parseLeanPiFlags(["--jev-key=secret", "chat"])).toMatchObject({ jevKey: "secret", rest: ["chat"] });
	});
});

describe("model candidates", () => {
	it("reads each vendor's own model instead of a table in this repository", () => {
		const { home, env } = machine({ vendors: ["claude", "codex", "opencode"] });

		expect(detectModels("codex", { env, home })).toEqual([{ vendor: "codex", model: "gpt-6-astra", source: "codex config.toml" }]);
		expect(detectModels("claude", { env, home })).toEqual([{ vendor: "claude", model: "opus", source: "claude settings" }]);
		// `opencode models` is the one vendor that lists, and the one LeanPi passes
		// `--model` to.
		const listed = detectModels("opencode", {
			env,
			home,
			run: () => "opencode-go/deepseek-v4.1-flash\nopencode-go/muse-spark-1.3-contributor\n",
		});
		expect(listed.map((candidate) => candidate.model)).toEqual(["opencode-go/deepseek-v4.1-flash", "opencode-go/muse-spark-1.3-contributor"]);
	});

	it("says `default` when a vendor names no model, because LeanPi then passes none", () => {
		const { home, env } = machine({ vendors: [] });

		expect(detectModels("codex", { env, home })[0]?.model).toBe(VENDOR_DEFAULT);
		expect(
			detectModels("opencode", {
				env,
				home,
				run: () => {
					throw new Error("not installed");
				},
			})[0]?.model,
		).toBe(VENDOR_DEFAULT);
	});

	it("falls back to cheapest-first when JEV has no answer", () => {
		const candidates: ModelCandidate[] = [
			{ vendor: "claude", model: "opus", source: "test" },
			{ vendor: "opencode", model: "flash", source: "test" },
		];

		const ladder = ladderAllocation(candidates);

		expect(candidateKey(ladder.quick)).toBe("opencode:flash");
		expect(candidateKey(ladder.strong)).toBe("claude:opus");
		expect(candidateKey(ladder.review_strong)).toBe("claude:opus");
	});
});

describe("what the vendor actually runs", () => {
	it("passes the role's model and the compiled effort to the vendor CLIs", () => {
		// Before this, `claude` and `codex` ignored both: every role ran the vendor's
		// own configured model at the vendor's own reasoning effort (`xhigh` on the
		// machine this was written on), so the role map and the compiler's
		// per-turn effort decision were decoration on two of three backends.
		const claude = HARNESS_DESCRIPTORS.claude.argv({
			packet: { objective: "x", role: "strong", model: "opus", effort: "high" },
			prompt: "do it",
		} as never);
		expect(claude).toContain("--model");
		expect(claude[claude.indexOf("--model") + 1]).toBe("opus");

		const codex = HARNESS_DESCRIPTORS.codex.argv({
			packet: { objective: "x", role: "quick", model: "gpt-6-astra", effort: "low" },
			prompt: "do it",
		} as never);
		expect(codex[codex.indexOf("--model") + 1]).toBe("gpt-6-astra");
		expect(codex).toContain('model_reasoning_effort="low"');
	});

	it("sends no model flag when the config says the vendor chooses", async () => {
		const spawned: string[][] = [];
		await runHarness(
			{ name: "codex", type: "external_harness", vendor: "codex", command: "codex" } as never,
			{ objective: "x", role: "quick", model: VENDOR_DEFAULT },
			{
				cwd: process.cwd(),
				spawn: (async (request: { args: string[] }) => {
					spawned.push(request.args);
					return { code: 0, stdout: JSON.stringify({ text: "done" }), stderr: "" };
				}) as never,
			} as never,
		);
		expect(spawned[0]).not.toContain("--model");
		expect(spawned[0]).not.toContain(VENDOR_DEFAULT);
	});
});

describe("the status line", () => {
	it("shows what this turn routed to, how hard it thinks, and what it was classified as", () => {
		const config = {
			backends: { claude: { type: "external_harness", vendor: "claude" } },
			models: { strong: { backend: "claude", model: "opus[1m]" }, balanced: { backend: "claude", model: "opus[1m]" } },
		} as never;
		const contract = {
			task: { execution_complexity: "MEDIUM" },
			routing: { executor_class: "strong" },
			reasoning: { effort: "medium" },
		} as never;

		const line = statusLine({ config, contract, lane: "executor" });

		// The vendor's bracket alias is not a model name a human reads.
		expect(line).toBe("Auto: opus (1m) (Medium) — MEDIUM complexity — Executor lane");
	});

	it("names the role when the config has no model for it, instead of throwing mid-turn", () => {
		const config = { backends: {}, models: {} } as never;
		const contract = { task: { execution_complexity: "LOW" }, routing: { executor_class: "quick" }, reasoning: { effort: "low" } } as never;

		expect(statusLine({ config, contract, lane: "compiler" })).toContain("quick");
	});
});

describe("detection asks the vendor", () => {
	it("believes the CLI's own status over a credential file that is merely present", () => {
		const { home, env } = machine({ vendors: ["claude"] });

		// The file is there; the vendor says otherwise. This is a real state —
		// `~/.claude/.credentials.json` survives a logout elsewhere — and the file
		// check alone would write a config routing `strong` at a dead backend.
		const state = probeVendor("claude", { env, home, verify: true, run: () => '{"loggedIn": false}' });

		expect(state.signedIn).toBe(false);
		expect(state.evidence).toContain("not signed in");
	});

	it("keeps the file check when the vendor has no answer", () => {
		const { home, env } = machine({ vendors: ["claude"] });

		const state = probeVendor("claude", {
			env,
			home,
			verify: true,
			run: () => {
				throw new Error("command failed");
			},
		});

		expect(state.signedIn).toBe(true);
		expect(state.evidence).toContain(".credentials.json");
	});

	it("reads each vendor's own status output", () => {
		const { home, env } = machine({ vendors: ["claude", "codex", "opencode"] });
		const answers: Record<string, string> = {
			claude: '{\n  "loggedIn": true,\n  "authMethod": "claude.ai"\n}',
			codex: "Logged in using ChatGPT\n",
			opencode: "│  OpenCode Go api\n└  1 credentials\n",
		};

		for (const vendor of ["claude", "codex", "opencode"] as const) {
			expect(probeVendor(vendor, { env, home, verify: true, run: () => answers[vendor] as string }).signedIn).toBe(true);
		}
		// An empty OpenCode store is a logged-out machine, not a signed-in one.
		expect(probeVendor("opencode", { env, home, verify: true, run: () => "└  0 credentials\n" }).signedIn).toBe(false);
	});
});

describe("allocation confidence", () => {
	it("keeps the roles JEV was sure about and ladders only the rest", async () => {
		const candidates: ModelCandidate[] = [
			{ vendor: "claude", model: "opus", source: "test" },
			{ vendor: "opencode", model: "flash", source: "test" },
		];
		// Six questions over near-equal cheap models will have one the model is
		// unsure about; discarding five confident answers over it is how a control
		// plane ends up never used.
		const client = {
			ask: async () =>
				MODEL_ROLES.map((role) => ({
					kind: "Choice" as const,
					questionId: role,
					choice: "claude:opus",
					probabilities: {},
					confidence: role === "review_quick" ? 0.1 : 0.9,
				})),
			fallbackCount: () => 0,
		};

		const allocation = await allocateRoles(client as never, candidates);

		expect(allocation.fallbackUsed).toBe(false);
		expect(allocation.decided).not.toContain("review_quick");
		expect(candidateKey(allocation.roles.strong)).toBe("claude:opus");
		// The unsure role falls to the ladder, which puts the cheap model on cheap review.
		expect(candidateKey(allocation.roles.review_quick)).toBe("opencode:flash");
	});
});

describe("a PRD the user has not written yet", () => {
	it("does not kill the turn, and says how to open the lane", async () => {
		// The compiler decides a task needs a PRD before one exists — that is the
		// normal order — so the first thing a new user typed in a fresh project
		// died with "No active PRD state under …/.leanpi/prd".
		const record = {
			next_stage: "prd_lane",
			contract: { task: { planning_decision: "PRD_REQUIRED" } },
		} as never;

		const lane = await openPrdLane(record, {
			config: { backends: {}, models: {} } as never,
			cwd: mkdtempSync(join(tmpdir(), "leanpi-noprd-")),
			artifactStore: {} as never,
		});

		expect(lane).toBeNull();

		const line = statusLine({
			config: { backends: {}, models: {} } as never,
			contract: {
				task: { execution_complexity: "HIGH", planning_decision: "PRD_REQUIRED" },
				routing: { executor_class: "strong" },
				reasoning: { effort: "high" },
			} as never,
			lane: "compiler",
			prdWanted: true,
		});
		expect(line).toContain("/prd create");
	});
});
