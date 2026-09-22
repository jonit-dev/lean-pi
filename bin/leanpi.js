#!/usr/bin/env node
/**
 * `leanpi` — Pi's CLI with this package's extension already attached.
 *
 * The decisions live in `dist/cli/{launch,bootstrap}.js`; this file is the
 * shebang and the process plumbing, so everything it does stays testable
 * without spawning anything.
 */
import { spawn } from "node:child_process";

// `package.json` requires Node >= 22.19; an older runtime fails somewhere deep
// in Pi's bundle with a syntax or API error that says nothing about versions.
// nvm makes this ordinary: `leanpi` linked under one version is run from a
// project pinned to another.
const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 19)) {
	process.stderr.write(`leanpi needs Node >= 22.19 (running ${process.version}). With nvm: nvm use 22\n`);
	process.exit(1);
}
import { autoConfigure, jevClientFor, jevWarning, unusableBackendKeys, requireJev, sessionModelFor, startupBanner } from "../dist/cli/bootstrap.js";
import { runOnboarding, shouldOnboard } from "../dist/cli/onboarding.js";
import { loadConfig } from "../dist/core/config.js";
import { isInformational, launchEnv, launchPlan, parseLeanPiFlags } from "../dist/cli/launch.js";
import { ensureGitIgnored } from "../dist/runtime/ignore.js";
import { ensureCompactUiDefaults, thinkingFoldEnabled } from "../dist/cli/ui-settings.js";
import { prepareCliSubagents } from "../dist/subagents/index.js";
import { patchPiModelCommand } from "../scripts/patch-pi-model-command.mjs";

let flags;
try {
	flags = parseLeanPiFlags(process.argv.slice(2));
} catch (error) {
	// A mistyped level is a usage error, not a crash: the message names the three.
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
}

let plan;
// Whether this process told the user JEV is unconfigured. The extension inside
// the child must not repeat it, so the fact travels in the child's environment.
let jevWarned = false;
try {
	// `--help`/`--version` print and exit: they start no session, so they neither
	// need a control plane nor deserve a refusal.
	if (isInformational(flags.rest)) {
		plan = launchPlan(flags.rest, undefined, undefined, flags.ui, thinkingFoldEnabled());
	} else {
	// Everything LeanPi writes lands in `.leanpi/`. Exclude it before the first
	// session creates it, or the operator's next `git status` is our state dir.
	ensureGitIgnored(process.cwd(), ".leanpi");
	// The compact UI reads Pi's own settings file. Seed the one thing it cannot
	// take from the theme — the diff's syntax colours — and only where the user
	// has not already answered.
	if (flags.ui === "compact") ensureCompactUiDefaults();
	// The one question the machine cannot answer for itself, asked before
	// anything is written: the key decides the role map `autoConfigure` is about
	// to write, and that map is never recomputed. Only when a person is watching
	// and the question is genuinely open — a prompt in CI hangs forever.
	if (shouldOnboard({ flags, interactive: process.stdin.isTTY === true && process.stderr.isTTY === true })) {
		await runOnboarding();
	}
	// The key first: JEV allocates the roles the config is written with, so a run
	// that has no control plane must stop before it writes anything.
	const jev = requireJev({
		allowMissing: flags.allowMissingJev,
		...(flags.jevKey === undefined ? {} : { setKey: flags.jevKey }),
		// `--laya` / `--jev` decide the control plane for the run, and the banner is
		// the first thing the user reads: resolving the provider only inside the
		// child would print the TypeSafe line above a session that never uses it.
		...(flags.provider === undefined ? {} : { env: { ...process.env, LEANPI_LAYAY_PROVIDER: flags.provider } }),
	});
	if (jev.stored) process.stderr.write(`leanpi: JEV key stored at ${jev.stored}\n`);
	const configured = await autoConfigure({ client: jevClientFor() });
	// Printed when a config was written *and* when none could be: the
	// no-subscription branch carries the only instructions the user gets, and
	// swallowing it left them with `no model roles configured` from the loader.
	// Printed when a config was written *and* when none could be: the
	// no-subscription branch carries the only instructions the user gets, and
	// swallowing it left them with `no model roles configured` from the loader.
	// An existing config is not news.
	if (configured.outcome !== "existing") process.stderr.write(`leanpi: ${configured.summary}\n`);
	// Nothing to route to and nothing written: the line above is the whole
	// answer, and letting the loader also throw `no model roles configured`
	// buries it under the error this bootstrap exists to replace.
	if (configured.outcome === "no-subscription") process.exit(1);
	const config = loadConfig(process.cwd());
	const sessionModel = sessionModelFor(config);
	process.stderr.write(`${startupBanner(config, jev, sessionModel, { color: process.stderr.isTTY === true })}\n`);
	// The key is optional; the cost of running without one is not. Yellow on a
	// TTY like the banner, plain when the stream is redirected.
	const warning = jevWarning(jev.source);
	if (warning) {
		const yellow = process.stderr.isTTY === true;
		process.stderr.write(`${yellow ? "\u001b[33m" : ""}${warning.join("\n")}${yellow ? "\u001b[0m" : ""}\n`);
		jevWarned = true;
	}
	// A named credential the shell does not hold *and* Pi cannot cover from its
	// own store: the provider would answer `401 Invalid API key` and the user
	// would read it as a verdict on the key they just configured. When `pi auth`
	// already has the provider, the variable is unused and there is nothing to say.
	for (const { backend, variable } of unusableBackendKeys(config)) {
		process.stderr.write(`leanpi: backend "${backend}" reads its key from $${variable}, which is not set in this shell — export it, or remove the \`apiKey\` line to use pi's own credential for that provider.\n`);
	}
	// Folded reasoning unless `/thinking-fold off` stored the other answer.
	// Select upstream's one resource path before spawning: a global-only preflight
	// (project packages are reported, never trusted or executed) feeds Pi's own
	// `--extension`, whose canonical-path merge dedupes it against the global copy.
	const subagents = await prepareCliSubagents(process.cwd());
	plan = launchPlan(flags.rest, undefined, sessionModel, flags.ui, thinkingFoldEnabled(), subagents.entry);
	}
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
}

// Both flags are decisions about the session, not just about startup, and the
// extension runs in this child: `--no-jev` used to only tolerate a missing key,
// so a machine that *had* one ran every JEV site anyway, and `--safety` has no
// other way to reach the permission state the guard resolves against. `launchEnv`
// also decides whether Pi's own update banner is left on (a source checkout) or
// switched off (an installed package).
// Pi resolves `/model` in a hardcoded chain ahead of every extension command,
// so the name has to be taken from the host itself. Idempotent, and re-applied
// here rather than at build time because a `pnpm install` restores Pi's file.
// A Pi release that moves the branch loses the picker, and says which so the
// patch gets fixed instead of the feature rotting away silently.
const modelOverride = patchPiModelCommand(new URL("..", import.meta.url).pathname);
if (modelOverride.status === "unavailable") {
	process.stderr.write(`leanpi: pi's /model could not be overridden — ${modelOverride.reason}. Pi's own selector will answer /model, and LeanPi's picker is unavailable until this patch is updated.\n`);
}

const child = spawn(process.execPath, [plan.cli, ...plan.args], {
	stdio: "inherit",
	env: launchEnv(flags, jevWarned),
});
child.on("error", (error) => {
	process.stderr.write(`leanpi could not start Pi (${plan.cli}): ${error.message}\n`);
	process.exit(1);
});
child.on("exit", (code, signal) => {
	if (signal) process.kill(process.pid, signal);
	else process.exit(code ?? 0);
});
