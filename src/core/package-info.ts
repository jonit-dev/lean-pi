/** Package identity, resolved from the repository/package root rather than a build-time constant. */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const LEANPI_EXTENSION_NAME = "leanpi";

function findPackageRoot(start: string): string {
	let dir = dirname(start);
	for (;;) {
		if (existsSync(join(dir, "package.json"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) throw new Error(`package root not found above ${start}`);
		dir = parent;
	}
}

export const PACKAGE_ROOT = findPackageRoot(fileURLToPath(import.meta.url));
export const LEANPI_VERSION: string = (
	JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as { version: string }
).version;
