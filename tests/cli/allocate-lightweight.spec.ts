import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

vi.mock("../../src/backends/cli-provider.js", () => {
	throw new Error("model discovery must not load the CLI provider");
});
vi.mock("@earendil-works/pi-coding-agent", () => {
	throw new Error("model discovery must not load the Pi SDK");
});

it("discovers learned model IDs without loading provider execution or the Pi SDK", async () => {
	const allocation = import("../../src/cli/allocate.js");
	await expect(allocation).resolves.toBeDefined();
	const { detectModels } = await allocation;
	const home = mkdtempSync(join(tmpdir(), "leanpi-allocation-"));
	try {
		mkdirSync(join(home, ".leanpi"));
		writeFileSync(join(home, ".claude.json"), JSON.stringify({ model: "opus" }));
		const cache = join(home, ".leanpi", "model-ids.json");
		writeFileSync(cache, JSON.stringify({ opus: { id: "claude-opus-5-5", contextWindow: 200_000 } }));
		expect(detectModels("claude", { home })).toEqual([
			{ vendor: "claude", model: "claude-opus-5-5", source: "claude settings opus" },
			{ vendor: "claude", model: "sonnet", source: "claude alias" },
			{ vendor: "claude", model: "haiku", source: "claude alias" },
		]);
		writeFileSync(cache, "broken JSON");
		expect(detectModels("claude", { home })[0]).toEqual({ vendor: "claude", model: "opus", source: "claude settings" });
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
