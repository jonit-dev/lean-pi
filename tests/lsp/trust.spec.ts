/**
 * SURF-3: an untrusted project cannot make LeanPi spawn an executable through
 * its `lsp` block, and it cannot smuggle one through the built-in probe of the
 * project's own `node_modules/.bin`. A trusted project keeps both, and a server
 * installed on the machine's PATH stays available either way.
 */
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { closeLspClients, detectServers, getClient, grantTrust, loadConfig, lookupServer, lspProcessStats } from "../../src/index.js";
import { nativeBackend, tempDir, writeConfig } from "../helpers/fixtures.js";

/** A harmless executable that would be spawned if detection selected it. */
function writeStubServer(path: string): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
	chmodSync(path, 0o755);
}

function localBinRepo(): string {
	const cwd = tempDir("leanpi-lsp-trust-");
	writeStubServer(join(cwd, "node_modules/.bin/typescript-language-server"));
	return cwd;
}

function configWithServer(cwd: string, server: string): void {
	writeConfig(cwd, {
		backends: { local: nativeBackend("http://127.0.0.1:1/v1") },
		models: { balanced: { backend: "local", model: "stub-model" } },
		lsp: { mode: "auto", servers: { typescript: server } },
	});
}

/** PATH with nothing on it: only the project's own bin could resolve. */
const STRIPPED: NodeJS.ProcessEnv = { PATH: "" };

describe("SURF-3: the LSP trust boundary", () => {
	it("drops an untrusted project's server overrides and its project-local bin", async () => {
		const cwd = localBinRepo();
		const evil = join(cwd, "evil-language-server");
		writeStubServer(evil);
		configWithServer(cwd, evil);

		const config = loadConfig(cwd);
		expect(config.permissions.trust.trusted).toBe(false);
		// The untrusted project's declared server is gone from the loaded config.
		expect(config.lsp.servers).toEqual({});
		// The executable the project declared resolves, but only if it survived.
		const override = lookupServer(cwd, "typescript", { config, env: STRIPPED });
		expect(override.ok).toBe(false);

		// Nothing on PATH, so only the project's own bin could answer for the
		// built-in table — and it must not, override or not.
		const noOverride = loadConfig(cwd, { lsp: { mode: "auto", servers: {} } });
		expect(lookupServer(cwd, "typescript", { config: noOverride, env: STRIPPED }).ok).toBe(false);
		expect(detectServers(cwd, { config: noOverride, env: STRIPPED })).toEqual([]);

		// And the lazy spawn entry point refuses before starting anything.
		const spawnedBefore = lspProcessStats.spawned;
		const client = await getClient(cwd, "typescript", { config: noOverride, env: STRIPPED });
		expect(client.ok).toBe(false);
		expect(lspProcessStats.spawned).toBe(spawnedBefore);
		await closeLspClients();
	});

	it("keeps a trusted project's override and built-in project-local bin", async () => {
		const cwd = localBinRepo();
		const trusted = join(cwd, "trusted-language-server");
		writeStubServer(trusted);
		configWithServer(cwd, trusted);
		grantTrust(cwd);

		const config = loadConfig(cwd);
		expect(config.permissions.trust.trusted).toBe(true);
		expect(config.lsp.servers).toEqual({ typescript: trusted });
		const override = lookupServer(cwd, "typescript", { config, env: STRIPPED });
		expect(override).toMatchObject({ ok: true, server: { source: "config", path: trusted } });

		// The built-in probe still finds the trusted project's own bin.
		const noOverride = loadConfig(cwd, { lsp: { mode: "auto", servers: {} } });
		const builtin = lookupServer(cwd, "typescript", { config: noOverride, env: STRIPPED });
		expect(builtin).toMatchObject({ ok: true, server: { source: "local-bin" } });
		await closeLspClients();
	});

	it("drops a config-supplied interpreter and its script arguments, so neither can bypass trust", () => {
		const cwd = localBinRepo();
		const script = join(cwd, "evil.js");
		writeStubServer(script);
		configWithServer(cwd, `${process.execPath} ${script}`);

		const config = loadConfig(cwd);
		expect(config.lsp.servers).toEqual({});
		expect(lookupServer(cwd, "typescript", { config, env: STRIPPED }).ok).toBe(false);
	});

	it("refuses a project-local server placed on PATH, through the real spawn entry point", async () => {
		const cwd = tempDir("leanpi-lsp-path-");
		// The project's own executable, reachable because the project also puts its
		// own bin directory on PATH — the path trust must not lose sight of.
		const tools = join(cwd, "tools");
		writeStubServer(join(tools, "typescript-language-server"));
		writeConfig(cwd, {
			backends: { local: nativeBackend("http://127.0.0.1:1/v1") },
			models: { balanced: { backend: "local", model: "stub-model" } },
		});
		const config = loadConfig(cwd);
		expect(config.permissions.trust.trusted).toBe(false);

		const before = lspProcessStats.spawned;
		const client = await getClient(cwd, "typescript", { config, env: { PATH: tools } });
		expect(client.ok).toBe(false);
		expect(lspProcessStats.spawned).toBe(before);
		await closeLspClients();
	});

	it("refuses a PATH symlink that resolves back into the untrusted project", async () => {
		const cwd = tempDir("leanpi-lsp-symlink-");
		const inside = join(cwd, "bin");
		writeStubServer(join(inside, "typescript-language-server"));
		// The PATH entry itself is outside the project; only the link's target is
		// inside, so lexical containment alone would let it through.
		const globalBin = tempDir("leanpi-lsp-symlink-bin-");
		symlinkSync(join(inside, "typescript-language-server"), join(globalBin, "typescript-language-server"));
		writeConfig(cwd, {
			backends: { local: nativeBackend("http://127.0.0.1:1/v1") },
			models: { balanced: { backend: "local", model: "stub-model" } },
		});
		const config = loadConfig(cwd);

		const before = lspProcessStats.spawned;
		const client = await getClient(cwd, "typescript", { config, env: { PATH: globalBin } });
		expect(client.ok).toBe(false);
		expect(lspProcessStats.spawned).toBe(before);
		await closeLspClients();
	});

	it("leaves globally installed language servers available to an untrusted project", () => {		const cwd = tempDir("leanpi-lsp-global-");
		writeConfig(cwd, {
			backends: { local: nativeBackend("http://127.0.0.1:1/v1") },
			models: { balanced: { backend: "local", model: "stub-model" } },
		});
		// A PATH entry this test owns, outside the project, stands in for a global
		// install: untrusted repositories do not lose the machine's servers.
		const globalBin = tempDir("leanpi-lsp-globalbin-");
		writeStubServer(join(globalBin, "typescript-language-server"));
		const config = loadConfig(cwd);
		const found = lookupServer(cwd, "typescript", { config, env: { PATH: globalBin } });
		expect(found).toMatchObject({ ok: true, server: { source: "path" } });
	});
});
