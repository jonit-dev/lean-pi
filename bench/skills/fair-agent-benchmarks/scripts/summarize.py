#!/usr/bin/env python3
"""Summarize normalized coding-agent benchmark attempts into per-arm cost metrics.

Input JSON (top level): parity_verified: bool, parity_evidence: str, attempts: [row].
Row: {task: str, arm: str, trial: int, status: str in {passed,failed,timeout,error,invalid},
cost_usd: {model,classifier,delegated,other} each number>=0 or null, seconds: number}.
Retries must already be aggregated into the trial before input.

All costs are summed including failures; null components make known_spend a lower
bound and block a cost-per-completion claim. Invalid infrastructure trials
invalidate the comparison but remain spent, are excluded from the quality pass
rate, and leave that rate null when no valid task trials remain.
parity_evidence is a human note; the caller must verify the real artifacts, the
helper cannot.

Usage:
  python3 summarize.py results.json
  python3 summarize.py --self-test
"""
import json
import math
import sys

STATUSES = {"passed", "failed", "timeout", "error", "invalid"}
COMPONENTS = ("model", "classifier", "delegated", "other")


class BadInput(ValueError):
    pass


def _num(v, name, allow_null=True):
    if v is None and allow_null:
        return None
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or v < 0:
        raise BadInput(f"invalid {name}: {v!r}")
    return float(v)


def parse(data):
    if not isinstance(data, dict):
        raise BadInput("top level must be an object")
    if not isinstance(data.get("parity_verified"), bool):
        raise BadInput("parity_verified must be a bool")
    evidence = data.get("parity_evidence")
    if not isinstance(evidence, str):
        raise BadInput("parity_evidence must be a string")
    if data["parity_verified"] and not evidence.strip():
        raise BadInput("parity_evidence must be non-empty when parity_verified is true")
    attempts = data.get("attempts")
    if not isinstance(attempts, list):
        raise BadInput("attempts must be a list")
    rows, seen = [], set()
    for i, r in enumerate(attempts):
        if not isinstance(r, dict):
            raise BadInput(f"attempt {i} must be an object")
        task, arm, trial, status = r.get("task"), r.get("arm"), r.get("trial"), r.get("status")
        if not isinstance(task, str) or not task.strip():
            raise BadInput(f"attempt {i}: task must be a non-empty string")
        if not isinstance(arm, str) or not arm.strip():
            raise BadInput(f"attempt {i}: arm must be a non-empty string")
        if isinstance(trial, bool) or not isinstance(trial, int) or trial < 1:
            raise BadInput(f"attempt {i}: trial must be a positive int")
        if not isinstance(status, str) or status not in STATUSES:
            raise BadInput(f"attempt {i}: invalid status {status!r}")
        cost = r.get("cost_usd")
        if not isinstance(cost, dict) or any(c not in cost for c in COMPONENTS):
            raise BadInput(f"attempt {i}: cost_usd must explicitly contain {COMPONENTS}")
        cost = {c: _num(cost[c], f"cost_usd.{c}") for c in COMPONENTS}
        key = (task, arm, trial)
        if key in seen:
            raise BadInput(f"duplicate (task,arm,trial): {key}")
        seen.add(key)
        rows.append({"task": task, "arm": arm, "trial": trial, "status": status,
                     "cost_usd": cost, "seconds": _num(r.get("seconds"), "seconds", False)})
    return {"parity_verified": data["parity_verified"],
            "parity_evidence": data["parity_evidence"], "rows": rows}


def summarize(parsed):
    rows, arms = parsed["rows"], {}
    for r in rows:
        a = arms.setdefault(r["arm"], {"total_trials": 0, "verified": 0, "spend": 0.0,
                                       "complete": True, "seconds": 0.0, "pairs": set(),
                                       "counts": {s: 0 for s in STATUSES}})
        a["total_trials"] += 1
        a["verified"] += r["status"] == "passed"
        a["counts"][r["status"]] += 1
        a["seconds"] += r["seconds"]
        a["pairs"].add((r["task"], r["trial"]))
        for c in COMPONENTS:
            v = r["cost_usd"][c]
            if v is None:
                a["complete"] = False
            else:
                a["spend"] += v
    reasons = []
    if not parsed["parity_verified"]:
        reasons.append("capability parity not verified")
    if any(r["status"] == "invalid" for r in rows):
        reasons.append("invalid trials present")
    pair_sets = [a["pairs"] for a in arms.values()]
    if len(pair_sets) < 2 or any(s != pair_sets[0] for s in pair_sets):
        reasons.append("paired (task,trial) sets differ across arms")
    if len(arms) < 2 or any(a["verified"] == 0 for a in arms.values()):
        reasons.append("not every arm has a verified completion")
    if any(not a["complete"] for a in arms.values()):
        reasons.append("cost incomplete (null component present)")
    out = {}
    for name, a in arms.items():
        valid = a["total_trials"] - a["counts"]["invalid"]
        out[name] = {
            "total_trials": a["total_trials"],
            "valid_trials": valid,
            "status_counts": dict(a["counts"]),
            "verified": a["verified"],
            "passrate": a["verified"] / valid if valid else None,
            "known_spend_usd": round(a["spend"], 6),
            "cost_complete": a["complete"],
            "cost_per_verified_completion": (round(a["spend"] / a["verified"], 6)
                                             if a["complete"] and a["verified"] else None),
            "elapsed_seconds": round(a["seconds"], 3),
        }
    return {"parity_verified": parsed["parity_verified"], "arms": out,
            "comparison_eligible": not reasons, "reasons": reasons}


