#!/usr/bin/env python3
"""Fold a cost series from the bench ledgers, one arm at a time.

Every figure the cost report cites comes from here, and from `telemetry.jsonl`
alone. Three rules the earlier, thrown-together fold broke:

  * a run counts only when it completed every task of its suite (a partial run's
    unreached tasks have unknown spend, so its total is not comparable);
  * an arm's runs must have run the same task set, or the medians compare
    different work;
  * a pair is reported as a within-pair ratio, because the absolute numbers swing
    with the hour, and the pair is what cancels that.

Usage: bench/cost/fold.py bench/cost/series.json

`series.json` records what was run, so no label is ever inferred from a
directory name:

    [
      {
        "label": "express — permissions",
        "tasks": 1,
        "arms": {
          "A (ed05f8d)": ["cost-r1-base", "cost-r2-base"],
          "C (this tree)": ["cost-r1-treat", "cost-r2-treat"]
        },
        "pairs": [["cost-r1-base", "cost-r1-treat"]]
      }
    ]
"""
import json
import os
import statistics
import sys

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "out")


def load(run):
    path = os.path.join(OUT, run, "telemetry.jsonl")
    if not os.path.exists(path):
        return None
    rows = [json.loads(line) for line in open(path) if line.strip()]
    # The verdict is the adjudicator's, and it lives in the ledger: telemetry
    # carries LeanPi's own claim, which on this path is always `success: false`.
    ledger_path = os.path.join(OUT, run, "ledger.jsonl")
    verdicts = {}
    if os.path.exists(ledger_path):
        for line in open(ledger_path):
            if line.strip():
                row = json.loads(line)
                verdicts[row["task_id"].split("@")[0]] = (row.get("adjudication") or {}).get("verdict")
    return {
        "run": run,
        "tasks": {row["task_id"].split("@")[0]: row for row in rows},
        "cost": sum(row["cost"]["effective_cost"] for row in rows),
        "reason": sum(row["usage"]["reasoning_tokens"] for row in rows),
        "tools": sum(row["execution"]["tool_calls"] for row in rows),
        "wall_ms": sum(row["execution"]["wall_ms"] for row in rows),
        "verdicts": sorted({str(v) for v in verdicts.values()}) or ["(no ledger)"],
    }


def complete(run, expected):
    """The loaded run when it finished its whole suite, else (None, why not)."""
    loaded = load(run)
    if loaded is None:
        return None, "no telemetry"
    if len(loaded["tasks"]) != expected:
        return None, f"{len(loaded['tasks'])}/{expected} tasks (partial run)"
    return loaded, None


def describe(label, runs, expected):
    kept, dropped = [], []
    for run in runs:
        loaded, why = complete(run, expected)
        (kept.append(loaded) if loaded else dropped.append(f"{run}: {why}"))
    print(f"\n{label}  (n={len(kept)})")
    for why in dropped:
        print(f"    dropped — {why}")
    if not kept:
        return kept
    if len({frozenset(r["tasks"]) for r in kept}) > 1:
        print("    !! runs cover different task sets; the medians are not comparable")
    costs = [r["cost"] for r in kept]
    print(f"    median ${statistics.median(costs):.6f}   min ${min(costs):.6f}   max ${max(costs):.6f}")
    for r in sorted(kept, key=lambda r: r["cost"]):
        print(f"      {r['run']:<20} ${r['cost']:.6f}  tools={r['tools']:<4} reason={r['reason']:<7} wall={r['wall_ms'] / 1000:>6.0f}s  {','.join(r['verdicts'])}")
    return kept


def ratios(pairs, expected):
    print("\n    pairs (same hour, alternating arms):")
    seen = []
    for base, treat in pairs:
        b, bwhy = complete(base, expected)
        t, twhy = complete(treat, expected)
        if not b or not t:
            print(f"      skipped {base} / {treat} — {bwhy or twhy}")
            continue
        if set(b["tasks"]) != set(t["tasks"]):
            print(f"      skipped {base} / {treat} — different task sets")
            continue
        ratio = t["cost"] / b["cost"]
        seen.append(ratio)
        print(f"      {base:<20} ${b['cost']:.6f}   {treat:<20} ${t['cost']:.6f}   x{ratio:.2f} ({100 * (ratio - 1):+.0f}%)")
    if seen:
        print(f"      median ratio {statistics.median(seen):.2f}   min {min(seen):.2f}   max {max(seen):.2f}")


def main(path):
    for series in json.load(open(path)):
        print(f"\n=== {series['label']} ({series['tasks']} task(s) per run) ===")
        for label, runs in series["arms"].items():
            describe(label, runs, series["tasks"])
        ratios([tuple(pair) for pair in series.get("pairs", [])], series["tasks"])


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
