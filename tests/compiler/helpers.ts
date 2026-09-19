/** Shared fixtures for the PRD-004 compiler suite. */
import { createJevClient, loadConfig, setCompilerContext, type JevClient, type LeanPiConfig, type TaskPacket } from "../../src/index.js";
import { startStubJev, type StubJev, type StubJevResponder } from "../helpers/stub-jev.js";
import { tempDir } from "../helpers/fixtures.js";

export interface AnswerSpec {
	/** Choice answers by question id; anything unspecified answers `no`. */
	choices?: Record<string, string>;
	/** Score answers by question id; anything unspecified answers 1. */
	scores?: Record<string, number>;
	confidence?: number;
}

/** A responder that answers every question in the request from `spec`. */
export function answerScript(spec: AnswerSpec): StubJevResponder {
	return (body) => {
		const questions = (body.questions ?? {}) as Record<string, { type?: string; criteria?: unknown }>;
		const answers: Record<string, unknown> = {};
		for (const [id, question] of Object.entries(questions)) {
			const confidence = spec.confidence ?? 0.95;
			if (question.type === "choice") {
				const options = Object.keys((question.criteria ?? {}) as Record<string, string>);
				const choice = spec.choices?.[id] ?? options.find((option) => option === "no") ?? options[0] ?? "no";
				answers[id] = { type: "choice", choice, probabilities: { [choice]: confidence }, confidence };
			} else if (question.type === "score") {
				answers[id] = { type: "score", score: spec.scores?.[id] ?? 1, legend: {}, probabilities: {}, confidence };
			} else {
				answers[id] = { type: "noul", noul: 0.9 };
			}
		}
		return { answers };
	};
}

export interface CompilerHarness {
	client: JevClient;
	stub: StubJev;
	config: LeanPiConfig;
	cwd: string;
	close(): Promise<void>;
}

/** Point the real JEV client at a stub endpoint and install it as the compiler context. */
export async function harness(responders: StubJevResponder[], overrides: Partial<LeanPiConfig> = {}): Promise<CompilerHarness> {
	const stub = await startStubJev(responders);
	const cwd = tempDir("leanpi-compile-");
	const config = loadConfig(cwd, {
		configPath: null,
		backends: { local: { type: "native", baseUrl: "http://127.0.0.1:1/v1" } },
		models: { quick: { backend: "local", model: "m" } },
		jev: { endpoint: stub.url, apiKey: "test-key", model: "jev-latest", mode: "enabled" },
		...overrides,
	});
	const client = createJevClient({ config, cwd });
	setCompilerContext({ client, config, cwd });
	return {
		client,
		stub,
		config,
		cwd,
		async close() {
			setCompilerContext(undefined);
			await stub.close();
		},
	};
}

/** A JEV client that is never reachable — every site must resolve deterministically. */
export function unavailableClient(): CompilerHarness["client"] {
	return {
		ask: () => Promise.reject(new Error("JEV is down")),
		fallbackCount: () => 0,
		lastUsage: () => ({ inputTokens: 0, outputTokens: 0 }),
	} as unknown as JevClient;
}

export async function unavailableHarness(overrides: Partial<LeanPiConfig> = {}): Promise<CompilerHarness> {
	const cwd = tempDir("leanpi-compile-");
	const config = loadConfig(cwd, {
		configPath: null,
		backends: { local: { type: "native", baseUrl: "http://127.0.0.1:1/v1" } },
		models: { quick: { backend: "local", model: "m" } },
		jev: { endpoint: "http://127.0.0.1:1/v1/systemone", apiKey: null, model: "jev-latest", mode: "enabled" },
		...overrides,
	});
	const client = unavailableClient();
	setCompilerContext({ client, config, cwd });
	return { client, stub: undefined as unknown as StubJev, config, cwd, close: async () => setCompilerContext(undefined) };
}

export function packet(overrides: Partial<TaskPacket> = {}): TaskPacket {
	const base: TaskPacket = {
		repository: { languages: ["typescript"], project_type: "single", package_manager: "npm", dirty: true },
		task: { user_request: "do the thing" },
		workspace: {
			changed_files: ["src/app.ts"],
			likely_modules: ["src"],
			test_runners: ["vitest"],
			lsp_available: true,
			git_branch: "feature/x",
		},
	};
	return {
		repository: { ...base.repository, ...overrides.repository },
		task: { ...base.task, ...overrides.task },
		workspace: { ...base.workspace, ...overrides.workspace },
	};
}
