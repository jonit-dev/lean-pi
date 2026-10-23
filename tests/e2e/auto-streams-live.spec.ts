/**
 * The owner-gated live check that a normal Auto question streams its tool calls.
 *
 * v0.1.10 ran the binding in `models:` first, so on a config with
 * `balanced: claude/opus[1m]` an ordinary question went to `claude -p`: no tool
 * call, no text, nothing on screen until the whole answer landed minutes later.
 * This spawns the real `leanpi` (real config, real JEV, real models, no stub)
 * in a real repository and reads Pi's JSON event stream.
 *
 * Run: `LEANPI_LIVE_E2E=1 pnpm vitest run tests/e2e/auto-streams-live.spec.ts`,
 * optionally with `LEANPI_E2E_CWD=<repo>` (default: this checkout).
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PACKAGE_ROOT } from "../../src/index.js";

const live = process.env.LEANPI_LIVE_E2E === "1";

describe("live: a normal Auto question streams its tool calls", () => {
	it.skipIf(!live)(
		"runs on a streaming provider, not a headless CLI, and shows tool calls",
		() => {
			const run = spawnSync(
				join(PACKAGE_ROOT, "scripts/leanpi-local.sh"),
				[
					"--mode",
					"json",
					"-p",
					"Look at package.json and the top-level folders, then tell me in 3 bullets what this repo builds and how to run its tests.",
				],
				{ cwd: process.env.LEANPI_E2E_CWD ?? PACKAGE_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 300_000 },
			);
			expect(run.status, run.stderr).toBe(0);
			const events = run.stdout
				.split("\n")
				.filter((line) => line.startsWith("{"))
				.map((line) => JSON.parse(line) as { type: string; message?: { role?: string; provider?: string } });
			const providers = new Set(
				events.flatMap((e) => (e.type === "message_end" && e.message?.role === "assistant" ? [e.message.provider] : [])),
			);
			expect(providers.size).toBeGreaterThan(0);
			expect([...providers].filter((p) => p?.endsWith("-cli"))).toEqual([]);
			expect(events.filter((e) => e.type === "tool_execution_start").length).toBeGreaterThan(0);
		},
		320_000,
	);
});
