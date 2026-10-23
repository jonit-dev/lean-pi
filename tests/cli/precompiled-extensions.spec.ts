import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { launchPlan } from "../../src/cli/launch.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
	const cwd = mkdtempSync(join(tmpdir(), "leanpi-compiled-"));
	temporary.push(cwd);
	const agentDir = join(cwd, "agent");
	mkdirSync(agentDir);
	writeFileSync(join(cwd, "leanpi.config.yaml"), JSON.stringify({
		backends: { local: { type: "native", baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "stub" } },
		models: Object.fromEntries(["quick", "balanced", "strong"].map((role) => [role, { backend: "local", model: "stub" }])),
		jev: { mode: "disabled" },
	}));
	const env: NodeJS.ProcessEnv = { ...process.env, HOME: cwd, XDG_CONFIG_HOME: cwd, PI_CODING_AGENT_DIR: agentDir, LEANPI_CWD: cwd, LEANPI_NO_JEV: "1", PI_OFFLINE: "1", PI_TIMING: "1" };
	delete env.LEANPI_T0;
	return { cwd, env };
}

const probe = `
import assert from 'node:assert/strict';
import {registerHooks,createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
const root=process.argv[1];
const {piVirtualModules:modules}=await import(pathToFileURL(join(root,'dist/cli/extension-loader.js')));
let typescriptLoads=0;
registerHooks({load(url,context,nextLoad){if(/\\.ts(?:\\?|$)/.test(url)){typescriptLoads++;throw new Error('Runtime TypeScript load: '+url)}return nextLoad(url,context)}});
const sdk=await import('@earendil-works/pi-coding-agent');
const tui=await import('@earendil-works/pi-tui');
for(const key of ['ToolExecutionComponent','AssistantMessageComponent']) assert.equal(sdk[key].prototype,modules['@earendil-works/pi-coding-agent'][key].prototype);
assert.equal(tui.Loader,modules['@earendil-works/pi-tui'].Loader);
assert.equal(tui.TUI_KEYBINDINGS,modules['@earendil-works/pi-tui'].TUI_KEYBINDINGS);
const {launchPlan}=await import(pathToFileURL(join(root,'dist/cli/launch.js')));
const subagents=createRequire(pathToFileURL(join(root,'package.json'))).resolve('pi-subagents');
const plan=launchPlan([],root,undefined,'compact',true,subagents);
const entries=plan.args.flatMap((arg,index)=>arg==='--extension'?[plan.args[index+1]]:[]);
assert(entries.every(path=>path.endsWith('.js')));
const before=sdk.ToolExecutionComponent.prototype.getCallRenderer;
const loaded=await sdk.discoverAndLoadExtensions(entries,process.cwd(),process.env.PI_CODING_AGENT_DIR);
assert.deepEqual(loaded.errors,[]);
assert.notEqual(sdk.ToolExecutionComponent.prototype.getCallRenderer,before);
const {installSpinnerFrames,SPINNER_FRAMES}=await import(pathToFileURL(join(root,'dist/cli/spinner.js')));
installSpinnerFrames();
let text;
tui.Loader.prototype.updateDisplay.call({currentFrame:0,message:'working',messageColorFn:x=>x,spinnerColorFn:x=>x,setText:x=>text=x});
assert.equal(text,SPINNER_FRAMES[0]+' working');
const previous=sdk.AssistantMessageComponent.prototype.render;
const {installFoldCacheInvalidation}=await import(pathToFileURL(join(root,'dist/cli/fold-cache.js')));
assert.equal(installFoldCacheInvalidation(),true);
assert.notEqual(sdk.AssistantMessageComponent.prototype.render,previous);
assert.equal(typescriptLoads,0);
console.log(JSON.stringify({entries:loaded.extensions.length,typescriptLoads,identity:true}));
process.exit(0);
`;

function runProbe(packageRoot: string, app: ReturnType<typeof fixture>) {
	return spawnSync(process.execPath, ["--import", pathToFileURL(join(packageRoot, "dist/cli/extension-loader.js")).href, "--input-type=module", "--eval", probe, packageRoot], { ...app, encoding: "utf8", timeout: 20_000 });
}

