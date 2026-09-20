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
import { autoConfigure, jevClientFor, missingBackendKeys, MissingJevKeyError, requireJev, sessionModelFor, startupBanner } from "../dist/cli/bootstrap.js";
import { loadConfig } from "../dist/core/config.js";
import { isInformational, launchPlan, parseLeanPiFlags } from "../dist/cli/launch.js";

let flags;
try {
	flags = parseLeanPiFlags(process.argv.slice(2));
} catch (error) {
	// A mistyped level is a usage error, not a crash: the message names the three.
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
}

let plan;
try {
	// `--help`/`--version` print and exit: they start no session, so they neither
	// need a control plane nor deserve a refusal.
	if (isInformational(flags.rest)) {
		plan = launchPlan(flags.rest);
	} else {
	// The key first: JEV allocates the roles the config is written with, so a run
	// that has no control plane must stop before it writes anything.
	const jev = requireJev({ allowMissing: flags.allowMissingJev, ...(flags.jevKey === undefined ? {} : { setKey: flags.jevKey }) });
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
	process.stderr.write(`${startupBanner(config, jev, sessionModel)}\n`);
	// A named credential the shell does not hold: the provider would answer
	// `401 Invalid API key` and the user would read it as a verdict on the key
	// they just configured.
	for (const { backend, variable } of missingBackendKeys(config)) {
		process.stderr.write(`leanpi: backend "${backend}" reads its key from $${variable}, which is not set in this shell — export it, or remove the \`apiKey\` line to use pi's own credential for that provider.\n`);
	}
	plan = launchPlan(flags.rest, undefined, sessionModel);
	}
} catch (error) {
	if (error instanceof MissingJevKeyError) {
		process.stderr.write(`${error.message}\n`);
		process.exit(2);
	}
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
}

// Both flags are decisions about the session, not just about startup, and the
// extension runs in this child: `--no-jev` used to only tolerate a missing key,
// so a machine that *had* one ran every JEV site anyway, and `--safety` has no
// other way to reach the permission state the guard resolves against.
const child = spawn(process.execPath, [plan.cli, ...plan.args], {
	stdio: "inherit",
	env: {
		...process.env,
		...(flags.allowMissingJev ? { LEANPI_NO_JEV: "1" } : {}),
		...(flags.safety === undefined ? {} : { LEANPI_SAFETY: flags.safety }),
	},
});
child.on("error", (error) => {
	process.stderr.write(`leanpi could not start Pi (${plan.cli}): ${error.message}\n`);
	process.exit(1);
});
child.on("exit", (code, signal) => {
	if (signal) process.kill(process.pid, signal);
	else process.exit(code ?? 0);
});
