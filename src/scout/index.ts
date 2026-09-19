/**
 * Stage 0 — the deterministic task scout (PRD-003, ROADMAP §9).
 *
 * Before any generative model inspects the repository, LeanPi gathers a small
 * task packet from facts: languages, project type, package manager, dirty flag,
 * changed files, likely modules, test runners and LSP availability. Zero model
 * inference, zero network I/O — Node's `fs` plus `git` only, so routing stays
 * usable when every provider is offline (§49).
 *
 * §9 forbids dumping trees, manifests, instruction files, history or file
 * bodies; `SCOUT_PACKET_MAX_BYTES` makes that prohibition an executable
 * invariant instead of a promise.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";

export const SCOUT_PACKET_MAX_BYTES = 2048;

export interface TaskPacket {
	repository: {
		languages: string[];
		project_type: "single" | "monorepo" | "polyglot" | "unknown";
		package_manager: string | null;
		dirty: boolean;
	};
	task: {
		user_request: string;
	};
	workspace: {
		changed_files: string[];
		likely_modules: string[];
		test_runners: string[];
		lsp_available: boolean;
		git_branch: string | null;
	};
}

const LOCKFILES: Array<[string, string]> = [
	["package-lock.json", "npm"],
	["pnpm-lock.yaml", "pnpm"],
	["yarn.lock", "yarn"],
	["bun.lockb", "bun"],
	["Cargo.lock", "cargo"],
	["uv.lock", "uv"],
	["poetry.lock", "poetry"],
	["go.sum", "go"],
];

const EXTENSION_LANGUAGE: Record<string, string> = {
	".ts": "typescript",
	".tsx": "typescript",
	".mts": "typescript",
	".cts": "typescript",
	".js": "javascript",
	".jsx": "javascript",
	".mjs": "javascript",
	".cjs": "javascript",
	".py": "python",
	".rs": "rust",
	".go": "go",
	".java": "java",
	".kt": "kotlin",
	".rb": "ruby",
	".php": "php",
	".cs": "csharp",
	".swift": "swift",
	".c": "c",
	".h": "c",
	".cc": "cpp",
	".cpp": "cpp",
	".cxx": "cpp",
	".hpp": "cpp",
	".hh": "cpp",
	".csproj": "csharp",
};

const TEST_RUNNER_SIGNALS: Array<[string, string]> = [
	["vitest", "vitest"],
	["jest", "jest"],
	["mocha", "mocha"],
	["pytest", "pytest"],
	["unittest", "pytest"],
];

const TEST_RUNNER_CONFIGS: Array<[string, string]> = [
	["vitest.config.ts", "vitest"],
	["vitest.config.js", "vitest"],
	["jest.config.js", "jest"],
	["jest.config.ts", "jest"],
	["pytest.ini", "pytest"],
	["tox.ini", "pytest"],
	["Cargo.toml", "cargo test"],
	["CMakeLists.txt", "ctest"],
];

/** Server binary per language; no server is started, only resolved on PATH. */
const LSP_SERVERS: Record<string, string[]> = {
	typescript: ["typescript-language-server", "vscode-languageserver"],
	javascript: ["typescript-language-server"],
	python: ["pyright-langserver", "pylsp"],
	rust: ["rust-analyzer"],
	go: ["gopls"],
	c: ["clangd"],
	cpp: ["clangd"],
	java: ["jdtls"],
	kotlin: ["kotlin-language-server"],
	ruby: ["solargraph"],
	php: ["intelephense"],
	csharp: ["csharp-ls"],
	swift: ["sourcekit-lsp"],
};

function git(cwd: string, args: string[]): string | null {
	try {
		return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 8 * 1024 * 1024 });
	} catch {
		return null;
	}
}

