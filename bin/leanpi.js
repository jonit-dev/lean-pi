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
import { autoConfigure, jevClientFor, MissingJevKeyError, requireJev, sessionModelFor, startupBanner } from "../dist/cli/bootstrap.js";
import { loadConfig } from "../dist/core/config.js";
import { isInformational, launchPlan, parseLeanPiFlags } from "../dist/cli/launch.js";

const flags = parseLeanPiFlags(process.argv.slice(2));

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
	if (configured.created) process.stderr.write(`leanpi: ${configured.summary}\n`);
	const config = loadConfig(process.cwd());
	process.stderr.write(`${startupBanner(config, jev)}\n`);
	plan = launchPlan(flags.rest, undefined, sessionModelFor(config));
	}
} catch (error) {
	if (error instanceof MissingJevKeyError) {
		process.stderr.write(`${error.message}\n`);
		process.exit(2);
	}
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
}

const child = spawn(process.execPath, [plan.cli, ...plan.args], { stdio: "inherit" });
child.on("error", (error) => {
	process.stderr.write(`leanpi could not start Pi (${plan.cli}): ${error.message}\n`);
	process.exit(1);
});
child.on("exit", (code, signal) => {
	if (signal) process.kill(process.pid, signal);
	else process.exit(code ?? 0);
});
