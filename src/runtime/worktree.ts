/**
 * Worktree isolation for bounded executions (PRD-022 Phase 4, AC-6–AC-9,
 * ROADMAP §60).
 *
 * One module wrapping `git worktree` — no container runtime, no second VCS. A
 * run gets `.leanpi/worktrees/<runId>` on a detached HEAD at the run's base
 * commit, so the operator's checkout is never the executor's working directory
 * and `git status` there stays untouched. On completion the module surfaces a
 * patch keyed by run id (`git diff` against the base plus a manifest of untracked
 * files) and then reclaims the directory.
 *
 * The destructive path is where the care is:
 *
 * - Every mutation — create, remove, prune — requests PRD-017's
 *   `destructive git operations` scope first. `deny` refuses before a directory
 *   exists; `ask` prompts with the scope and the concrete path; no confirmation
 *   channel means the answer is no, exactly as PRD-017's guard behaves without a
 *   UI.
 * - Removal never forces work it cannot account for. Before `worktree remove
 *   --force` runs, every dirty path in the worktree must appear in the surfaced
 *   patch with a content hash that still matches, and the worktree must hold no
 *   commit the patch does not represent. Otherwise removal is refused and the
 *   paths or commits are named.
 * - Cleanup is idempotent and crash-safe: `pruneOrphans` reclaims run
 *   directories with no live run at session start, after surfacing their patch
 *   to a sidecar so a killed executor's work is preserved rather than dropped.
 *
 * ponytail: ignored files (build output, `node_modules`) do not block removal —
 * they are regenerable and no git patch represents them. Upgrade to inspection
 * of `--ignored` only if a run's deliverable ever lives there.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { LeanPiConfig } from "../core/types.js";
import { builtinPermissions, capabilityId, resolveAll, type GuardQuestion, type PermissionsConfig, type Resolution } from "../permissions/index.js";
import { ensureGitIgnored } from "./ignore.js";

/** ROADMAP §47's scope for branch/worktree mutations; PRD-017 owns the name. */
const DESTRUCTIVE_GIT_SCOPE = "git_destructive";

/** The default run root, relative to the repository a run isolates. */
const DEFAULT_RUN_ROOT = join(".leanpi", "worktrees");

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
	 * `pruneOrphans` reclaims it on the next session start.
	 */
	keep?: boolean;
	/** PRD-017's effective permissions. Defaults to `builtinPermissions()`, where the scope is `deny`. */
	permissions?: PermissionsConfig;
	/** The `ask` channel. Absent means an `ask` resolves to a refusal, as PRD-017's guard does without a UI. */
	confirm?: (request: WorktreePermissionRequest) => boolean | Promise<boolean>;
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

/** Porcelain lines are `XY <path>`, with `R  old -> new` for renames and quoted odd paths. */
function porcelainPaths(porcelain: string): string[] {
	const paths: string[] = [];
	for (const line of porcelain.split("\n")) {
		if (line.trim().length === 0) continue;
		const body = line.slice(3);
		const target = body.includes(" -> ") ? body.split(" -> ").pop()! : body;
		paths.push(target.startsWith('"') && target.endsWith('"') ? target.slice(1, -1) : target);
	}
	return paths;
}

