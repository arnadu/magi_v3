#!/usr/bin/env python3
"""One HTTP request from inside the sandbox's mission machine; prints {"status", "body"} as JSON.

Usage: probe.py <METHOD> <url> [--header "name: value"]... [--body <json>]
Copied into the container by sandbox.py and run with `python3 -I` as an agent's user.
"""
import json
import sys
import urllib.error
import urllib.request

method, url, rest = sys.argv[1], sys.argv[2], sys.argv[3:]
headers, body = {}, None
i = 0
while i < len(rest):
    if rest[i] == "--header":
        k, v = rest[i + 1].split(":", 1)
        headers[k.strip()] = v.strip()
    elif rest[i] == "--body":
        body = rest[i + 1].encode()
        headers["content-type"] = "application/json"
    i += 2
req = urllib.request.Request(url, data=body, method=method, headers=headers)
try:
    with urllib.request.urlopen(req, timeout=5) as r:
        print(json.dumps({"status": r.status, "body": r.read(4096).decode("utf-8", "replace")}))
except urllib.error.HTTPError as e:
    print(json.dumps({"status": e.code, "body": e.read(4096).decode("utf-8", "replace")}))
except Exception as e:  # noqa: BLE001 — any failure to get an answer is status 0
    print(json.dumps({"status": 0, "body": f"{type(e).__name__}: {e}"}))
