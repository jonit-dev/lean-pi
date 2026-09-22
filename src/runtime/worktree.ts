/**
 * Worktree isolation for bounded executions (PRD-022 Phase 4, AC-6–AC-9,
 * ROADMAP §60).
 *
 * One module wrapping `git worktree` — no container runtime, no second VCS. A
 * run gets `<primary-repo>/.worktrees/<runId>` on a detached HEAD at the run's
 * base commit, so the operator's checkout is never the executor's working
 * directory and `git status` there stays untouched. On completion the module
 * surfaces a patch keyed by run id (`git diff` against the base plus a manifest
 * of untracked files) and then reclaims the directory.
 *
 * The destructive path is where the care is:
 *
 * - Every mutation — create, remove, prune — requests PRD-017's
 *   `destructive git operations` scope first. `deny` refuses before a directory
 *   exists; `ask` prompts with the scope and the concrete path; no confirmation
 *   channel means the answer is no, exactly as PRD-017's guard behaves without a
 *   UI.
 * - Removal requires an inactive owner and a complete, matching saved patch.
 *   Ignored files, unknown commits and changed content retain the checkout.
 * - Only represented changes are restored or removed before ordinary Git
 *   removal. No force removal or blanket cleaning is used.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { LeanPiConfig } from "../core/types.js";
import { builtinPermissions, capabilityId, resolveAll, type GuardQuestion, type PermissionsConfig, type Resolution } from "../permissions/index.js";
import { porcelainPaths, primaryRepoRoot } from "./git.js";
import { ensureGitIgnored } from "./ignore.js";

/** ROADMAP §47's scope for branch/worktree mutations; PRD-017 owns the name. */
const DESTRUCTIVE_GIT_SCOPE = "git_destructive";

/**
 * The default run root, relative to the owning primary repository. Every
 * worktree this product creates lives under `<primary-repo>/.worktrees/`, the
 * same project-local placement the agent worktree convention uses.
 */
const DEFAULT_RUN_ROOT = ".worktrees";

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface UntrackedFile {
	path: string;
	content: string;
	encoding: "utf8" | "base64";
}

/** Everything needed to reproduce a run's work somewhere else, keyed by the run it came from. */
export interface WorktreePatch {
	runId: string;
	baseCommit: string;
	/** `git diff --binary <base>` for tracked additions, modifications and deletions. */
	diff: string;
	/**
	 * A single standard binary-capable diff against `baseCommit` covering tracked
	 * edits *and* new files, produced through a temporary index so the worktree's
	 * own index is never touched. This is what the surfaced `.diff` carries and
	 * what `applyPatch` prefers; absent on a legacy manifest, where `diff` plus
	 * `untracked` is the only representation.
	 */
	completeDiff?: string;
	/** Files git does not track, content included verbatim. */
	untracked: UntrackedFile[];
	/** Every path the patch represents: tracked diff paths plus untracked files, sorted. */
	paths: string[];
	/** sha256 of each existing path's worktree content; `"deleted"` marks a deleted path. */
	hashes: Record<string, string>;
}

export type CleanupResult =
	| { removed: true; path: string }
	| {
			removed: false;
			path: string;
			reason: string;
			/** Worktree paths the patch does not represent. */
			paths: string[];
			/** Commits present in the worktree and absent from the patch. */
			commits: string[];
	  };

export interface CleanupOptions {
	repoRoot: string;
	root?: string;
	/**
	 * The patch already surfaced for this run. Removal is refused for any worktree
	 * state it does not represent — including every dirty path when it is absent.
	 */
	patch?: WorktreePatch;
}

export interface WorktreeRun<T> {
	runId: string;
	/** The worktree the executor ran in: evidence collected here is stamped with this tree's hash. */
	path: string;
	baseCommit: string;
	result: T;
	patch: WorktreePatch;
	/** Absent when the worktree was kept rather than reclaimed. */
	cleanup?: CleanupResult;
}

/** The `ask` channel's answer, named separately so a caller can render it. */
export interface WorktreePermissionRequest extends GuardQuestion {
	action: "add" | "remove" | "prune";
	/** The concrete worktree path this operation will touch. */
	path: string;
}

