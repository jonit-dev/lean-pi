/**
 * `/usage` as two panes, laid out like `/model`: the providers on the left, the
 * selected one's quota bars on the right.
 *
 * The inventory alone says a login exists; what the reader opened `/usage` for
 * is how much of it is left. Quotas are fetched once, in parallel, when the
 * picker opens, and each pane fills in as its answer lands.
 */
import { HStack, SelectList, Text, VStack, type Component, type SelectItem, type SelectListTheme, type TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Quota, UsageRow } from "./usage.js";

const VISIBLE = 12;
const PROVIDER_WIDTH = 22;
const PANE_GAP = 2;
const GUTTER = 2;
const BAR_WIDTH = 20;
const LEFT_COLUMN = { basis: PROVIDER_WIDTH, shrink: 0 } as const;

function listTheme(theme: Theme): SelectListTheme {
	return {
		selectedPrefix: (text) => theme.fg("accent", text),
		selectedText: (text) => theme.fg("accent", text),
		description: (text) => theme.fg("muted", text),
		scrollInfo: (text) => theme.fg("dim", text),
		noMatch: (text) => theme.fg("dim", text),
	};
}

/** The same thresholds the bundled status bar uses, so the two never disagree. */
function colourFor(percent: number): "success" | "warning" | "error" {
	return percent >= 90 ? "error" : percent >= 70 ? "warning" : "success";
}

function bar(theme: Theme, label: string, used: number, resets: string | undefined): string {
	const percent = Math.max(0, Math.min(100, Math.round(Number.isFinite(used) ? used : 0)));
	const filled = Math.round((percent / 100) * BAR_WIDTH);
	return (
		theme.fg("muted", label.padEnd(8)) +
		theme.fg(colourFor(percent), "█".repeat(filled)) +
		theme.fg("dim", "░".repeat(BAR_WIDTH - filled)) +
		theme.fg(colourFor(percent), `${percent}%`.padStart(5)) +
		(resets ? theme.fg("dim", `  resets in ${resets}`) : "")
	);
}

/** The right pane's lines for one row: its verdict, then its bars once they land. */
export function quotaLines(theme: Theme, row: UsageRow, quota: Quota | null | undefined): string[] {
	const colour = row.state === "authenticated" || row.state === "reachable" ? "success" : row.kind === "detected" ? "muted" : "warning";
	const lines = [`${theme.fg(colour, row.state)} ${theme.fg("dim", `· ${row.kind}`)}`, theme.fg("muted", row.detail), ""];
	if (quota === undefined) return [...lines, theme.fg("dim", "fetching quota…")];
	if (quota === null) return [...lines, theme.fg("dim", "no quota API for this provider")];
	if (quota.error) return [...lines, theme.fg("error", `quota unavailable: ${quota.error}`)];
	if (!quota.sessionHidden) lines.push(bar(theme, quota.sessionLabel ?? "5h", quota.session, quota.sessionResetsIn));
	if (!quota.weeklyHidden) lines.push(bar(theme, quota.weeklyLabel ?? "Weekly", quota.weekly, quota.weeklyResetsIn));
	if (quota.monthly !== undefined) lines.push(bar(theme, "Monthly", quota.monthly, quota.monthlyResetsIn));
	if (quota.warning) lines.push(theme.fg("warning", `⚠ ${quota.warning}`));
	return lines;
}

class UsagePicker implements Component {
	private readonly providers: SelectList;
	private readonly detail = new Text("", GUTTER, 0);
	private readonly root: VStack;
	/** `undefined` while fetching, `null` when the row has no quota source. */
	private readonly quotas = new Map<string, Quota | null>();

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly rows: readonly UsageRow[],
		quota: (row: UsageRow) => Promise<Quota | null>,
		done: () => void,
	) {
		const items: SelectItem[] = rows.map((row) => {
			const ready = row.state === "authenticated" || row.state === "reachable";
			return { value: row.name, label: `${theme.fg(ready ? "success" : "warning", ready ? "●" : "○")} ${row.name}` };
		});
		this.providers = new SelectList(items, VISIBLE, listTheme(theme), { minPrimaryColumnWidth: PROVIDER_WIDTH, maxPrimaryColumnWidth: PROVIDER_WIDTH });
		this.providers.onSelectionChange = () => this.refresh();
		this.providers.onSelect = () => done();
		this.providers.onCancel = () => done();

		const header = new HStack([], { gap: PANE_GAP });
		header.addChild(new Text(theme.fg("accent", "providers"), GUTTER, 0), LEFT_COLUMN);
		header.addChild(new Text(theme.fg("muted", "usage"), GUTTER, 0), { grow: 1 });
		const panes = new HStack([], { gap: PANE_GAP });
		panes.addChild(this.providers, LEFT_COLUMN);
		panes.addChild(this.detail, { grow: 1 });
		this.root = new VStack([header, panes, new Text(theme.fg("dim", "↑/↓ move · esc close"), GUTTER, 0)]);

		for (const row of rows) {
			void quota(row)
				.catch((error: unknown) => ({ session: 0, weekly: 0, error: error instanceof Error ? error.message : String(error) }))
				.then((result) => {
					this.quotas.set(row.name, result);
					this.refresh();
				});
		}
		this.refresh();
	}

	private refresh(): void {
		const row = this.rows.find((entry) => entry.name === this.providers.getSelectedItem()?.value);
		this.detail.setText(row === undefined ? "" : quotaLines(this.theme, row, this.quotas.get(row.name)).join("\n"));
		this.tui.requestRender();
	}

	render(width: number): string[] {
		return this.root.render(width);
	}

	invalidate(): void {
		this.root.invalidate();
	}

	handleInput(data: string): void {
		this.providers.handleInput(data);
		this.tui.requestRender();
	}
}

/** The factory `ctx.ui.custom` takes. */
export function usagePicker(
	rows: readonly UsageRow[],
	quota: (row: UsageRow) => Promise<Quota | null>,
): (tui: TUI, theme: Theme, keybindings: unknown, done: () => void) => Component {
	return (tui, theme, _keybindings, done) => new UsagePicker(tui, theme, rows, quota, done);
}