def _row(task, arm, trial, status, cost, seconds=1.0):
    c = {k: 0 for k in COMPONENTS}
    c.update(cost)
    return {"task": task, "arm": arm, "trial": trial, "status": status,
            "cost_usd": c, "seconds": seconds}


def self_test():
    base = {"parity_verified": True, "parity_evidence": "same provider/model/settings"}
    s = summarize(parse(dict(base, attempts=[
        _row("t1", "A", 1, "passed", {"model": 1.0}),
        _row("t1", "B", 1, "failed", {"model": 2.0})])))
    assert s["arms"]["A"]["known_spend_usd"] == 1.0
    assert s["arms"]["B"]["known_spend_usd"] == 2.0, "failed trial cost must stay in spend"
    assert s["arms"]["A"]["cost_per_verified_completion"] == 1.0
    assert s["arms"]["B"]["verified"] == 0 and s["arms"]["B"]["cost_per_verified_completion"] is None

    s0 = summarize(parse(dict(base, attempts=[
        _row("t1", "A", 1, "failed", {"model": 1.0}),
        _row("t1", "B", 1, "failed", {"model": 1.0})])))
    assert s0["arms"]["A"]["cost_per_verified_completion"] is None
    assert s0["comparison_eligible"] is False

    sn = summarize(parse(dict(base, attempts=[
        _row("t1", "A", 1, "passed", {"model": None}),
        _row("t1", "B", 1, "passed", {"model": 3.0})])))
    assert sn["arms"]["A"]["known_spend_usd"] == 0.0 and sn["arms"]["A"]["cost_complete"] is False
    assert sn["arms"]["A"]["cost_per_verified_completion"] is None

    for bad in [dict(base, attempts=[_row("t1", "A", 1, "passed", {"model": 1.0}),
                                     _row("t1", "A", 1, "passed", {"model": 1.0})])]:
        try:
            parse(bad)
            assert False, "duplicate not rejected"
        except BadInput:
            pass
    for v in (float("nan"), float("inf"), -1.0):
        try:
            parse(dict(base, attempts=[_row("t1", "A", 1, "passed", {"model": v})]))
            assert False, f"cost {v} not rejected"
        except BadInput:
            pass

    su = summarize(parse(dict(base, attempts=[
        _row("t1", "A", 1, "passed", {"model": 1.0}),
        _row("t2", "B", 1, "passed", {"model": 1.0})])))
    assert su["comparison_eligible"] is False and any("paired" in r for r in su["reasons"])

    si = summarize(parse(dict(base, attempts=[
        _row("t1", "A", 1, "invalid", {"model": 5.0}),
        _row("t1", "B", 1, "passed", {"model": 1.0})])))
    assert si["comparison_eligible"] is False and si["arms"]["A"]["known_spend_usd"] == 5.0

    sr = summarize(parse(dict(base, attempts=[
        _row("t1", "A", 1, "passed", {"model": 1.0}),
        _row("t1", "A", 2, "failed", {"model": 2.0}),
        _row("t1", "B", 1, "passed", {"model": 4.0}),
        _row("t1", "B", 2, "passed", {"model": 4.0})])))
    assert sr["arms"]["A"]["known_spend_usd"] == 3.0
    assert sr["arms"]["A"]["cost_per_verified_completion"] == 3.0
    assert sr["arms"]["B"]["cost_per_verified_completion"] == 4.0
    assert sr["arms"]["A"]["passrate"] == 0.5 and sr["arms"]["B"]["passrate"] == 1.0
    assert sr["comparison_eligible"] is True

    sv = summarize(parse(dict(base, attempts=[
        _row("t1", "A", 1, "invalid", {"model": 5.0}),
        _row("t1", "A", 2, "invalid", {"model": 1.0}),
        _row("t1", "B", 1, "invalid", {"model": 2.0}),
        _row("t1", "B", 2, "invalid", {"model": 3.0})])))
    assert sv["arms"]["A"]["passrate"] is None and sv["arms"]["A"]["status_counts"]["invalid"] == 2
    assert sv["arms"]["A"]["known_spend_usd"] == 6.0 and sv["arms"]["B"]["known_spend_usd"] == 5.0
    assert sv["comparison_eligible"] is False

    for bad in [dict(base, parity_evidence=""),
                dict(base, parity_evidence="   "),
                dict(base, attempts=[_row("", "A", 1, "passed", {"model": 1.0})]),
                dict(base, attempts=[_row("t1", " ", 1, "passed", {"model": 1.0})]),
                dict(base, attempts=[_row("t1", "A", 0, "passed", {"model": 1.0})]),
                dict(base, attempts=[_row("t1", "A", -1, "passed", {"model": 1.0})]),
                dict(base, attempts=[_row("t1", "A", 1, ["passed"], {"model": 1.0})])]:
        try:
            parse(bad)
            assert False, f"accepted {bad!r}"
        except BadInput:
            pass
    assert parse({"parity_verified": False, "parity_evidence": "", "attempts": []})
    print("self-test: all assertions passed")


def main(argv):
    if argv[1:] == ["--self-test"]:
        self_test()
        return 0
    if len(argv) != 2:
        print(__doc__)
        return 2
    with open(argv[1]) as f:
        data = json.load(f)
    print(json.dumps(summarize(parse(data)), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
