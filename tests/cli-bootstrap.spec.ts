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
import { autoConfigure, jevWarning, missingBackendKeys, requireJev, sessionModelFor, startupBanner, unusableBackendKeys } from "../src/cli/bootstrap.js";
import { allocateRoles, candidateKey, detectModels, ladderAllocation, VENDOR_DEFAULT, type ModelCandidate } from "../src/cli/allocate.js";
import { MODEL_ROLES } from "../src/core/types.js";
import type { JevResult } from "../src/jev/types.js";
import { HARNESS_DESCRIPTORS, runHarness } from "../src/backends/harness.js";
import { launchPlan, parseLeanPiFlags } from "../src/cli/launch.js";
import { statusLine } from "../src/cli/statusline.js";
import { probeVendor } from "../src/backends/subscriptions.js";
import { openPrdLane } from "../src/prd/dispatch.js";
import { activate, clearLanes } from "../src/index.js";
import { loadConfig } from "../src/core/config.js";

/** A machine with the vendor CLIs installed and logged in. */
function machine(options: { vendors: readonly string[]; signedIn?: boolean }): { cwd: string; home: string; env: NodeJS.ProcessEnv } {
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
	// that is what detection now asks. `signedIn: false` is the other real state:
	// installed, with a credential file, and the CLI itself saying no.
	const signedIn = options.signedIn ?? true;
	const status: Record<string, string> = signedIn
		? {
				claude: '{"loggedIn": true}',
				codex: "Logged in using ChatGPT",
				// `opencode auth list` for the status probe, `opencode models` for the
				// candidate list: the stub answers both the way the real CLI does.
				opencode: '{"loggedIn": true}\n1 credentials\nopencode-go/deepseek-v4.1-flash',
			}
		: { claude: '{"loggedIn": false}', codex: "Not logged in", opencode: "0 credentials" };
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
		const result = await autoConfigure({ cwd, home, env, client, piReady: () => false });

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

		await autoConfigure({ cwd, home, env, client: jevPicking(() => "codex:gpt-6-astra"), piReady: () => false });

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

	it("names every candidate and the command that would fix it, instead of one verdict", async () => {
		const { cwd, home, env } = machine({ vendors: [] });

		const result = await autoConfigure({ cwd, home, env });

		expect(result.created).toBe(false);
		// One row per thing that could have run the turn: three vendors and Pi
		// itself. The old summary collapsed all four into "no vendor CLI on this
		// machine is both installed and signed in", which is the same sentence
		// for an empty machine and for one with Claude installed and signed out.
		for (const vendor of ["claude", "codex", "opencode"]) expect(result.summary).toContain(`${vendor}: not installed`);
		expect(result.summary).toContain("pi auth login");
	});

	it("tells a signed-out vendor apart from a missing one, and names its login command", async () => {
		const { cwd, home, env } = machine({ vendors: ["claude"], signedIn: false });

		const result = await autoConfigure({ cwd, home, env });

		expect(result.summary).toContain("claude: installed but signed out — run `claude /login`");
		expect(result.summary).toContain("codex: not installed");
	});
});

