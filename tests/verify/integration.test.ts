/**
 * E2 integration (AC-1): verification is reachable from the turn entry point.
 *
 * PRD-001 owns `src/commands/session.ts`, so this spec uses its public lane seam
 * — the place a lane hooks into an ordered turn — rather than editing the file.
 * The run happens after the turn's workspace edits have landed, against a
 * workspace whose typecheck genuinely fails.
 */
import { describe, expect, it } from "vitest";
import { clearLanes, registerLane, runTurn, type Lane, type TurnContext } from "../../src/commands/session.js";
import { verifyTask, type VerifyResult } from "../../src/verify/index.js";
import { contractOf, gitInit, stubConfig, tempWorkspace, writeFiles, TSC } from "./support.js";

describe("verification on the turn path (AC-1)", () => {
	it("attaches a deterministic failure to the turn's outcome", async () => {
		const root = tempWorkspace();
		gitInit(root);
		writeFiles(root, { "src/bad.ts": "export const bad: number = 'not a number';\n" });
		const contract = contractOf({ required: ["typecheck"], criteria: [{ id: "AC-1", verifiers: ["typecheck"] }] });

		clearLanes();
		const lane: Lane = {
			name: "verify",
			async run(_turn, context: TurnContext) {
				context.contract ??= contract;
				(context as TurnContext & { evidence?: VerifyResult }).evidence = await verifyTask(context.contract, context.cwd, {
					commands: { typecheck: `${TSC} --noEmit --strict src/bad.ts` },
					touchedPaths: ["src/bad.ts"],
					timeoutMs: 60_000,
				});
			},
		};
		registerLane(lane);

		const outcome = (await runTurn({ text: "fix the parse bug" }, { config: stubConfig(root, "disabled"), cwd: root })) as TurnContext & {
			evidence?: VerifyResult;
		};

		expect(outcome.evidence?.status).toBe("deterministic_failure");
		const record = outcome.evidence?.records.find((entry) => entry.kind === "typecheck");
		expect(record?.status).toBe("fail");
		expect(record?.exitCode).toBeGreaterThan(0);
		expect(outcome.evidence?.records.find((entry) => entry.kind === "git_status")?.status).toBe("pass");
	});
});
