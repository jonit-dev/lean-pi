/**
 * Laya runtime seams for tests (PRD-042).
 *
 * `fakeRuntime` keeps the production process and HTTP path and fakes only the
 * two things a test cannot honestly have: the runtime probe (there is no torch
 * in CI) and the interpreter path. The real `vendor/laya/server.py` is what
 * actually runs, in `--fake` mode.
 */
import { defaultLayaDeps, type LayaDeps, type LayaRunResult } from "../../src/index.js";

export interface FakeRuntime {
	deps: LayaDeps;
	spawned: number[];
	exited: number[];
}

export function fakeRuntime(extraArgs: string[] = []): FakeRuntime {
	const real = defaultLayaDeps();
	const spawned: number[] = [];
	const exited: number[] = [];
	const deps: LayaDeps = {
		...real,
		async run(command, args, options) {
			if (args[0] === "-c" && String(args[1]).includes("import laya")) return { code: 0, stdout: "", stderr: "" };
			return real.run(command, args, options);
		},
		spawn(_command, args) {
			const child = real.spawn("python3", [...args, "--fake", ...extraArgs]);
			if (child.pid !== undefined) spawned.push(child.pid);
			child.onExit((code) => exited.push(code ?? -1));
			return child;
		},
	};
	return { deps, spawned, exited };
}

/** A fully stubbed runtime seam: no process, no interpreter, recorded execs. */
export function stubDeps(overrides: Partial<LayaDeps> = {}, runs: Array<{ command: string; args: string[] }> = []): LayaDeps {
	const real = defaultLayaDeps();
	return {
		...real,
		async run(command, args, options): Promise<LayaRunResult> {
			runs.push({ command, args });
			if (args[0] === "-c") return { code: 1, stdout: "", stderr: "No module named 'laya'" };
			return real.run(command, args, options);
		},
		which: (binary) => binary === "uv",
		...overrides,
	};
}