function sha256(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** The directory a run's worktree lives in. */
export function worktreeRoot(repoRoot: string, root?: string): string {
	if (root === undefined) return join(repoRoot, DEFAULT_RUN_ROOT);
	return isAbsolute(root) ? root : resolve(repoRoot, root);
}

/**
 * The run root a configuration declares, else the documented default. Read
 * structurally so this lane does not require a key on PRD-001's config type:
 *
 * ```yaml
 * workspace:
 *   worktreeRoot: .leanpi/worktrees
 * ```
 */
export function worktreeRootOf(config: LeanPiConfig | undefined, repoRoot: string): string {
	const declared = (config as { workspace?: { worktreeRoot?: unknown } } | undefined)?.workspace?.worktreeRoot;
	return worktreeRoot(repoRoot, typeof declared === "string" && declared.trim().length > 0 ? declared : undefined);
}

/** The worktree path for one run. `runId` is a path segment, so it is validated, not sanitized. */
export function worktreePath(repoRoot: string, runId: string, root?: string): string {
	if (!RUN_ID_PATTERN.test(runId) || runId === "." || runId === "..") {
		throw new Error(`invalid run id ${JSON.stringify(runId)}: an isolated run's id must be a single safe path segment`);
	}
	return join(worktreeRoot(repoRoot, root), runId);
}

/**
 * Worktrees live inside the repository, so the run root must be excluded from
 * `git status` or every run would dirty the checkout it was meant to protect.
 */
export function ensureRunRootIgnored(repoRoot: string, root?: string): void {
	ensureGitIgnored(repoRoot, relative(repoRoot, worktreeRoot(repoRoot, root)));
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
	return existsSync(path) ? readFileSync(path, "utf8").trim() : undefined;
}

/** The command a scope request names, so PRD-017's glob rules can match the concrete operation. */
function worktreeCommand(action: WorktreePermissionRequest["action"], path: string, baseRef?: string): string {
	return action === "add" ? `git worktree add --detach ${path} ${baseRef ?? "HEAD"}` : action === "remove" ? `git worktree remove --force ${path}` : "git worktree prune";
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
	for (const tracked of porcelainPaths(git(path, ["status", "--porcelain", "--untracked-files=all", "--", ":/"]))) {
		paths.add(tracked);
		const absolute = join(path, tracked);
		hashes[tracked] = existsSync(absolute) && statSync(absolute).isFile() ? sha256(readFileSync(absolute)) : "deleted";
	}
	for (const line of git(path, ["ls-files", "--others", "--exclude-standard"]).split("\n")) {
		const untrackedPath = line.trim();
		if (untrackedPath.length === 0) continue;
		const bytes = readFileSync(join(path, untrackedPath));
		const utf8 = bytes.toString("utf8");
		const encoding = Buffer.from(utf8, "utf8").equals(bytes) ? "utf8" : "base64";
		untracked.push({ path: untrackedPath, content: encoding === "utf8" ? utf8 : bytes.toString("base64"), encoding });
		paths.add(untrackedPath);
		hashes[untrackedPath] = sha256(bytes);
	}
	return { runId, baseCommit, diff, untracked, paths: [...paths].sort(), hashes };
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

/**
 * Apply a surfaced patch to `targetRoot`: the tracked diff through `git apply`,
 * then the untracked manifest written verbatim, then every recorded hash
 * re-checked — content that does not match what the worktree held is a failed
 * apply, not a silent one. A run whose patch was already applied is rejected
 * rather than applied twice.
 */
export function applyPatch(patch: WorktreePatch, targetRoot: string, options: { root?: string } = {}): { paths: string[] } {
	const ledger = readLedger(targetRoot, options.root);
	if (ledger[patch.runId] !== undefined) throw new PatchAlreadyAppliedError(patch.runId, targetRoot);
	ensureRunRootIgnored(targetRoot, options.root);
	if (patch.diff.trim().length > 0) git(targetRoot, ["apply", "--binary", "--whitespace=nowarn", "-"], patch.diff);
	for (const file of patch.untracked) {
		const absolute = join(targetRoot, file.path);
		mkdirSync(dirname(absolute), { recursive: true });
		writeFileSync(absolute, Buffer.from(file.content, file.encoding));
	}
	for (const [entry, expected] of Object.entries(patch.hashes)) {
		const absolute = join(targetRoot, entry);
		const found = !existsSync(absolute) ? "deleted" : sha256(readFileSync(absolute));
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
			return (!existsSync(absolute) ? "deleted" : sha256(readFileSync(absolute))) !== expected;
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
 * operator was shown what the run produced. `--force` is reached only once the
 * supplied patch has been shown to account for the worktree's state.
 */
export function cleanup(runId: string, options: CleanupOptions): CleanupResult {
	const runRoot = worktreeRoot(options.repoRoot, options.root);
	const path = worktreePath(options.repoRoot, runId, options.root);
	if (!existsSync(path)) {
		git(options.repoRoot, ["worktree", "prune"]);
		rmSync(stampPath(runRoot, runId), { force: true });
		return { removed: true, path };
	}
	const baseCommit = readBaseStamp(runRoot, runId);
	const commits = baseCommit === undefined ? [] : git(path, ["rev-list", `${baseCommit}..HEAD`]).split("\n").filter((line) => line.trim().length > 0);
	if (commits.length > 0) {
		return {
			removed: false,
			path,
			reason: `the worktree holds ${commits.length} commit(s) the surfaced patch does not represent; its directory was kept`,
			paths: [],
			commits,
		};
	}
	const dirty = porcelainPaths(git(path, ["status", "--porcelain", "--untracked-files=all", "--", ":/"]));
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
		const unrepresented = dirty.filter((entry) => !patch.paths.includes(entry));
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
	git(options.repoRoot, ["worktree", "remove", "--force", path]);
	git(options.repoRoot, ["worktree", "prune"]);
	rmSync(stampPath(runRoot, runId), { force: true });
	return { removed: true, path };
}

/**
 * Reclaim run directories with no live run. This is what makes the crash path
 * recoverable instead of a leak: a worktree orphaned by a killed executor is
 * surfaced to a sidecar patch — so the killed run's work survives its directory —
 * and then removed on the next session start.
 */
export function pruneOrphans(options: { repoRoot: string; root?: string; liveRunIds?: Iterable<string> }): OrphanReclamation[] {
	const runRoot = worktreeRoot(options.repoRoot, options.root);
	if (!existsSync(runRoot)) return [];
	const live = new Set(options.liveRunIds ?? []);
	const reclaimed: OrphanReclamation[] = [];
	for (const entry of readdirSync(runRoot, { withFileTypes: true })) {
		if (!entry.isDirectory() || live.has(entry.name)) continue;
		const path = join(runRoot, entry.name);
		const dirty = porcelainPaths(git(path, ["status", "--porcelain", "--untracked-files=all", "--", ":/"]));
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

	let result: T;
	try {
		result = await options.run(path);
	} catch (error) {
		// The executor's failure still owes the operator a patch and a clean checkout.
		const patch = surfacePatch(runId, options);
		if (!options.keep) cleanup(runId, { ...options, patch });
		throw error;
	}
	const patch = surfacePatch(runId, options);
	if (options.keep) return { runId, path, baseCommit, result, patch };
	return { runId, path, baseCommit, result, patch, cleanup: cleanup(runId, { ...options, patch }) };
}