export interface WorktreeRunOptions<T> {
	/** The repository the worktree is created from — never the executor's working directory. */
	repoRoot: string;
	/** The bounded execution, handed the worktree as its working directory. */
	run(cwd: string): Promise<T>;
	/** Overrides the run root; a relative path resolves against `repoRoot`. */
	root?: string;
	/** The commit the worktree starts from. Defaults to `HEAD`. */
	baseRef?: string;
	/**
	 * Leave the worktree in place and skip reclamation — what a killed executor
	 * leaves behind, and what a caller that wants to inspect the tree asks for.
	 * `pruneOrphans` can reclaim it after confirming that its owner has stopped.
	 */
	keep?: boolean;
	/** PRD-017's effective permissions. Defaults to `builtinPermissions()`, where the scope is `deny`. */
	permissions?: PermissionsConfig;
	/** The `ask` channel. Absent means an `ask` resolves to a refusal, as PRD-017's guard does without a UI. */
	confirm?: (request: WorktreePermissionRequest) => boolean | Promise<boolean>;
	/**
	 * Called with the surfaced patch before reclamation, on success and on failure
	 * alike, so a caller can persist a failed run's work before its directory is
	 * reclaimed. Synchronous on purpose: it must complete before cleanup removes
	 * the tree the patch describes. If it throws, the directory is retained and
	 * `onCleanup` reports that rather than discarding the work.
	 */
	onPatch?: (patch: WorktreePatch) => void;
	/**
	 * Called with the actual cleanup outcome, on success and on failure alike, so
	 * a caller can surface whether the checkout was reclaimed or retained and why.
	 */
	onCleanup?: (result: CleanupResult) => void;
}

export interface OrphanReclamation {
	runId: string;
	path: string;
	removed: boolean;
	reason?: string;
	/** Where the reclaimed run's patch was written before its directory was removed. */
	patchPath?: string;
}

export class WorktreePermissionError extends Error {
	readonly scope = DESTRUCTIVE_GIT_SCOPE;
	readonly capability: string;
	readonly path: string;
	readonly decision: Resolution;

	constructor(message: string, capability: string, path: string, decision: Resolution) {
		super(message);
		this.name = "WorktreePermissionError";
		this.capability = capability;
		this.path = path;
		this.decision = decision;
	}
}

export class PatchAlreadyAppliedError extends Error {
	readonly runId: string;
	readonly targetRoot: string;

	constructor(runId: string, targetRoot: string) {
		super(`the patch for run ${runId} was already applied to ${targetRoot}: applying it twice would duplicate its work`);
		this.name = "PatchAlreadyAppliedError";
		this.runId = runId;
		this.targetRoot = targetRoot;
	}
}

/** The prompt text an `ask` decision presents; it names the scope and the concrete path. */
export function worktreePermissionPrompt(request: WorktreePermissionRequest): string {
	return `LeanPi asks to ${request.action} a git worktree under scope "${DESTRUCTIVE_GIT_SCOPE}" at ${request.path} (${request.capability}).`;
}

/**
 * Run git and return exactly what it wrote. Nothing is trimmed: porcelain's
 * leading status column and a patch's trailing newline are both significant, so
 * a caller that wants a scalar trims it at the call site.
 */
function git(repoRoot: string, args: string[], input?: string): string {
	try {
		return execFileSync("git", args, {
			cwd: repoRoot,
			encoding: "utf8",
			stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
			...(input === undefined ? {} : { input }),
		});
	} catch (error) {
		const stderr = (error as { stderr?: string }).stderr?.trim();
		throw new Error(`git ${args.join(" ")} failed in ${repoRoot}${stderr ? `: ${stderr}` : ""}`);
	}
}

