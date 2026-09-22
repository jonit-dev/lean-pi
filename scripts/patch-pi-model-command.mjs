/**
 * Lets LeanPi's `/model` reach LeanPi.
 *
 * Pi's interactive editor resolves its own slash commands in a hardcoded chain
 * and only asks the extension runner after every one of them has missed:
 * `/model` is the third branch of `setupEditorSubmitHandler`, so an extension
 * that registers the name is never called and Pi prints "Extension command
 * '/model' conflicts with built-in interactive command. Skipping in
 * autocomplete." There is no override flag on `registerCommand`, no hook that
 * replaces a built-in selector, and extension commands are checked last by
 * construction — the name cannot be won through the extension API.
 *
 * So the branch is patched to ask first, using Pi's *own* helper: the same
 * `isExtensionCommand` the chain already calls at its end. An installation with
 * no extension claiming `/model` behaves exactly as before; LeanPi's picker wins
 * only where LeanPi registered it.
 *
 * Patched in place in Pi's bundle rather than vendored: the bundle is 8.3MB, and
 * copying the host into `vendor/` to change one condition would double the
 * published package. The launcher re-applies it on every start (idempotent, and
 * a `pnpm install` that restores Pi's file is repaired on the next run) and says
 * so out loud when it cannot, because a silent miss is indistinguishable from
 * the bug it fixes.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The exact strings claimed from Pi's build, and what they become. `this` is the
 * interactive mode: the submit handler is an arrow function on the instance, and
 * the line above the first one already calls `this.showModelsSelector()`.
 */
export const PI_MODEL_PATCHES = [
	{
		reason: "/model asks the extension runner before opening Pi's own selector",
		find: 'if(text==="/model"||text.startsWith("/model ")){',
		replace: 'if((text==="/model"||text.startsWith("/model "))&&!this.isExtensionCommand(text)){',
	},
	{
		// The startup panel warned that `/model` "conflicts with built-in
		// interactive command", which was true before the branch above and is
		// now the opposite of what happens: the extension answers it.
		reason: "the conflict diagnostic still reported the name it no longer loses",
		find: ".filter(command=>builtinNames.has(command.name))",
		replace: '.filter(command=>builtinNames.has(command.name)&&command.name!=="model")',
	},
];

/** The branch that decides whether a chunk is the interactive one at all. */
const ANCHOR = PI_MODEL_PATCHES[0];

/**
 * Pi's bundled chunks, where the interactive mode lives after bundling. Walked
 * up `node_modules` rather than resolved: Pi's `exports` map does not publish
 * its bundle, which is why `src/cli/launch.ts` finds the CLI the same way.
 */
export function piChunkDir(root = process.cwd()) {
	for (let dir = root; ; dir = dirname(dir)) {
		const candidate = join(dir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "chunks");
		if (existsSync(candidate)) return realpathSync(candidate);
		if (dirname(dir) === dir) throw new Error("pi's bundle is not installed under this project");
	}
}

/**
 * The chunk carrying the branch, already patched or not. Returned rather than
 * hardcoded: the chunk's name carries a content hash that moves with every Pi
 * release.
 */
export function findPiModelChunk(chunkDir) {
	for (const entry of readdirSync(chunkDir)) {
		if (!entry.endsWith(".js")) continue;
		const path = join(chunkDir, entry);
		const source = readFileSync(path, "utf8");
		if (source.includes(ANCHOR.replace)) return { path, source, patched: !source.includes(PI_MODEL_PATCHES[1].find) };
		if (source.includes(ANCHOR.find)) return { path, source, patched: false };
	}
	return undefined;
}

/**
 * Applies the patch, refusing when the claimed branch is not there exactly once.
 * An already-patched source is returned untouched, so a launcher may call this
 * on every start.
 */
export function applyPiModelPatch(source) {
	let patched = source;
	for (const { reason, find, replace } of PI_MODEL_PATCHES) {
		if (patched.includes(replace)) continue;
		const matches = patched.split(find).length - 1;
		if (matches !== 1) {
			throw new Error(`pi /model patch "${reason}" expected exactly one match, found ${matches}. Pi changed; re-verify the patch.`);
		}
		patched = patched.replace(find, replace);
	}
	return patched;
}

/**
 * Patch Pi in place. Never throws: the caller is a launcher, and a Pi release
 * that moved the branch must degrade to Pi's own `/model` with a reason, not to
 * a session that will not start.
 */
export function patchPiModelCommand(root = process.cwd()) {
	try {
		const chunk = findPiModelChunk(piChunkDir(root));
		if (chunk === undefined) return { status: "unavailable", reason: "pi's interactive bundle no longer carries the /model branch this patch claims" };
		if (chunk.patched) return { status: "already", file: chunk.path };
		writeFileSync(chunk.path, applyPiModelPatch(chunk.source));
		return { status: "patched", file: chunk.path };
	} catch (error) {
		return { status: "unavailable", reason: error instanceof Error ? error.message : String(error) };
	}
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const result = patchPiModelCommand(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
	process.stderr.write(`pi /model override: ${result.status}${result.reason ? ` — ${result.reason}` : ""}\n`);
}
