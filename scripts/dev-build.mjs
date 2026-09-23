/**
 * Incremental transpile-only build for the launcher.
 *
 * `leanpi-local.sh` must not pay for a type check: `tsc -b` re-checks all ~1900
 * files (~6.5s) after any `src/` touch, while launching only needs `dist/*.js`
 * to be current. `tsc --noEmit` and the tests cover correctness, so this walks
 * the `src/` tree and transpiles only files whose `dist` output is missing or
 * older, reading the real compilerOptions from tsconfig.json.
 */
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = join(root, "src");
const outRoot = join(root, "dist");
const stale = [];
for (const rel of readdirSync(srcRoot, { recursive: true })) {
	if (!rel.endsWith(".ts") || rel.endsWith(".d.ts")) continue;
	const source = join(srcRoot, rel);
	const out = join(outRoot, rel.slice(0, -3) + ".js");
	if (existsSync(out) && statSync(out).mtimeMs >= statSync(source).mtimeMs) continue;
	stale.push([source, out, rel]);
}
// Nothing stale means nothing to build: importing `typescript` costs ~300ms,
// so it is not imported at all when no file needs it.
if (stale.length === 0) process.exit(0);

const { default: ts } = await import("typescript");
const { config, error } = ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile);
if (error) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, "\n"));
const { options } = ts.parseJsonConfigFileContent(config, ts.sys, root);

for (const [source, out, rel] of stale) {
	const { outputText, sourceMapText } = ts.transpileModule(ts.sys.readFile(source), {
		compilerOptions: { ...options, sourceMap: true },
		fileName: rel,
	});
	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(out, outputText);
	if (sourceMapText !== undefined) {
		// `fileName` is `src`-relative, so `transpileModule` writes `sources`
		// that resolve against the wrong directory; `tsc` names the source
		// relative to the map's own directory, and so must this.
		const map = JSON.parse(sourceMapText);
		map.sources = [relative(dirname(out), source)];
		writeFileSync(out + ".map", JSON.stringify(map));
	}
}
