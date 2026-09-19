/**
 * PRD-019 spec seams: a real reducer process, and a counter around the real spawn.
 *
 * The counter wraps `spawnReducerProcess` rather than replacing it, so AC-2's
 * zero-spawn assertion and AC-1's reduction run through the same code path — a
 * mocked-away spawn would prove neither.
 */
import type { LeanPiConfig } from "../../src/core/types.js";
import { spawnReducerProcess, type RtkSpawn } from "../../src/rtk/reducer.js";

export interface CountingSpawn {
	spawn: RtkSpawn;
	count(): number;
	commands: string[];
}

export function countingSpawn(inner: RtkSpawn = spawnReducerProcess): CountingSpawn {
	let calls = 0;
	const commands: string[] = [];
	return {
		count: () => calls,
		commands,
		spawn: (command, args, input, timeoutMs) => {
			calls += 1;
			commands.push(command);
			return inner(command, args, input, timeoutMs);
		},
	};
}

/** A `rtk` block that config.ts does not declare yet: read structurally, like PRD-015's `cost:`. */
export function rtkConfig(rtk: Record<string, unknown> = {}): LeanPiConfig {
	return { rtk } as unknown as LeanPiConfig;
}

/** The reducer command: the Node that is running this test, over stdin/stdout, like any other binary. */
export function reducerCommand(source: string): { binary: string; args: string[] } {
	return { binary: process.execPath, args: ["-e", source] };
}

export const REDUCING_REDUCER = `let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write("[rtk] "+s.split("\\n").length+" lines summarized\\n"));`;
export const FAILING_REDUCER = `process.stdin.resume();process.stdin.on("end",()=>process.exit(3));`;
export const HANGING_REDUCER = `process.stdin.resume();setTimeout(()=>{},5000);`;
