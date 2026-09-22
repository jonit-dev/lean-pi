/**
 * Drop-in proof: LeanPi's unmodified JEV client, pointed at Laya.
 *
 * This imports the built `dist/index.js` and uses the real `createJevClient`
 * with its real HTTP transport, the real registered decision site
 * (`executor.failure_classification`, registered by `classifyFailure`) and the
 * real `accept()` confidence gate. The only difference from production is the
 * endpoint URL: it points at `shim.py`, a JEV-contract server over Laya.
 *
 * Nothing in `src/` is changed. If this passes, "replace JEV with Laya" is a
 * config change, not a code change.
 *
 * Usage: node drop_in.mjs [--subfolder typed-decisions]
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyFailure, createJevClient, loadConfig } from "../../dist/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 8791;
const PYTHON = join(HERE, ".venv", "bin", "python");

function arg(name, fallback) {
	const index = process.argv.indexOf(name);
	return index === -1 ? fallback : process.argv[index + 1];
}

const subfolder = arg("--subfolder", null);

function startShim() {
	const args = [join(HERE, "shim.py"), "--port", String(PORT), "--device", "cuda"];
	if (subfolder) args.push("--subfolder", subfolder);
	const child = spawn(PYTHON, args, { env: { ...process.env, USE_TF: "0" } });
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("shim did not start in 180s")), 180_000);
		child.stdout.on("data", (chunk) => {
			const text = chunk.toString();
			if (text.includes("listening")) {
				clearTimeout(timer);
				resolve(child);
			}
		});
		child.stderr.on("data", (chunk) => process.stderr.write(chunk));
		child.on("exit", (code) => reject(new Error(`shim exited ${code}`)));
	});
}

const shim = await startShim();
const cwd = mkdtempSync(join(tmpdir(), "leanpi-laya-"));

try {
	const config = loadConfig(cwd, { configPath: null });
	// The only change: endpoint. Same client, same transport, same registry.
	const client = createJevClient({
		config,
		cwd,
		endpoint: `http://127.0.0.1:${PORT}/v1/systemone`,
		credential: () => ({ key: "laya-shim", source: "env" }),
	});

	const status = await client.status();
	console.log(`status: configured=${status.configured} source=${status.source} reachable=${status.reachable}`);

	const probe = await client.test();
	console.log(`/jev test -> ok=${probe.ok} model=${probe.modelVersion} kind=${probe.answer?.kind} latency=${probe.latencyMs}ms`);

	const failures = [
		{ kind: "typecheck", detail: "error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'." },
		{ kind: "test", detail: "AssertionError: expected 3 to equal 4" },
		{ kind: "command", detail: "spawn npx ENOENT" },
	];
	for (const failure of failures) {
		const before = client.fallbackCount();
		const result = await classifyFailure({ client, failure });
		const via = client.fallbackCount() > before ? "deterministic fallback" : "Laya over the wire";
		console.log(`classifyFailure(${failure.kind}) -> ${result.value}  (via ${via})`);
	}

	const logPath = join(cwd, ".leanpi", "decisions.jsonl");
	const rows = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	console.log(`decision log: ${rows.length} rows, sites=${[...new Set(rows.map((row) => row.siteId))].join(",")}`);
	console.log(`answeredCount=${client.answeredCount()} fallbackCount=${client.fallbackCount()}`);

	if (probe.answer?.kind !== "Noul") throw new Error("probe did not return a Noul answer");
	if (client.answeredCount() === 0) throw new Error("Laya answered nothing - the shim is not wired");
	if (rows.length === 0) throw new Error("no decision log rows written");
	console.log("\nDROP-IN OK: unmodified LeanPi client, site registry and accept() gate, Laya on the wire.");
} finally {
	shim.kill("SIGTERM");
}
