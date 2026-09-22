import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("terminating an already-drained child does not keep the host process alive", () => {
	const source = new URL("../../src/runtime/proc.ts", import.meta.url).href;
	const script = `import {startProcess} from ${JSON.stringify(source)};
		const child = startProcess("true", {cwd: process.cwd()});
		await child.closed();
		await child.terminate();
		console.log("drained and terminated");`;
	const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
		encoding: "utf8",
		timeout: 2_000,
	});
	expect(output.trim()).toBe("drained and terminated");
});
