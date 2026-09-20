/**
 * PRD-008 Phase 3 — E3: AC-4 (Claude), AC-5 (Codex), AC-6 (OpenCode) and
 * AC-7 (no credential crosses the LeanPi boundary).
 *
 * Everything runs against one stub CLI installed under three symlinks, so the
 * assertions are made on the argv, environment, schema and session id the
 * vendor process actually received.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BackendRegistry, runHarness, runWorkerTurn } from "../../src/backends/index.js";
import { loadConfig, createLeanPiSession } from "../../src/index.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fixtureRepo, nativeBackend, tempDir, writeConfig } from "../helpers/fixtures.js";
import { startStubBackend, type StubBackend } from "../helpers/stub-backend.js";
import { installStubCli, RESULT_SCHEMA, setStubScript, type StubCli } from "./helpers.js";

const OBJECTIVE = "create the requested file";

/** Every value in the recorded environment, for the "no added variable" check. */
function flattenEnv(env: Record<string, string | undefined>): string {
	return Object.entries(env)
		.map(([key, value]) => `${key}=${value ?? ""}`)
		.join("\n");
}

function filesUnder(root: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) found.push(...filesUnder(path));
		else if (statSync(path).isFile()) found.push(path);
	}
	return found;
}

function configFor(cli: StubCli, vendor: "claude" | "codex" | "opencode", extra: Record<string, unknown> = {}) {
	return {
		backends: {
			[vendor]: { type: "external_harness", command: cli.bin[vendor], roles: ["strong"], ...extra },
			// A native provider whose key must never reach the harness or session state.
			metered: nativeBackend("http://127.0.0.1:9/v1", { model: "cheap-fast", apiKey: "sk-secret-LEANPI-7f3a" }),
		},
		models: {
			strong: { backend: vendor, model: `${vendor}-model` },
			balanced: { backend: "metered", model: "cheap-fast" },
		},
	};
}

