/**
 * The single `/usage` owner.
 *
 * Pi has no `unregisterCommand` and renames two `usage` registrations to
 * `usage:1`/`usage:2`, so `/usage` resolves to neither. This adapter runs the
 * bundled `@hk_net/pi-usage-bars` factory for its polling, `usage` flag and
 * status bar, captures and drops its `usage` command, and registers LeanPi's own
 * inventory in its place. `src/cli/usage.ts` carries the why and the rows.
 *
 * Loaded by Pi through jiti, so it imports the built library entry the same way
 * the launcher's other `.ts` extensions resolve Pi's own modules.
 */
import usageBars from "@hk_net/pi-usage-bars/extensions/usage-bars/index.ts";
import { fetchClaudeUsageWithFallback, fetchCodexUsage } from "@hk_net/pi-usage-bars/extensions/usage-bars/core.ts";
import { fetchOpenCodeGoUsage, harnessToken, loadConfig, usageAdapter, usageInventory } from "../../dist/index.js";

export default usageAdapter(usageBars as never, {
	inventory: async (cwd) => usageInventory(loadConfig(cwd), { env: process.env, home: process.env.HOME }),
	// The bundled fetchers, fed the token each harness CLI already keeps: Pi's
	// model registry never holds these logins, so the bundled selector cannot.
	quota: async (row) => {
		const token = row.vendor === undefined ? undefined : harnessToken(row.vendor, process.env.HOME);
		if (token === undefined) return null;
		if (row.vendor === "opencode") return fetchOpenCodeGoUsage(token);
		return row.vendor === "claude" ? fetchClaudeUsageWithFallback(token) : fetchCodexUsage(token);
	},
});
