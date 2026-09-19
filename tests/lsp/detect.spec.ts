/**
 * PRD-018 Phase 2 — AC-4 (against real detection results) and AC-5.
 *
 * The stripped-environment half is the negative control: it must change the
 * outcome, otherwise detection is not being consulted at all.
 */
import { afterEach, afterAll, describe, expect, it } from "vitest";
import { closeLspClients, detectServers, languageOfPath, lookupServer, lspSelectionOf, type DetectedServer } from "../../src/lsp/index.js";
import { bootSession, nativeBackend, writeConfig } from "../helpers/fixtures.js";
import { startStubBackend, type StubBackend } from "../helpers/stub-backend.js";
import { configFor, harness, lintOnlyRepo, taskPacket, tsRepo, type LspHarness } from "./harness.js";

let active: LspHarness | undefined;

afterEach(async () => {
	await active?.close();
	active = undefined;
});

afterAll(async () => {
	await closeLspClients();
});

const RENAME_REQUEST = "rename the exported greet symbol across the repository";
const RENAME_PACKET = taskPacket(RENAME_REQUEST);
const BUGFIX_REQUEST = "fix the wrong port constant in src/symbols.ts";
const BUGFIX_PACKET = taskPacket(BUGFIX_REQUEST);

/** PATH with nothing on it: no server can resolve, and the local bin dir is empty. */
const STRIPPED_ENV: NodeJS.ProcessEnv = { PATH: "" };

describe("PRD-018 Phase 2 — language-server detection and degradation", () => {
	it("AC-5: a resolvable server selects navigation; a stripped PATH degrades the same task to LSP_OFF", async () => {
		// Detection also probes the repository's own bin dir, so this fixture carries
		// its own server: availability is a property of the repository, not the machine.
		const repo = tsRepo();
		const detected = detectServers(repo.cwd);
		const typescript = detected.find((server: DetectedServer) => server.language === "typescript");
		expect(typescript).toMatchObject({ language: "typescript", source: "local-bin" });
		expect(lookupServer(repo.cwd, "typescript")).toMatchObject({ ok: true, server: { language: "typescript" } });

		active = await harness({ cwd: repo.cwd, lsp: { mode: "auto" }, jev: "enabled" });
		const navigated = await active.compile(RENAME_REQUEST, RENAME_PACKET);
		expect(lspSelectionOf(navigated)!.mode).toBe("LSP_NAVIGATION");
		await active.close();
		active = undefined;

		// Negative control: the same repository shape with no server reachable at all.
		const bare = tsRepo({}, undefined, { server: false });
		const unavailable = lookupServer(bare.cwd, "typescript", { env: STRIPPED_ENV });
		expect(unavailable.ok).toBe(false);
		expect(unavailable.ok ? "" : unavailable.reason).toContain('no language server for "typescript"');

		active = await harness({ cwd: bare.cwd, lsp: { mode: "auto" }, jev: "enabled", env: STRIPPED_ENV });
		const degraded = await active.compile(RENAME_REQUEST, RENAME_PACKET);
		expect(lspSelectionOf(degraded)!.mode).toBe("LSP_OFF");
		expect(lspSelectionOf(degraded)!.reason).toBe("no-server-for-changed-language");
		expect(degraded.capabilities.lsp).toBe(false);
	});

	it("AC-5: a session still completes its turn with no server and no unhandled rejection", async () => {
		const rejections: unknown[] = [];
		const onRejection = (reason: unknown) => rejections.push(reason);
		process.on("unhandledRejection", onRejection);
		let stub: StubBackend | undefined;
		try {
			stub = await startStubBackend([{ text: "done" }]);
			const repo = tsRepo({}, undefined, { server: false });
			writeConfig(repo.cwd, {
				backends: { local: nativeBackend(stub.baseUrl) },
				models: { balanced: { backend: "local", model: "stub-model" } },
			});
			const session = await bootSession({ cwd: repo.cwd });
			active = await harness({ cwd: repo.cwd, lsp: { mode: "auto" }, jev: "enabled", env: STRIPPED_ENV });
			const contract = await active.compile(RENAME_REQUEST, RENAME_PACKET);
			expect(lspSelectionOf(contract)!.mode).toBe("LSP_OFF");

			await session.runTurn(RENAME_REQUEST);
			expect(stub.requests.length).toBeGreaterThan(0);
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(rejections).toEqual([]);
			session.session.dispose();
		} finally {
			process.off("unhandledRejection", onRejection);
			await stub?.close();
		}
	});

	it("AC-4: the typecheck override and the diagnostics contrast hold against real detection", async () => {
		const withTypecheck = tsRepo();
		expect(detectServers(withTypecheck.cwd).some((server: DetectedServer) => server.language === "typescript")).toBe(true);
		active = await harness({ cwd: withTypecheck.cwd, lsp: { mode: "auto" }, jev: "enabled" });
		const targeted = await active.compile(BUGFIX_REQUEST, BUGFIX_PACKET);
		expect(lspSelectionOf(targeted)!.mode).toBe("LSP_OFF");
		expect(lspSelectionOf(targeted)!.targetedCheck?.kind).toBe("typecheck");
		expect(targeted.verification.required).toContain("typecheck");
		await active.close();
		active = undefined;

		const lintOnly = lintOnlyRepo();
		expect(detectServers(lintOnly.cwd).some((server: DetectedServer) => server.language === "typescript")).toBe(true);
		active = await harness({ cwd: lintOnly.cwd, lsp: { mode: "auto" }, jev: "enabled" });
		const diagnostics = await active.compile(BUGFIX_REQUEST, BUGFIX_PACKET);
		expect(lspSelectionOf(diagnostics)!.mode).toBe("LSP_DIAGNOSTICS");
		expect(lspSelectionOf(diagnostics)!.targetedCheck).toBeUndefined();
	});

	it("AC-5: an unavailable language is a reason, never a throw — and config overrides come first", async () => {
		const repo = tsRepo();
		const unknown = lookupServer(repo.cwd, "cobol");
		expect(unknown).toEqual({ ok: false, reason: 'no language server is defined for "cobol"' });

		// A configured override replaces the default command list and is still probed.
		const overridden = lookupServer(repo.cwd, "typescript", { config: configFor(repo.cwd, { servers: { typescript: process.execPath } }) });
		expect(overridden).toMatchObject({ ok: true, server: { command: process.execPath, source: "config" } });

		const brokenOverride = lookupServer(repo.cwd, "typescript", {
			config: configFor(repo.cwd, { servers: { typescript: "/nonexistent/greet-server" } }),
			env: STRIPPED_ENV,
		});
		expect(brokenOverride.ok).toBe(false);
		expect(brokenOverride.ok ? "" : brokenOverride.reason).toContain("/nonexistent/greet-server");

		expect(languageOfPath("src/app.ts")).toBe("typescript");
		expect(languageOfPath("README.md")).toBe("markdown");
		expect(languageOfPath("Makefile")).toBeNull();
	});
});
