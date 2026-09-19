/**
 * `/route` — the routing decision, its overrides and the JEV lines (PRD-016 Phase 3, §45).
 *
 * The ten lines map one-to-one onto `ExecutionContract` fields; a pinned field
 * renders `(forced)` so a forced route is never mistaken for a classification.
 * The pins are written here and read by the compiler (`src/compiler/pins.ts`),
 * so `/route executor strong` changes the *next* contract, not just this
 * display. JEV lines enumerate PRD-002's registry: a site registered by another
 * PRD appears here with no edit to this module, an empty registry says so, and a
 * disabled JEV prints every site as `fallback`.
 */
import { compileRecordOf } from "../compiler/index.js";
import { clearRoutePins, routePins, setRoutePins, type RoutePins } from "../compiler/pins.js";
import type { ExecutorClass, ReviewerClass } from "../compiler/contract.js";
import { listSites } from "../jev/registry.js";
import type { CommandRegistry, CommandResult } from "./registry.js";
import type { CommandSurface } from "./surface.js";

const EXECUTOR_CLASSES: readonly ExecutorClass[] = ["quick", "balanced", "strong", "specialist"];
const REVIEWER_CLASSES: readonly ReviewerClass[] = ["none", "review_quick", "review_strong"];

/**
 * `/route reviewer strong` is accepted alongside `/route reviewer review_strong`:
 * §45's override names a lane strength, and the contract's reviewer classes are
 * the executor families prefixed with `review_`. A reviewer request is always a
 * Strong-or-Quick lane, never a silent executor swap.
 */
function reviewerClassOf(value: string): ReviewerClass | undefined {
	if ((REVIEWER_CLASSES as readonly string[]).includes(value)) return value as ReviewerClass;
	if (value === "strong" || value === "specialist") return "review_strong";
	if (value === "quick" || value === "balanced") return "review_quick";
	return undefined;
}

/** The §45 lines, in §45's order. */
export function routeLines(surface: CommandSurface): string[] {
	const contract = surface.contract;
	const pins = routePins();

	if (!contract) {
		const executor = surface.bindingFor(pins.executor_class ?? "quick");
		const reasoning = surface.host.agent()?.thinkingLevel ?? "unknown";
		return [
			"route: no contract compiled yet",
			...(pins.prd_required === undefined ? [] : [`PRD: ${pins.prd_required ? "yes" : "no"} (forced)`]),
			`executor: ${pins.executor_class ?? "unclassified"}${executor.ref ? ` ${executor.ref.backend}/${executor.ref.model}` : ""}${pins.executor_class ? " (forced)" : ""}`,
			`review: ${pins.reviewer_class ?? "unclassified"}${pins.reviewer_class ? " (forced)" : ""}`,
			`reasoning: ${reasoning}`,
		];
	}

	const executorClass = pins.executor_class ?? contract.routing.executor_class;
	const reviewerClass = pins.reviewer_class ?? contract.routing.reviewer_class;
	const executor = surface.bindingFor(executorClass);
	const reviewer = reviewerClass === "none" ? null : surface.bindingFor(reviewerClass);
	const skills = contract.capabilities.skills.map((skill) => skill.name);

	return [
		`PRD: ${contract.task.prd_required ? "yes" : "no"}${pins.prd_required === undefined ? ` (planning ${contract.task.planning_decision})` : " (forced)"}`,
		`complexity: ${contract.task.execution_complexity}`,
		`review risk: ${contract.task.review_risk}`,
		`executor: ${executorClass}${executor.ref ? ` ${executor.ref.backend}/${executor.ref.model}` : ""}${pins.executor_class ? " (forced)" : ""}`,
		`review: ${reviewerClass}${reviewer?.ref ? ` ${reviewer.ref.backend}/${reviewer.ref.model}` : ""}${pins.reviewer_class ? " (forced)" : ""}`,
		`skills: ${skills.length > 0 ? skills.join(", ") : "none selected"}`,
		`MCP: ${contract.capabilities.mcps.length} selected`,
		`LSP: ${contract.capabilities.lsp ? "available" : "unavailable"}`,
		`reasoning: ${contract.reasoning.effort}`,
		`budget: ${contract.context.budget_tokens} tokens (${contract.context.strategy})`,
	];
}

/** One `site fired|fallback` clause per registered decision site. */
export function jevLine(surface: CommandSurface): string {
	const sites = listSites();
	if (sites.length === 0) return "jev: no sites registered";
	const rows = surface.contract ? (compileRecordOf(surface.contract)?.telemetry ?? []) : [];
	const disabled = surface.jev === undefined || surface.jev.getMode() === "disabled";
	const clauses = sites.map((site) => {
		const row = rows.find((candidate) => candidate.site_id === site.id || candidate.site_id === site.telemetryTag);
		if (!row || disabled || row.fallback_used) return `${site.id} fallback (${disabled ? "jev disabled" : "deterministic rule"})`;
		return `${site.id} fired (choice ${String(row.answer)}, conf ${row.confidence})`;
	});

	const wrapped: string[] = [];
	let current = "";
	for (const clause of clauses) {
		if (current.length > 0 && current.length + clause.length + 3 > 110) {
			wrapped.push(current);
			current = clause;
			continue;
		}
		current = current.length === 0 ? clause : `${current} · ${clause}`;
	}
	wrapped.push(current);
	return [`jev: ${wrapped[0]}`, ...wrapped.slice(1).map((line) => `     ${line}`)].join("\n");
}

export function renderRoute(surface: CommandSurface): string {
	return [...routeLines(surface), jevLine(surface)].join("\n");
}

export function registerRouteCommand(registry: CommandRegistry, surface: CommandSurface): void {
	registry.register({
		name: "route",
		summary: "show the §45 routing lines and the JEV sites; pin executor, reviewer or PRD",
		usage: "/route [executor <class>|reviewer <class>|prd force|prd skip|reset]",
		run: (args): CommandResult => {
			const [subcommand, value] = args.split(/\s+/).filter(Boolean);
			const sessionId = surface.host.current().getSessionId();

			if (subcommand === undefined) return { ok: true, text: renderRoute(surface) };

			if (subcommand === "reset") {
				clearRoutePins();
				return { ok: true, text: "route pins cleared — the classifier decides again" };
			}

			if (subcommand === "executor" || subcommand === "reviewer") {
				const allowed = subcommand === "executor" ? EXECUTOR_CLASSES : REVIEWER_CLASSES;
				const reviewer = subcommand === "reviewer" && value !== undefined ? reviewerClassOf(value) : undefined;
				if (value === undefined || (subcommand === "executor" && !(allowed as readonly string[]).includes(value)) || (subcommand === "reviewer" && reviewer === undefined)) {
					return { ok: false, text: `usage: /route ${subcommand} <${allowed.join("|")}>` };
				}
				setRoutePins(
					subcommand === "executor" ? { executor_class: value as ExecutorClass } : { reviewer_class: reviewer as ReviewerClass },
					sessionId,
				);
				return { ok: true, text: `${subcommand} pinned to ${value} for this session\n${renderRoute(surface)}` };
			}

			if (subcommand === "prd") {
				if (value !== "force" && value !== "skip") return { ok: false, text: "usage: /route prd <force|skip>" };
				setRoutePins({ prd_required: value === "force" }, sessionId);
				return { ok: true, text: `PRD ${value === "force" ? "forced" : "skipped"} for this session\n${renderRoute(surface)}` };
			}

			return {
				ok: false,
				text: `unknown /route subcommand: ${subcommand} (expected executor <class>, reviewer <class>, prd <force|skip> or reset)`,
			};
		},
	});
}
