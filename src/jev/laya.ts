/**
 * The local Laya runtime (PRD-042 Phase 2).
 *
 * TypeSafe is a URL and a key; Laya is a process. This module owns the whole
 * difference: where the runtime lives, installing it when it is missing,
 * starting the vendored JEV-contract server, and stopping it again. Everything
 * the process touches — `spawn`, `execFile`, `fetch`, `PATH` lookup, the clock —
 * goes through `LayaDeps`, so the TypeScript suite drives the lifecycle against
 * a stub and the real implementation is one small factory at the bottom.
 *
 * Failure is always the same shape: `resolve()` rejects, the client resolves the
 * site through its registered fallback, and the turn continues. A local runtime
 * that is missing, half-installed or dead is not a reason to stop working.
 */
import { spawn as nodeSpawn, execFile as nodeExecFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { PACKAGE_ROOT } from "../core/package-info.js";
import type { LayaConfig } from "../core/types.js";
import type { CredentialSource } from "./credentials.js";
import type { ControlPlaneProvider } from "./provider.js";

/** The CUDA wheel index; the CPU default comes from PyPI. */
export const LAYA_TORCH_CUDA_INDEX = "https://download.pytorch.org/whl/cu124";
/** A cold install downloads wheels and weights; a warm start only loads them. */
export const LAYA_INSTALL_TIMEOUT_MS = 30 * 60_000;
/**
 * Readiness, not install. A cold start also downloads ~0.8 GB of weights inside
 * `laya.load`, so this is generous on purpose: killing the server mid-download
 * leaves a half-populated cache and the next attempt pays for it again.
 */
export const LAYA_START_TIMEOUT_MS = 15 * 60_000;
/** How long `stop()` waits for a terminated server before returning anyway. */
export const LAYA_STOP_TIMEOUT_MS = 10_000;

export interface LayaRunResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface LayaProcess {
	readonly pid: number | undefined;
	/** Resolved lines from stdout, in order. */
	onLine(handler: (line: string) => void): void;
	onExit(handler: (code: number | null) => void): void;
	kill(): void;
}

/** Everything the runtime does to the outside world, in one injectable seam. */
export interface LayaDeps {
	run(command: string, args: string[], options?: { timeoutMs?: number }): Promise<LayaRunResult>;
	spawn(command: string, args: string[]): LayaProcess;
	which(binary: string): boolean;
	fetch: typeof fetch;
	log(line: string): void;
	env: NodeJS.ProcessEnv;
	platform: NodeJS.Platform;
	now(): number;
}

export class LayaRuntimeError extends Error {
	constructor(message: string, readonly detail?: string) {
		super(message);
		this.name = "LayaRuntimeError";
	}
}

export interface LayaRuntime {
	python: string;
	home: string;
	venv: string;
	/** False when the runtime was already present. */
	installed: boolean;
}

export interface LayaServer {
	endpoint: string;
	model: string;
	stop(): Promise<void>;
}

export interface LayaStatus {
	home: string;
	python: string;
	installed: boolean;
	running: boolean;
	endpoint: string | null;
	detail: string;
}

/** `$XDG_DATA_HOME/leanpi/laya`, or `~/.local/share/leanpi/laya`. */
export function layaHome(options: LayaConfig, env: NodeJS.ProcessEnv): string {
	if (options.home) return options.home;
	const base = env.XDG_DATA_HOME ?? join(env.HOME ?? homedir(), ".local", "share");
	return join(base, "leanpi", "laya");
}

export function layaPython(home: string, platform: NodeJS.Platform): string {
	return platform === "win32" ? join(home, "venv", "Scripts", "python.exe") : join(home, "venv", "bin", "python");
}

export function layaServerScript(): string {
	return join(PACKAGE_ROOT, "vendor", "laya", "server.py");
}

/** The install command a user can run by hand, quoted into an error message. */
export function layaSetupHint(home: string): string {
	return `leanpi --laya (auto-setup) or /jev setup-laya; managed home: ${home}`;
}

async function probeRuntime(python: string, deps: LayaDeps): Promise<boolean> {
	try {
		const result = await deps.run(python, ["-c", "import laya, torch"]);
		return result.code === 0;
	} catch {
		// A missing interpreter is "not installed", not an error: the install path
		// is exactly what handles it.
		return false;
	}
}

function torchIndex(options: LayaConfig, deps: LayaDeps): string | null {
	if (options.device === "cpu") return null;
	// `auto` uses the CUDA wheel when the machine has a CUDA driver; the wheel is
	// 2.5 GB and pointless on a CPU-only host.
	return deps.which("nvidia-smi") ? LAYA_TORCH_CUDA_INDEX : null;
}

async function installRuntime(home: string, options: LayaConfig, deps: LayaDeps): Promise<void> {
	const venv = join(home, "venv");
	const python = layaPython(home, deps.platform);
	const useUv = deps.which("uv");

	deps.log(`Laya runtime missing; creating ${venv}${useUv ? " with uv" : ""}...`);
	const create = useUv
		? await deps.run("uv", ["venv", "--python", "3.12", venv], { timeoutMs: LAYA_INSTALL_TIMEOUT_MS })
		: await deps.run("python3", ["-m", "venv", venv], { timeoutMs: LAYA_INSTALL_TIMEOUT_MS });
	if (create.code !== 0) {
		throw new LayaRuntimeError(
			`Could not create a Python environment for Laya (${useUv ? "uv venv" : "python3 -m venv"} exited ${create.code}).`,
			`${create.stderr.trim()}\nInstall Python 3.12 or uv, then retry. ${layaSetupHint(home)}`,
		);
	}

	const index = torchIndex(options, deps);
	deps.log(`Installing torch${index ? " (CUDA)" : ""} and laya; this downloads a few GB...`);
	const pip = (packages: string[], extraIndex: string | null) =>
		useUv
			? deps.run("uv", ["pip", "install", "--python", python, ...packages, ...(extraIndex ? ["--index-url", extraIndex] : [])], {
					timeoutMs: LAYA_INSTALL_TIMEOUT_MS,
				})
			: deps.run(python, ["-m", "pip", "install", ...packages, ...(extraIndex ? ["--index-url", extraIndex] : [])], {
					timeoutMs: LAYA_INSTALL_TIMEOUT_MS,
				});

	const torch = await pip(["torch"], index);
	if (torch.code !== 0) {
		throw new LayaRuntimeError(`Installing torch failed (exit ${torch.code}).`, `${torch.stderr.trim()}\n${layaSetupHint(home)}`);
	}
	const laya = await pip(["laya"], null);
	if (laya.code !== 0) {
		throw new LayaRuntimeError(`Installing laya failed (exit ${laya.code}).`, `${laya.stderr.trim()}\n${layaSetupHint(home)}`);
	}
}

/** Locate the runtime, installing it when it is missing and setup is allowed. */
export async function ensureLayaRuntime(options: LayaConfig, deps: LayaDeps): Promise<LayaRuntime> {
	const home = layaHome(options, deps.env);
	const python = layaPython(home, deps.platform);
	const venv = join(home, "venv");
	if (await probeRuntime(python, deps)) return { python, home, venv, installed: false };

	if (options.autoSetup === false) {
		throw new LayaRuntimeError(`The Laya runtime is not installed at ${home} and autoSetup is off.`, layaSetupHint(home));
	}
	if (!existsSync(layaServerScript())) {
		throw new LayaRuntimeError(`The vendored Laya server is missing: ${layaServerScript()}`, "Reinstall LeanPi; the packaged file list must carry vendor/laya/server.py.");
	}

	await installRuntime(home, options, deps);
	if (!(await probeRuntime(python, deps))) {
		throw new LayaRuntimeError(`The Laya runtime at ${python} still cannot import laya and torch after installing.`, layaSetupHint(home));
	}
	return { python, home, venv, installed: true };
}

function deviceFlag(options: LayaConfig, deps: LayaDeps): string {
	if (options.device === "cuda") return "cuda";
	if (options.device === "cpu") return "cpu";
	return deps.which("nvidia-smi") ? "cuda" : "cpu";
}

/** Spawn the vendored server and wait for its readiness line. */
export async function startLayaServer(options: LayaConfig, deps: LayaDeps): Promise<LayaServer> {
	const runtime = await ensureLayaRuntime(options, deps);
	const args = [layaServerScript(), "--port", String(options.port ?? 0), "--device", deviceFlag(options, deps)];
	if (options.checkpoint) args.push("--subfolder", options.checkpoint);

	deps.log(`Starting Laya (${options.checkpoint ?? "english"})...`);
	const child = deps.spawn(runtime.python, args);
	const started = deps.now();
	const exited = new Promise<number | null>((resolve) => child.onExit(resolve));

	const endpoint = await new Promise<string>((resolve, reject) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill();
			reject(new LayaRuntimeError(`Laya did not start within ${Math.round(LAYA_START_TIMEOUT_MS / 1000)}s.`, layaSetupHint(runtime.home)));
		}, LAYA_START_TIMEOUT_MS);
		timer.unref?.();

		child.onLine((line) => {
			if (settled) return;
			const match = /listening on (http:\/\/\S+)/.exec(line);
			if (!match) return;
			settled = true;
			clearTimeout(timer);
			resolve(match[1]!);
		});
		child.onExit((code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(new LayaRuntimeError(`The Laya server exited with code ${code} before it was ready.`, layaSetupHint(runtime.home)));
		});
	});

	deps.log(`Laya ready at ${endpoint} in ${Math.round(deps.now() - started)}ms.`);
	let stopped = false;
	return {
		endpoint,
		model: options.checkpoint ? `laya-${options.checkpoint}` : "laya-english",
		async stop() {
			if (stopped) return;
			stopped = true;
			child.kill();
			// `stop()` must mean "the process is gone", not "a signal was sent":
			// a session switch that returns while the model is still resident leaks
			// GPU memory, and the caller has no way to find out later.
			await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, LAYA_STOP_TIMEOUT_MS).unref?.())]);
		},
	};
}

