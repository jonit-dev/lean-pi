/** Native ESM bridge to the exact classes embedded in Pi's bundled CLI. */
import { readFileSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { dependencyDir, packageRoot } from "./launch.js";

const root = packageRoot();
const chunks = dependencyDir("@earendil-works/pi-coding-agent/dist/bundle/chunks", root);
if (!chunks) throw new Error("Pi's bundled runtime is missing; reinstall leanpi.");
const bridges = readdirSync(chunks).filter((name) => /^virtual-modules-.*\.js$/.test(name));
if (bridges.length !== 1) throw new Error("Pi's bundled virtual module entry changed; rebuild LeanPi's extension bridge for this Pi release.");
export const piVirtualModules: Record<string, Record<string, unknown>> = (await import(pathToFileURL(join(chunks, bridges[0])).href)).VIRTUAL_MODULES;
const key = Symbol.for("leanpi.pi-virtual-modules");
(globalThis as Record<symbol, unknown>)[key] = piVirtualModules;

interface SourceGroup { source?: string; package?: string; output: string; version?: string; files: string[] }
const groups: SourceGroup[] = JSON.parse(readFileSync(join(root, "dist/extensions/manifest.json"), "utf8"));
const outputs = new Map<string, string>();
const sources = new Map<string, string>();
for (const group of groups) {
	const sourceRoot = group.package ? dependencyDir(group.package, root) : join(root, group.source!);
	if (!sourceRoot) throw new Error(`${group.package} is missing; reinstall leanpi.`);
	if (group.package && JSON.parse(readFileSync(join(sourceRoot, "package.json"), "utf8")).version !== group.version) {
		throw new Error(`${group.package} changed after extensions were compiled; rebuild or reinstall leanpi.`);
	}
	for (const file of group.files) {
		const source = pathToFileURL(join(sourceRoot, file)).href;
		const output = pathToFileURL(join(root, "dist/extensions", group.output, file.replace(/\.ts$/, ".js"))).href;
		outputs.set(source, output);
		sources.set(output, source);
	}
}

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (Object.hasOwn(piVirtualModules, specifier)) return { url: `leanpi-pi:${encodeURIComponent(specifier)}`, shortCircuit: true };
		const parentURL = sources.get(context.parentURL ?? "") ?? context.parentURL;
		if (parentURL && specifier.startsWith(".")) {
			const source = new URL(specifier, parentURL).href;
			// Dependencies ship both explicit .ts imports and extensionless imports.
			for (const candidate of [source, `${source}.ts`, source.replace(/\.js$/, ".ts"), `${source}/index.ts`]) {
				const output = outputs.get(candidate);
				if (output) return { url: output, shortCircuit: true };
			}
		}
		const resolved = nextResolve(specifier, { ...context, parentURL });
		return outputs.has(resolved.url) ? { ...resolved, url: outputs.get(resolved.url)! } : resolved;
	},
	load(url, context, nextLoad) {
		if (!url.startsWith("leanpi-pi:")) return nextLoad(url, context);
		const specifier = decodeURIComponent(url.slice("leanpi-pi:".length));
		const declarations = Object.keys(piVirtualModules[specifier]).map((name, index) =>
			`const e${index}=m[${JSON.stringify(name)}];export{e${index} as ${JSON.stringify(name)}};`,
		).join("");
		return { format: "module", source: `const m=globalThis[Symbol.for("leanpi.pi-virtual-modules")][${JSON.stringify(specifier)}];${declarations}`, shortCircuit: true };
	},
});
