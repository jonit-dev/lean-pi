/**
 * `/new`, `/resume` and `/tree` — Pi's session tree, wrapped (PRD-016 Phase 4, FR-150).
 *
 * LeanPi stores no session records of its own: ids, names, parent links,
 * message counts and the fork prefix all come from Pi's `SessionManager`, and
 * `/tree fork` uses Pi's branch primitive so a child session inherits the
 * parent's path. A fork is a new Pi session file with `parentSession` in its
 * header; the parent's file is never touched.
 */
import { basename } from "node:path";
import type { SessionInfo } from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { clearRoutePins } from "../compiler/pins.js";
import type { CommandRegistry, CommandResult } from "./registry.js";
import type { CommandSurface } from "./surface.js";

/** Every session Pi knows about for this project, newest last. */
async function sessionsOf(surface: CommandSurface): Promise<SessionInfo[]> {
	const sessions = await SessionManager.list(surface.cwd, surface.host.sessionDir());
	return sessions.sort((left, right) => left.created.getTime() - right.created.getTime());
}

/**
 * The current session as a row. Pi only writes a session file once an assistant
 * message exists, so a brand-new session is not in `list()` yet — its identity
 * still comes from Pi's manager, never from a record of ours.
 */
function currentRow(surface: CommandSurface): SessionInfo {
	const manager = surface.host.current();
	const header = manager.getHeader();
	return {
		path: manager.getSessionFile() ?? "",
		id: manager.getSessionId(),
		cwd: surface.cwd,
		...(manager.getSessionName() ? { name: manager.getSessionName() } : {}),
		...(header?.parentSession ? { parentSessionPath: header.parentSession } : {}),
		created: new Date(header?.timestamp ?? Date.now()),
		modified: new Date(),
		messageCount: manager.getBranch().filter((entry) => entry.type === "message").length,
		firstMessage: "",
		allMessagesText: "",
	};
}

export function renderTree(surface: CommandSurface, listed: readonly SessionInfo[]): string {
	const rows = [...listed];
	if (!rows.some((row) => row.id === surface.host.current().getSessionId())) rows.push(currentRow(surface));
	rows.sort((left, right) => left.created.getTime() - right.created.getTime());

	const byPath = new Map(rows.map((row) => [row.path, row]));
	const currentId = surface.host.current().getSessionId();
	const lines = rows.map((row) => {
		const marker = row.id === currentId ? "●" : " ";
		const parent = row.parentSessionPath ? byPath.get(row.parentSessionPath) : undefined;
		const relation = row.parentSessionPath
			? `  child of ${parent?.name ?? parent?.id ?? basename(row.parentSessionPath)}`
			: "";
		const current = row.id === currentId ? "  (current)" : "";
		return `${marker} ${row.name ?? "unnamed"} — id ${row.id}, created ${row.created.toISOString()}, ${row.messageCount} messages${relation}${current}`;
	});
	return [`sessions in ${surface.host.sessionDir()}:`, ...lines].join("\n");
}

export function registerSessionCommands(registry: CommandRegistry, surface: CommandSurface): void {
	registry.register({
		name: "new",
		summary: "start a new Pi session, optionally named",
		usage: "/new [name]",
		run: async (args): Promise<CommandResult> => {
			const name = args.trim();
			const manager = SessionManager.create(surface.cwd, surface.host.sessionDir());
			await surface.host.adopt(manager, name.length > 0 ? name : undefined);
			surface.resetSessionState();
			clearRoutePins();
			return { ok: true, text: `new session ${name.length > 0 ? name : "unnamed"} (id ${manager.getSessionId()})` };
		},
	});

	registry.register({
		name: "resume",
		summary: "reattach to a Pi session by name or id",
		usage: "/resume <name|id>",
		run: async (args): Promise<CommandResult> => {
			const target = args.trim();
			if (target.length === 0) return { ok: false, text: "usage: /resume <name|id>" };

			// ponytail: Pi's name lookup is a scan of its session list, not an index.
			// Replace with an index only if a session directory ever grows large enough to notice.
			const sessions = await sessionsOf(surface);
			const info =
				sessions.find((session) => session.name === target) ??
				sessions.find((session) => session.id === target) ??
				sessions.find((session) => session.id.startsWith(target)) ??
				sessions.find((session) => session.path === target);
			if (!info) return { ok: false, text: `no session named or identified "${target}" in ${surface.host.sessionDir()}` };

			const manager = SessionManager.open(info.path, surface.host.sessionDir(), surface.cwd);
			await surface.host.adopt(manager);
			surface.resetSessionState();
			clearRoutePins();
			return {
				ok: true,
				text: `resumed ${info.name ?? info.id} (id ${manager.getSessionId()}, ${info.messageCount} messages)`,
			};
		},
	});

	registry.register({
		name: "tree",
		summary: "show Pi's session tree, or fork the current session from its head",
		usage: "/tree [fork [name]]",
		run: async (args): Promise<CommandResult> => {
			const [subcommand, name = ""] = args.split(/\s+/).filter(Boolean);
			if (subcommand !== undefined && subcommand !== "fork") return { ok: false, text: `unknown /tree subcommand: ${subcommand}` };

			if (subcommand === "fork") {
				const manager = surface.host.current();
				const parentLabel = manager.getSessionName() ?? manager.getSessionId();
				if (!manager.isPersisted()) {
					return { ok: false, text: "cannot fork an in-memory session: a Pi fork is a new session file" };
				}
				const leaf = manager.getLeafId();
				if (!leaf) return { ok: false, text: "nothing to fork: the current session has no head entry" };
				const file = manager.createBranchedSession(leaf);
				if (!file) return { ok: false, text: "Pi did not persist the fork" };
				const child = SessionManager.open(file, surface.host.sessionDir(), surface.cwd);
				await surface.host.adopt(child, name.length > 0 ? name : undefined);
				surface.resetSessionState();
				clearRoutePins();
				return {
					ok: true,
					text: `forked ${name.length > 0 ? name : child.getSessionId()} from ${parentLabel} (id ${child.getSessionId()})`,
				};
			}

			return { ok: true, text: renderTree(surface, await sessionsOf(surface)) };
		},
	});
}
