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
import {
	ARTIFACT_TOOL_NAME,
	LEANPI_VERSION,
	LSP_TOOL_NAMES,
	PACKAGE_ROOT,
	TODO_ADD_TOOL_NAME,
	TODO_UPDATE_TOOL_NAME,
	clearLanes,
	listLanes,
	registerLane,
	writeUserDefault,
} from "../src/index.js";
import { boundedCommand, COMMAND_TIMEOUT_SECONDS_DEFAULT } from "../src/core/tools.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
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
		const entry = join(PACKAGE_ROOT, "dist/leanpi.js");
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
			// Registered is not active: PRD-018's seven LSP tools are in the registry
			// so a turn's mode can expose its group, and PRD-025's `todo_add` /
			// `todo_update` pair is registered for the session while the list they
			// write costs bytes only once it has items. The session boots with the
			// five baseline names active (asserted through `activation.tools` above
			// and by AC-2 below).
			expect([...loaded.extensions[0]!.tools.keys()].sort()).toEqual(
				["edit", "execute", "read", "search", "write", ARTIFACT_TOOL_NAME, TODO_ADD_TOOL_NAME, TODO_UPDATE_TOOL_NAME, ...LSP_TOOL_NAMES].sort(),
			);
		} finally {
			delete process.env.LEANPI_CWD;
		}
		await stub.close();
		// This test runs `tsc` itself, which on a cold, loaded CI runner exceeds the
		// 30s default; the budget is for the build, not for a hang.
	}, 120_000);

	it("AC-1: a second boot of one configuration supersedes the first boot's lanes", async () => {
		// The bench boots a fresh session per task in one process. Appended rather
		// than replaced, the second boot's turn would run two compiler lanes and the
		// first boot's lane would compile against the first task's workspace.
		stub = await startStubBackend([{ text: "hello" }]);
		const { cwd, agentDir } = fixtureRepo();
		writeConfig(cwd, {
			backends: { local: nativeBackend(stub.baseUrl) },
			models: { balanced: { backend: "local", model: "cheap-fast" } },
		});

		const first = await bootSession({ cwd, agentDir });
		expect(listLanes().map((lane) => lane.name)).toEqual(["compiler", "tool-surface", "executor"]);
		// A lane the caller registered by hand is not LeanPi's to replace.
		registerLane({ name: "probe", run: () => {} });
		const second = await bootSession({ cwd, agentDir });
		expect(listLanes().map((lane) => lane.name)).toEqual(["probe", "compiler", "tool-surface", "executor"]);

		first.session.dispose();
		second.session.dispose();
		await stub.close();
	});

	it("bounds a shell command the model did not bound (PRD-001 §44)", async () => {
		// Pi's `execute` schema makes `timeout` optional with no default, so an
		// unbounded command can hang the turn: measured, one `npx eslint … && npm
		// test` sat 14 minutes with zero CPU and voided a bench run.
		const seen: Array<Record<string, unknown>> = [];
		const inner = {
			name: "execute",
			label: "execute",
			description: "",
			parameters: {},
			execute: async (_id: string, params: Record<string, unknown>) => {
				seen.push(params);
				return { content: [] };
			},
		} as unknown as ToolDefinition;
		await boundedCommand(inner).execute("call-1", { command: "npx eslint ." } as never, undefined, undefined, {} as never);
		await boundedCommand(inner).execute("call-2", { command: "sleep 1", timeout: 30 } as never, undefined, undefined, {} as never);

		expect(seen[0]).toMatchObject({ command: "npx eslint .", timeout: COMMAND_TIMEOUT_SECONDS_DEFAULT });
		// A model that named a bound keeps it.
		expect(seen[1]).toMatchObject({ timeout: 30 });
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

		// Every request offered the five baseline tools plus PRD-014's expand
		// affordance, which the tool-output pipeline needs whenever it can turn a
		// large result into an `artifact://` reference. The LSP group stays
		// inactive; the pi-subagents parent tools are active once attached.
		expect(stub.requests).toHaveLength(6);
		for (const request of stub.requests) {
			expect(toolNamesOf(request.body)).toEqual(["artifact", "bg_wait", "edit", "execute", "read", "search", "subagent", "write"]);
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
