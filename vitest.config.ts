import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { defineConfig } from "vitest/config";

/**
 * NodeNext TypeScript requires explicit `.js` specifiers on relative imports so
 * `tsc`'s output runs under Node ESM (`pi --extension ./dist/index.js`). Vitest
 * resolves the same specifier against the `.ts` source here.
 */
const tsSpecifierPlugin = {
	name: "leanpi-ts-specifier",
	enforce: "pre" as const,
	resolveId(source: string, importer?: string) {
		if (!importer || !source.startsWith(".") || !source.endsWith(".js")) return null;
		if (importer.includes("node_modules")) return null;
		const candidate = resolve(dirname(importer), `${source.slice(0, -3)}.ts`);
		return existsSync(candidate) ? candidate : null;
	},
};

export default defineConfig({
	plugins: [tsSpecifierPlugin],
	test: {
		include: ["tests/**/*.spec.ts", "tests/**/*.test.ts"],
		// Integration specs boot real Pi sessions and real stub HTTP servers.
		testTimeout: 30_000,
		hookTimeout: 30_000,
		pool: "forks",
	},
});
