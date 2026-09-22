/**
 * Copies `@99percentpeople/pi-thinking-fold`'s build into `vendor/`, then applies
 * LeanPi's renderer patch to the copy.
 *
 * The package ships only `index.min.js`, and Pi native-imports a `.js`
 * extension instead of routing it through jiti's virtual-module map: its
 * `AssistantMessageComponent.prototype.updateContent` patch then lands on a
 * second copy of the class, and nothing that renders ever sees it. The same
 * bytes under a `.ts` name are transformed by jiti, resolve Pi's own modules,
 * and fold. `src/cli/spinner.ts` documents the identical trap.
 *
 * `model-behaviors.json` comes along because the extension reads it relative to
 * its own `import.meta.url`, so the two have to stay siblings.
 *
 * ## The patch
 *
 * Upstream streams a growing **tail preview** and can surface a summary headline
 * in the working status. LeanPi's `/thinking-fold` is binary: zero trace from the
 * first frame, Ctrl+T reveals the full trace, working status generic. Upstream's
 * persisted config is not a hook for that, so the copy is patched exactly and
 * guardedly: every `find` must match once or the build fails, which makes a
 * dependency bump a red build instead of a silent preview.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The exact strings claimed from the upstream build, and what they become.
 * Ordered: the resolver, the two raw-message fallbacks, the working-status
 * label, then the settings surface.
 */
export const THINKING_FOLD_PATCHES = [
	{
		reason: "always collapse a non-expanded block, so streaming is binary",
		find: 'function k(f,r,u){if(u)return r.completedBehavior==="auto"?"collapse":r.completedBehavior;if(r.streamingBehavior!=="auto")return r.streamingBehavior;return c(f,r.mode)==="summary"?"collapse":"preview"}',
		replace: 'function k(f,r,u){return"collapse"}',
	},
	{
		reason: "an unwrappable marker fell back to the raw full trace",
		find: "if(!M){r.renderedMessage=h,u.originalUpdate.call(f,h,r.isStreaming);return}",
		replace:
			'if(!M){let c0=V==="collapse"?Su(h,u.options,!1,0,1,{timing:i,now:u.now}):h;r.renderedMessage=c0,u.originalUpdate.call(f,c0,r.isStreaming);return}',
	},
	{
		reason: "a failed rewrap fell back to the raw full trace",
		find: ",!ru(f,M,V,u.options.previewLines,Z,J))r.renderedMessage=h,u.originalUpdate.call(f,h,r.isStreaming)}",
		replace:
			',!ru(f,M,V,u.options.previewLines,Z,J)){let c0=V==="collapse"?Su(h,u.options,!1,0,1,{timing:i,now:u.now}):h;r.renderedMessage=c0,u.originalUpdate.call(f,c0,r.isStreaming)}}',
	},
	{
		reason: "a summary headline leaked into the working status while collapsed",
		find: "let n=D(J,u.options.mode);if(n===V)return;V=n,B.ui.setWorkingMessage(n)",
		replace: "let n=U;if(n===V)return;V=n,B.ui.setWorkingMessage(n)",
	},
	{
		reason: "the settings rows still offered preview and displayed persisted preview/full values",
		find: 'settings:()=>[{id:"foldThreshold",label:"Fold after lines",description:"Show at most this many terminal-visible lines in a preview",currentValue:String(r.foldThreshold),values:Ju(r.foldThreshold)},{id:"streamingBehavior",label:"While thinking",description:"Auto hides summaries and previews traces while they stream",currentValue:r.streamingBehavior,values:["auto","preview","collapse"]},{id:"completedBehavior",label:"After thinking",description:"Auto hides completed content for every model",currentValue:r.completedBehavior,values:["auto","collapse","preview","full"]}],onChange:(B,$,n)=>{if(B==="foldThreshold")o({...r,foldThreshold:Number($)},n);else if(B==="streamingBehavior"&&($==="auto"||$==="preview"||$==="collapse"))o({...r,streamingBehavior:$},n);else if(B==="completedBehavior"&&($==="auto"||$==="collapse"||$==="preview"||$==="full"))o({...r,completedBehavior:$},n)}}',
		replace: 'settings:()=>[{id:"reasoning",label:"Reasoning",description:"Collapsed to one line while streaming; ctrl+t expands the full trace",currentValue:"collapse"}],onChange:()=>{}}',
	},
];

/** Applies every patch, refusing to run if a claimed string is not there exactly once. */
export function applyThinkingFoldPatches(source) {
	let patched = source;
	for (const { reason, find, replace } of THINKING_FOLD_PATCHES) {
		const matches = patched.split(find).length - 1;
		if (matches !== 1) {
			throw new Error(`thinking-fold vendor patch "${reason}" expected exactly one match, found ${matches}. Upstream changed; re-verify the patch.`);
		}
		patched = patched.replace(find, replace);
	}
	return patched;
}

function vendor() {
	const source = dirname(createRequire(import.meta.url).resolve("@99percentpeople/pi-thinking-fold/index.min.js"));
	const target = join(root, "vendor", "pi-thinking-fold");
	mkdirSync(target, { recursive: true });
	writeFileSync(join(target, "index.min.ts"), applyThinkingFoldPatches(readFileSync(join(source, "index.min.js"), "utf8")));
	copyFileSync(join(source, "model-behaviors.json"), join(target, "model-behaviors.json"));
	process.stderr.write(`vendored pi-thinking-fold (patched) -> ${target}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) vendor();
