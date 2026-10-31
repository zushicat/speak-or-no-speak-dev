#!/usr/bin/env python3
"""Dev-only STT stub endpoint (WP9 verification) — NOT part of the package.

THIS IS JUST A MOCKUP

POST /transcribe with a WAV body → canned JSON transcription with CORS.
Run: python3 demo/stt-stub-server.py [port]   (default 5175)
"""

import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5175


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header(
            "Access-Control-Allow-Headers", "Content-Type, Authorization, X-Language"
        )

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        is_wav = body[:4] == b"RIFF"
        # canned "transcription" — a real backend would run STT here
        payload = {
            "text": (
                "(stub) turn received" if not is_wav else "(stub) recognized turn audio"
            ),
            "confidence": 0.9,
            "bytes": length,
            "wav": is_wav,
        }
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(payload).encode())

    def log_message(self, fmt, *args):
        print("STT stub:", fmt % args)


if __name__ == "__main__":
    print(f"STT stub listening on http://localhost:{PORT}/transcribe")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