/**
 * The provider the client resolves against. `resolve()` is memoized, including
 * its failure: a session makes one attempt to bring the runtime up, not one per
 * decision, so a 3 GB download cannot be started by a retry loop.
 */
export function layaProvider(options: LayaConfig, deps: LayaDeps): ControlPlaneProvider {
	let started: Promise<LayaServer> | null = null;
	let disposed = false;

	return {
		name: "laya",
		get source(): CredentialSource {
			return "laya";
		},
		async resolve() {
			if (disposed) throw new LayaRuntimeError("The Laya provider was disposed.");
			if (options.endpoint) {
				// An operator running their own server: LeanPi manages nothing and
				// spawns nothing. An unreachable endpoint fails in `send()` and takes
				// the site's fallback like any other transport error.
				return { endpoint: options.endpoint, key: "laya-local", source: "laya", model: "laya-external" };
			}
			started ??= startLayaServer(options, deps);
			const server = await started;
			return { endpoint: server.endpoint, key: "laya-local", source: "laya", model: server.model };
		},
		async dispose() {
			disposed = true;
			if (!started) return;
			try {
				await (await started).stop();
			} catch {
				// A server that never started has nothing to stop.
			}
			started = null;
		},
	};
}

/** What `/jev` reports under `provider: laya`. */
export async function layaStatus(options: LayaConfig, deps: LayaDeps): Promise<LayaStatus> {
	const home = layaHome(options, deps.env);
	const python = layaPython(home, deps.platform);
	if (options.endpoint) {
		return { home, python, installed: true, running: true, endpoint: options.endpoint, detail: "external server" };
	}
	const installed = await probeRuntime(python, deps);
	return {
		home,
		python,
		installed,
		running: false,
		endpoint: null,
		detail: installed ? "installed" : `missing — ${layaSetupHint(home)}`,
	};
}

