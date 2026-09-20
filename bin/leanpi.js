#!/usr/bin/env node
/**
 * `leanpi` — Pi's CLI with this package's extension already attached.
 *
 * The decisions live in `dist/cli/{launch,bootstrap}.js`; this file is the
 * shebang and the process plumbing, so everything it does stays testable
 * without spawning anything.
 */
import { spawn } from "node:child_process";
import { autoConfigure, jevClientFor, MissingJevKeyError, requireJev } from "../dist/cli/bootstrap.js";
import { launchPlan, parseLeanPiFlags } from "../dist/cli/launch.js";

const flags = parseLeanPiFlags(process.argv.slice(2));

let plan;
try {
	// The key first: JEV allocates the roles the config is written with, so a run
	// that has no control plane must stop before it writes anything.
	const jev = requireJev({ allowMissing: flags.allowMissingJev, ...(flags.jevKey === undefined ? {} : { setKey: flags.jevKey }) });
	if (jev.stored) process.stderr.write(`leanpi: JEV key stored at ${jev.stored}\n`);
	const configured = await autoConfigure({ client: jevClientFor() });
	if (configured.created) process.stderr.write(`leanpi: ${configured.summary}\n`);
	plan = launchPlan(flags.rest);
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
