/**
 * PRD-001 Phase 1 — AC-1 and AC-2.
 *
 * The spec boots a real Pi session through the real SDK; it never imports
 * `activate` to call it by hand, so a registration that only works in tests
 * cannot pass.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	DefaultResourceLoader,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LEANPI_VERSION, PACKAGE_ROOT, clearLanes, listLanes, registerLane, writeUserDefault } from "../src/index.js";
import { bootSession, fixtureRepo, nativeBackend, systemText, tempDir, toolNamesOf, writeConfig } from "./helpers/fixtures.js";
import { startStubBackend, type StubBackend, type StubStep } from "./helpers/stub-backend.js";

const DRIVE_FIVE_TOOLS: StubStep[] = [
	{ toolCalls: [{ name: "write", args: { path: "a.txt", content: "one\ntwo\nthree\n" } }] },
	{ toolCalls: [{ name: "search", args: { pattern: "two" } }] },
	{ toolCalls: [{ name: "read", args: { path: "a.txt" } }] },
	{ toolCalls: [{ name: "edit", args: { path: "a.txt", edits: [{ oldText: "two", newText: "TWO" }] } }] },
	{ toolCalls: [{ name: "execute", args: { command: "cat a.txt" } }] },
	{ text: "done" },
];

function lastToolMessage(body: Record<string, unknown>): string {
	const messages = (body.messages ?? []) as Array<{ role?: string; content?: unknown }>;
	const toolMessages = messages.filter((message) => message.role === "tool");
	return JSON.stringify(toolMessages);
}

describe("PRD-001 Phase 1 — bootstrap and the baseline tool surface", () => {
	let stub: StubBackend;

	beforeEach(() => {
		clearLanes();
	});

	afterEach(async () => {
		clearLanes();
		await stub?.close();
	});

	it("AC-1: a booted LeanPi session reports the extension name and package version", async () => {
		stub = await startStubBackend([{ text: "hello" }]);
		const { cwd, agentDir } = fixtureRepo();
		writeConfig(cwd, {
			backends: { local: nativeBackend(stub.baseUrl) },
			models: { balanced: { backend: "local", model: "cheap-fast" } },
		});

		const session = await bootSession({ cwd, agentDir });
		expect(session.leanpi.name).toBe("leanpi");
		expect(session.leanpi.version).toBe(LEANPI_VERSION);
		expect(session.activation.config.models.balanced).toEqual({ backend: "local", model: "cheap-fast" });
		expect(session.activation.tools.sort()).toEqual(["edit", "execute", "read", "search", "write"]);

		// Negative control: the same boot without the extension registers no LeanPi surface.
		const bareDir = tempDir("leanpi-agent-");
		const services = await createAgentSessionServices({ cwd, agentDir: bareDir });
		const { session: bare } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(),
			noTools: "builtin",
		});
		expect(services.resourceLoader.getExtensions().extensions).toHaveLength(0);

		session.session.dispose();
		bare.dispose();
		await stub.close();
	});

	it("AC-1: the built extension loads through Pi's own extension loader", async () => {
		stub = await startStubBackend([{ text: "hello" }]);
		const tsc = join(PACKAGE_ROOT, "node_modules/.bin/tsc");
		execFileSync(tsc, ["-p", "tsconfig.json"], { cwd: PACKAGE_ROOT, stdio: "pipe" });
		const entry = join(PACKAGE_ROOT, "dist/index.js");
		expect(existsSync(entry)).toBe(true);

		const { cwd } = fixtureRepo();
		writeConfig(cwd, {
			backends: { local: nativeBackend(stub.baseUrl) },
			models: { balanced: { backend: "local", model: "cheap-fast" } },
		});
		process.env.LEANPI_CWD = cwd;
		try {
			const loader = new DefaultResourceLoader({ cwd, agentDir: tempDir("leanpi-agent-"), additionalExtensionPaths: [entry] });
			await loader.reload();
			const loaded = loader.getExtensions();
			expect(loaded.errors).toEqual([]);
			expect(loaded.extensions).toHaveLength(1);
			expect(loaded.extensions[0]!.resolvedPath).toBe(entry);
			expect([...loaded.extensions[0]!.tools.keys()].sort()).toEqual(["edit", "execute", "read", "search", "write"]);
		} finally {
			delete process.env.LEANPI_CWD;
		}
		await stub.close();
	});

	it("AC-2: an executor turn driven through runTurn() uses all five baseline tools", async () => {
		stub = await startStubBackend(DRIVE_FIVE_TOOLS);
		const { cwd, agentDir } = fixtureRepo();
		writeConfig(cwd, {
			backends: { local: nativeBackend(stub.baseUrl) },
			models: { balanced: { backend: "local", model: "cheap-fast" } },
		});
		// PRD-017's guard defaults `shell` to ask, which a non-interactive session
		// cannot answer. The fixture is the user's own project, so the user scope
		// allows it explicitly — the same grant a real user makes once.
		const env = { XDG_CONFIG_HOME: tempDir("leanpi-xdg-"), HOME: tempDir("leanpi-home-") };
		writeUserDefault("shell", "allow", env);
		writeUserDefault("edit", "allow", env);

		const session = await bootSession({ cwd, agentDir, env });
		let probeFired = 0;
		registerLane({
			name: "probe",
			run: () => {
				probeFired += 1;
			},
		});
		expect(listLanes().map((lane) => lane.name)).toContain("probe");

		const context = await session.runTurn({ text: "drive all five tools", role: "balanced" });

		// The turn reached the executor through runTurn(), not a test-only path.
		expect(probeFired).toBe(1);
		expect(context.modelRef).toEqual({ backend: "local", model: "cheap-fast", type: "native" });

		// Every request offered exactly the five baseline tools.
		expect(stub.requests).toHaveLength(6);
		for (const request of stub.requests) {
			expect(toolNamesOf(request.body)).toEqual(["edit", "execute", "read", "search", "write"]);
		}

		// write → search → read → edit → execute, each observed at the next request.
		expect(stub.requests[1]!.body.messages).toBeDefined();
		expect(lastToolMessage(stub.requests[1]!.body)).toContain("a.txt");

		// The edited bytes reached the executor: the execute tool's output carried them.
		const finalToolText = lastToolMessage(stub.requests[5]!.body);
		expect(finalToolText).toContain("one\\nTWO\\nthree");

		expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("one\nTWO\nthree\n");
		expect(systemText(stub.requests[0]!.body)).toContain("ponytail@");

		session.session.dispose();
	});
});
