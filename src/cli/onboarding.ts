/**
 * The one thing a first run cannot work out for itself.
 *
 * Everything else about a cold start is detectable: `autoConfigure` finds the
 * vendor CLIs, asks JEV to allocate the roles and writes the config. The JEV
 * credential is not detectable, and until now it was not *asked for* either —
 * the launcher printed "JEV not configured" under the banner and handed the
 * user three shell snippets, after the config had already been written by the
 * cheapest-first fallback ladder. The role map is never recomputed, so a key
 * supplied afterwards did not fix the file the first run left behind.
 *
 * So the question is asked before anything is written, and only when it is a
 * real question: a terminal is attached, no config exists yet, and none of the
 * four credential sources — nor `--jev-key`, `--no-jev` or `jev.mode:
 * disabled` — has already answered it. In every other case this module does
 * nothing at all, which is the property that matters most: a prompt that
 * appears in CI or behind a pipe hangs the run forever.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { configPathFor } from "../core/config.js";
import { writeStoredKey } from "../jev/credentials.js";
import { jevClientFor, requireJev, type BootstrapEnv } from "./bootstrap.js";
import type { JevClient } from "../jev/client.js";

/** The launcher flags that are themselves answers to this question. */
export interface OnboardingFlags {
	allowMissingJev?: boolean;
	jevKey?: string | undefined;
}

export interface OnboardingGate extends Partial<BootstrapEnv> {
	flags: OnboardingFlags;
	/** A person is watching: both ends of the conversation are a terminal. */
	interactive: boolean;
}

function environment(options: Partial<BootstrapEnv>): BootstrapEnv {
	const env = options.env ?? process.env;
	return { cwd: options.cwd ?? process.cwd(), env, home: options.home ?? env.HOME ?? homedir() };
}

/**
 * Is there a question to ask, and someone to ask it of?
 *
 * The `requireJev` call is the whole credential test in one line: it returns
 * `not configured` only when `jev.apiKey`, the credential store, `$JEV_API_KEY`
 * and the project `.env` are all empty *and* the mode is not `disabled` — the
 * same resolution the session itself runs, so this cannot disagree with it.
 */
export function shouldOnboard(options: OnboardingGate): boolean {
	if (!options.interactive) return false;
	if (options.flags.jevKey !== undefined || options.flags.allowMissingJev === true) return false;
	const { cwd, env, home } = environment(options);
	// A config that exists means this machine has run before and was already
	// given its chance to answer; re-asking on every launch is nagging.
	if (existsSync(configPathFor(cwd, env))) return false;
	return requireJev({ cwd, env, home }).source === "not configured";
}

export interface OnboardingResult {
	stored: boolean;
}

const INTRO: readonly string[] = [
	"First run. LeanPi routes each task with a cheap semantic control plane (JEV);",
	"without a key it falls back to heuristics and spends more tokens per task.",
	"Get a key at https://typesafe.ai — or press Enter to skip and decide later.",
];

/**
 * Read one line without putting it on screen.
 *
 * readline is handed a sink instead of the real stream, so nothing it would
 * echo — the value included — reaches the terminal; the prompt is written by
 * us. `terminal: true` still takes the tty out of canonical mode, which is what
 * stops the driver echoing the key behind readline's back.
 */
async function askMasked(prompt: string, input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Promise<string> {
	output.write(prompt);
	const sink = new Writable({ write: (_chunk, _encoding, done) => done() });
	const rl = createInterface({ input, output: sink, terminal: true });
	try {
		return (await rl.question("")).trim();
	} finally {
		rl.close();
		output.write("\n");
	}
}

/**
 * Ask for the key, validate it once, store it.
 *
 * One attempt, no retry loop — the same contract `/jev setup` already has. A
 * rejected key, an unreachable endpoint and an empty answer all end the same
 * way: the session starts. The key is optional (PRD-032), so nothing here may
 * refuse a run, and the caller prints the existing `JEV not configured` warning
 * for a run that ends up without one.
 */
export async function runOnboarding(
	options: Partial<BootstrapEnv> & {
		input?: NodeJS.ReadableStream;
		output?: NodeJS.WritableStream;
		/** Test seam; defaults to the same client the role allocation uses. */
		client?: JevClient;
	} = {},
): Promise<OnboardingResult> {
	const { cwd, env, home } = environment(options);
	const input = options.input ?? process.stdin;
	const output = options.output ?? process.stderr;
	output.write(`${INTRO.join("\n")}\n`);
	const key = await askMasked("JEV API key: ", input, output);
	if (key.length === 0) return { stored: false };
	const client = options.client ?? jevClientFor({ cwd, env, home });
	// Exactly one attempt: `validateKey` reports rather than throws, but a client
	// that could not be built at all must still not refuse a session.
	let validation: Awaited<ReturnType<JevClient["validateKey"]>>;
	try {
		validation = await client.validateKey(key);
	} catch (error) {
		validation = { ok: false, modelVersion: "", latencyMs: 0, costUsd: 0, error: error instanceof Error ? error.message : String(error) };
	}
	if (!validation.ok) {
		// The provider's own reason, once. Not a retry: a typo costs one launch,
		// and `leanpi --jev-key <key>` or `/jev key set` fixes it without one.
		output.write(`JEV key rejected: ${validation.error ?? "unknown error"} — continuing without it.\n`);
		return { stored: false };
	}
	try {
		writeStoredKey(key, { ...env, HOME: home });
	} catch (error) {
		output.write(`JEV key could not be stored: ${error instanceof Error ? error.message : String(error)} — continuing without it.\n`);
		return { stored: false };
	}
	output.write(`JEV configured (model ${validation.modelVersion}, ${validation.latencyMs}ms).\n`);
	return { stored: true };
}
