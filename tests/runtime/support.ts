/**
 * Shared fixtures for the PRD-022 suite: a declarative contract builder, a
 * scratch repository, a real static file server, and a fake browser facility.
 *
 * The fake facility is the host adapter's stand-in: it serves the fixture page's
 * bytes and answers selector/text questions from them, and it hands back the
 * stored PNG as a capture. Removing an element from the fixture therefore really
 * removes it from what the verifier sees, which is what makes the negative
 * controls real rather than mocked-to-the-call-shape.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExecutionContract } from "../../src/compiler/contract.js";
import type { ArtifactStore } from "../../src/context/artifacts.js";
import { builtinPermissions, type PermissionDecision, type PermissionsConfig, type Scope } from "../../src/permissions/index.js";
import type { BrowserFacility, BrowserQuery, BrowserTab, RuntimePlan } from "../../src/runtime/index.js";
import { bindRuntimePlan, runtimePlanOf } from "../../src/runtime/index.js";
import { verifyTask, type VerifyResult } from "../../src/verify/index.js";
import type { EvidenceStore } from "../../src/verify/evidence.js";
import { gitCommitAll, gitInit, tempDir as helperTempDir } from "../helpers/fixtures.js";
import { contractOf, gitInit as gitInitBare, tempWorkspace, writeFiles } from "../verify/support.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

/** A path inside `tests/runtime/fixtures`. */
export function runtimeFixture(relativePath: string): string {
	return join(FIXTURES, relativePath);
}

export interface RuntimeContractSpec {
	required: string[];
	criteria?: Array<{ id: string; verifiers?: string[]; scope?: string }>;
	runtime?: RuntimePlan;
	/** PRD-010's round ceiling; `0` runs no recovery round at all. */
	rounds?: number;
}

/** A §8 contract carrying the verification block and runtime declarations this lane reads. */
export function runtimeContract(spec: RuntimeContractSpec): ExecutionContract {
	const contract = contractOf({ required: spec.required, ...(spec.criteria ? { criteria: spec.criteria } : {}) });
	// `ExecutionContract.verification` names only `required`; the runtime block is
	// read structurally, exactly as the verifier and planner read it.
	(contract.verification as unknown as Record<string, unknown>).runtime = spec.runtime ?? {};
	contract.limits.semantic_review_rounds = spec.rounds ?? 0;
	return contract;
}

/** A temp workspace holding `files`, initialized as a git repository. */
export function runtimeWorkspace(files: Record<string, string> = {}): string {
	const root = tempWorkspace();
	gitInitBare(root);
	writeFiles(root, files);
	return root;
}

/** A scratch repository with one committed file, for the worktree suite. */
export function scratchRepo(files: Record<string, string> = { "src/app.ts": "export const version = 1;\n" }): string {
	const root = helperTempDir("leanpi-scratch-");
	gitInit(root);
	writeFiles(root, files);
	gitCommitAll(root);
	return root;
}

/** Raw git output: porcelain's leading status column is significant, so nothing is trimmed here. */
export function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * `git status --porcelain` in a checkout, exactly as git wrote it minus the
 * trailing newline; empty means nothing new is there. Leading status columns are
 * preserved, so `" D src/old.ts"` keeps its meaning.
 */
export function gitStatus(cwd: string): string {
	return git(cwd, ["status", "--porcelain"]).replace(/\n$/, "");
}

/** Every registered worktree path, main checkout first. */
export function gitWorktreePaths(cwd: string): string[] {
	return git(cwd, ["worktree", "list", "--porcelain"])
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.map((line) => line.slice("worktree ".length));
}

export function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function sha256Text(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/** A PRD-017 permission configuration with one scope's default moved. */
export function permissionConfig(scope: Scope, decision: PermissionDecision): PermissionsConfig {
	const config = builtinPermissions();
	config.defaults[scope] = decision;
	return config;
}

export function artifactText(artifacts: ArtifactStore, ref: string): string {
	return artifacts.expand(ref).toString("utf8");
}

/**
 * Run PRD-009's verification with this contract's runtime plan bound for the
 * duration — the session's own binding step, reduced to one call for a spec.
 */
export async function verifyRuntime(
	contract: ExecutionContract,
	root: string,
	options: { artifacts?: ArtifactStore; timeoutMs?: number; store?: EvidenceStore; commands?: Partial<Record<string, string>> } = {},
): Promise<VerifyResult> {
	return withRuntimePlan(contract, () => verifyTask(contract, root, options));
}

/** Bind a contract's runtime plan around any call that may run a runtime verifier. */
export async function withRuntimePlan<T>(contract: ExecutionContract | undefined, run: () => Promise<T>): Promise<T> {
	const restore = bindRuntimePlan(runtimePlanOf(contract));
	try {
		return await run();
	} finally {
		restore();
	}
}

// `Promise.withResolvers` is Node 22+, and this package runs on the Node 20 the
// Pi hosts ship, so the executor form is spelled out here.
/** A port nothing is listening on right now. */
export async function freePort(): Promise<number> {
	return new Promise<number>((resolvePort, reject) => {
		const probe = createServer();
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const port = (probe.address() as AddressInfo).port;
			probe.close(() => resolvePort(port));
		});
	});
}

