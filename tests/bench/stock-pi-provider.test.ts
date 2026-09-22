/**
 * The stock-Pi negative control has to reach the same backend the LeanPi arm
 * uses. `leanpi.config.yaml` authenticates opencode-go with a per-request
 * `x-opencode-session` header; dropping it made every stock-Pi attempt die in
 * ~260ms with `400 MissingSessionID`, zero tokens and a "success" record — a
 * benchmark arm that silently measures nothing.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeStockPiModels } from "../../src/bench/adapters.js";
import type { LeanPiConfig } from "../../src/index.js";
import { tempDir } from "../helpers/fixtures.js";

const config = {
	backends: {
		"opencode-go": {
			type: "native",
			baseUrl: "https://example.invalid/v1",
			api: "openai-completions",
			apiKey: "OPENCODE_API_KEY",
			reasoning: true,
			compat: { thinkingFormat: "deepseek" },
			headers: { "x-opencode-session": "LEANPI_OPENCODE_SESSION" },
			contextWindow: 1_000_000,
			maxTokens: 32_000,
			cost: { input: 0.15, output: 0.6, cacheRead: 0.003 },
		},
	},
	models: { quick: { backend: "opencode-go", model: "deepseek-v4.1-flash" } },
} as unknown as LeanPiConfig;

describe("writeStockPiModels", () => {
	it("can omit the rate card, for providers whose catalog Pi does not know", () => {
		const dir = tempDir("leanpi-stock-models-nocost-");
		writeStockPiModels(config, dir, { includeCost: false });
		const written = JSON.parse(readFileSync(join(dir, "models.json"), "utf8"));
		const model = written.providers["opencode-go"].models[0];
		expect(model.cost).toBeUndefined();
		// Everything Pi needs to reach the backend still survives the omission.
		expect(written.providers["opencode-go"].headers).toEqual({ "x-opencode-session": "LEANPI_OPENCODE_SESSION" });
		expect(model).toMatchObject({ id: "deepseek-v4.1-flash", reasoning: true });
	});

	it("forwards the backend's headers and compat so stock Pi can authenticate", () => {
		const dir = tempDir("leanpi-stock-models-");
		writeStockPiModels(config, dir);
		const written = JSON.parse(readFileSync(join(dir, "models.json"), "utf8"));
		const provider = written.providers["opencode-go"];
		expect(provider.headers).toEqual({ "x-opencode-session": "LEANPI_OPENCODE_SESSION" });
		expect(provider.compat).toEqual({ thinkingFormat: "deepseek" });
	});

	it("carries the model metadata the backend declares", () => {
		const dir = tempDir("leanpi-stock-models-meta-");
		writeStockPiModels(config, dir);
		const written = JSON.parse(readFileSync(join(dir, "models.json"), "utf8"));
		const model = written.providers["opencode-go"].models[0];
		expect(model).toMatchObject({ id: "deepseek-v4.1-flash", reasoning: true, contextWindow: 1_000_000, maxTokens: 32_000 });
		expect(model.cost).toEqual({ input: 0.15, output: 0.6, cacheRead: 0.003 });
	});
});
