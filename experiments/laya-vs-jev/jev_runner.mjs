/**
 * Answer `cases.jsonl` with the live TypeSafe JEV service.
 *
 * The request body is built exactly as `src/jev/client.ts` builds it in
 * `enabled` privacy mode (`state` + `model` + `{id: {type, instructions,
 * criteria}}`), so JEV sees the same bytes LeanPi sends in production. The raw
 * response envelope is recorded for scoring.
 *
 * Usage: JEV_API_KEY=... node jev_runner.mjs [--limit N] [--endpoint URL]
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENDPOINT = process.env.JEV_ENDPOINT ?? "https://api.typesafe.ai/v1/systemone";
const MODEL = process.env.JEV_MODEL ?? "jev-latest";

function arg(name, fallback) {
	const index = process.argv.indexOf(name);
	return index === -1 ? fallback : process.argv[index + 1];
}

const key = process.env.JEV_API_KEY;
if (!key) {
	console.error("JEV_API_KEY is not set");
	process.exit(2);
}

const limit = Number(arg("--limit", "0"));
const outPath = arg("--out", join(HERE, "out", "jev.jsonl"));

let cases = readFileSync(join(HERE, "cases.jsonl"), "utf8")
	.split("\n")
	.filter((line) => line.trim())
	.map((line) => JSON.parse(line));
if (limit) cases = cases.slice(0, limit);

const rows = [];
for (const testCase of cases) {
	const body = { state: testCase.state, model: MODEL, questions: testCase.questions };
	const started = Date.now();
	const response = await fetch(ENDPOINT, {
		method: "POST",
		headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(60_000),
	});
	const latencyMs = Date.now() - started;
	const text = await response.text();
	if (!response.ok) {
		console.error(`${testCase.id}: HTTP ${response.status} ${text.slice(0, 200)}`);
		process.exit(1);
	}
	const parsed = JSON.parse(text);
	rows.push({
		id: testCase.id,
		site: testCase.site,
		provider: "jev",
		latencyMs,
		answers: parsed.answers ?? {},
		usage: parsed.usage ?? {},
		model: parsed.model ?? MODEL,
	});
	console.log(`${testCase.id.padEnd(18)} ${String(latencyMs).padStart(6)} ms`);
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");

const latencies = rows.map((row) => row.latencyMs).sort((a, b) => a - b);
const tokens = rows.reduce((sum, row) => sum + (row.usage.input_tokens ?? 0), 0);
const p50 = latencies[Math.floor(latencies.length / 2)];
const p95 = latencies[Math.floor(latencies.length * 0.95)];
console.log(
	`\n${rows.length} cases | p50 ${p50} ms | p95 ${p95} ms | ${tokens} input tokens | $${((tokens / 1_000_000) * 0.042).toFixed(6)} -> ${outPath}`,
);
