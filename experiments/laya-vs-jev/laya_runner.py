"""Answer `cases.jsonl` with Laya, locally, and record latency.

Laya's response envelope is already `{model, answers, usage}` with
`choice`/`score`/`noul` answer objects, i.e. the same shape TypeSafe's
`/v1/systemone` returns. This runner keeps the raw envelope so the comparison
scores exactly what a JEV-shaped caller would receive.

Usage: .venv/bin/python laya_runner.py [--device cuda] [--subfolder multilingual] [--limit N]
"""

from __future__ import annotations

import argparse
import json
import pathlib
import time

HERE = pathlib.Path(__file__).parent


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--subfolder", default=None, help="multilingual | typed-decisions | (none = English root)")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--out", default=None)
    args = parser.parse_args()

    import laya

    cases = [json.loads(line) for line in (HERE / "cases.jsonl").read_text().splitlines() if line.strip()]
    if args.limit:
        cases = cases[: args.limit]

    started = time.time()
    agent = laya.load("convaiinnovations/laya", device=args.device, subfolder=args.subfolder)
    load_seconds = time.time() - started
    tag = args.subfolder or "english"

    out_path = pathlib.Path(args.out) if args.out else HERE / "out" / f"laya-{tag}.jsonl"
    out_path.parent.mkdir(parents=True, exist_ok=True)

    # One warm-up so the first case is not charged model compilation.
    agent.predict({"body": "warm up"}, {"q": {"type": "noul", "instructions": "Is this a warm up?"}})

    rows = []
    for case in cases:
        started = time.time()
        response = agent.predict(case["state"], case["questions"])
        latency_ms = (time.time() - started) * 1000
        rows.append(
            {
                "id": case["id"],
                "site": case["site"],
                "provider": f"laya-{tag}",
                "latencyMs": latency_ms,
                "answers": response.get("answers", {}),
                "usage": response.get("usage", {}),
                "model": response.get("model", "laya"),
            }
        )
        print(f"{case['id']:<18} {latency_ms:7.1f} ms")

    with out_path.open("w") as handle:
        for row in rows:
            handle.write(json.dumps(row) + "\n")

    latencies = sorted(row["latencyMs"] for row in rows)
    print(
        f"\n{len(rows)} cases in {sum(latencies)/1000:.2f}s | load {load_seconds:.1f}s | "
        f"p50 {latencies[len(latencies)//2]:.1f} ms | p95 {latencies[int(len(latencies)*0.95)]:.1f} ms -> {out_path}"
    )


if __name__ == "__main__":
    main()