describe("the control plane is optional, and says so", () => {
	it("starts with no JEV key and reports it as not configured", () => {
		const { cwd, home, env } = machine({ vendors: ["codex"] });

		expect(requireJev({ cwd, home, env }).source).toBe("not configured");
	});

	it("warns with the cost and every way to set a key when none is configured", () => {
		const warning = jevWarning("not configured");

		expect(warning).not.toBeNull();
		const text = warning?.join("\n") ?? "";
		expect(text).toContain("spends more tokens");
		expect(text).toContain("typesafe.ai");
		expect(text).toContain("--jev-key");
		expect(text).toContain("JEV_API_KEY");
		expect(text).toContain("/jev key set");
	});

	it("stays silent when a key is resolved", () => {
		expect(jevWarning("configured (source: credential store)")).toBeNull();
	});

	it("stays silent for the deliberate opt-outs", () => {
		expect(jevWarning("not configured (--no-jev)")).toBeNull();
		expect(jevWarning("disabled (jev.mode)")).toBeNull();
	});

	it("accepts the key the user configured in leanpi.config.yaml", () => {
		// `config.jev.apiKey` is the first source `resolveCredential` checks, and
		// the startup gate used to read a synthetic config instead — refusing a
		// configured operator with "LeanPi needs a JEV key".
		const { cwd, home, env } = machine({ vendors: ["codex"] });
		writeFileSync(
			join(cwd, "leanpi.config.yaml"),
			["backends:", "  codex: { type: external_harness, vendor: codex }", "models:", "  quick:", "    backend: codex", "    model: gpt-6-astra", "jev:", "  apiKey: jev-from-config", ""].join("\n"),
		);

		expect(requireJev({ cwd, home, env }).source).toContain("config");
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

describe("what Pi's own loop can run", () => {
	it("writes the OpenCode subscription as a native provider when Pi already has that credential", async () => {
		// Pi's own loop answers the user on the `--extension` entry, and it can dial
		// a provider but cannot spawn a vendor CLI: with only CLI backends the loop
		// falls back to whatever provider Pi happens to find, which on this machine
		// was an unrelated endpoint whose first reply was a bare `429`.
		const { cwd, home, env } = machine({ vendors: ["opencode"] });

		const result = await autoConfigure({
			cwd,
			home,
			env,
			piReady: (provider) => provider === "opencode-go",
			client: jevPicking(() => "opencode-go:deepseek-v4.1-flash"),
		});

		const written = readFileSync(result.path, "utf8");
		expect(written).toContain("type: native");
		expect(written).toContain("baseUrl: https://opencode.ai/zen/go/v1");
		// The dialect and session facts that decide the bill and whether the
		// endpoint answers at all travel with it.
		expect(written).toContain("thinkingFormat: deepseek");
		expect(written).toMatch(/x-opencode-session: [0-9a-f-]{36}/);
		expect(written).not.toContain("vendor: opencode\n");

		const config = loadConfig(cwd, {}, env);
		expect(sessionModelFor(config)).toBe("opencode-go/deepseek-v4.1-flash");
		// The banner says who answers the prompt, because Pi's loop is not the
		// role map.
		// The banner names the model that answers, not the backend path to it:
		// `/status` owns role bindings, reasoning level and cost.
		expect(startupBanner(config, { source: "env" }, sessionModelFor(config))).toContain("deepseek-v4.1-flash");
	});

	it("passes no model to Pi when the role says `default`, which a native provider cannot mean", () => {
		// `default` means "let the vendor CLI choose" and a native provider has no
		// CLI: passed through, Pi registers `default` as a model id and the
		// endpoint answers `400 Model is unavailable`.
		const config = {
			backends: { "opencode-go": { type: "native", baseUrl: "https://example.test" } },
			models: { balanced: { backend: "opencode-go", model: VENDOR_DEFAULT } },
		} as never;

		expect(sessionModelFor(config)).toBeUndefined();
		expect(startupBanner(config, { source: "env" }, undefined)).toContain("pi's own model");
	});

	it("passes that model to Pi, and never overrides a model the user asked for", () => {
		const root = mkdtempSync(join(tmpdir(), "leanpi-launch-"));
		mkdirSync(join(root, "dist"), { recursive: true });
		writeFileSync(join(root, "dist", "leanpi.js"), "");
		mkdirSync(join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle"), { recursive: true });
		writeFileSync(join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"), "");

		expect(launchPlan([], root, "opencode-go/flash").args).toContain("opencode-go/flash");
		expect(launchPlan(["--model", "mine/own"], root, "opencode-go/flash").args.filter((argument) => argument === "--model")).toHaveLength(1);
		// A CLI-only config has nothing Pi can dial; the launcher says nothing.
		expect(launchPlan([], root).args).not.toContain("--model");
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
		// `env` explicitly, both ways: the `--bare` branch keys off
		// `ANTHROPIC_API_KEY`, and reading it from the ambient environment makes
		// this assertion pass or fail depending on the developer's shell.
		const claude = HARNESS_DESCRIPTORS.claude.argv({
			packet: { objective: "x", role: "strong", model: "opus", effort: "high" },
			prompt: "do it",
			env: {},
		} as never);
		const withKey = HARNESS_DESCRIPTORS.claude.argv({
			packet: { objective: "x", role: "strong", model: "opus" },
			prompt: "do it",
			env: { ANTHROPIC_API_KEY: "sk-test" },
		} as never);
		// With an API key `--bare` is safe and is the stronger suppression; with a
		// subscription login it disables OAuth and the backend is dead.
		expect(withKey).toContain("--bare");
		expect(claude).toContain("--model");
		expect(claude[claude.indexOf("--model") + 1]).toBe("opus");

		const codex = HARNESS_DESCRIPTORS.codex.argv({
			packet: { objective: "x", role: "quick", model: "gpt-6-astra", effort: "low" },
			prompt: "do it",
			env: {},
		} as never);
		expect(codex[codex.indexOf("--model") + 1]).toBe("gpt-6-astra");
		expect(codex).toContain('model_reasoning_effort="low"');
		// Codex refuses to run outside a trusted directory without this, and every
		// worker invocation exited 1 before reaching the model.
		expect(codex).toContain("--skip-git-repo-check");

		// `--allowedTools` is variadic: a prompt placed after it is read as one more
		// tool name and Claude exits with "Input must be provided …". Verified
		// against the installed CLI; `--` is what ends option parsing.
		const separator = claude.indexOf("--");
		expect(separator).toBeGreaterThan(claude.indexOf("--allowedTools"));
		expect(claude[separator + 1]).toBe("do it");
		expect(claude[claude.length - 1]).toBe("do it");
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
			verification: { required: ["test"] },
		} as never;

		const line = statusLine({ config, contract, lane: "executor" });

		// The vendor's bracket alias is not a model name a human reads, and the
		// line names no internal lane: "Executor lane" is a word the operator
		// cannot act on. The lane's one visible consequence is the /verify chip.
		expect(line).toBe("opus (1m)  ·  thinking: medium  ·  normal task");
	});

	it("colours the model and the effort only when asked, so the plain line stays plain", () => {
		const config = { backends: {}, models: {} } as never;
		const mk = (effort: string, color?: boolean) =>
			statusLine({
				config,
				contract: { task: { execution_complexity: "LOW" }, routing: { executor_class: "quick" }, reasoning: { effort }, verification: { required: [] } } as never,
				lane: "executor",
				...(color === undefined ? {} : { color }),
			});
		// Measured, not assumed: Pi's `setStatus` passes the string to the TUI
		// verbatim, so an escape written here reaches the terminal.
		expect(mk("low", true)).toContain("\u001b[1mquick\u001b[0m");
		// Effort is a green-to-red ramp, so the number is readable as a cost.
		expect(mk("low", true)).toContain("\u001b[38;5;77m");
		expect(mk("medium", true)).toContain("\u001b[38;5;221m");
		expect(mk("high", true)).toContain("\u001b[38;5;208m");
		expect(mk("max", true)).toContain("\u001b[38;5;196m");
		// A caller that did not ask gets text it can compare as text.
		expect(mk("low")).not.toContain("\u001b");
		expect(mk("low")).toBe("quick  ·  thinking: low  ·  simple task");
	});

	it("names the role when the config has no model for it, instead of throwing mid-turn", () => {
		const config = { backends: {}, models: {} } as never;
		const contract = { task: { execution_complexity: "LOW" }, routing: { executor_class: "quick" }, reasoning: { effort: "low" }, verification: { required: [] } } as never;

		expect(statusLine({ config, contract, lane: "pi_loop" })).toContain("quick");
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
		// "Not logged in" contains "logged in": the naive matcher read a logged-out
		// Codex as signed in and wrote a config routing every role at it.
		expect(probeVendor("codex", { env, home, verify: true, run: () => "Not logged in\n" }).signedIn).toBe(false);
	});

	it("says \"could not ask\" — not \"signed out\" — when the CLI answers with something else", () => {
		// Measured here: a second, newer `codex` on PATH printed `Error loading
		// configuration: …/config.toml:475:1: invalid type: map` while that
		// account was live, and detection dropped a paid subscription. An answer
		// that is neither shape is not an answer, so the credential file decides.
		const { home, env } = machine({ vendors: ["codex", "claude"] });

		const codex = probeVendor("codex", { env, home, verify: true, run: () => "Error loading configuration: config.toml:475:1: invalid type: map" });
		expect(codex.signedIn).toBe(true);
		expect(codex.evidence).toContain("auth.json");

		const claude = probeVendor("claude", { env, home, verify: true, run: () => "panic: something else entirely" });
		expect(claude.signedIn).toBe(true);
		expect(claude.evidence).toContain(".credentials.json");
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
				verification: { required: [] },
			} as never,
			lane: "pi_loop",
			prdWanted: true,
		});
		expect(line).toContain("/prd create");
	});
});

describe("the status line reaches the footer", () => {
	it("is installed by the turn handler, naming the model Pi was actually given", async () => {
		// The renderer had tests; nothing asserted the extension ever calls
		// `ctx.ui.setStatus`, so deleting the call would have been invisible.
		const { cwd, home, env } = machine({ vendors: [] });
		writeFileSync(
			join(cwd, "leanpi.config.yaml"),
			[
				"backends:",
				"  local: { type: native, baseUrl: https://example.test, apiKey: LOCAL_KEY }",
				"  claude: { type: external_harness, vendor: claude }",
				"models:",
				"  quick:",
				"    backend: local",
				"    model: cheap",
				"  balanced:",
				"    backend: local",
				"    model: cheap",
				"  strong:",
				"    backend: claude",
				"    model: opus",
				"jev:",
				"  mode: disabled",
				"",
			].join("\n"),
		);
		const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
		const statuses: Array<[string, string | undefined]> = [];
		const pi = {
			on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => handlers.set(event, handler),
			registerTool: () => {},
			registerCommand: () => {},
			registerProvider: () => {},
			setModel: async () => {},
			setThinkingLevel: () => {},
		};
		clearLanes();
		activate(pi as never, { cwd, config: loadConfig(cwd, {}, env), env: { ...env, HOME: home } });

		const handler = handlers.get("before_agent_start");
		expect(handler).toBeDefined();
		await handler?.(
			{ prompt: "rename the helper in src/target.ts", systemPrompt: "you are an assistant" },
			{
				// Pi has no model for the `strong` class here — it is a vendor CLI —
				// so `setModel` is skipped and Pi keeps running the session model.
				modelRegistry: { find: (backend: string) => (backend === "local" ? { id: "cheap" } : undefined) },
				ui: { setStatus: (key: string, text: string | undefined) => statuses.push([key, text]) },
			},
		);
		clearLanes();

		const [entry] = statuses;
		expect(entry?.[0]).toBe("leanpi");
		expect(entry?.[1]).toMatch(/thinking: /);
		expect(entry?.[1]).toMatch(/ task/);
		// Never the class's model when Pi was not given it: with JEV disabled the
		// fallback route is what runs, and the line has to name what Pi will dial.
		expect(entry?.[1]).not.toContain("opus");
	});
});

describe("a credential the config names and the shell does not have", () => {
	it("is reported by name instead of surfacing as `401 Invalid API key`", () => {
		// What the user hit: `apiKey: OPENCODE_API_KEY` in a shell that does not
		// export it. Pi 0.85 reads a bare name as a *literal key*, so the provider
		// answered `401 {"type":"AuthError","message":"Invalid API key."}` — which,
		// right after `leanpi --jev-key`, reads as a verdict on the key they just
		// set. The variable was never the JEV key.
		const config = {
			backends: {
				"opencode-go": { type: "native", baseUrl: "https://example.test", apiKey: "OPENCODE_API_KEY" },
				claude: { type: "external_harness", vendor: "claude" },
			},
			models: { balanced: { backend: "opencode-go", model: "flash" } },
		} as never;

		expect(missingBackendKeys(config, {})).toEqual([{ backend: "opencode-go", variable: "OPENCODE_API_KEY" }]);
		// Set: nothing to report.
		expect(missingBackendKeys(config, { OPENCODE_API_KEY: "sk-test" })).toEqual([]);
		// Pi's own syntax is Pi's to resolve and Pi's to complain about.
		const piSyntax = { backends: { p: { type: "native", baseUrl: "https://x.test", apiKey: "$SOME_VAR" } }, models: {} } as never;
		expect(missingBackendKeys(piSyntax, {})).toEqual([]);
	});

	it("warns about a missing key only when Pi cannot cover the provider itself", () => {
		const config = { backends: { "opencode-go": { type: "native", baseUrl: "https://x.test", apiKey: "OPENCODE_API_KEY" } }, models: {} } as never;
		// The variable is unset either way — that is the question `missingBackendKeys`
		// answers, and it is not on its own a problem.
		expect(missingBackendKeys(config, {})).toHaveLength(1);
		// Pi's own credential store already has the provider: the request will
		// succeed, so saying anything is a false alarm. This one printed on every
		// single launch above a session that then worked perfectly.
		expect(unusableBackendKeys(config, {}, () => true)).toEqual([]);
		// Nothing can authenticate it: now the 401 is coming and the name of the
		// variable is the actionable thing to say.
		expect(unusableBackendKeys(config, {}, () => false)).toEqual([{ backend: "opencode-go", variable: "OPENCODE_API_KEY" }]);
	});

	it("registers no key at all rather than the variable's name, so Pi can use its own credential", async () => {
		const registered: Array<Record<string, unknown>> = [];
		const pi = {
			on: () => {},
			registerTool: () => {},
			registerCommand: () => {},
			registerProvider: (_name: string, provider: Record<string, unknown>) => registered.push(provider),
			setModel: async () => {},
			setThinkingLevel: () => {},
		};
		const { cwd, home, env } = machine({ vendors: [] });
		writeFileSync(
			join(cwd, "leanpi.config.yaml"),
			[
				"backends:",
				"  local: { type: native, baseUrl: https://example.test, apiKey: ABSENT_VAR }",
				"models:",
				"  balanced:",
				"    backend: local",
				"    model: cheap",
				"jev:",
				"  mode: disabled",
				"",
			].join("\n"),
		);
		clearLanes();
		activate(pi as never, { cwd, config: loadConfig(cwd, {}, env), env: { ...env, HOME: home } });
		clearLanes();

		expect(registered).toHaveLength(1);
		// Never the literal name: that is what produced the 401.
		expect(registered[0]?.apiKey).toBeUndefined();
	});
});
