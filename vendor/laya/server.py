#!/usr/bin/env python3
"""A JEV-contract HTTP server backed by Laya (PRD-040).

LeanPi's JEV client speaks one wire contract:

    POST /v1/systemone
    {"state": {...}, "model": "...", "questions": {"id": {"type", "instructions", "criteria"}}}
    -> {"model": "...", "answers": {"id": {"type": "choice"|"score"|"noul", ...}}, "usage": {...}}

Laya's `Agent.predict()` already returns that envelope, so this server is a
transport swap plus one adapter: `adapt_answers` rewrites Laya's normalised
entropy confidence into the top-option probability JEV reports, because
LeanPi's `accept()` thresholds were calibrated against the latter and would
otherwise reject every answer and silently fall back on every site.

`--fake` answers from a canned table with no torch import, so LeanPi's own test
suite can spawn this process and speak real HTTP without a GPU or a 2 GB
download. `--selftest` asserts the adapter and exits non-zero when it is a
passthrough.
"""

from __future__ import annotations

import argparse
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

AGENT = None
MODEL_NAME = "laya"
LOCK = threading.Lock()
FAKE = False
ADAPT = True


def adapt_answers(answers: dict) -> dict:
    """Map a Laya answer envelope onto the confidence JEV reports.

    Laya's choice/score confidence is normalised Shannon entropy
    (`1 - H(p)/log k`), which stays low even when one option dominates: a
    five-option question answered at P(top)=0.9 scores about 0.7 and lands
    under LeanPi's `normal` (0.7) and `high` (0.85) thresholds. JEV reports the
    top-option probability, so that is what this emits. `noul` is left alone:
    the client derives its confidence from the probability itself.
    """
    for answer in answers.values():
        if not isinstance(answer, dict):
            continue
        if str(answer.get("type", "")).lower() not in ("choice", "score"):
            continue
        probabilities = answer.get("probabilities")
        if isinstance(probabilities, dict) and probabilities:
            answer["confidence"] = max(float(value) for value in probabilities.values())
    return answers


def fake_answers(questions: dict) -> dict:
    """A deterministic canned answer per question, shaped like a Laya answer.

    The `confidence` here is deliberately the *raw entropy* value (0.2), not the
    adapted one, so `--selftest` and LeanPi's adapter test have a real input to
    distinguish from the adapted output.
    """
    answers = {}
    for question_id, question in questions.items():
        kind = str(question.get("type", "")).lower()
        if kind == "choice":
            criteria = question.get("criteria") or {}
            options = list(criteria.keys()) if isinstance(criteria, dict) else list(criteria)
            first = options[0] if options else "none"
            probabilities = {option: (0.9 if option == first else 0.1 / max(len(options) - 1, 1)) for option in options}
            answers[question_id] = {"type": "choice", "choice": first, "probabilities": probabilities, "confidence": 0.2}
        elif kind == "score":
            criteria = question.get("criteria") or []
            levels = list(range(len(criteria))) or [0]
            probabilities = {str(level): (0.9 if level == levels[0] else 0.1 / max(len(levels) - 1, 1)) for level in levels}
            answers[question_id] = {"type": "score", "score": float(levels[0]), "legend": {}, "probabilities": probabilities, "confidence": 0.2}
        else:
            answers[question_id] = {"type": "noul", "noul": 0.9, "confidence": 0.9}
    return answers


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args) -> None:  # LeanPi reads stderr for readiness only
        pass

    def _send(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:  # noqa: N802 - stdlib naming
        if self.path.rstrip("/") != "/v1/systemone":
            self._send(404, {"error": f"unknown path {self.path}"})
            return
        length = int(self.headers.get("content-length", "0"))
        try:
            request = json.loads(self.rfile.read(length))
        except json.JSONDecodeError as error:
            self._send(400, {"error": f"bad json: {error}"})
            return

        state = request.get("state") or {}
        questions = request.get("questions") or {}
        started = time.time()
        try:
            if FAKE:
                answers = fake_answers(questions)
            else:
                with LOCK:  # one GPU, one request at a time
                    answers = AGENT.predict(state, questions).get("answers", {})
        except Exception as error:  # a 5xx is what makes the client take its fallback
            self._send(500, {"error": f"{type(error).__name__}: {error}"})
            return

        answers = adapt_answers(answers) if ADAPT else answers
        self._send(
            200,
            {
                "model": MODEL_NAME,
                "answers": answers,
                "usage": {"input_tokens": 0, "output_tokens": 0},
                "latency_ms": round((time.time() - started) * 1000, 2),
            },
        )


def selftest() -> int:
    """Assert the adapter, and fail loudly when it is a passthrough."""
    cases = {
        "choice": {"type": "choice", "choice": "a", "probabilities": {"a": 0.9, "b": 0.1}, "confidence": 0.2},
        "score": {"type": "score", "score": 0.0, "probabilities": {"0": 0.9, "1": 0.1}, "confidence": 0.2},
        "noul": {"type": "noul", "noul": 0.9, "confidence": 0.9},
    }
    adapted = adapt_answers({key: dict(value) for key, value in cases.items()})
    assert adapted["choice"]["confidence"] == 0.9, f"choice confidence not adapted: {adapted['choice']}"
    assert adapted["score"]["confidence"] == 0.9, f"score confidence not adapted: {adapted['score']}"
    assert adapted["noul"]["confidence"] == 0.9, "noul confidence must be left alone"
    # A question with no probabilities keeps whatever the model reported.
    kept = adapt_answers({"q": {"type": "choice", "choice": "a", "confidence": 0.4}})
    assert kept["q"]["confidence"] == 0.4, "an answer with no probabilities must keep its confidence"
    print("selftest ok: adapter maps entropy confidence to the top probability", file=sys.stderr)
    return 0


def main() -> int:
    global AGENT, MODEL_NAME, FAKE, ADAPT
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--subfolder", default=None)
    parser.add_argument("--fake", action="store_true")
    parser.add_argument("--no-adapt", action="store_true", help="serve Laya's raw entropy confidence (the adapter's negative control)")
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args()

    if args.selftest:
        return selftest()

    FAKE = args.fake
    ADAPT = not args.no_adapt
    if FAKE:
        MODEL_NAME = "laya-fake"
    else:
        import laya

        AGENT = laya.load("convaiinnovations/laya", device=args.device, subfolder=args.subfolder)
        MODEL_NAME = f"laya-{args.subfolder}" if args.subfolder else "laya-english"
        # One warm-up so the first real request is not charged model compilation.
        AGENT.predict({"body": "warm up"}, {"q": {"type": "noul", "instructions": "warm up?"}})

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    port = server.server_address[1]
    # LeanPi parses this line for readiness; keep "listening" in it.
    print(f"{MODEL_NAME} listening on http://127.0.0.1:{port}/v1/systemone", flush=True)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
