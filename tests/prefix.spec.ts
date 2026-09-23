/**
 * PRD-001 Phase 3 — AC-5 to AC-8: the vendored, versioned Ponytail prefix.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	PACKAGE_ROOT,
	PONYTAIL_MARKER,
	PONYTAIL_VERSION,
	PREFIX_MAX_BYTES,
	buildStaticPrefix,
	installExecutorPrefix,
	readVendoredPonytail,
	setActivePrefix,
} from "../src/index.js";
import { bootSession, fixtureRepo, nativeBackend, systemText, tempDir, toolNamesOf, writeConfig } from "./helpers/fixtures.js";
import { startStubBackend } from "./helpers/stub-backend.js";

const TASK = "rename the deploy button label";

async function captureOneTurn(options: { ponytail: boolean }): Promise<{ body: Record<string, unknown>; close: () => Promise<void> }> {
	const stub = await startStubBackend([{ text: "done" }]);
	const { cwd, agentDir } = fixtureRepo();
	writeConfig(cwd, {
		backends: { local: nativeBackend(stub.baseUrl) },
		models: { balanced: { backend: "local", model: "cheap-fast" } },
		instructions: { ponytail: options.ponytail },
	});
	const session = await bootSession({ cwd, agentDir });
	await session.runTurn(TASK);
	const body = stub.requests[0]!.body;
	session.session.dispose();
	return { body, close: () => stub.close() };
}

/**
 * BUG D: `before_provider_request` was only told to inject the prefix into
 * `payload.messages`, so every provider whose payload keeps the system prompt
 * elsewhere — Responses `instructions`, Google `systemInstruction`, Bedrock
 * `system` — silently dropped the static prefix, and Bedrock got an invalid
 * `{role:"system"}` message it does not allow.
 */
describe("BUG D — the prefix reaches every provider payload shape", () => {
	const PREFIX = "LEANPI-PREFIX";

	function prefixHandler(): (event: { payload: Record<string, unknown> }) => void {
		let captured: ((event: { payload: Record<string, unknown> }) => void) | undefined;
		const pi = {
			on: (_event: string, handler: (event: { payload: Record<string, unknown> }) => void) => {
				captured = handler;
			},
		};
		installExecutorPrefix(pi as unknown as Parameters<typeof installExecutorPrefix>[0], () => PREFIX);
		return captured!;
	}

	beforeEach(() => setActivePrefix(""));

	it("prepends the responses `instructions` string and keeps the base prompt", () => {
		const handler = prefixHandler();
		const payload: Record<string, unknown> = { instructions: "base", input: [] };
		handler({ payload });
		expect(String(payload.instructions).startsWith(PREFIX)).toBe(true);
		expect(String(payload.instructions)).toContain("base");
	});

	it("prepends Bedrock's `system` block and leaves its messages untouched", () => {
		const handler = prefixHandler();
		const payload: Record<string, unknown> = { system: [{ text: "base" }], messages: [{ role: "user", content: [{ text: "hi" }] }] };
		const messagesBefore = structuredClone(payload.messages);
		handler({ payload });
		expect(payload.messages).toEqual(messagesBefore);
		expect(String((payload.system as Array<{ text: string }>)[0]!.text).startsWith(PREFIX)).toBe(true);
		expect(String((payload.system as Array<{ text: string }>)[0]!.text)).toContain("base");
	});

	it("still prepends the leading system message of an openai-completions payload", () => {
		const handler = prefixHandler();
		const payload: Record<string, unknown> = { messages: [{ role: "system", content: "base" }, { role: "user", content: "hi" }] };
		handler({ payload });
		expect(String((payload.messages as Array<{ content: string }>)[0]!.content).startsWith(PREFIX)).toBe(true);
	});
});