/** The real process/file/PATH implementations; the only untested-by-unit surface. */
export function defaultLayaDeps(): LayaDeps {
	const env = process.env;
	return {
		run(command, args, options) {
			return new Promise((resolve) => {
				nodeExecFile(command, args, { env, maxBuffer: 8 * 1024 * 1024, timeout: options?.timeoutMs }, (error, stdout, stderr) => {
					const code = error && typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : error ? 1 : 0;
					resolve({ code, stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "" });
				});
			});
		},
		spawn(command, args) {
			const child = nodeSpawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
			child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
			return {
				pid: child.pid,
				onLine(handler) {
					let buffered = "";
					child.stdout?.on("data", (chunk: Buffer) => {
						buffered += chunk.toString();
						const lines = buffered.split("\n");
						buffered = lines.pop() ?? "";
						for (const line of lines) handler(line);
					});
				},
				onExit(handler) {
					child.on("exit", handler);
				},
				kill() {
					child.kill("SIGTERM");
				},
			};
		},
		which(binary) {
			const path = env.PATH ?? "";
			const extensions = process.platform === "win32" ? (env.PATHEXT ?? ".EXE").split(";") : [""];
			return path.split(delimiter).some((directory) => extensions.some((extension) => existsSync(join(directory, `${binary}${extension}`))));
		},
		fetch: (...args) => fetch(...args),
		log: (line) => process.stderr.write(`${line}\n`),
		env,
		platform: process.platform,
		now: () => Date.now(),
	};
}
