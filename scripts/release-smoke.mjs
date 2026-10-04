#!/usr/bin/env node
/**
 * PRD-054 G2 — the live pre-release smoke.
 *
 * v0.1.10 passed every stub test and still broke every normal Auto turn on a
 * real machine: a `balanced` turn ran as a headless vendor CLI that shows
 * nothing until the whole task is done. This runs the *built* binary with this
 * machine's real config, once per everyday executor class — pinned with
 * `/route executor <class>`, because JEV's classification of any one prompt is
 * not stable — on a prompt that needs a tool, and fails unless, per class:
 *
 *   - a model starts answering within FIRST_EVENT_MS,
 *   - a tool call streams through Pi's own loop (a headless CLI turn emits none),
 *   - the reply carries the token only the tool could have read.
 *
 * `strong` is left out on purpose: routing hard tasks to a vendor CLI is a
 * configured choice (PRD-053 AC-3), not a regression.
 *
 * ~$0.02 and ~20 s, so it runs on every publish. `LEANPI_SMOKE=0` skips it
 * loudly — CI has no credentials, and an all-CLI config has no Pi-loop tools.
 *
 * Usage: node scripts/release-smoke.mjs [path/to/bin/leanpi.js]
 */
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FIRST_EVENT_MS = 30_000;
const TURN_TIMEOUT_MS = 120_000;
const CLASSES = ["quick", "balanced"];

if (process.env.LEANPI_SMOKE === "0") {
	console.log("release smoke: SKIPPED (LEANPI_SMOKE=0) — the built binary was not run live");
	process.exit(0);
}

const bin = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "leanpi.js"));

/** One live print-mode turn on `executorClass`; returns the failures it saw. */
async function smoke(executorClass) {
	const cwd = mkdtempSync(join(tmpdir(), "leanpi-smoke-"));
	const token = `smoke-${randomBytes(4).toString("hex")}`;
	writeFileSync(join(cwd, "smoke.txt"), `${token}\n`);
	execFileSync("git", ["init", "-q"], { cwd });
	const prompt = "Use your read tool to read smoke.txt, then reply with its contents only.";

	const started = Date.now();
	const timeline = [];
	let firstModelAt;
	let model;
	let toolCalls = 0;
	let reply = "";
	let buffered = "";
	let stderr = "";

	const child = spawn(process.execPath, [bin, "-p", "--mode", "json", `/route executor ${executorClass}`, prompt], { cwd, stdio: ["ignore", "pipe", "pipe"] });
	child.stderr.on("data", (chunk) => (stderr += chunk));
	child.stdout.on("data", (chunk) => {
		buffered += chunk;
		const lines = buffered.split("\n");
		buffered = lines.pop() ?? "";
		for (const line of lines) {
			let event;
			try {
				event = JSON.parse(line);
			} catch {
				continue;
			}
			const at = Date.now() - started;
			const message = event.message && typeof event.message === "object" ? event.message : undefined;
			if (event.type === "message_start" && message?.role === "assistant" && firstModelAt === undefined) {
				firstModelAt = at;
				model = `${message.provider}/${message.model}`;
				timeline.push(`${(at / 1000).toFixed(1)}s first model event (${model})`);
			}
			if (event.type === "tool_execution_start") {
				toolCalls += 1;
				timeline.push(`${(at / 1000).toFixed(1)}s tool ${event.toolName ?? "?"}`);
			}
			if (event.type === "message_end" && message?.role === "assistant" && Array.isArray(message.content)) {
				const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
				if (text) reply = text;
			}
		}
	});

	const timer = setTimeout(() => child.kill("SIGKILL"), TURN_TIMEOUT_MS);
	const code = await new Promise((done) => child.on("close", done));
	clearTimeout(timer);

	const failures = [];
	if (code !== 0) failures.push(`exit ${code}${Date.now() - started >= TURN_TIMEOUT_MS ? " (killed at the turn timeout)" : ""}`);
	if (firstModelAt === undefined) failures.push("no model ever answered");
	else if (firstModelAt > FIRST_EVENT_MS) failures.push(`first model event at ${(firstModelAt / 1000).toFixed(1)}s, over ${FIRST_EVENT_MS / 1000}s`);
	if (toolCalls === 0) failures.push("no tool call streamed through Pi's loop — the turn ran somewhere that shows nothing until done (a headless vendor CLI?)");
	if (!reply.includes(token)) failures.push(`reply does not carry the file's token (${token}): ${JSON.stringify(reply.slice(0, 120))}`);

	console.log(`[${executorClass}]`);
	for (const line of timeline) console.log(`  ${line}`);
	if (failures.length > 0 && stderr.trim()) failures.push(`stderr tail: ${stderr.trim().split("\n").slice(-3).join(" | ")}`);
	if (failures.length === 0) console.log(`  PASS — ${model}, first model event ${(firstModelAt / 1000).toFixed(1)}s, ${toolCalls} tool call(s), token read back`);
	return failures.map((failure) => `${executorClass}: ${failure}`);
}

console.log(`release smoke: ${bin}`);
const failures = [];
for (const executorClass of CLASSES) failures.push(...(await smoke(executorClass)));
if (failures.length > 0) {
	console.error(`release smoke: FAILED\n${failures.map((failure) => `  - ${failure}`).join("\n")}`);
	process.exit(1);
}
console.log("release smoke: PASS");