function sha256(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** The nearest existing ancestor's real path with the not-yet-created suffix appended, so a symlinked ancestor cannot smuggle a root outside the owner. */
function realpathConfined(path: string): string {
	let current = path;
	const missing: string[] = [];
	while (!existsSync(current)) {
		const parent = dirname(current);
		if (parent === current) break;
		missing.unshift(basename(current));
		current = parent;
	}
	const real = existsSync(current) ? realpathSync(current) : current;
	return missing.length === 0 ? real : join(real, ...missing);
}

/** A strict descendant of `owner` (never equal to it, never on another branch). */
function isInside(owner: string, candidate: string): boolean {
	const rel = relative(owner, candidate);
	return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Runs stay in the primary repository's .worktrees namespace, outside linked checkouts. */
export function worktreeRoot(repoRoot: string, root?: string): string {
	const owner = realpathConfined(primaryRepoRoot(repoRoot));
	const namespace = join(owner, DEFAULT_RUN_ROOT);
	const candidate = realpathConfined(root === undefined ? namespace : resolve(owner, root));
	if (candidate !== namespace && !isInside(namespace, candidate)) {
		throw new Error(`worktree root ${candidate} escapes the owning repository .worktrees namespace ${namespace}`);
	}
	if (!existsSync(join(owner, ".git"))) return candidate;
	for (const linked of registeredWorktrees(owner)) {
		if (linked !== owner && (candidate === linked || isInside(linked, candidate))) {
			throw new Error(`worktree root ${candidate} is inside another linked checkout ${linked}`);
		}
	}
	return candidate;
}

/**
 * The run root a configuration declares, else the documented default. The
 * declared value is preserved; a relative path resolves under the owning primary
 * repository, so a custom location still stays project-local.
 *
 * ```yaml
 * workspace:
 *   worktreeRoot: .worktrees
 * ```
 */
export function worktreeRootOf(config: LeanPiConfig | undefined, repoRoot: string): string {
	const declared = config?.workspace?.worktreeRoot;
	return worktreeRoot(repoRoot, typeof declared === "string" && declared.trim().length > 0 ? declared : undefined);
}

/** The worktree path for one run. `runId` is a path segment, so it is validated, not sanitized. */
export function worktreePath(repoRoot: string, runId: string, root?: string): string {
	if (!RUN_ID_PATTERN.test(runId) || runId === "." || runId === "..") {
		throw new Error(`invalid run id ${JSON.stringify(runId)}: an isolated run's id must be a single safe path segment`);
	}
	const runRoot = worktreeRoot(repoRoot, root);
	const path = join(runRoot, runId);
	if (!isInside(runRoot, realpathConfined(path))) throw new Error(`run path ${path} escapes its worktree root`);
	return path;
}

/**
 * Worktrees live inside the repository, so the run root must be excluded from
 * `git status` or every run would dirty the checkout it was meant to protect.
 */
export function ensureRunRootIgnored(repoRoot: string, root?: string): void {
	const owner = primaryRepoRoot(repoRoot);
	ensureGitIgnored(owner, relative(owner, worktreeRoot(repoRoot, root)));
}

/** Ask PRD-017's permission engine, then honour its answer. A refusal throws before anything is created. */
async function authorize(request: WorktreePermissionRequest, options: { permissions?: PermissionsConfig; confirm?: WorktreeRunOptions<unknown>["confirm"] }): Promise<void> {
	const decision = resolveAll([request.capability], options.permissions ?? builtinPermissions()).deciding;
	if (decision.decision === "allow") return;
	if (decision.decision === "deny") {
		throw new WorktreePermissionError(
			`LeanPi refused this worktree ${request.action}: scope "${DESTRUCTIVE_GIT_SCOPE}", capability "${request.capability}" (${decision.source} decision: deny; nothing was created at ${request.path}).`,
			request.capability,
			request.path,
			decision,
		);
	}
	const approved = options.confirm ? await options.confirm(request) : false;
	if (!approved) {
		throw new WorktreePermissionError(
			`LeanPi refused this worktree ${request.action}: scope "${DESTRUCTIVE_GIT_SCOPE}", capability "${request.capability}" (the confirmation prompt for ${request.path} was declined or unavailable; nothing was created).`,
			request.capability,
			request.path,
			decision,
		);
	}
}

function stampPath(runRoot: string, runId: string): string {
	return join(runRoot, `${runId}.base`);
}

function readBaseStamp(runRoot: string, runId: string): string | undefined {
	const path = stampPath(runRoot, runId);
	const base = existsSync(path) ? readFileSync(path, "utf8").trim() : "";
	return /^[a-f0-9]{40,64}$/.test(base) ? base : undefined;
}

/** Missing or corrupt ownership is never proof that a checkout is abandoned. */
function ownerPath(runRoot: string, runId: string): string {
	return join(runRoot, `${runId}.owner`);
}

function ownerInactive(runRoot: string, runId: string): boolean {
	try {
		const owner: unknown = JSON.parse(readFileSync(ownerPath(runRoot, runId), "utf8"));
		if (owner === null) return true;
		if (typeof owner !== "number" || !Number.isSafeInteger(owner) || owner <= 1) return false;
		try { process.kill(owner, 0); return false; }
		catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
	} catch { return false; }
}

function fileHash(path: string): string {
	try {
		return sha256(lstatSync(path).isSymbolicLink() ? Buffer.from(readlinkSync(path)) : readFileSync(path));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "deleted";
		throw error;
	}
}

/** The command a scope request names, so PRD-017's glob rules can match the concrete operation. */
function worktreeCommand(action: WorktreePermissionRequest["action"], path: string, baseRef?: string): string {
	return action === "add" ? `git worktree add --detach ${path} ${baseRef ?? "HEAD"}` : action === "remove" ? `git worktree remove ${path}` : "git worktree prune";
}

/** The scope request for one worktree operation. */
export function worktreePermissionRequest(action: WorktreePermissionRequest["action"], path: string, baseRef?: string): WorktreePermissionRequest {
	return {
		capability: capabilityId(DESTRUCTIVE_GIT_SCOPE, worktreeCommand(action, path, baseRef)),
		scopes: [DESTRUCTIVE_GIT_SCOPE],
		target: path,
		action,
		path,
	};
}

/**
 * One standard diff against `baseCommit` covering tracked edits and new files.
 *
 * Built through a throwaway index (`GIT_INDEX_FILE`): `read-tree` seeds it from
 * the base, `add -A` stages the worktree's tracked changes and untracked files,
 * and `diff --cached --binary` renders the whole result. The worktree's own index
 * is never opened. Capture errors propagate so cleanup cannot discard an
 * incompletely represented result.
 */
function completeDiffOf(worktree: string, baseCommit: string): string {
	const dir = mkdtempSync(join(tmpdir(), "leanpi-index-"));
	try {
		const env = { ...process.env, GIT_INDEX_FILE: join(dir, "index") };
		const run = (args: string[]): string => execFileSync("git", args, { cwd: worktree, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
		run(["read-tree", baseCommit]);
		run(["add", "-A", "--", "."]);
		return run(["diff", "--cached", "--binary", baseCommit, "--"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * Describe the worktree's difference from its base commit: the tracked diff plus
 * every untracked file's content. Deterministic and self-describing — the
 * recorded hashes are what `applyPatch` proves against.
 */
export function surfacePatch(runId: string, options: { repoRoot: string; root?: string }): WorktreePatch {
	const runRoot = worktreeRoot(options.repoRoot, options.root);
	const path = worktreePath(options.repoRoot, runId, options.root);
	const baseCommit = readBaseStamp(runRoot, runId);
	if (baseCommit === undefined) {
		throw new Error(`run ${runId} has no base stamp at ${stampPath(runRoot, runId)}: its patch cannot be described without one`);
	}
	const diff = git(path, ["diff", "--binary", baseCommit, "--"]);
	const untracked: UntrackedFile[] = [];
	const hashes: Record<string, string> = {};
	const paths = new Set<string>();
	for (const tracked of porcelainPaths(git(path, ["status", "--porcelain", "-z", "--untracked-files=all", "--", ":/"]))) {
		paths.add(tracked);
		const absolute = join(path, tracked);
		hashes[tracked] = fileHash(absolute);
	}
	// `-z` output is NUL-delimited and unquoted, so a filename with a space, a
	// newline, a quote or a leading dash is read exactly as git wrote it.
	for (const untrackedPath of git(path, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0")) {
		if (untrackedPath.length === 0) continue;
		// A symlink's identity is in completeDiff; never copy its target bytes.
		if (lstatSync(join(path, untrackedPath)).isSymbolicLink()) continue;
		const bytes = readFileSync(join(path, untrackedPath));
		const utf8 = bytes.toString("utf8");
		const encoding = Buffer.from(utf8, "utf8").equals(bytes) ? "utf8" : "base64";
		untracked.push({ path: untrackedPath, content: encoding === "utf8" ? utf8 : bytes.toString("base64"), encoding });
		paths.add(untrackedPath);
		hashes[untrackedPath] = sha256(bytes);
	}
	const completeDiff = completeDiffOf(path, baseCommit);
	return { runId, baseCommit, diff, completeDiff, untracked, paths: [...paths].sort(), hashes };
}

function appliedLedgerPath(targetRoot: string, root?: string): string {
	return join(worktreeRoot(targetRoot, root), "applied.json");
}

function readLedger(targetRoot: string, root?: string): Record<string, string> {
	const path = appliedLedgerPath(targetRoot, root);
	if (!existsSync(path)) return {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
	} catch {
		// An unreadable ledger means "nothing recorded", and the hash check below still guards the apply.
		return {};
	}
}

/** A patch target path, refused before any mutation when it is absolute, climbs out, or resolves outside `targetRoot` through a symlink. */
function confinedTarget(targetRoot: string, entry: string): string {
	if (entry.length === 0 || isAbsolute(entry)) {
		throw new Error(`refusing to apply a patch path ${JSON.stringify(entry)}: it must be a relative path inside ${targetRoot}`);
	}
	const absolute = resolve(targetRoot, entry);
	const owner = realpathConfined(targetRoot);
	const rel = relative(owner, realpathConfined(absolute));
	if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) {
		throw new Error(`refusing to apply a patch path ${JSON.stringify(entry)}: it escapes ${targetRoot}`);
	}
	return absolute;
}

/** Refuse a manifest write that would overwrite an existing file with different content. */
function preflightUntracked(targetRoot: string, patch: WorktreePatch): void {
	for (const file of patch.untracked) {
		const absolute = confinedTarget(targetRoot, file.path);
		if (!existsSync(absolute)) continue;
		const expected = Buffer.from(file.content, file.encoding);
		if (!readFileSync(absolute).equals(expected)) {
			throw new Error(`refusing to apply run ${patch.runId}: ${file.path} already exists with different content; nothing was written`);
		}
	}
}

/**
 * Apply a surfaced patch to `targetRoot`. Every path is checked before anything
 * mutates: an escaping path, a conflicting user file, or a diff whose preimage no
 * longer matches is refused by `git apply --check` (and the manifest preflight)
 * before a single byte lands, so a refused apply never partially applies tracked
 * edits or overwrites the operator's work. A complete diff (tracked edits and new
 * files) is preferred; a legacy manifest falls back to its tracked diff plus
 * untracked writes. Every recorded hash is re-checked afterwards. A run whose
 * patch was already applied is rejected rather than applied twice.
 */
export function applyPatch(patch: WorktreePatch, targetRoot: string, options: { root?: string } = {}): { paths: string[] } {
	const ledger = readLedger(targetRoot, options.root);
	if (ledger[patch.runId] !== undefined) throw new PatchAlreadyAppliedError(patch.runId, targetRoot);
	ensureRunRootIgnored(targetRoot, options.root);
	// Preflight every path this patch claims, before any mutation.
	for (const entry of new Set([...patch.paths, ...Object.keys(patch.hashes), ...patch.untracked.map(file => file.path)])) confinedTarget(targetRoot, entry);
	preflightUntracked(targetRoot, patch);
	const diff = patch.completeDiff ?? patch.diff;
	if (diff.trim().length > 0) {
		git(targetRoot, ["apply", "--check", "--binary", "--whitespace=nowarn", "-"], diff);
		git(targetRoot, ["apply", "--binary", "--whitespace=nowarn", "-"], diff);
	}
	if (patch.completeDiff === undefined) for (const file of patch.untracked) {
		const absolute = confinedTarget(targetRoot, file.path);
		mkdirSync(dirname(absolute), { recursive: true });
		writeFileSync(absolute, Buffer.from(file.content, file.encoding));
	}
	for (const [entry, expected] of Object.entries(patch.hashes)) {
		// Paths were confined before apply; hashing reads link identity, not its target.
		const found = fileHash(resolve(targetRoot, entry));
		if (found !== expected) {
			throw new Error(`applying run ${patch.runId} did not reproduce ${entry}: expected ${expected}, found ${found}`);
		}
	}
	mkdirSync(worktreeRoot(targetRoot, options.root), { recursive: true });
	writeFileSync(appliedLedgerPath(targetRoot, options.root), JSON.stringify({ ...ledger, [patch.runId]: new Date().toISOString() }, null, 2));
	return { paths: patch.paths };
}

/** The dirty paths of a worktree whose content no longer matches the patch that claims to represent them. */
function driftedPaths(path: string, patch: WorktreePatch): string[] {
	return Object.entries(patch.hashes)
		.filter(([entry, expected]) => {
			const absolute = join(path, entry);
			return fileHash(absolute) !== expected;
		})
		.map(([entry]) => entry);
}

/**
 * Reclaim one run's worktree. Idempotent: a directory that is already gone is a
 * success. Removal is refused — naming what it cannot account for — when the
 * worktree holds a dirty path the patch does not represent, a path whose content
 * changed after the patch was surfaced, a commit the patch does not carry, or
 * any dirty state at all when no patch was ever surfaced.
 *
 * The patch is an input rather than something re-derived here on purpose: a
 * patch re-surfaced at removal time would silently cover work done *after* the
 * operator was shown what the run produced. Only represented changes can be
 * restored before ordinary Git removal.
 */
export function cleanup(runId: string, options: CleanupOptions): CleanupResult {
	const runRoot = worktreeRoot(options.repoRoot, options.root);
	const path = worktreePath(options.repoRoot, runId, options.root);
	if (!existsSync(path)) {
		rmSync(stampPath(runRoot, runId), { force: true });
		rmSync(ownerPath(runRoot, runId), { force: true });
		return { removed: true, path };
	}
	const baseCommit = readBaseStamp(runRoot, runId);
	// Ownership, not mere existence, is what permits reclamation. Without the
	// `<runId>.base` stamp this is not an exact run this module created, and a
	// clean directory that merely sits under the shared `.worktrees/` root (a
	// developer's own checkout, a sibling task) must never be removed.
	if (baseCommit === undefined) {
		return {
			removed: false,
			path,
			reason: `run ${runId} has no ownership stamp at ${stampPath(runRoot, runId)}; its directory was kept and nothing was forced`,
			paths: [],
			commits: [],
		};
	}
	if (!ownerInactive(runRoot, runId) || !registeredWorktrees(options.repoRoot).has(realpathConfined(path))) {
		return { removed: false, path, reason: "the checkout has a live or unknown owner, or is not the registered run; it was kept", paths: [], commits: [] };
	}
	const unmerged = git(path, ["diff", "--name-only", "--diff-filter=U", "-z", "--"]).split("\0").filter(Boolean);
	if (unmerged.length > 0) {
		return { removed: false, path, reason: "unmerged index entries are not represented by a worktree patch; the checkout was kept", paths: unmerged, commits: [] };
	}
	const ignored = git(path, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
	if (ignored.length > 0) {
		return { removed: false, path, reason: "ignored files are not represented by the patch; the checkout was kept", paths: ignored, commits: [] };
	}
	if (options.patch && (options.patch.runId !== runId || options.patch.baseCommit !== baseCommit)) {
		return { removed: false, path, reason: "the patch belongs to a different run or base; the checkout was kept", paths: [], commits: [] };
	}
	const commits = git(path, ["rev-list", `${baseCommit}..HEAD`]).split("\n").filter((line) => line.trim().length > 0);
	if (commits.length > 0 || git(path, ["rev-parse", "HEAD"]).trim() !== baseCommit) {
		return {
			removed: false,
			path,
			reason: `the worktree holds ${commits.length} commit(s) the surfaced patch does not represent; its directory was kept`,
			paths: [],
			commits,
		};
	}
	const dirty = porcelainPaths(git(path, ["status", "--porcelain", "-z", "--untracked-files=all", "--", ":/"]));
	if (dirty.length > 0 && options.patch === undefined) {
		return {
			removed: false,
			path,
			reason: `the worktree holds ${dirty.length} unaccounted path(s) and no patch was surfaced for them; its directory was kept and nothing was forced`,
			paths: dirty,
			commits: [],
		};
	}
	if (dirty.length > 0) {
		const patch = options.patch!;
		const unrepresented = dirty.filter((entry) => !patch.paths.includes(entry) || patch.hashes[entry] === undefined);
		if (unrepresented.length > 0) {
			return {
				removed: false,
				path,
				reason: `the worktree holds ${unrepresented.length} path(s) the surfaced patch does not represent; its directory was kept and nothing was forced`,
				paths: unrepresented,
				commits: [],
			};
		}
		const drifted = driftedPaths(path, patch);
		if (drifted.length > 0) {
			return {
				removed: false,
				path,
				reason: `the worktree changed after its patch was surfaced (${drifted.length} path(s) no longer match); its directory was kept and nothing was forced`,
				paths: drifted,
				commits: [],
			};
		}
	}
	try {
		if (dirty.length > 0) {
			if (options.patch?.completeDiff === undefined || completeDiffOf(path, baseCommit) !== options.patch.completeDiff) {
				return { removed: false, path, reason: "the complete patch is missing or the worktree changed after capture (including file modes); the checkout was kept", paths: dirty, commits: [] };
			}
			const untracked = git(path, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
			// All dirty content has been captured and checked above. Restore only
			// this owned checkout, and remove only the represented untracked files.
			git(path, ["restore", `--source=${baseCommit}`, "--staged", "--worktree", "--", "."]);
			for (const entry of untracked) rmSync(join(path, entry));
		}
		git(options.repoRoot, ["worktree", "remove", path]);
	} catch (error) {
		return { removed: false, path, reason: `ordinary worktree cleanup refused: ${error instanceof Error ? error.message : String(error)}`, paths: dirty, commits: [] };
	}
	rmSync(stampPath(runRoot, runId), { force: true });
	rmSync(ownerPath(runRoot, runId), { force: true });
	return { removed: true, path };
}

/**
 * Reclaim run directories with no live run. This is what makes the crash path
 * recoverable instead of a leak: a worktree orphaned by a killed executor is
 * surfaced to a sidecar patch — so the killed run's work survives its directory —
 * and then removed after its owner has stopped.
 */
/** The worktrees git itself reports for the owning repository, as real paths. */
function registeredWorktrees(repoRoot: string): Set<string> {
	const out = git(repoRoot, ["worktree", "list", "--porcelain", "-z"]);
	return new Set(
		out
			.split("\0")
			.filter((line) => line.startsWith("worktree "))
			.map((line) => realpathConfined(line.slice("worktree ".length))),
	);
}

export function pruneOrphans(options: { repoRoot: string; root?: string; liveRunIds?: Iterable<string> }): OrphanReclamation[] {
	const runRoot = worktreeRoot(options.repoRoot, options.root);
	if (!existsSync(runRoot)) return [];
	const live = new Set(options.liveRunIds ?? []);
	const registered = registeredWorktrees(primaryRepoRoot(options.repoRoot));
	const reclaimed: OrphanReclamation[] = [];
	for (const entry of readdirSync(runRoot, { withFileTypes: true })) {
		if (!entry.isDirectory() || live.has(entry.name) || !ownerInactive(runRoot, entry.name)) continue;
		const path = join(runRoot, entry.name);
		// Only an exact run this module created is reclaimable: it carries the
		// `<runId>.base` ownership stamp and is a registered worktree of the owning
		// repository. A developer checkout or an unrelated directory under the
		// shared root has neither and is left exactly where it is.
		if (readBaseStamp(runRoot, entry.name) === undefined || !registered.has(realpathConfined(path))) continue;
		const dirty = porcelainPaths(git(path, ["status", "--porcelain", "-z", "--untracked-files=all", "--", ":/"]));
		let patch: WorktreePatch | undefined;
		let patchPath: string | undefined;
		if (dirty.length > 0) {
			try {
				patch = surfacePatch(entry.name, options);
				patchPath = join(runRoot, `${entry.name}.patch.json`);
				writeFileSync(patchPath, `${JSON.stringify(patch, null, 2)}\n`);
			} catch (error) {
				reclaimed.push({
					runId: entry.name,
					path,
					removed: false,
					reason: `the orphan could not be surfaced before removal: ${error instanceof Error ? error.message : String(error)}`,
				});
				continue;
			}
		}
		const result = cleanup(entry.name, { ...options, ...(patch ? { patch } : {}) });
		reclaimed.push({
			runId: entry.name,
			path,
			removed: result.removed,
			...(result.removed ? {} : { reason: result.reason }),
			...(patchPath === undefined ? {} : { patchPath }),
		});
	}
	return reclaimed;
}

/**
 * Run one bounded execution inside its own worktree and reclaim it afterwards.
 * Cleanup happens whether the executor succeeded or threw, so a failed run still
 * leaves the checkout and `git worktree list` clean; a run whose changes the
 * patch cannot account for keeps its directory and reports that instead of
 * discarding them.
 */
export async function runIsolated<T>(runId: string, options: WorktreeRunOptions<T>): Promise<WorktreeRun<T>> {
	const runRoot = worktreeRoot(options.repoRoot, options.root);
	const path = worktreePath(options.repoRoot, runId, options.root);
	const baseRef = options.baseRef ?? "HEAD";
	const baseCommit = git(options.repoRoot, ["rev-parse", baseRef]).trim();
	await authorize(worktreePermissionRequest("add", path, baseRef), options);
	ensureRunRootIgnored(options.repoRoot, options.root);
	mkdirSync(runRoot, { recursive: true });
	git(options.repoRoot, ["worktree", "add", "--detach", path, baseCommit]);
	writeFileSync(stampPath(runRoot, runId), `${baseCommit}\n`);
	writeFileSync(ownerPath(runRoot, runId), JSON.stringify(process.pid));

	/** Surface and persist the patch; a persistence failure must retain the checkout, not discard it. */
	const surfaceAndPersist = (): WorktreePatch => {
		let patch: WorktreePatch | undefined;
		try {
			patch = surfacePatch(runId, options);
			options.onPatch?.(patch);
		} catch (error) {
			options.onCleanup?.({
				removed: false,
				path,
				reason: `persisting the surfaced patch failed (${error instanceof Error ? error.message : String(error)}); the checkout was kept so its work is not lost`,
				paths: patch?.paths ?? [],
				commits: [],
			});
			throw error;
		}
		return patch;
	};

	let result: T;
	try {
		result = await options.run(path);
	} catch (error) {
		writeFileSync(ownerPath(runRoot, runId), "null");
		// The executor's failure still owes the operator a patch and a clean checkout.
		const patch = surfaceAndPersist();
		if (!options.onPatch) writeFileSync(join(runRoot, `${runId}.patch.json`), `${JSON.stringify(patch, null, 2)}\n`);
		if (!options.keep) {
			const cleanupResult = cleanup(runId, { ...options, patch });
			options.onCleanup?.(cleanupResult);
		}
		throw error;
	}
	writeFileSync(ownerPath(runRoot, runId), "null");
	const patch = surfaceAndPersist();
	if (options.keep) return { runId, path, baseCommit, result, patch };
	const cleanupResult = cleanup(runId, { ...options, patch });
	options.onCleanup?.(cleanupResult);
	return { runId, path, baseCommit, result, patch, cleanup: cleanupResult };
}

