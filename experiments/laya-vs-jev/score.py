"""Score JEV and Laya answers against the hand-written labels in cases.jsonl.

Choice and Noul questions are scored as accuracy (Noul thresholded at 0.5).
Score questions are scored as mean absolute error on the rubric's 0..N-1 index,
plus the rounded-level accuracy LeanPi actually consumes (`scoreToLevel` rounds
to the nearest level before use).

Calibration: ECE over the Choice answers at 5 equal-width bins, with the
confidence each provider reports (`confidence` for choice, `decisiveness` for
noul, matching `src/jev/types.ts`).

Usage: python score.py out/laya-english.jsonl out/jev.jsonl [...]
"""

from __future__ import annotations

import json
import pathlib
import sys

HERE = pathlib.Path(__file__).parent
BINS = 5

# The consequence class each case's site registers with in `src/`, and therefore
# the `accept()` threshold the lane applies (src/jev/confidence.ts):
# low 0.5, normal 0.7, high 0.85.
THRESHOLDS = {
    "executor.failure_classification": 0.5,
    "routing.quota_preference": 0.5,
    "routing.delegation_worth": 0.5,
    "routing.reasoning_effort": 0.7,
    "explore.candidate_relevance": 0.7,
    "explore.sufficiency": 0.7,
    "explore.subsystem_order": 0.7,
    "explore.snippet_relevance": 0.85,
    "explore.sibling_expansion": 0.7,
    "explore.test_relevance": 0.7,
    "classify.execution_complexity": 0.7,
    "classify.required_capability": 0.7,
    "classify.review_risk_input": 0.7,
    "gate.prd_required": 0.85,
}


def load_cases() -> dict[str, dict]:
    return {case["id"]: case for case in (json.loads(line) for line in (HERE / "cases.jsonl").read_text().splitlines() if line.strip())}


def decisiveness(probability: float) -> float:
    return abs(probability - 0.5) * 2


def predict(question: dict, answer: dict) -> tuple[str | float | None, float]:
    """Return (value, confidence) for one question, or (None, _) when absent."""
    if not answer:
        return None, 0.0
    kind = str(answer.get("type", "")).lower()
    if kind == "choice":
        return answer.get("choice"), float(answer.get("confidence", 0.0))
    if kind == "score":
        return float(answer["score"]), float(answer.get("confidence", 0.0))
    if kind == "noul":
        return float(answer["noul"]), decisiveness(float(answer["noul"]))
    return None, 0.0


def question_kind(question: dict) -> str:
    return question["type"].lower()


