/** Build the shipped extension sources and assets; runtime needs no TypeScript compiler. */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dependency = (name) => {
	for (let dir = root; ; dir = dirname(dir)) {
		const candidate = join(dir, "node_modules", name);
		if (existsSync(candidate)) return realpathSync(candidate);
		if (dirname(dir) === dir) throw new Error(`Cannot build extensions: ${name} is not installed`);
	}
};
const groups = [
	{ source: "extensions", output: "local" },
	{ source: "vendor/pi-thinking-fold", output: "thinking-fold" },
	...[
		"pi-claude-code-ui",
		"pi-patty-bg-tasks",
		"@hk_net/pi-usage-bars",
		"pi-context-view",
		"pi-web-search",
	].map((name) => ({ package: name, output: name })),
];

export async function buildExtensions() {
	const stale = [];
	for (const group of groups) {
		const sourceRoot = group.package ? dependency(group.package) : join(root, group.source);
		group.files = [];
		if (group.package) group.version = JSON.parse(readFileSync(join(sourceRoot, "package.json"), "utf8")).version;
		const walk = (directory) => {
			for (const entry of readdirSync(directory, { withFileTypes: true })) {
				if (entry.name === "node_modules" || entry.name === ".git") continue;
				const source = join(directory, entry.name);
				if (entry.isDirectory()) { walk(source); continue; }
				if (!entry.isFile()) continue;
				const path = relative(sourceRoot, source);
				const out = join(root, "dist/extensions", group.output, path.endsWith(".d.ts") ? path : path.replace(/\.ts$/, ".js"));
				if (!existsSync(out) || statSync(out).mtimeMs < statSync(source).mtimeMs) stale.push({ source, out, typescript: path.endsWith(".ts") && !path.endsWith(".d.ts"), local: group.output === "local" });
				if (/\.(?:[cm]?js|ts)$/.test(path) && !path.endsWith(".d.ts")) group.files.push(path);
			}
		};
		walk(sourceRoot);
		if (group.output === "thinking-fold") {
			const upstream = dependency("@99percentpeople/pi-thinking-fold");
			for (const file of ["LICENSE", "package.json", "README.md"]) {
				const source = join(upstream, file);
				const out = join(root, "dist/extensions", group.output, file);
				if (!existsSync(out) || statSync(out).mtimeMs < statSync(source).mtimeMs) stale.push({ source, out, typescript: false });
			}
		}
	}
	const ts = stale.some((file) => file.typescript) ? (await import("typescript")).default : undefined;
	for (const { source, out, typescript, local } of stale) {
		mkdirSync(dirname(out), { recursive: true });
		if (typescript) {
			const result = ts.transpileModule(readFileSync(source, "utf8"), {
				fileName: source,
				compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, isolatedModules: true, esModuleInterop: true },
			});
			// `extensions/<name>/` is copied to `dist/extensions/local/<name>/`,
			// one level deeper, so a specifier that climbed to the package root now
			// lands in `dist/extensions` and Pi reports "Cannot find module".
			const outputText = local ? result.outputText.replaceAll(/(["'])\.\.\/\.\.\/dist\//g, "$1../../../") : result.outputText;
			writeFileSync(out, outputText);
		} else copyFileSync(source, out);
	}
	const manifest = join(root, "dist/extensions/manifest.json");
	const content = JSON.stringify(groups);
	if (!existsSync(manifest) || readFileSync(manifest, "utf8") !== content) {
		mkdirSync(dirname(manifest), { recursive: true });
		writeFileSync(manifest, content);
	}
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildExtensions();
