#!/usr/bin/env node
/**
 * One stub implementing the documented non-interactive CLI contract of
 * `claude`, `codex` and `opencode`, dispatched on the name it was invoked as
 * (three symlinks pointing at this file) — PRD-008 Phase 3.
 *
 * It is deliberately strict: an unknown flag exits non-zero, and a script that
 * requires a schema makes the schema's absence fatal. A permissive stub would
 * accept a wrong argv silently and the E3 assertions would prove nothing.
 *
 * What it does, per invocation:
 *   1. validates argv against the invoked vendor's documented flag set;
 *   2. appends one JSON line (argv, env, cwd, session id, schema, prompt) to
 *      `LEANPI_STUB_RECORD` so the spec asserts on what the process received;
 *   3. writes the scripted workspace files relative to its cwd;
 *   4. prints the vendor's result envelope on stdout;
 *   5. exits with the vendor's rate-limit / error signal when scripted to.
 *
 * Script inputs come from the environment the *test* set before LeanPi spawned
 * anything, so the child environment LeanPi produces is exactly the parent's.
 */
import { mkdirSync, readFileSync, appendFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const vendor = basename(process.argv[1] ?? "");
const argv = process.argv.slice(2);

function readJson(value, fallback) {
	if (typeof value !== "string" || value.length === 0) return fallback;
	try {
		return JSON.parse(value);
	} catch {
		return fallback;
	}
}

const script = readJson(process.env.LEANPI_STUB_SCRIPT, {});
const recordPath = process.env.LEANPI_STUB_RECORD;

function fail(message, code) {
	process.stderr.write(`${vendor}: ${message}\n`);
	process.exit(code);
}

/** flag → does it consume a value */
const FLAGS = {
	claude: {
		// `--strict-mcp-config` and `--disable-slash-commands` are what LeanPi sends
		// instead of `--bare` on a subscription login, where `--bare` disables OAuth
		// entirely; `--model` selects the role's model. All three exist on the
		// installed CLI (`claude --help`).
		bool: ["-p", "--print", "--bare", "--strict-mcp-config", "--disable-slash-commands"],
		value: ["--output-format", "--json-schema", "--allowedTools", "--allowed-tools", "--resume", "-r", "--model", "--mcp-config"],
	},
	codex: {
		bool: ["--json", "--skip-git-repo-check"],
		// `-c key=value` is how Codex takes reasoning effort; `-m/--model` selects
		// the role's model.
		value: ["--sandbox", "-s", "--output-schema", "--cd", "-C", "--model", "-m", "-c", "--config"],
	},
	opencode: {
		bool: ["--pure", "--print-logs"],
		value: ["--format", "--model", "-m", "--agent", "--session", "-s", "--dir", "--title", "--log-level"],
	},
};

const flags = FLAGS[vendor];
if (!flags) fail(`unknown vendor ${JSON.stringify(vendor)}`, 3);

// ── 1. argv validation ────────────────────────────────────────────────────────
const options = {};
const positionals = [];
const rest = [...argv];
if (vendor === "codex" || vendor === "opencode") {
	const command = rest.shift();
	if (command !== "exec" && command !== "run") fail(`expected "${vendor === "codex" ? "exec" : "run"}", got ${JSON.stringify(command)}`, 2);
	if (vendor === "codex" && rest[0] === "resume") {
		rest.shift();
		options.resume = rest.shift();
		if (!options.resume) fail("resume requires a session id", 2);
	}
}
let literal = false;
for (let index = 0; index < rest.length; index += 1) {
	const token = rest[index];
	if (token === "--") {
		// End of options, as the real CLIs read it: everything after is the prompt.
		literal = true;
		continue;
	}
	if (!literal && token.startsWith("-")) {
		if (flags.bool.includes(token)) {
			options[token] = true;
			continue;
		}
		if (flags.value.includes(token)) {
			const value = rest[index + 1];
			if (value === undefined) fail(`${token} requires a value`, 2);
			options[token] = value;
			index += 1;
			continue;
		}
		fail(`unknown flag ${JSON.stringify(token)}`, 2);
	}
	positionals.push(token);
}

const prompt = positionals.join(" ");
if (prompt.length === 0) fail("no prompt given", 2);

const requireSchema = script.requireSchema === true;
if (requireSchema && vendor === "claude" && options["--json-schema"] === undefined) fail("missing --json-schema", 2);
if (requireSchema && vendor === "codex" && options["--output-schema"] === undefined) fail("missing --output-schema", 2);
// `--bare` is required only when the vendor authenticates by API key: with an
// OAuth/subscription login it turns auth off entirely (`claude --help`), so
// LeanPi sends the narrower context flags instead.
if (vendor === "claude" && process.env.ANTHROPIC_API_KEY && options["--bare"] !== true) fail("missing --bare", 2);
if (vendor === "claude" && options["--output-format"] !== "json") fail("missing --output-format json", 2);
if (vendor === "codex" && typeof options["--sandbox"] !== "string") fail("missing --sandbox", 2);
if (vendor === "codex" && options["--json"] !== true) fail("missing --json", 2);
if (vendor === "opencode" && options["--format"] !== "json") fail("missing --format json", 2);
if (vendor === "opencode" && script.requireModel === true && options["--model"] === undefined) fail("missing --model", 2);

// ── 2. what the vendor CLI received ───────────────────────────────────────────
let schema;
if (vendor === "claude" && typeof options["--json-schema"] === "string") schema = readJson(options["--json-schema"], null);
if (vendor === "codex" && typeof options["--output-schema"] === "string") {
	schema = readJson(readFileSync(options["--output-schema"], "utf8"), null);
}

const resumed =
	vendor === "claude" ? options["--resume"] ?? options["-r"] : vendor === "opencode" ? options["--session"] ?? options["-s"] : options.resume;
const sessionId = resumed ?? `ses_${vendor}_1`;

if (recordPath) {
	const record = {
		vendor,
		argv,
		env: { ...process.env },
		cwd: process.cwd(),
		prompt,
		sessionId,
		resumedFrom: resumed ?? null,
		schema: schema ?? null,
	};
	mkdirSync(dirname(recordPath), { recursive: true });
	appendFileSync(recordPath, `${JSON.stringify(record)}\n`);
}

// ── 5. vendor scripts that are not a result ───────────────────────────────────
const mode = (script.modes && script.modes[vendor]) ?? script.mode ?? "ok";
if (mode === "hang") {
	// A vendor that accepts the request and never answers: measured on this
	// machine, `opencode run` with an exhausted plan quota does exactly this.
	setTimeout(() => {}, 60_000);
	await new Promise(() => {});
}
if (mode === "rate-limit") {
	process.stderr.write(`${vendor}: usage limit reached — resets at 09:00 (429 rate limit)\n`);
	process.exit(1);
}
if (mode === "error") {
	process.stderr.write(`${vendor}: internal error while running the task\n`);
	process.exit(1);
}

// ── 3. workspace change ───────────────────────────────────────────────────────
// A reviewer invocation (its prompt names the reviewer lane) may write different
// bytes than the executor did, so a spec can prove the gate notices a change that
// lands after verification.
const baseFiles = script.files ?? { "stub-change.txt": `changed by ${vendor}\n` };
const files = script.reviewFiles && /reviewer/i.test(prompt) ? { ...baseFiles, ...script.reviewFiles } : baseFiles;
for (const [path, content] of Object.entries(files)) {
	const target = join(process.cwd(), path);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, content);
}
// A reviewer invocation may also replace a path with a symlink (e.g. a cycle),
// so a spec can prove the gate refuses to hash a workspace it cannot read.
const symlinks = script.reviewSymlinks && /reviewer/i.test(prompt) ? script.reviewSymlinks : null;
if (symlinks) {
	for (const [path, target] of Object.entries(symlinks)) {
		const link = join(process.cwd(), path);
		mkdirSync(dirname(link), { recursive: true });
		rmSync(link, { force: true });
		symlinkSync(target, link);
	}
}

const summary = typeof script.summary === "string" ? script.summary : `${vendor} completed the task`;
const structured =
	script.structured !== undefined
		? script.structured
		: { status: "ok", summary, files: Object.keys(files) };

// ── 4. the vendor's result envelope ───────────────────────────────────────────
const lines = [];
if (vendor === "claude") {
	lines.push(
		JSON.stringify({
			type: "result",
			subtype: "success",
			is_error: false,
			result: summary,
			session_id: sessionId,
			...(schema ? { structured_output: structured } : {}),
		}),
	);
} else if (vendor === "codex") {
	lines.push(JSON.stringify({ type: "thread.started", thread_id: sessionId }));
	lines.push(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: summary } }));
	if (schema) lines.push(JSON.stringify({ type: "structured", structured }));
	lines.push(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } }));
} else {
	lines.push(JSON.stringify({ type: "session", sessionID: sessionId }));
	lines.push(JSON.stringify({ type: "text", sessionID: sessionId, part: { type: "text", text: summary } }));
	if (schema) lines.push(JSON.stringify({ type: "structured", sessionID: sessionId, structured }));
}
process.stdout.write(`${lines.join("\n")}\n`);
process.exit(0);