/** `--porcelain=v1 -z` is NUL-delimited and stable; rename records carry the destination. */
export function parsePorcelainZ(output: string): string[] {
	const files: string[] = [];
	const records = output.split("\0").filter((record) => record.length > 0);
	for (let index = 0; index < records.length; index += 1) {
		const record = records[index]!;
		const status = record.slice(0, 2);
		const path = record.slice(3);
		if (status.startsWith("R") || status.startsWith("C")) {
			// The source path follows as its own NUL-delimited record; the
			// destination (this record's path) is the file's current name.
			index += 1;
		}
		if (path.length > 0) files.push(path);
	}
	return files;
}

function readManifest(cwd: string): Record<string, unknown> | null {
	const path = join(cwd, "package.json");
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	} catch {
		return null;
	}
}

export function detectPackageManager(cwd: string): string | null {
	for (const [lockfile, manager] of LOCKFILES) {
		if (existsSync(join(cwd, lockfile))) return manager;
	}
	return null;
}

function manifestLanguages(manifest: Record<string, unknown> | null): string[] {
	if (!manifest) return [];
	const languages = new Set<string>();
	const devDependencies: Record<string, string> = {
		...(manifest.devDependencies as Record<string, string> | undefined),
		...(manifest.dependencies as Record<string, string> | undefined),
	};
	for (const name of Object.keys(devDependencies)) {
		if (name === "typescript" || name.startsWith("@types/")) languages.add("typescript");
		if (name === "react" || name === "vue" || name === "svelte") languages.add("javascript");
	}
	if (manifest.types) languages.add("typescript");
	if (manifest.type === "module") languages.add("javascript");
	return [...languages];
}

export function detectLanguages(cwd: string, changedFiles: string[]): string[] {
	const languages = new Set<string>(manifestLanguages(readManifest(cwd)));
	for (const file of changedFiles) {
		const language = EXTENSION_LANGUAGE[extname(file).toLowerCase()];
		if (language) languages.add(language);
	}
	if (existsSync(join(cwd, "Cargo.toml"))) languages.add("rust");
	if (existsSync(join(cwd, "go.mod"))) languages.add("go");
	if (existsSync(join(cwd, "pyproject.toml")) || existsSync(join(cwd, "requirements.txt"))) languages.add("python");
	return [...languages].sort();
}

export function detectProjectType(cwd: string, languages: string[]): TaskPacket["repository"]["project_type"] {
	const manifest = readManifest(cwd);
	const declaresWorkspaces = Boolean(manifest?.workspaces);
	const declaresMembers = existsSync(join(cwd, "pnpm-workspace.yaml")) || existsSync(join(cwd, "lerna.json"));
	if (declaresWorkspaces || declaresMembers) return "monorepo";
	if (languages.length >= 2) return "polyglot";
	if (languages.length === 1) return "single";
	return "unknown";
}

export function detectTestRunners(cwd: string): string[] {
	const runners = new Set<string>();
	const manifest = readManifest(cwd);
	if (manifest) {
		const devDependencies: Record<string, string> = {
			...(manifest.devDependencies as Record<string, string> | undefined),
			...(manifest.dependencies as Record<string, string> | undefined),
		};
		for (const name of Object.keys(devDependencies)) {
			const signal = TEST_RUNNER_SIGNALS.find(([dependency]) => name === dependency || name.startsWith(`${dependency}-`));
			if (signal) runners.add(signal[1]);
		}
	}
	for (const [file, runner] of TEST_RUNNER_CONFIGS) {
		if (existsSync(join(cwd, file))) runners.add(runner);
	}
	return [...runners].sort();
}

function pathEntries(env: NodeJS.ProcessEnv): string[] {
	return (env.PATH ?? "").split(delimiter).filter(Boolean);
}

export function detectLspAvailable(languages: string[], env: NodeJS.ProcessEnv = process.env): boolean {
	const entries = pathEntries(env);
	return languages.some((language) =>
		(LSP_SERVERS[language] ?? []).some((binary) => entries.some((entry) => existsSync(join(entry, binary)))),
	);
}

/** Common ancestor directories of the changed files, depth-capped at three segments. */
export function commonAncestors(files: string[]): string[] {
	const directories = new Set<string>();
	for (const file of files) {
		const directory = dirname(file);
		if (directory === "." || directory === "") continue;
		directories.add(directory.split("/").slice(0, 3).join("/"));
	}
	return [...directories].sort();
}

