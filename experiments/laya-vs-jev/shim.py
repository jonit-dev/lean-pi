"""A JEV-contract HTTP server backed by Laya.

Speaks exactly what `src/jev/client.ts` sends and expects:

    POST /v1/systemone
    {"state": {...}, "model": "...", "questions": {"id": {"type", "instructions", "criteria"}}}
    -> {"model": "...", "answers": {"id": {"type", "choice"|"score"|"noul", ...}}, "usage": {...}}

Laya's `agent.predict()` already returns that envelope, so the shim is a
transport swap: LeanPi's client is not modified, and pointing it at this URL is
the whole "replace JEV with Laya" change.

Usage: .venv/bin/python shim.py [--port 8765] [--device cuda] [--subfolder typed-decisions]
"""

from __future__ import annotations

import argparse
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

AGENT = None
MODEL_NAME = "laya"
LOCK = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args) -> None:  # keep the experiment output clean
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
            with LOCK:  # one GPU, one request at a time
                response = AGENT.predict(state, questions)
        except Exception as error:  # surface as a 5xx so the client takes its fallback
            self._send(500, {"error": f"{type(error).__name__}: {error}"})
            return

        latency_ms = (time.time() - started) * 1000
        self._send(
            200,
            {
                "model": MODEL_NAME,
                "answers": response.get("answers", {}),
                "usage": response.get("usage", {}),
                "latency_ms": round(latency_ms, 2),
            },
        )


def main() -> None:
    global AGENT, MODEL_NAME
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--subfolder", default=None)
    args = parser.parse_args()

    import laya

    AGENT = laya.load("convaiinnovations/laya", device=args.device, subfolder=args.subfolder)
    MODEL_NAME = f"laya-{args.subfolder}" if args.subfolder else "laya-english"
    AGENT.predict({"body": "warm up"}, {"q": {"type": "noul", "instructions": "warm up?"}})

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"{MODEL_NAME} listening on http://127.0.0.1:{args.port}/v1/systemone", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
