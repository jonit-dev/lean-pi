/**
 * S1: the verifier scope is data — changed filenames and contract-declared
 * surfaces — and it used to be pasted raw into a `shell: true` command. A
 * filename with a space became two arguments; `;`, `$(...)` and backticks
 * executed. The scope is now a shell-quoted token list and substitution is
 * literal, so every path arrives as one inert argv element.
 *
 * The recorder is a real executable, and the runner is the real `execShell`, so
 * what is asserted is the argv the operating system handed the process.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileTask } from "../../src/index.js";
import { GAP_ACTIONS } from "../../src/proof/actions.js";
import { criteriaOf } from "../../src/proof/packet.js";
import { recover } from "../../src/proof/recover.js";
import { AmbiguousScopeTemplateError, resolveCommand } from "../../src/verify/descriptors.js";
import { EvidenceStore } from "../../src/verify/evidence.js";
import { verifyTask } from "../../src/verify/index.js";
import { packet } from "../compiler/helpers.js";
import { contractOf, gitInit, tempWorkspace, writeFiles } from "./support.js";

/**
 * A real executable that writes each of its arguments, one per line. It lives
 * outside the workspace: writing the recording inside it would change the
 * workspace hash and turn the run's own records stale.
 */
function recorder(): { command: string; argsFile: string } {
	const dir = mkdtempSync(join(tmpdir(), "leanpi-scope-args-"));
	const argsFile = join(dir, "argv.txt");
	const script = join(dir, "record-args.sh");
	writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argsFile)}\n`, { mode: 0o755 });
	chmodSync(script, 0o755);
	return { command: script, argsFile };
}

function argvOf(argsFile: string): string[] {
	return readFileSync(argsFile, "utf8").split("\n").filter((line) => line.length > 0);
}

const SENTINELS = ["SENTINEL", "PWNED", "TICKED"];

function assertNoSentinels(root: string): void {
	for (const sentinel of SENTINELS) expect(existsSync(join(root, sentinel)), `${sentinel} was created`).toBe(false);
}

describe("S1 — the verifier scope is inert argv, not shell text", () => {
	it("runs every changed test path as one literal argv element", async () => {
		const root = tempWorkspace();
		gitInit(root);
		const { command, argsFile } = recorder();
		const files = [
			"tests/a b.spec.ts",
			"tests/x; touch SENTINEL.spec.ts",
			"tests/$(touch PWNED).spec.ts",
			"tests/back`touch TICKED`.spec.ts",
			"tests/dollar$&.spec.ts",
			"tests/quote'quote.spec.ts",
		];
		for (const file of files) writeFiles(root, { [file]: "export {};\n" });

		const result = await verifyTask(contractOf({ required: ["affected_tests"] }), root, {
			commands: { targeted_test: `${command} {{scope}}`, full_suite: "true" },
			diff: { files },
			timeoutMs: 60_000,
		});

		expect(result.records.find((record) => record.kind === "targeted_test")?.status).toBe("pass");
		expect(argvOf(argsFile)).toEqual(files);
		assertNoSentinels(root);
	});

	it("makes a contract-declared scope inert", async () => {
		const root = tempWorkspace();
		gitInit(root);
		const { command, argsFile } = recorder();
		const scope = "tests/it's $(touch PWNED).spec.ts";

		await verifyTask(
			contractOf({ required: ["affected_tests"], criteria: [{ id: "AC-1", verifiers: ["affected_tests"], scope }] }),
			root,
			{ commands: { targeted_test: `${command} {{scope}}`, full_suite: "true" }, touchedPaths: [], timeoutMs: 60_000 },
		);

		expect(argvOf(argsFile)).toEqual([scope]);
		assertNoSentinels(root);
	});

	it("makes the scope inert on the proof recovery path too", async () => {
		const root = tempWorkspace();
		gitInit(root);
		const { command, argsFile } = recorder();
		const scope = "tests/$(touch PWNED).spec.ts";
		const contract = contractOf({ required: ["affected_tests"], criteria: [{ id: "AC-1", verifiers: ["affected_tests"], scope }] });

		const outcome = await recover(
			{ criterion: criteriaOf(contract)[0]!, category: "TARGETED_TEST_REQUIRED", action: GAP_ACTIONS.TARGETED_TEST_REQUIRED, round: 1 },
			{ store: new EvidenceStore(), workspaceHash: "h", cwd: root, commands: { targeted_test: `${command} {{scope}}` }, timeoutMs: 60_000 },
		);

		expect(outcome.status).toBe("evidence");
		expect(argvOf(argsFile)).toEqual([scope]);
		assertNoSentinels(root);
	});

	it("leaves a declared glob for the shell to expand, as the default runner expects", async () => {
		const root = tempWorkspace();
		gitInit(root);
		const { command, argsFile } = recorder();
		writeFiles(root, { "tests/one.spec.ts": "export {};\n", "tests/two.spec.ts": "export {};\n" });

		await verifyTask(
			contractOf({ required: ["affected_tests"], criteria: [{ id: "AC-1", verifiers: ["affected_tests"], scope: "tests/*.spec.ts" }] }),
			root,
			{ commands: { targeted_test: `${command} {{scope}}`, full_suite: "true" }, touchedPaths: [], timeoutMs: 60_000 },
		);

		// The glob keeps its metacharacters, so the shell expands it to the real
		// files rather than the runner receiving one literal pattern.
		expect(argvOf(argsFile).sort()).toEqual(["tests/one.spec.ts", "tests/two.spec.ts"]);
	});

	it("keeps compiler-derived literal paths intact through compileTask, verifyTask and proof recovery", async () => {
		const root = tempWorkspace();
		gitInit(root);
		const files = [
			"tests/space name.spec.ts",
			"tests/star*.spec.ts",
			"tests/q?.spec.ts",
			"tests/br[ack]et.spec.ts",
			"tests/dollar$.spec.ts",
			"tests/quote'q.spec.ts",
		];
		for (const file of files) writeFiles(root, { [file]: "export {};\n" });
		// A decoy the `*` would expand to if a literal filename were read as a glob.
		writeFiles(root, { "tests/star-decoy.spec.ts": "export {};\n" });

		const contract = await compileTask(
			"fix the parse bug",
			packet({ workspace: { changed_files: files, likely_modules: ["tests"], test_runners: ["vitest"], lsp_available: true, git_branch: "main" } }),
		);
		// The compiler records the raw list — not a pre-quoted string that the
		// verifier would then quote a second time and collapse into one argument.
		expect(contract.verification.criteria).toEqual([{ id: "AC-1", verifiers: ["affected_tests"], scope: files }]);

		const first = recorder();
		const result = await verifyTask(contract, root, {
			commands: { typecheck: "true", targeted_test: `${first.command} {{scope}}`, full_suite: "true" },
			diff: { files },
			timeoutMs: 60_000,
		});
		expect(result.records.find((record) => record.kind === "targeted_test")?.status).toBe("pass");
		expect(argvOf(first.argsFile)).toEqual(files);
		assertNoSentinels(root);

		// The recovery path reads the same structured scope and stays inert.
		const second = recorder();
		const outcome = await recover(
			{ criterion: criteriaOf(contract)[0]!, category: "TARGETED_TEST_REQUIRED", action: GAP_ACTIONS.TARGETED_TEST_REQUIRED, round: 1 },
			{ store: new EvidenceStore(), workspaceHash: "h", cwd: root, commands: { targeted_test: `${second.command} {{scope}}` }, timeoutMs: 60_000 },
		);
		expect(outcome.status).toBe("evidence");
		expect(argvOf(second.argsFile)).toEqual(files);
		assertNoSentinels(root);
	});

	it("rejects a template that quotes {{scope}}, by name", () => {
		expect(() => resolveCommand("targeted_test", "tests/a.spec.ts", { targeted_test: 'npx vitest run "{{scope}}"' })).toThrow(AmbiguousScopeTemplateError);
		// A quote elsewhere in the template is not ambiguous: the placeholder itself
		// is bare, so the substitution is still inert.
		expect(resolveCommand("targeted_test", "tests/a.spec.ts", { targeted_test: "npx vitest run --reporter='verbose' {{scope}}" })).toBe(
			"npx vitest run --reporter='verbose' tests/a.spec.ts",
		);
	});

	it.each(["cat <<EOF\n{{scope}}\nEOF", "cat <<< {{scope}}"])("rejects heredoc scope substitution: %s", (template) => {
		expect(() => resolveCommand("targeted_test", ["tests/$(touch PWNED).spec.ts"], { targeted_test: template })).toThrow(AmbiguousScopeTemplateError);
	});
});