function requestedDirectories(cwd: string, request: string): string[] {
	const tokens = request.match(/[\w./-]+/g) ?? [];
	const found = new Set<string>();
	for (const token of tokens) {
		const cleaned = token.replace(/[.,;:)]+$/, "");
		if (cleaned.length < 2 || !/[./]/.test(cleaned)) continue;
		const candidate = isAbsolute(cleaned) ? cleaned : resolve(cwd, cleaned);
		if (existsSync(candidate)) {
			const asRelative = relative(cwd, candidate) || ".";
			found.add(asRelative.split("/").slice(0, 3).join("/"));
		}
	}
	return [...found].sort();
}

/**
 * Assemble the packet, then truncate in a fixed priority order until it fits the
 * ceiling. Each truncated field carries one `+N more` marker whose N is the true
 * number dropped, so the packet never misreports its own totals. An over-ceiling
 * packet throws rather than being returned: a silently oversized packet would
 * defeat the whole cost control.
 */
function enforceCeiling(packet: TaskPacket): TaskPacket {
	const size = () => Buffer.byteLength(JSON.stringify(packet), "utf8");
	if (size() <= SCOUT_PACKET_MAX_BYTES) return packet;

	const plan: Array<{ field: "changed_files" | "likely_modules" | "languages"; label: string; keep: number }> = [
		{ field: "changed_files", label: "changed", keep: 8 },
		{ field: "likely_modules", label: "modules", keep: 4 },
		{ field: "languages", label: "languages", keep: 4 },
	];
	for (const step of plan) {
		if (size() <= SCOUT_PACKET_MAX_BYTES) break;
		const list = step.field === "languages" ? packet.repository.languages : packet.workspace[step.field];
		if (list.length <= 1) continue;
		const keep = Math.max(1, Math.min(step.keep, list.length - 1));
		const dropped = list.length - keep;
		const truncated = [...list.slice(0, keep), `+${dropped} more ${step.label}`];
		if (step.field === "languages") packet.repository.languages = truncated;
		else packet.workspace[step.field] = truncated;
	}

	// The request is truncated last, and only to a hard 256-byte prefix, so it is
	// never silently lost.
	if (size() > SCOUT_PACKET_MAX_BYTES && Buffer.byteLength(packet.task.user_request, "utf8") > 256) {
		packet.task.user_request = packet.task.user_request.slice(0, 256);
	}
	const finalSize = size();
	if (finalSize > SCOUT_PACKET_MAX_BYTES) {
		throw new Error(`Scout packet is ${finalSize} bytes, over the ${SCOUT_PACKET_MAX_BYTES}-byte ceiling (§9).`);
	}
	return packet;
}

export function scoutTask(cwd: string, userRequest: string): TaskPacket {
	const status = git(cwd, ["status", "--porcelain=v1", "-z"]);
	const isRepository = status !== null;
	const changedFiles = (status ? parsePorcelainZ(status) : [])
		.map((file) => normalize(file))
		.sort();
	const branchOutput = isRepository ? git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]) : null;
	const gitBranch = branchOutput ? branchOutput.trim() || null : null;

	const languages = detectLanguages(cwd, changedFiles);
	const packageManager = detectPackageManager(cwd);
	const likelyModules = [...new Set([...commonAncestors(changedFiles), ...requestedDirectories(cwd, userRequest)])].sort();

	const packet: TaskPacket = {
		repository: {
			languages,
			project_type: detectProjectType(cwd, languages),
			package_manager: packageManager,
			dirty: changedFiles.length > 0,
		},
		task: { user_request: userRequest },
		workspace: {
			changed_files: changedFiles,
			likely_modules: likelyModules,
			test_runners: detectTestRunners(cwd),
			lsp_available: detectLspAvailable(languages),
			git_branch: gitBranch,
		},
	};
	return enforceCeiling(packet);
}

function normalize(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\.\//, "");
}
