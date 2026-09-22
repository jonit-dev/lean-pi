/**
 * PRD-041 Phase 1 — the package is attached and its parent tools are reachable
 * through the real SDK session (AC-1, AC-2).
 *
 * Nothing here mocks the session: `createLeanPiSession` boots Pi with the real
 * `subagentsFactory`, and the assertions read the tools Pi actually activated.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLeanPiSession } from "../../src/index.js";
import { SUBAGENTS_DEFAULT_CONCURRENCY_LIMIT, subagentConfigPath } from "../../src/subagents/index.js";
import { LSP_TOOL_NAMES } from "../../src/lsp/index.js";
import { FIVE_TOOLS, fixtureRepo, nativeBackend, tempDir, writeConfig } from "../helpers/fixtures.js";
import { startStubBackend, type StubBackend } from "../helpers/stub-backend.js";

describe("pi-subagents is attached to the real SDK session (AC-1, AC-2)", () => {
	let native: StubBackend;
	let cwd: string;
	let agentDir: string;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

	beforeAll(async () => {
		native = await startStubBackend([{ text: "ok" }]);
		const repo = fixtureRepo();
		cwd = repo.cwd;
		agentDir = repo.agentDir;
		// Upstream resolves its config directory from the process environment, so
		// the session's config write and upstream's read must agree.
		process.env.PI_CODING_AGENT_DIR = agentDir;
		writeConfig(cwd, {
			backends: { local: nativeBackend(native.baseUrl) },
			models: {
				quick: { backend: "local", model: "cheap-fast" },
				balanced: { backend: "local", model: "cheap-fast" },
				strong: { backend: "local", model: "cheap-fast" },
			},
			jev: { mode: "disabled" },
		});
	});

	afterAll(async () => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await native.close();
	});

	it("activates subagent and bg_wait through the real session and keeps LSP inactive", async () => {
		const session = await createLeanPiSession({ cwd, agentDir });
		try {
			const active = session.session.getActiveToolNames();
			for (const name of FIVE_TOOLS) expect(active, `${name} missing`).toContain(name);
			expect(active).toContain("subagent");
			expect(active).toContain("bg_wait");
			// The package's on-demand supervisor tool is admitted but not registered
			// yet, so it is not active — and never force-activated by name.
			expect(active).not.toContain("subagent_supervisor");
			for (const name of LSP_TOOL_NAMES) expect(active, `${name} must stay inactive`).not.toContain(name);
		} finally {
			session.session.dispose();
		}
	});

	it("writes the operator default before the session starts", async () => {
		const session = await createLeanPiSession({ cwd, agentDir });
		try {
			const config = JSON.parse(readFileSync(subagentConfigPath(agentDir), "utf8"));
			expect(config.globalConcurrencyLimit).toBe(SUBAGENTS_DEFAULT_CONCURRENCY_LIMIT);
		} finally {
			session.session.dispose();
		}
	});

	it("uses upstream's global config without changing the environment or writing a shadow SDK config", async () => {
		const globalDir = tempDir("leanpi-global-agent-");
		const sdkDir = tempDir("leanpi-sdk-agent-");
		process.env.PI_CODING_AGENT_DIR = globalDir;
		const session = await createLeanPiSession({ cwd, agentDir: sdkDir });
		try {
			expect(process.env.PI_CODING_AGENT_DIR).toBe(globalDir);
			expect(existsSync(subagentConfigPath(globalDir))).toBe(true);
			expect(JSON.parse(readFileSync(subagentConfigPath(globalDir), "utf8")).globalConcurrencyLimit).toBe(3);
			expect(existsSync(subagentConfigPath(sdkDir))).toBe(false);
		} finally {
			session.session.dispose();
			process.env.PI_CODING_AGENT_DIR = agentDir;
		}
	});

	it("does not register upstream when its global config is malformed", async () => {
		const globalDir = tempDir("leanpi-invalid-agent-");
		const path = subagentConfigPath(globalDir);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, "{broken");
		process.env.PI_CODING_AGENT_DIR = globalDir;
		const session = await createLeanPiSession({ cwd, agentDir: tempDir("leanpi-sdk-agent-") });
		try {
			expect(session.session.getActiveToolNames()).not.toContain("subagent");
			expect(readFileSync(path, "utf8")).toBe("{broken");
		} finally {
			session.session.dispose();
			process.env.PI_CODING_AGENT_DIR = agentDir;
		}
	});
});