def score_run(cases: dict[str, dict], run: list[dict]) -> dict:
    per_site: dict[str, dict] = {}
    confidences: list[tuple[float, bool]] = []
    # (site, cleared_threshold, correct) for every labelled categorical answer.
    gated: list[tuple[str, bool, bool]] = []
    latencies: list[float] = []
    input_tokens = 0
    missing = 0

    for row in run:
        case = cases[row["id"]]
        latencies.append(row["latencyMs"])
        input_tokens += row.get("usage", {}).get("input_tokens", 0)
        site = per_site.setdefault(
            case["site"],
            {"choice": [0, 0], "noul": [0, 0], "scoreAbs": 0.0, "scoreLevel": [0, 0], "scoreN": 0},
        )
        for qid, expected in case["expected"].items():
            question = case["questions"][qid]
            value, confidence = predict(question, row["answers"].get(qid))
            if value is None:
                missing += 1
                continue
            kind = question_kind(question)
            if kind == "score":
                error = abs(float(value) - float(expected))
                site["scoreAbs"] += error
                site["scoreN"] += 1
                if round(float(value)) == round(float(expected)):
                    site["scoreLevel"][0] += 1
                site["scoreLevel"][1] += 1
            else:
                if kind == "noul":
                    got = 1.0 if float(value) > 0.5 else 0.0
                    correct = got == float(expected)
                    site["noul"][1] += 1
                    site["noul"][0] += int(correct)
                else:
                    correct = value == expected
                    site["choice"][1] += 1
                    site["choice"][0] += int(correct)
                confidences.append((confidence, bool(correct)))
                threshold = THRESHOLDS.get(case["site"], 0.7)
                gated.append((case["site"], confidence >= threshold, bool(correct)))

    choice_hits = sum(bucket["choice"][0] for bucket in per_site.values())
    choice_n = sum(bucket["choice"][1] for bucket in per_site.values())
    noul_hits = sum(bucket["noul"][0] for bucket in per_site.values())
    noul_n = sum(bucket["noul"][1] for bucket in per_site.values())
    score_abs = sum(bucket["scoreAbs"] for bucket in per_site.values())
    score_level_hits = sum(bucket["scoreLevel"][0] for bucket in per_site.values())
    score_level_n = sum(bucket["scoreLevel"][1] for bucket in per_site.values())
    score_n = sum(bucket["scoreN"] for bucket in per_site.values())

    # ECE over categorical answers.
    ece = 0.0
    if confidences:
        for index in range(BINS):
            low, high = index / BINS, (index + 1) / BINS
            bucket = [(c, ok) for c, ok in confidences if (low <= c < high) or (index == BINS - 1 and c == 1.0)]
            if not bucket:
                continue
            accuracy = sum(ok for _, ok in bucket) / len(bucket)
            mean_confidence = sum(c for c, _ in bucket) / len(bucket)
            ece += (len(bucket) / len(confidences)) * abs(accuracy - mean_confidence)

    accepted = [entry for entry in gated if entry[1]]
    accepted_correct = sum(1 for _, _, ok in accepted if ok)
    latencies.sort()
    return {
        "perSite": per_site,
        "choice": (choice_hits, choice_n),
        "noul": (noul_hits, noul_n),
        "scoreMae": (score_abs / score_n if score_n else 0.0, score_n),
        "scoreLevel": (score_level_hits, score_level_n),
        "ece": ece,
        "gated": (len(accepted), len(gated), accepted_correct),
        "p50": latencies[len(latencies) // 2] if latencies else 0.0,
        "p95": latencies[int(len(latencies) * 0.95)] if latencies else 0.0,
        "inputTokens": input_tokens,
        "missing": missing,
    }


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        raise SystemExit(2)
    show_diff = "--diff" in sys.argv
    paths = [arg for arg in sys.argv[1:] if not arg.startswith("--")]
    cases = load_cases()
    runs = {path: [json.loads(line) for line in pathlib.Path(path).read_text().splitlines() if line.strip()] for path in paths}
    results = {}
    for path, run in runs.items():
        provider = run[0]["provider"] if run else pathlib.Path(path).stem
        results[provider] = score_run(cases, run)

    providers = list(results)
    width = max(len(name) for name in providers) + 2

    def row(label: str, value_of) -> None:
        cells = "".join(f"{value_of(results[name]):>18}" for name in providers)
        print(f"{label:<28}{cells}")

    print(f"{'':<28}" + "".join(f"{name:>18}" for name in providers))
    print("-" * (28 + 18 * len(providers)))
    row("Choice accuracy", lambda r: f"{r['choice'][0]}/{r['choice'][1]} = {r['choice'][0]/max(r['choice'][1],1):.3f}")
    row("Noul accuracy", lambda r: f"{r['noul'][0]}/{r['noul'][1]} = {r['noul'][0]/max(r['noul'][1],1):.3f}")
    row("Score MAE (0..3)", lambda r: f"{r['scoreMae'][0]:.3f} (n={r['scoreMae'][1]})")
    row("Score level accuracy", lambda r: f"{r['scoreLevel'][0]}/{r['scoreLevel'][1]} = {r['scoreLevel'][0]/max(r['scoreLevel'][1],1):.3f}")
    row("ECE (categorical)", lambda r: f"{r['ece']:.3f}")
    row("accepted by accept()", lambda r: f"{r['gated'][0]}/{r['gated'][1]} = {r['gated'][0]/max(r['gated'][1],1):.2f}")
    row("accuracy when accepted", lambda r: f"{r['gated'][2]}/{r['gated'][0]} = {r['gated'][2]/max(r['gated'][0],1):.3f}")
    row("p50 latency (ms)", lambda r: f"{r['p50']:.0f}")
    row("p95 latency (ms)", lambda r: f"{r['p95']:.0f}")
    row("input tokens", lambda r: f"{r['inputTokens']}")
    row("missing answers", lambda r: f"{r['missing']}")

    sites = sorted({case["site"] for case in cases.values()})
    print("\nPer-site Choice/Noul accuracy (hits/asked):")
    for site in sites:
        cells = []
        for name in providers:
            bucket = results[name]["perSite"].get(site, {"choice": [0, 0], "noul": [0, 0]})
            hits = bucket["choice"][0] + bucket["noul"][0]
            asked = bucket["choice"][1] + bucket["noul"][1]
            cells.append(f"{hits}/{asked}" if asked else "-")
        print(f"  {site:<34}" + "".join(f"{cell:>12}" for cell in cells))

    if show_diff:
        print("\nEvery labelled question at least one provider got wrong:")
        providers = list(runs)
        for case_id, case in cases.items():
            for qid, expected in case["expected"].items():
                question = case["questions"][qid]
                kind = question_kind(question)
                values = []
                marks = ""
                for path in providers:
                    row = next(r for r in runs[path] if r["id"] == case_id)
                    value, _ = predict(question, row["answers"].get(qid))
                    if kind == "score":
                        correct = value is not None and abs(float(value) - float(expected)) <= 0.5
                    elif kind == "noul":
                        correct = value is not None and (1.0 if float(value) > 0.5 else 0.0) == float(expected)
                    else:
                        correct = value == expected
                    marks += "Y" if correct else "."
                    values.append(f"{pathlib.Path(path).stem.split('-')[0][:4]}:{value}")
                if marks != "Y" * len(providers):
                    print(f"  {case_id:<14} {qid[:24]:<24} expected={str(expected):<14} {marks}  " + "  ".join(values))


if __name__ == "__main__":
    main()
