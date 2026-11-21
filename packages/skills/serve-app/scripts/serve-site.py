#!/usr/bin/env python3
"""serve-site — the `site` kind of interactive app (ADR-0037).

Serves a folder at `/` on 127.0.0.1:$PORT. The platform removes the app's
path prefix before a request arrives, so pages use relative links
(`href="page2.html"`, `fetch("api/items")`), never ones starting with `/`.

Optional request handlers: a Python file passed with --handlers that defines

    def handle(request):
        # request: {"method", "path", "query" (dict of lists), "headers" (dict), "body" (bytes)}
        # Return None to fall through to the files, or (status, body) where body is
        # a dict/list (sent as JSON), str (text/html) or bytes (application/octet-stream).
        ...

The platform starts this script; agents declare a site with serve-app.sh.
"""

import argparse
import importlib.util
import json
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

MAX_BODY = 10 * 1024 * 1024


def load_handlers(path):
    spec = importlib.util.spec_from_file_location("site_handlers", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    handle = getattr(module, "handle", None)
    if not callable(handle):
        sys.exit(f"serve-site: {path} defines no handle(request) function")
    return handle


def make_handler(root, handle):
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=root, **kwargs)

        def list_directory(self, path):
            self.send_error(404, "Not found")
            return None

        def _custom(self):
            if handle is None:
                return False
            parts = urlsplit(self.path)
            length = min(int(self.headers.get("Content-Length") or 0), MAX_BODY)
            request = {
                "method": self.command,
                "path": parts.path,
                "query": parse_qs(parts.query),
                "headers": dict(self.headers.items()),
                "body": self.rfile.read(length) if length else b"",
            }
            try:
                result = handle(request)
            except Exception as e:  # the app's own bug: answer 500, keep serving
                self.log_error("handler failed on %s %s: %r", self.command, parts.path, e)
                self.send_error(500, "The site's handler failed; see the app's log")
                return True
            if result is None:
                return False
            status, body = result
            if isinstance(body, (dict, list)):
                data, ctype = json.dumps(body).encode(), "application/json"
            elif isinstance(body, str):
                data, ctype = body.encode(), "text/html; charset=utf-8"
            else:
                data, ctype = bytes(body), "application/octet-stream"
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return True

        def do_GET(self):
            if not self._custom():
                super().do_GET()

        def do_HEAD(self):
            if not self._custom():
                super().do_HEAD()

        def do_POST(self):
            if not self._custom():
                self.send_error(404, "Not found")

        do_PUT = do_POST
        do_DELETE = do_POST

    return Handler


def main():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--root", required=True)
    p.add_argument("--handlers")
    args = p.parse_args()
    port = int(os.environ["PORT"])
    handle = load_handlers(args.handlers) if args.handlers else None
    server = ThreadingHTTPServer(("127.0.0.1", port), make_handler(os.path.realpath(args.root), handle))
    print(f"serve-site: {args.root} on 127.0.0.1:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