describe("PRD-001 Phase 3 — static Ponytail prefix", () => {
	it("AC-5: every executor request carries a byte-identical prefix with the version marker", async () => {
		const stub = await startStubBackend([{ text: "done" }]);
		const { cwd, agentDir } = fixtureRepo();
		writeConfig(cwd, {
			backends: { local: nativeBackend(stub.baseUrl) },
			models: { balanced: { backend: "local", model: "cheap-fast" } },
		});
		const session = await bootSession({ cwd, agentDir });
		await session.runTurn(TASK);
		await session.runTurn("a different task in the same session");

		expect(stub.requests).toHaveLength(2);
		const prefix = buildStaticPrefix(session.activation.config);
		const first = systemText(stub.requests[0]!.body);
		const second = systemText(stub.requests[1]!.body);

		expect(PONYTAIL_VERSION).toBe("4.9.0");
		expect(PONYTAIL_MARKER).toBe("ponytail@4.9.0");
		expect(first).toContain(PONYTAIL_MARKER);
		expect(second).toContain(PONYTAIL_MARKER);
		expect(first.slice(0, prefix.length)).toBe(prefix);
		expect(second.slice(0, prefix.length)).toBe(prefix);

		session.session.dispose();
		await stub.close();
	});

	it("AC-6: instructions.ponytail:false removes the prefix and leaves the rest of the request unchanged", async () => {
		const enabled = await captureOneTurn({ ponytail: true });
		const disabled = await captureOneTurn({ ponytail: false });

		const enabledText = systemText(enabled.body);
		const disabledText = systemText(disabled.body);
		expect(enabledText).toContain(PONYTAIL_MARKER);
		expect(disabledText).not.toContain(PONYTAIL_MARKER);
		expect(disabledText).not.toContain(PONYTAIL_MARKER.replace("@", ""));

		// The rest of the request is unchanged: same tools, model and user content.
		expect(toolNamesOf(disabled.body)).toEqual(toolNamesOf(enabled.body));
		expect(disabled.body.model).toBe(enabled.body.model);
		const userOf = (body: Record<string, unknown>) =>
			(body.messages as Array<{ role?: string; content?: unknown }>).filter((message) => message.role === "user");
		expect(userOf(disabled.body)).toEqual(userOf(enabled.body));

		await enabled.close();
		await disabled.close();
	});

	it("AC-7: the rendered prefix stays inside the 8192-byte ceiling", () => {
		const config = { instructions: { ponytail: true } };
		const prefix = buildStaticPrefix(config);
		expect(Buffer.byteLength(prefix, "utf8")).toBeLessThanOrEqual(PREFIX_MAX_BYTES);
		// The check runs against the real shipped file, not a fixture.
		expect(prefix).toContain(readVendoredPonytail());
	});

	it("the working rules make finishing a task conditional on verification, with or without Ponytail", () => {
		for (const ponytail of [true, false]) {
			const prefix = buildStaticPrefix({ instructions: { ponytail } });
			expect(prefix).toContain("Done only when tests covering your change pass.");
			expect(prefix).toContain("Changing untested code → write tests first.");
			expect(prefix).toContain("No check possible → say unverified.");
		}
	});

	it("the working rules ask for independent tool calls in one turn, with or without Ponytail", () => {
		for (const ponytail of [true, false]) {
			expect(buildStaticPrefix({ instructions: { ponytail } })).toContain("issue them as parallel tool calls in the same turn");
		}
	});

	it("AC-8: --check passes on the pristine tree, fails on a mutated copy, and degrades without upstream", () => {
		const script = resolve(PACKAGE_ROOT, "scripts/sync-ponytail.mjs");
		const pristine = execFileSync("node", [script, "--check"], { encoding: "utf8" });
		expect(pristine).toContain("OK");

		// A one-byte mutation of the vendored copy must be reported against the lock.
		const tree = tempDir("leanpi-ponytail-");
		mkdirSync(join(tree, "scripts"), { recursive: true });
		mkdirSync(join(tree, "src/core/instructions"), { recursive: true });
		cpSync(script, join(tree, "scripts/sync-ponytail.mjs"));
		// The script is an argv wrapper over the shared vendoring core (PRD-026),
		// so the isolated tree needs that module too.
		mkdirSync(join(tree, "src/skills"), { recursive: true });
		cpSync(resolve(PACKAGE_ROOT, "src/skills/vendor.mjs"), join(tree, "src/skills/vendor.mjs"));
		cpSync(resolve(PACKAGE_ROOT, "src/core/instructions/ponytail.md"), join(tree, "src/core/instructions/ponytail.md"));
		cpSync(resolve(PACKAGE_ROOT, "src/core/instructions/ponytail.lock.json"), join(tree, "src/core/instructions/ponytail.lock.json"));
		const mutated = readFileSync(join(tree, "src/core/instructions/ponytail.md"));
		mutated[0] = mutated[0] === 0x23 ? 0x24 : 0x23;
		writeFileSync(join(tree, "src/core/instructions/ponytail.md"), mutated);

		let failure: { status?: number; stderr?: string } = {};
		try {
			execFileSync("node", [join(tree, "scripts/sync-ponytail.mjs"), "--check"], { encoding: "utf8", stdio: "pipe" });
		} catch (error) {
			failure = error as { status?: number; stderr?: string };
		}
		expect(failure.status).not.toBe(0);
		expect(String(failure.stderr)).toContain("does not match lock");

		// With no upstream plugin, --check still verifies the vendored copy against the lock.
		const degraded = execFileSync("node", [script, "--check"], {
			encoding: "utf8",
			env: { ...process.env, LEANPI_PONYTAIL_SOURCE: join(tempDir("leanpi-missing-"), "SKILL.md") },
		});
		expect(degraded).toContain("OK");
		expect(degraded).toContain("upstream plugin not installed");

		// Product code reads the vendored copy, so a session still boots without the plugin.
		expect(buildStaticPrefix({ instructions: { ponytail: true } })).toContain(PONYTAIL_MARKER);
	});
});
