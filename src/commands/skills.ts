/**
 * `/skills` — the pinned set, the installed library on request, and manual
 * enable/disable/pin control (PRD-005 Phase 1, FR-145).
 *
 * The bare command lists the pinned skills only. A machine with the plugin
 * caches populated has hundreds installed, and dumping all of them buries the
 * handful the user actually chose; `/skills all` is there for the inventory.
 */
import type { SkillControl, SkillRecord } from "../capabilities/skills.js";
import type { CommandRegistry, CommandResult } from "./registry.js";

export interface SkillsCommandDeps {
	records: SkillRecord[];
	control: SkillControl;
	/** Re-scan after a state change so `/skills` reflects the same view the pipeline uses. */
	reload?: () => SkillRecord[];
}

function render(header: string, records: SkillRecord[], control: SkillControl): string {
	const lines = records.map((record) => {
		const flags = [control.isEnabled(record.name) ? null : "disabled", control.isPinned(record.name) ? "pinned" : null].filter(Boolean);
		const version = record.version ?? "null";
		const status = record.status === "invalid" ? ` [invalid: ${record.error}]` : "";
		return `${record.name} — ${record.description || "(no description)"} [${record.source.class}, ${version}]${flags.length > 0 ? ` {${flags.join(", ")}}` : ""}${status}`;
	});
	return [header, ...lines].join("\n");
}

export function registerSkillsCommands(registry: CommandRegistry, deps: SkillsCommandDeps): void {
	const view = () => deps.reload?.() ?? deps.records;

	const handler = async (args: string): Promise<CommandResult> => {
		const [subcommand, ...rest] = args.split(/\s+/).filter(Boolean);
		const name = rest.join(" ").trim();
		const records = view();

		if (subcommand === undefined) {
			const pinned = records.filter((record) => deps.control.isPinned(record.name));
			if (pinned.length === 0) {
				return { ok: true, text: `no skills pinned — ${records.length} installed, \`/skills all\` lists them` };
			}
			return { ok: true, text: render(`${pinned.length} pinned of ${records.length} installed`, pinned, deps.control) };
		}

		if (subcommand === "all") return { ok: true, text: render(`${records.length} installed`, records, deps.control) };

		if (subcommand === "enable" || subcommand === "disable" || subcommand === "pin" || subcommand === "unpin") {
			if (!name) return { ok: false, text: `usage: /skills ${subcommand} <name>` };
			if (!records.some((record) => record.name === name)) return { ok: false, text: `unknown skill: ${name}` };
			if (subcommand === "enable") {
				deps.control.enable(name);
				return { ok: true, text: `${name} enabled` };
			}
			if (subcommand === "disable") {
				deps.control.disable(name);
				return { ok: true, text: `${name} disabled` };
			}
			if (subcommand === "unpin") {
				deps.control.unpin(name);
				return { ok: true, text: `${name} unpinned` };
			}
			const pinned = deps.control.pin(name);
			return { ok: pinned.ok, text: pinned.message };
		}

		return { ok: false, text: `unknown /skills subcommand: ${subcommand} (expected all, enable, disable, pin or unpin)` };
	};

	// A later session supersedes the earlier handler, exactly like `/jev`.
	if (registry.has("skills")) registry.unregister("skills");
	registry.register({
		name: "skills",
		summary: "list the pinned skills; `all` for the whole installed library",
		usage: "/skills [all|enable <name>|disable <name>|pin <name>|unpin <name>]",
		run: handler,
	});
}
