/**
 * PRD-014 Phase 1 — AC-1 and AC-2: the artifact store and reversible expansion.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	ArtifactNotFoundError,
	assemble,
	clearLanes,
	createArtifactStore,
	serializeWorkingState,
	stubSources,
	buildWorkingState,
} from "../src/index.js";
import { bootSession, fixtureRepo, nativeBackend, tempDir, writeConfig } from "./helpers/fixtures.js";
import { startStubBackend } from "./helpers/stub-backend.js";
import { clearSites } from "../src/jev/registry.js";
import { registerLane } from "../src/commands/session.js";

const BIG_OUTPUT = Array.from({ length: 1500 }, (_, index) => `line ${index}: ${"padding ".repeat(10)}end`).join("\n");

describe("PRD-014 Phase 1 — artifacts", () => {
	it("AC-1: a large tool result becomes a compact record and expands byte-identically", () => {
		const store = createArtifactStore({ sessionDir: tempDir("leanpi-session-") });
		expect(Buffer.byteLength(BIG_OUTPUT, "utf8")).toBeGreaterThan(100 * 1024);

		const captured = store.capture({ output: BIG_OUTPUT, sourceRef: "execute:npm test", exitCode: 1, kind: "tool" });
		expect(captured.record).not.toBeNull();
		const record = captured.record!;
		expect(Buffer.byteLength(captured.text, "utf8")).toBeLessThanOrEqual(2048);
		expect(record.exitCode).toBe(1);
		expect(Number.isNaN(Date.parse(record.timestamp))).toBe(false);
		expect(record.sourceRef).toBe("execute:npm test");
		expect(record.artifact).toMatch(/^artifact:\/\/tool\/[0-9a-f]{64}$/);

		const roundTrip = store.expand(record.artifact!);
		expect(createHash("sha256").update(roundTrip).digest("hex")).toBe(createHash("sha256").update(Buffer.from(BIG_OUTPUT, "utf8")).digest("hex"));

		// The sub-threshold path PRD-023 depends on is not gated: store() always
		// returns a ref, and it expands byte-identically.
		const tiny = "x".repeat(200);
		const tinyRef = store.store(tiny, "snippet", "grep:match");
		expect(store.expand(tinyRef).toString("utf8")).toBe(tiny);

		// Below the threshold the capture passes through untouched and stores nothing.
		const passthrough = store.capture({ output: "small output", sourceRef: "read:a.ts" });
		expect(passthrough.record).toBeNull();
		expect(passthrough.text).toBe("small output");

		expect(() => store.expand("artifact://tool/deadbeef")).toThrow(ArtifactNotFoundError);
		expect(() => store.expand("not-a-ref")).toThrow(/not stored/);
	});

	it("AC-2: an expand action reaches the next provider request, and an unknown ref errors loudly", async () => {
		const backend = await startStubBackend([{ text: "ok" }]);
		const { cwd, agentDir } = fixtureRepo();
		writeConfig(cwd, {
			backends: { local: nativeBackend(backend.baseUrl) },
			models: { balanced: { backend: "local", model: "cheap-fast" } },
		});
		clearLanes();
		clearSites();

		const store = createArtifactStore({ sessionDir: `${cwd}/.leanpi/session` });
		const ref = store.store(BIG_OUTPUT, "tool", "execute:npm test");
		const config = { instructions: { ponytail: true } };

		registerLane({
			name: "expand-lane",
			run(_turn, context) {
				const expanded = store.expand(ref).toString("utf8");
				const workingState = buildWorkingState(stubSources({ goal: () => "keep the build green" }));
				const assembled = assemble({
					config,
					workingState,
					evidence: [`expanded ${ref}: ${expanded.length} bytes`],
				});
				// The context engine owns the turn's prompt once it is wired.
				context.prefix = `${assembled.text}\n\n${expanded}`;
			},
		});

		const session = await bootSession({ cwd, agentDir });
		await session.runTurn("expand the artifact");

		const sent = JSON.stringify(backend.requests[0]!.body);
		expect(sent).toContain("line 1499: padding");
		expect(serializeWorkingState(buildWorkingState(stubSources({ goal: () => "keep the build green" })))).toContain("goal: keep the build green");

		// An unknown ref is an explicit error, never empty content.
		let failure: unknown;
		try {
			store.expand("artifact://tool/missing");
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(ArtifactNotFoundError);
		expect(String((failure as Error).message)).toContain("artifact://tool/missing");

		session.session.dispose();
		clearLanes();
		await backend.close();
	});
});
