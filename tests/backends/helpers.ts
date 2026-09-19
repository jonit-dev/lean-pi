/** PRD-008 backend-worker fixtures: the stub vendor CLIs and the §25 pool. */
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "../helpers/fixtures.js";

export const HARNESS_STUB_PATH = fileURLToPath(new URL("./stubs/harness-stub.mjs", import.meta.url));

export type StubVendor = "claude" | "codex" | "opencode";

export interface StubRecord {
	vendor: StubVendor;
	argv: string[];
	env: Record<string, string | undefined>;
	cwd: string;
	prompt: string;
	sessionId: string;
	resumedFrom: string | null;
	schema: unknown;
}

export interface StubCli {
	/** The `command` each vendor backend is configured with — a symlink to the stub. */
	bin: Record<StubVendor, string>;
	recordPath: string;
	/** Every invocation the stub processes, in order. */
	records(): StubRecord[];
}

/**
 * Three symlinks named after the vendor CLIs, all pointing at one stub, so the
 * stub dispatches on the invoked name exactly as the real binaries do.
 */
export function installStubCli(): StubCli {
	const dir = tempDir("leanpi-harness-");
	const binDir = join(dir, "bin");
	mkdirSync(binDir, { recursive: true });
	chmodSync(HARNESS_STUB_PATH, 0o755);
	const bin = {} as Record<StubVendor, string>;
	for (const vendor of ["claude", "codex", "opencode"] as const) {
		const path = join(binDir, vendor);
		symlinkSync(HARNESS_STUB_PATH, path);
		bin[vendor] = path;
	}
	const recordPath = join(dir, "invocations.jsonl");
	return {
		bin,
		recordPath,
		records: () =>
			existsSync(recordPath)
				? (readFileSync(recordPath, "utf8")
						.split("\n")
						.filter((line) => line.trim().length > 0)
						.map((line) => JSON.parse(line) as StubRecord))
				: [],
	};
}

/**
 * Point the stub at a script through the *test's* environment. LeanPi passes
 * `process.env` to the child untouched, so the stub inherits these without
 * LeanPi adding anything — which is also what AC-7 asserts.
 */
export function setStubScript(recordPath: string, script: Record<string, unknown>): () => void {
	const previousRecord = process.env.LEANPI_STUB_RECORD;
	const previousScript = process.env.LEANPI_STUB_SCRIPT;
	process.env.LEANPI_STUB_RECORD = recordPath;
	process.env.LEANPI_STUB_SCRIPT = JSON.stringify(script);
	return () => {
		if (previousRecord === undefined) delete process.env.LEANPI_STUB_RECORD;
		else process.env.LEANPI_STUB_RECORD = previousRecord;
		if (previousScript === undefined) delete process.env.LEANPI_STUB_SCRIPT;
		else process.env.LEANPI_STUB_SCRIPT = previousScript;
	};
}

/** The ROADMAP §25 `backends:` block, verbatim except for the command paths. */
export function s25Backends(cli: StubCli, overrides: Record<string, Record<string, unknown>> = {}): Record<string, unknown> {
	return {
		claude: { type: "external_harness", command: cli.bin.claude, enabled: true, priority: 20, quota_class: "scarce-premium", ...overrides.claude },
		codex: { type: "external_harness", command: cli.bin.codex, enabled: true, priority: 15, quota_class: "premium", ...overrides.codex },
		opencode: { type: "external_harness", command: cli.bin.opencode, enabled: true, quota_class: "low-cost", ...overrides.opencode },
		local: { type: "native", provider: "llama.cpp", model: "local-code-27b", marginal_cost: 0, ...overrides.local },
	};
}

/** The structured result the packets ask for; a violation of it is a worker failure. */
export const RESULT_SCHEMA: Record<string, unknown> = {
	type: "object",
	required: ["status", "files"],
	properties: {
		status: { type: "string", enum: ["ok"] },
		files: { type: "array", items: { type: "string" } },
	},
};
