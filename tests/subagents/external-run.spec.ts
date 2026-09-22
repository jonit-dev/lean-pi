/**
 * PRD-041 AC-9 — host-owned `/run` in an external-harness parent.
 *
 * `run.spec.ts` proves `/run` with a native parent; that is not the mode where
 * the model cannot call `subagent` at all. Here the parent's executor roles
 * (`quick`/`balanced`/`strong`) all resolve to an `external_harness` vendor, so
 * LeanPi's loop never serves a native prompt. The supported delegation entry is
 * the host-owned `/run`, and its child must still resolve a native provider.
 *
 * The native local provider is registered only because a fourth role
 * (`specialist`) binds it; `/run` names it explicitly in the agent token, so the
 * child answer comes from the stub provider boundary — not from a config read or
 * a vendor-model adapter (there is none).
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify as yaml } from "yaml";
import { createLeanPiSession, type LeanPiSession } from "../../src/index.js";
import { fixtureRepo, bindHeadlessUI, harnessStubEnv, isolateAgentDir } from "../helpers/fixtures.js";
import { installStubCli } from "../backends/helpers.js";
import { startStubBackend, type StubBackend, type StubStep } from "../helpers/stub-backend.js";

const CHILD_TOOLS = new Set(["bash", "grep", "find", "ls", "glob", "contact_supervisor"]);

function toolNames(body: Record<string, unknown>): string[] {
	const tools = body.tools as Array<{ function?: { name?: string } }> | undefined;
	return (tools ?? []).map((tool) => tool.function?.name ?? "");
}

const isChildRequest = (body: Record<string, unknown>): boolean => toolNames(body).some((name) => CHILD_TOOLS.has(name));

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function slashCards(session: LeanPiSession): Array<{ text: string }> {
	const entries = session.session.sessionManager.getEntries?.() ?? [];
	return entries
		.filter((entry) => (entry as { customType?: string }).customType === "subagent-slash-result")
		.map((entry) => ({ text: JSON.stringify(entry) }));
}

/** The initial card, or a child request observed at the provider boundary. */
async function waitForInitialSignal(session: LeanPiSession, native: StubBackend, timeoutMs = 30_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (slashCards(session).some((card) => card.text.includes("Running subagent"))) return;
		if (native.requests.some((request) => isChildRequest(request.body))) return;
		await sleep(100);
	}
	throw new Error("no initial slash card and no child request observed within 30s");
}

/** The terminal slash card, never the initial "Running subagent..." one. */
async function waitForTerminalCard(session: LeanPiSession, needle: string | RegExp, timeoutMs = 30_000): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	let last = "";
	while (Date.now() < deadline) {
		const cards = slashCards(session);
		last = cards.at(-1)?.text ?? "";
		if (last && !last.includes("Running subagent...") && (typeof needle === "string" ? last.includes(needle) : needle.test(last))) return last;
		await sleep(100);
	}
	throw new Error(`no terminal slash result within ${timeoutMs}ms; last=${last.slice(0, 600)}`);
}

describe("the external-harness parent delegates through the host-owned /run (AC-9)", () => {
	let native: StubBackend | undefined;
	let session: LeanPiSession | undefined;
	let restoreAgentDir: (() => void) | undefined;

	afterEach(async () => {
		session?.session.dispose();
		await native?.close();
		restoreAgentDir?.();
		restoreAgentDir = undefined;
		delete process.env.LEANPI_SAFETY;
	});

	it("answers the child from the native provider while the parent stays external", { timeout: 120_000 }, async () => {
		let childRequests = 0;
		native = await startStubBackend([{ text: "x" }], {
			respond: (body): StubStep => {
				if (isChildRequest(body)) {
					childRequests += 1;
					return { text: "external-parent child answer" };
				}
				return { text: "unexpected native parent prompt" };
			},
		});
		const repo = fixtureRepo();
		const vendor = installStubCli();
		process.env.LEANPI_SAFETY = "low";
		writeFileSync(
			join(repo.cwd, "leanpi.config.yaml"),
			yaml({
				backends: {
					claude: { type: "external_harness", vendor: "claude", command: vendor.bin.claude, enabled: true },
					local: { type: "native", baseUrl: native.baseUrl, api: "openai-completions", apiKey: "sk-stub" },
				},
				models: {
					quick: { backend: "claude", model: "claude-sonnet" },
					balanced: { backend: "claude", model: "claude-sonnet" },
					strong: { backend: "claude", model: "claude-sonnet" },
					// Registers the native `local` provider (`registerBackends` only
					// binds backends a role names); it is not one of the three roles
					// `ownsExecutionLoop` inspects, so the parent still owns no loop.
					specialist: { backend: "local", model: "cheap-fast" },
				},
				jev: { mode: "disabled" },
				lsp: { mode: "off" },
			}),
		);
		restoreAgentDir = isolateAgentDir(repo.agentDir);
		session = await createLeanPiSession({ cwd: repo.cwd, agentDir: repo.agentDir, env: harnessStubEnv() });
		await bindHeadlessUI(session);

		// The parent's executor roles really are external; nothing native holds it open.
		expect(session.modelFor("balanced")).toEqual({ provider: "claude", model: "claude-sonnet" });

		await session.session.prompt("/run delegate[model=local/cheap-fast] answer this question");
		await waitForInitialSignal(session, native);
		const card = await waitForTerminalCard(session, "external-parent child answer");

		expect(card).toContain("external-parent child answer");
		expect(childRequests).toBe(1);
		// No parent prompt went to the native provider — the child is the only one.
		expect(native.requests.filter((request) => !isChildRequest(request.body))).toHaveLength(0);
		expect(vendor.records()).toHaveLength(0);
	});
});
