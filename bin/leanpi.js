#!/usr/bin/env node
/**
 * `leanpi` — Pi's CLI with this package's extension already attached.
 *
 * Everything the command does lives in `dist/cli/launch.js`; this file is the
 * shebang and the process plumbing, so the argv construction stays testable
 * without spawning anything.
 */
import { spawn } from "node:child_process";
import { launchPlan } from "../dist/cli/launch.js";

let plan;
try {
	plan = launchPlan(process.argv.slice(2));
} catch (error) {
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