describe("precompiled default extensions", () => {
	it("hands Pi JavaScript paths for every shipped extension, including dependency TypeScript", () => {
		const subagents = createRequire(import.meta.url).resolve("pi-subagents");
		const plan = launchPlan([], undefined, undefined, "compact", true, subagents);
		const entries = plan.args.flatMap((arg, index) => arg === "--extension" ? [plan.args[index + 1]] : []);
		expect(entries.length).toBeGreaterThan(5);
		expect(entries.filter((entry) => !entry?.endsWith(".js"))).toEqual([]);
	});
	it("declares the exact install versions its compiled dependency sidecars require", () => {
		const manifest = JSON.parse(readFileSync(join(root, "dist/extensions/manifest.json"), "utf8"));
		const installed = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
		for (const group of manifest) {
			if (group.package) expect(installed.dependencies[group.package], group.package).toBe(group.version);
		}
	});
	it("loads dependency TypeScript as precompiled JavaScript and patches Pi's exact runtime prototypes", () => {
		const result = runProbe(root, fixture());
		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({ typescriptLoads: 0, identity: true });
	});

	it("reports only JavaScript default extensions in real Pi startup timings", () => {
		const app = fixture();
		const subagents = createRequire(import.meta.url).resolve("pi-subagents");
		const plan = launchPlan([], undefined, undefined, "compact", true, subagents);
		const result = spawnSync(process.execPath, ["--import", pathToFileURL(join(root, "dist/cli/extension-loader.js")).href, plan.cli, ...plan.args, "--offline", "--mode", "rpc", "--no-session"], { ...app, encoding: "utf8", input: "", timeout: 20_000 });
		expect(result.status, result.stderr).toBe(0);
		const pi_timing = result.stderr.split("\n").filter((line) => !line.trim().startsWith("builtin:") && (line.includes(" module import:") || line.includes(" factory:")));
		expect(pi_timing.length).toBeGreaterThan(10);
		expect(pi_timing.every((line) => /\.js (?:module import|factory):/.test(line)), pi_timing.join("\n")).toBe(true);
	});

	it("works after npm pack and relocation with hoisted dependencies and no local extension sources", () => {
		const app = fixture();
		const packed = spawnSync("npm", ["pack", "--json", "--pack-destination", app.cwd], { cwd: root, encoding: "utf8", timeout: 60_000 });
		expect(packed.status, packed.stderr).toBe(0);
		const filename = JSON.parse(packed.stdout).at(-1).filename;
		const unpacked = spawnSync("tar", ["-xzf", join(app.cwd, filename), "-C", app.cwd], { encoding: "utf8" });
		expect(unpacked.status, unpacked.stderr).toBe(0);
		const relocated = join(app.cwd, "relocated package");
		renameSync(join(app.cwd, "package"), relocated);
		const packageManifest = JSON.parse(readFileSync(join(relocated, "package.json"), "utf8"));
		const sidecars = JSON.parse(readFileSync(join(relocated, "dist/extensions/manifest.json"), "utf8"));
		for (const group of sidecars) {
			if (group.package) expect(packageManifest.dependencies[group.package], group.package).toBe(group.version);
		}
		symlinkSync(join(root, "node_modules"), join(app.cwd, "node_modules"), "dir");
		rmSync(join(relocated, "extensions"), { recursive: true });
		rmSync(join(relocated, "vendor", "pi-thinking-fold"), { recursive: true });
		const result = runProbe(relocated, app);
		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({ typescriptLoads: 0, identity: true });
		expect(readFileSync(join(relocated, "dist/extensions/@hk_net/pi-usage-bars/LICENSE"), "utf8")).toBe(readFileSync(join(root, "node_modules/@hk_net/pi-usage-bars/LICENSE"), "utf8"));
		expect(readFileSync(join(relocated, "dist/extensions/thinking-fold/LICENSE"), "utf8")).toBe(readFileSync(join(root, "node_modules/@99percentpeople/pi-thinking-fold/LICENSE"), "utf8"));
	}, 60_000);
});