describe("PRD-008 Phase 3 — external harness workers", () => {
	it("AC-4: Claude runs non-interactively with a restricted tool set, a schema, and resumes its session", async () => {
		const cli = installStubCli();
		const { cwd } = fixtureRepo();
		writeConfig(cwd, configFor(cli, "claude"));
		const registry = new BackendRegistry(loadConfig(cwd));

		const packet = {
			objective: OBJECTIVE,
			role: "strong" as const,
			files: ["cli.txt"],
			outputSchema: RESULT_SCHEMA,
			allowedTools: ["read", "edit", "write"],
		};
		const restore = setStubScript(cli.recordPath, {
			requireSchema: true,
			files: { "cli.txt": "claude wrote this\n" },
			summary: "claude finished",
			structured: { status: "ok", files: ["cli.txt"] },
		});
		const first = await runWorkerTurn(packet, { registry, cwd });
		const afterFirst = readFileSync(join(cwd, "cli.txt"), "utf8");
		restore();
		const resume = setStubScript(cli.recordPath, {
			requireSchema: true,
			files: { "cli.txt": "claude wrote this again\n" },
			summary: "claude finished again",
			structured: { status: "ok", files: ["cli.txt"] },
		});
		const second = await runWorkerTurn({ ...packet, sessionId: first.result?.sessionId }, { registry, cwd });
		resume();

		const [one, two] = cli.records();
		expect(first.status).toBe("completed");
		expect(afterFirst).toBe("claude wrote this\n");
		expect(first.result?.changedFiles).toEqual(["cli.txt"]);
		expect(first.result?.sessionId).toBe("ses_claude_1");

		// The configured command, with the documented non-interactive flags.
		expect(one!.argv).toContain("-p");
		// Not `--bare`: with a subscription (OAuth) login it turns Anthropic auth off
		// — "strictly ANTHROPIC_API_KEY or apiKeyHelper (OAuth and keychain are never
		// read)" — and every call came back `Not logged in · Please run /login`.
		// Verified against the installed CLI. The context suppression `--bare`
		// bundled is kept through the flags that do not touch auth.
		expect(one!.argv).not.toContain("--bare");
		expect(one!.argv).toContain("--strict-mcp-config");
		expect(one!.argv).toContain("--disable-slash-commands");
		expect(one!.argv).toContain("--output-format");
		expect(one!.argv[one!.argv.indexOf("--output-format") + 1]).toBe("json");
		expect(one!.argv).toContain("--json-schema");
		expect(one!.argv[one!.argv.indexOf("--allowedTools") + 1]).toBe("Read,Edit,Write");
		// The schema the vendor was handed is the packet's schema.
		expect(one!.schema).toEqual(RESULT_SCHEMA);

		// The second attempt continues the vendor session rather than starting over.
		expect(one!.resumedFrom).toBeNull();
		expect(two!.resumedFrom).toBe("ses_claude_1");
		expect(two!.argv).toContain("--resume");
		expect(two!.argv[two!.argv.indexOf("--resume") + 1]).toBe("ses_claude_1");
		expect(second.result?.sessionId).toBe("ses_claude_1");
		expect(readFileSync(join(cwd, "cli.txt"), "utf8")).toBe("claude wrote this again\n");
	});

	it("AC-5: Codex runs with an explicit sandbox and output schema, and a schema violation is a worker failure", async () => {
		const cli = installStubCli();
		const { cwd } = fixtureRepo();
		writeConfig(cwd, configFor(cli, "codex"));
		const registry = new BackendRegistry(loadConfig(cwd));
		const packet = {
			objective: OBJECTIVE,
			role: "strong" as const,
			files: ["codex.txt"],
			outputSchema: RESULT_SCHEMA,
		};

		const restore = setStubScript(cli.recordPath, {
			requireSchema: true,
			files: { "codex.txt": "codex wrote this\n" },
			summary: "codex finished",
			structured: { status: "ok", files: ["codex.txt"] },
		});
		const outcome = await runWorkerTurn(packet, { registry, cwd });
		restore();

		const [record] = cli.records();
		expect(outcome.status).toBe("completed");
		expect(outcome.result?.changedFiles).toEqual(["codex.txt"]);
		expect(record!.argv[0]).toBe("exec");
		expect(record!.argv).toContain("--sandbox");
		expect(record!.argv[record!.argv.indexOf("--sandbox") + 1]).toBe("workspace-write");
		expect(record!.argv).toContain("--json");
		expect(record!.argv).toContain("--output-schema");
		// The stub read the schema file LeanPi staged, so the packet's schema reached it.
		expect(record!.schema).toEqual(RESULT_SCHEMA);

		// A reply that violates the schema is a failure, never an accepted result.
		const violating = setStubScript(cli.recordPath, {
			requireSchema: true,
			files: { "codex.txt": "codex wrote this again\n" },
			structured: { files: ["codex.txt"] },
		});
		const backend = registry.byName("codex")!;
		const violated = await runHarness(backend, packet, { cwd });
		violating();

		expect(violated).toMatchObject({ status: "failed", failure: "schema" });
		expect(violated.status === "failed" && violated.reason).toMatch(/missing required key "status"/);
	});

	it("AC-6: OpenCode runs with the configured model and agent, and continues its session", async () => {
		const cli = installStubCli();
		const { cwd } = fixtureRepo();
		writeConfig(cwd, configFor(cli, "opencode"));
		const registry = new BackendRegistry(loadConfig(cwd));
		const packet = {
			objective: OBJECTIVE,
			role: "strong" as const,
			files: ["oc.txt"],
			model: "anthropic/claude-haiku",
			agent: "build",
		};

		const restore = setStubScript(cli.recordPath, {
			requireModel: true,
			files: { "oc.txt": "opencode wrote this\n" },
			summary: "opencode finished",
		});
		const first = await runWorkerTurn(packet, { registry, cwd });
		restore();
		const resume = setStubScript(cli.recordPath, {
			requireModel: true,
			files: { "oc.txt": "opencode wrote this again\n" },
			summary: "opencode finished again",
		});
		const second = await runWorkerTurn({ ...packet, sessionId: first.result?.sessionId }, { registry, cwd });
		resume();

		const [one, two] = cli.records();
		expect(first.status).toBe("completed");
		expect(first.result?.changedFiles).toEqual(["oc.txt"]);
		expect(one!.argv[0]).toBe("run");
		expect(one!.argv[one!.argv.indexOf("--format") + 1]).toBe("json");
		expect(one!.argv[one!.argv.indexOf("--model") + 1]).toBe("anthropic/claude-haiku");
		expect(one!.argv[one!.argv.indexOf("--agent") + 1]).toBe("build");
		expect(two!.resumedFrom).toBe("ses_opencode_1");
		expect(two!.argv[two!.argv.indexOf("--session") + 1]).toBe("ses_opencode_1");
		expect(second.result?.sessionId).toBe("ses_opencode_1");
	});

	it("AC-7: no vendor credential crosses the LeanPi boundary", async () => {
		const cli = installStubCli();
		const stub: StubBackend = await startStubBackend([
			{ toolCalls: [{ name: "write", args: { path: "session.txt", content: "persisted\n" } }] },
			{ text: "wrote session.txt" },
		]);
		const { cwd, agentDir } = fixtureRepo();
		writeConfig(cwd, {
			backends: {
				claude: { type: "external_harness", command: cli.bin.claude, roles: ["strong"] },
				metered: { ...nativeBackend(stub.baseUrl, { model: "cheap-fast" }), apiKey: "sk-secret-LEANPI-7f3a" },
			},
			models: {
				strong: { backend: "claude", model: "claude-model" },
				balanced: { backend: "metered", model: "cheap-fast" },
			},
		});
		const config = loadConfig(cwd);
		const registry = new BackendRegistry(config);

		const restore = setStubScript(cli.recordPath, { files: { "cli.txt": "claude\n" } });
		const spawnEnv = { ...process.env };
		const outcome = await runWorkerTurn({ objective: OBJECTIVE, role: "strong", files: ["cli.txt"] }, { registry, cwd });
		restore();

		const [record] = cli.records();
		expect(outcome.status).toBe("completed");
		// (a) The child environment is the parent's environment at spawn time,
		// verbatim: no variable added, none dropped by LeanPi.
		expect(record!.env).toEqual(spawnEnv);
		// (b) No key, token or secret material in the argv.
		expect(record!.argv.join(" ")).not.toMatch(/sk-[A-Za-z0-9]|api[_-]?key|token|bearer|secret/i);
		expect(flattenEnv(record!.env)).not.toContain("sk-secret-LEANPI-7f3a");

		// (c) A config carrying a native provider's key persists nothing either: the
		// live session writes its transcript to disk and the key is absent from it.
		const sessionDir = tempDir("leanpi-sessions-");
		const manager = SessionManager.create(cwd, sessionDir);
		const session = await createLeanPiSession({ cwd, agentDir, config, sessionManager: manager });
		await session.runTurn({ text: "write the file", role: "balanced" });
		const sessionFile = manager.getSessionFile();
		session.session.dispose();
		await stub.close();

		expect(sessionFile).toBeDefined();
		expect(readFileSync(sessionFile as string, "utf8")).not.toContain("sk-secret-LEANPI-7f3a");
		const persisted = [...filesUnder(sessionDir), ...filesUnder(agentDir)].filter((path) => statSync(path).isFile());
		expect(persisted.length).toBeGreaterThan(0);
		for (const path of persisted) expect(readFileSync(path, "utf8")).not.toContain("sk-secret-LEANPI-7f3a");
	});
});