export interface StaticServer {
	url: string;
	close(): Promise<void>;
}

/** A real static file server, so the page fixture is reached over HTTP. */
export async function staticServer(root: string): Promise<StaticServer> {
	const server: Server = createServer((request, response) => {
		const path = (request.url ?? "/").split("?")[0]!;
		const file = join(root, path === "/" ? "index.html" : path.replace(/^\/+/, ""));
		if (!file.startsWith(root) || !existsSync(file)) {
			response.writeHead(404).end("not found");
			return;
		}
		response.writeHead(200, { "content-type": file.endsWith(".html") ? "text/html" : "application/octet-stream" });
		response.end(readFileSync(file));
	});
	const listening = new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
	await listening;
	return {
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
		close: () => new Promise<void>((closed) => server.close(() => closed())),
	};
}

/** Strip tags and collapse whitespace: the "visible text" a fake browser reports. */
function visibleText(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]*>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** Match a CSS selector the fixtures use — `#id`, `.class`, `tag` — and report what a browser would. */
function query(html: string, selector: string): BrowserQuery {
	const trimmed = selector.trim();
	const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const attribute = trimmed.startsWith("#")
		? `id="${escape(trimmed.slice(1))}"`
		: trimmed.startsWith(".")
			? `class="[^"]*${escape(trimmed.slice(1))}[^"]*"`
			: null;
	const pattern = attribute !== null ? new RegExp(attribute, "g") : new RegExp(`<${escape(trimmed)}[\\s>/]`, "gi");
	const count = [...html.matchAll(pattern)].length;
	if (count === 0) return { count: 0, text: null };
	const element = attribute !== null ? new RegExp(`<[a-z][^>]*${attribute}[^>]*>([\\s\\S]*?)</`, "i").exec(html) : new RegExp(`<${escape(trimmed)}[^>]*>([\\s\\S]*?)</${escape(trimmed)}>`, "i").exec(html);
	return { count, text: element?.[1] === undefined ? null : visibleText(element[1]) };
}

export interface FakeBrowser {
	facility: BrowserFacility;
	/** Every URL the verifier navigated to, in order. */
	visited: string[];
	/** How many times a tab handle was closed. */
	closed: () => number;
	/** The viewport the verifier asked for. */
	viewports: Array<{ width: number; height: number }>;
}

/** A browser facility backed by fixture bytes: the host adapter's stand-in. */
export function fakeBrowser(options: { page: string; capture?: string }): FakeBrowser {
	const visited: string[] = [];
	const viewports: Array<{ width: number; height: number }> = [];
	let closed = 0;
	const facility: BrowserFacility = {
		open({ viewport }) {
			viewports.push({ ...viewport });
			const tab: BrowserTab = {
				async goto(url) {
					if (!existsSync(options.page)) throw new Error(`page fixture ${options.page} is missing`);
					visited.push(url);
				},
				async querySelector(selector) {
					return query(readFileSync(options.page, "utf8"), selector);
				},
				async text() {
					return visibleText(readFileSync(options.page, "utf8"));
				},
				async screenshot() {
					if (options.capture === undefined) throw new Error("this fake browser has no capture configured");
					return readFileSync(options.capture);
				},
				async close() {
					closed += 1;
				},
			};
			return tab;
		},
	};
	return { facility, visited, closed: () => closed, viewports };
}

export function pidOf(text: string, marker: string): number | null {
	const match = new RegExp(`${marker}\\s+(\\d+)`).exec(text);
	return match ? Number(match[1]) : null;
}

/** Whether a pid is still running; the AC-1 "no child survives" check. */
export function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Wait until a pid is gone, so the check is not a race against the reaper. */
export async function waitForDeath(pid: number, timeoutMs = 5_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isAlive(pid)) return true;
		await new Promise((tick) => setTimeout(tick, 25));
	}
	return !isAlive(pid);
}

/** Copy a fixture directory into a workspace so relative baseline paths resolve inside it. */
export function copyFixture(from: string, to: string): void {
	for (const entry of readdirSync(from, { withFileTypes: true, recursive: true })) {
		if (!entry.isFile()) continue;
		const source = join(entry.parentPath, entry.name);
		const target = resolve(to, relative(from, source));
		mkdirSync(dirname(target), { recursive: true });
		copyFileSync(source, target);
	}
}
