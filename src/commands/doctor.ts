/**
 * `/doctor` — backend and capability diagnostics (PRD-016 Phase 2, FR-151).
 *
 * Each row is `ok | degraded | unavailable` with a one-line reason, and the
 * summary reports the worst row. Probes run concurrently with a short timeout,
 * so a dead harness cannot hang the command; nothing here mutates state,
 * installs anything, or prints a credential value — probe results only.
 */
import { homedir } from "node:os";
import { defaultSkillRoots, scanSkills, type SkillRoot } from "../capabilities/skills.js";
import { buildCatalog, resolveConfigPaths } from "../mcp/catalog.js";
import type { CommandRegistry, CommandResult } from "./registry.js";
import { probeBackends, type CommandSurface } from "./surface.js";

export type DoctorStatus = "ok" | "degraded" | "unavailable";

export interface DoctorRow {
	name: string;
	status: DoctorStatus;
	reason: string;
}

const WORST_ORDER: DoctorStatus[] = ["ok", "degraded", "unavailable"];

/** The skill roots the session actually indexes: config when declared, else the shared defaults. */
export function skillRootsOf(surface: CommandSurface): SkillRoot[] {
	const declared = surface.config.capabilities.skillRoots;
	if (declared.length === 0) return defaultSkillRoots(surface.cwd, surface.env.HOME ?? homedir());
	return declared.map((path) => ({ path, class: path.includes(".claude/plugins") ? ("plugin" as const) : ("user" as const) }));
}

export async function doctorRows(surface: CommandSurface): Promise<DoctorRow[]> {
	// `/doctor` is the one caller that pays for an authentication probe: a row
	// saying "installed" about a signed-out vendor is the failure this command exists to catch.
	const probes = await probeBackends(surface, { verify: true });
	const rows: DoctorRow[] = surface.backends.backends.map((backend) => {
		const probe = probes.get(backend.name) ?? { status: "unavailable" as const, reason: "not probed" };
		return { name: `backend ${backend.name} (${backend.type})`, status: probe.status, reason: probe.reason };
	});

	if (surface.jev) {
		const status = await surface.jev.status();
		const accessible = status.configured && status.mode !== "disabled";
		if (!accessible) {
			rows.push({
				name: "jev",
				status: "unavailable",
				reason: `not answering: ${status.configured ? `mode ${status.mode}` : "no credential configured"} — deterministic fallback decides every site`,
			});
		} else {
			// One round trip is what "answering" means; the probe returns no credential.
			try {
				const probe = await surface.jev.test();
				rows.push({
					name: "jev",
					status: probe.ok ? "ok" : "degraded",
					reason: probe.ok
						? `configured (source: ${status.source}, mode: ${status.mode}) answered in ${probe.latencyMs}ms (model: ${probe.modelVersion})`
						: `configured (source: ${status.source}, mode: ${status.mode}) but the probe failed: ${probe.error ?? "no reason reported"}`,
				});
			} catch (error) {
				rows.push({
					name: "jev",
					status: "degraded",
					reason: `configured (source: ${status.source}) but the probe failed: ${error instanceof Error ? error.message : String(error)}`,
				});
			}
		}
	} else {
		rows.push({ name: "jev", status: "unavailable", reason: "no JEV client in this session — deterministic fallback decides every site" });
	}

	const roots = skillRootsOf(surface);
	const records = scanSkills(surface.cwd, { roots });
	rows.push({
		name: "skills",
		status: records.length > 0 ? "ok" : "degraded",
		reason: `${records.length} indexed from ${roots.map((root) => `${root.path} (${root.class})`).join(", ") || "no roots"}`,
	});

	const home = surface.env.HOME ?? homedir();
	const catalog = buildCatalog({ cwd: surface.cwd, config: surface.config, home });
	const paths = resolveConfigPaths(surface.cwd, surface.config, home);
	// A server the pool could not reach, or that wants authorization, is a real
	// fault. Having configured none is not one: MCP is optional, and a summary
	// that reads `degraded` on every stock installation teaches the reader to
	// ignore it.
	const broken = catalog.servers.filter((server) => server.health === "error" || server.health === "auth_required");
	rows.push({
		name: "mcp",
		status: broken.length > 0 ? "degraded" : "ok",
		reason:
			broken.length > 0
				? `${broken.length} of ${catalog.servers.length} servers unhealthy: ${broken.map((server) => `${server.name} (${server.health})`).join(", ")}`
				: `${catalog.servers.length} servers, ${catalog.tools.length} tools indexed from ${[...paths.user, ...paths.project].join(", ") || "no config paths"}`,
	});

	return rows;
}

export function worstStatus(rows: readonly DoctorRow[]): DoctorStatus {
	return rows.reduce<DoctorStatus>((worst, row) => (WORST_ORDER.indexOf(row.status) > WORST_ORDER.indexOf(worst) ? row.status : worst), "ok");
}

export function renderDoctor(rows: readonly DoctorRow[]): string {
	if (rows.length === 0) return "doctor: nothing to probe";
	const width = Math.max(...rows.map((row) => row.name.length));
	const worst = worstStatus(rows);
	const firstWorst = rows.find((row) => row.status === worst);
	return [
		...rows.map((row) => `${row.name.padEnd(width)}  ${row.status.padEnd(11)} ${row.reason}`),
		`summary: ${worst}${worst === "ok" ? "" : ` — ${firstWorst?.name}: ${firstWorst?.reason}`}`,
	].join("\n");
}

export function registerDoctorCommand(registry: CommandRegistry, surface: CommandSurface): void {
	registry.register({
		name: "doctor",
		summary: "probe backends, JEV and the capability registries; report the worst status",
		usage: "/doctor",
		run: async (): Promise<CommandResult> => ({ ok: true, text: renderDoctor(await doctorRows(surface)) }),
	});
}
