/**
 * E1 (PRD-036 Phase 1): the recap brief is capped and transcript-free, and the
 * model's two-line answer parses or is dropped.
 *
 * AC-1: `buildRecapBrief` emits a brief under the documented caps and never
 * includes the transcript. The negative half matters as much as the positive:
 * a brief that quietly carried the whole session would still pass a test that
 * only checked the slots were present.
 */
import { describe, expect, it } from "vitest";
import { buildRecapBrief, RECAP_CAPS } from "../../src/recap/brief.js";
import { parseRecapResponse, RECAP_MAX_CHARS, TITLE_MAX_CHARS } from "../../src/recap/parse.js";

const HEADINGS = ["SESSION GOAL:", "THIS TURN:", "WHAT THE TURN DID:", "OPEN WORK:"];

/** The text under one heading, up to the next heading — slots may span lines. */
function slot(brief: string, heading: string): string {
	const start = brief.indexOf(heading);
	if (start === -1) return "";
	const rest = brief.slice(start + heading.length);
	const next = HEADINGS.map((candidate) => rest.indexOf(candidate))
		.filter((index) => index !== -1)
		.sort((left, right) => left - right)[0];
	return (next === undefined ? rest : rest.slice(0, next)).trim();
}

describe("buildRecapBrief (PRD-036 Phase 1)", () => {
	it("caps each slot at its documented ceiling (AC-1)", () => {
		const brief = buildRecapBrief({
			goal: "g".repeat(500),
			ask: "a".repeat(500),
			did: "d".repeat(2_000),
			openWork: Array.from({ length: 40 }, (_, index) => `item-${index}-${"w".repeat(20)}`),
		});

		expect(slot(brief, "SESSION GOAL:").length).toBeLessThanOrEqual(RECAP_CAPS.goal);
		expect(slot(brief, "THIS TURN:").length).toBeLessThanOrEqual(RECAP_CAPS.ask);
		expect(slot(brief, "WHAT THE TURN DID:").length).toBeLessThanOrEqual(RECAP_CAPS.did);
		expect(slot(brief, "OPEN WORK:").length).toBeLessThanOrEqual(RECAP_CAPS.openWork);
	});

	it("never carries the transcript, only the capped brief (AC-1)", () => {
		// Fifty messages, each with a marker no other slot could produce.
		const transcript = Array.from({ length: 50 }, (_, index) => `message-${index}: ${"x".repeat(200)}`).join("\n");
		const brief = buildRecapBrief({ goal: "ship the recap", ask: "wire it up", did: transcript });

		expect(transcript).toContain("message-49");
		expect(brief).not.toContain("message-49");
		// And the whole brief is bounded by the caps plus the fixed scaffolding.
		const bound = RECAP_CAPS.goal + RECAP_CAPS.ask + RECAP_CAPS.did + RECAP_CAPS.openWork + 600;
		expect(brief.length).toBeLessThan(bound);
	});

	it("omits an absent slot instead of emitting an empty heading", () => {
		const brief = buildRecapBrief({ ask: "just this turn" });
		expect(brief).toContain("THIS TURN:");
		expect(brief).not.toContain("SESSION GOAL:");
		expect(brief).not.toContain("WHAT THE TURN DID:");
		expect(brief).not.toContain("OPEN WORK:");
	});

	it("asks for a title only when one is wanted", () => {
		expect(buildRecapBrief({ ask: "a", wantTitle: true })).toContain("TITLE:");
		expect(buildRecapBrief({ ask: "a", wantTitle: false })).not.toContain("TITLE:");
	});
});

describe("parseRecapResponse (PRD-036 Phase 1)", () => {
	it("reads the two lines positionally", () => {
		const parsed = parseRecapResponse("RECAP: Wiring provider autodetection into the router; detection lands, routing next.\nTITLE: Provider autodetection");
		expect(parsed).toEqual({ recap: "Wiring provider autodetection into the router; detection lands, routing next.", title: "Provider autodetection" });
	});

	it("accepts a response with no title line", () => {
		expect(parseRecapResponse("RECAP: still working on the router")).toEqual({ recap: "still working on the router" });
	});

	it("enforces the 240/60-character ceilings", () => {
		const parsed = parseRecapResponse(`RECAP: ${"r".repeat(400)}\nTITLE: ${"t".repeat(200)}`);
		expect(parsed?.recap.length).toBeLessThanOrEqual(RECAP_MAX_CHARS);
		expect(parsed?.title?.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
	});

	it("strips control characters and markdown noise", () => {
		const parsed = parseRecapResponse("RECAP: **bold** `code` \u001b[31mred\u001b[0m\t# heading");
		expect(parsed?.recap).not.toContain("*");
		expect(parsed?.recap).not.toContain("`");
		expect(parsed?.recap).not.toContain("\u001b");
		expect(parsed?.recap).not.toContain("#");
		expect(parsed?.recap).toContain("bold");
	});

	it("drops a malformed, empty or partial response rather than throwing", () => {
		expect(parseRecapResponse("")).toBeUndefined();
		expect(parseRecapResponse("   \n  ")).toBeUndefined();
		expect(parseRecapResponse("I could not produce a recap.")).toBeUndefined();
		expect(parseRecapResponse("TITLE: only a title")).toBeUndefined();
		expect(parseRecapResponse("RECAP:")).toBeUndefined();
		expect(parseRecapResponse("RECAP: \u001b[0m")).toBeUndefined();
	});
});
