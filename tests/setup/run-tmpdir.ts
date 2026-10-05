/**
 * Every temp directory a suite run creates must go away with the run.
 *
 * Specs and fixtures call `mkdtempSync(join(tmpdir(), "leanpi-…"))` and never
 * remove the result. On a machine where `/tmp` is a tmpfs, those directories
 * live in RAM: tens of thousands of them filled it and the OOM killer took the
 * terminal running the agents. Cleaning each call site would not stay fixed,
 * so the run gets one parent directory instead.
 *
 * Global setup runs in the main process before the fork pool starts, so the
 * moved `$TMPDIR` reaches every worker and every subprocess a spec spawns, and
 * `os.tmpdir()` resolves inside it. Teardown removes the whole directory.
 * `$LEANPI_HOST_TMPDIR` keeps the real one for the spec that asserts this.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default function setup(): () => void {
	process.env.LEANPI_HOST_TMPDIR = tmpdir();
	const runDir = mkdtempSync(join(tmpdir(), "leanpi-run-"));
	process.env.TMPDIR = runDir;
	return () => rmSync(runDir, { recursive: true, force: true });
}
