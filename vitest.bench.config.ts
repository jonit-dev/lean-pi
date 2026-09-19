import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { defineConfig } from "vitest/config";

/** Resolve NodeNext-style `.js` specifiers against the TypeScript sources (see vitest.config.ts). */
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

/**
 * Benchmark lane only (`pnpm bench:skills`). Kept out of the default test suite
 * because a measured rate is evidence about the machine's corpus, not a unit
 * assertion: it may legitimately fail the configured ceiling.
 */
export default defineConfig({
	plugins: [tsSpecifierPlugin],
	test: {
		include: ["bench/**/*.bench.ts"],
		testTimeout: 300_000,
		pool: "forks",
	},
});
