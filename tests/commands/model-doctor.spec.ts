/**
 * E2 (PRD-016 Phase 2): the model surface and backend health.
 *
 * Covers AC-4 (the switch is observable through `/status` and `/route`, not just
 * an echo; the ranking is annotated and never fetched) and AC-5 (honest health
 * reporting with a row per backend, plus registry counts and roots). The
 * fixture has one reachable backend and one whose command is absent from `PATH`,
 * so a `/doctor` that emitted a literal status would fail the asymmetry check.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createJevClient, type LeanPiConfig } from "../../src/index.js";
import { installStubCli } from "../backends/helpers.js";
import { nativeBackend, tempDir } from "../helpers/fixtures.js";
import { startStubBackend, type StubBackend } from "../helpers/stub-backend.js";
import { startStubJev, type StubJev } from "../helpers/stub-jev.js";
import { skillFixture, surfaceFixture, type SurfaceFixture } from "./helpers.js";

const RANKED_MODEL = "claude-haiku-4-5";
const UNRANKED_MODEL = "not-a-ranked-model";
const MISSING_COMMAND = "leanpi-not-installed-xyz";
const STUB_SECRET = "sk-super-secret-value";

let backend: StubBackend;
let jev: StubJev;

beforeAll(async () => {
	backend = await startStubBackend();
	jev = await startStubJev(() => ({ answers: { jev_check: { type: "noul", noul: 0.9 } }, model: "jev-stub-1.0" }));
});

afterAll(async () => {
	await backend.close();
	await jev.close();
});

function modelDoctorFixture(): SurfaceFixture {
	const cwd = tempDir("leanpi-models-");
	const skillRoots = [skillFixture(tempDir("leanpi-skillroot-"))];
	return surfaceFixture({
		cwd,
		config: {
			backends: {
				stub: nativeBackend(backend.baseUrl, { apiKey: STUB_SECRET }),
				harness: { type: "external_harness", vendor: "codex", command: MISSING_COMMAND, apiKey: "sk-harness-secret" },
			},
			models: {
				quick: { backend: "stub", model: RANKED_MODEL },
				balanced: { backend: "stub", model: "gpt-5" },
				strong: { backend: "stub", model: UNRANKED_MODEL },
				review_quick: { backend: "stub", model: "claude-sonnet-4-5" },
			},
			capabilities: { skillRoots },
			jev: { endpoint: jev.url, apiKey: "test-key", model: "jev-latest", mode: "enabled" },
		},
		// PRD-024's role floor/ceiling/pin surface is read structurally off the config.
		configOverrides: { capability: { roles: { strong: { pin: "gpt-5" } } } } as Partial<LeanPiConfig>,
		name: "models",
		jev: (config) => createJevClient({ config, cwd }),
	});
}

describe("/models and /doctor (PRD-016 Phase 2)", () => {
	it("lists configured models by role with the ranking's score, price, role-fill, revision and staleness (AC-4)", async () => {
		const fixture = modelDoctorFixture();

		const models = await fixture.dispatch("/models");
		expect(models.ok).toBe(true);
		expect(models.text).toContain("ranking revision 2");
		expect(models.text).toMatch(/oldest record \d{4}-\d{2}-\d{2} \(\d+ days old/);
		// A ranked model carries its score, price, role-fill and evidence kind.
		expect(models.text).toMatch(
			new RegExp(`quick\\s+stub/${RANKED_MODEL}\\s+coding_score: \\d+\\s+price: \\$[0-9.]+/Mtok blended\\s+roles: .*evidence: (measured|estimated)`),
		);
		// A configured model the ranking does not list stays in the listing, marked unavailable.
		expect(models.text).toMatch(new RegExp(`strong\\s+stub/${UNRANKED_MODEL}\\s+coding_score: unavailable\\s+price: unknown\\s+roles: unlisted`));
		// The platform resolved that role through the ranking instead of the static entry.
		expect(models.text).toContain("resolved: stub/gpt-5");
		expect(models.text).toContain(`backend: ok (reachable at 127.0.0.1`);
		expect(models.text).not.toContain(STUB_SECRET);

		// The ranking is a shipped file: there is nothing to refresh.
		const refresh = await fixture.dispatch("/models --refresh");
		expect(refresh.ok).toBe(false);
		expect(refresh.text).toContain("unknown flag");
	});

	it("pins the executor lane through /route, observable in the next /route (AC-4)", async () => {
		const fixture = modelDoctorFixture();

		const before = await fixture.dispatch("/route");
		expect(before.text).toContain("route: no contract compiled yet");
		expect(before.text).not.toContain("gpt-5");

		// `/model <role>` is gone: Pi owns `/model`, and the role switch was always
		// this pin. The binding still resolves through the ranking (PRD-024).
		const switched = await fixture.dispatch("/route executor strong");
		expect(switched.ok).toBe(true);

		const route = await fixture.dispatch("/route");
		expect(route.text).toContain("executor: strong stub/gpt-5 (forced)");
		expect(route.text).toContain("review: ");
	});

	it("reports one row per backend, the missing command, the registries' counts and roots, and no secret (AC-5)", async () => {
		const fixture = modelDoctorFixture();

		const doctor = await fixture.dispatch("/doctor");
		expect(doctor.ok).toBe(true);
		expect(doctor.text).toMatch(
			new RegExp(`backend harness \\(external_harness\\)\\s+unavailable\\s+command "${MISSING_COMMAND}" is not on PATH`),
		);
		expect(doctor.text).toMatch(/backend stub \(native\)\s+ok\s+reachable at 127\.0\.0\.1:\d+/);
		expect(doctor.text).toMatch(/jev\s+ok\s+configured \(source: config, mode: enabled\) answered in \d+ms/);
		expect(doctor.text).toMatch(/skills\s+ok\s+1 indexed from .*leanpi-skillroot-[^ ]* \(user\)/);
		expect(doctor.text).toMatch(/mcp\s+\w+\s+\d+ servers, \d+ tools indexed from/);
		// The summary reflects the worst row, and it is the backend that is missing its command.
		expect(doctor.text).toMatch(/summary: unavailable — backend harness/);
		// The two backend rows differ: a literal status could not pass both.
		expect(doctor.text).toContain("ok");
		expect(doctor.text).not.toContain(STUB_SECRET);
		expect(doctor.text).not.toContain("sk-harness-secret");
	});

	it("separates installed from signed in, reports a refused JEV probe, and does not degrade over absent MCP config (F7)", async () => {
		const cli = installStubCli();
		// A JEV endpoint that rejects the credential: the old row read this as
		// "answered in 3ms" and dropped the 401 entirely.
		const refusing = await startStubJev([() => ({ status: 401 })]);
		const cwd = tempDir("leanpi-doctor-auth-");
		const fixture = surfaceFixture({
			cwd,
			config: {
				// On PATH, but the fixture's `$HOME` holds no credential and the stub
				// answers `codex login status` with something that is not a login.
				backends: { harness: { type: "external_harness", vendor: "codex", command: cli.bin.codex } },
				models: { quick: { backend: "harness", model: "default" } },
				capabilities: { skillRoots: [skillFixture(tempDir("leanpi-skillroot-"))] },
				jev: { endpoint: refusing.url, apiKey: "test-key", model: "jev-latest", mode: "enabled" },
			},
			name: "doctor-auth",
			jev: (config) => createJevClient({ config, cwd }),
		});

		const doctor = await fixture.dispatch("/doctor");
		await refusing.close();

		expect(doctor.text).toMatch(/backend harness \(external_harness\)\s+degraded/);
		expect(doctor.text).toContain(`run \`${cli.bin.codex} login\``);
		expect(doctor.text).toMatch(/jev\s+degraded\s+.*but the probe failed: JEV responded 401/);
		// No MCP config in the fixture: optional and absent is not a fault.
		expect(doctor.text).toMatch(/mcp\s+ok\s+0 servers/);
		expect(doctor.text).toContain("summary: degraded");
	});
});
