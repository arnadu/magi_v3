#!/usr/bin/env python3
"""Environment B (security assurance plan, step 5): the control plane's own image, started on a
private Docker network with no route out, a MongoDB container and two test tenants, scanned by
Nuclei from a container on the same network. Nothing here touches Fly, Atlas, Firebase or a model.

Usage: stack.py --image <control-plane image> [--out <dir>] [--only magi|community|dast] [--verbose] [--keep]
       stack.py --image <control-plane image> --selftest

Runs, in order:
  controls   our control templates: each must match, or nothing after proves anything (unproven)
  magi       our templates (scripts/security/nuclei/templates): cross-tenant, no credential, headers,
             exposed files, source maps, error leaks. A match is a finding; a gate.
  community  the community templates (pinned release, signature-checked): exposures,
             misconfiguration, CVEs of medium and above. Report-only until a baseline is triaged.
  dast       Nuclei's DAST templates over every route of docs/api/control-plane.openapi.json, as a
             signed-in tenant (Alice, on her own mission). Report-only until a baseline is triaged.

Prints counts only unless --verbose (in CI the log is public); per-run JSONL and SARIF go to --out.
Exit 1 when a control fails or our templates find something.
"""
import argparse
import hashlib
import json
import os
import secrets
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
MAGI_TEMPLATES = os.path.join(REPO, "scripts", "security", "nuclei")
MONGO_IMAGE = "mongo:7.0.14"
NUCLEI_IMAGE = "projectdiscovery/nuclei:v3.11.1@sha256:582d5546902e67052097cb2d07296c642d50a1afc5e44623cb038845df9a32eb"
TEMPLATES_VERSION = "v10.5.1"
TEMPLATES_SHA256 = "30fe1cfaced4635f886e4a2673641bba86998dceec28e468274524e789aa56eb"
TEMPLATES_URL = f"https://github.com/projectdiscovery/nuclei-templates/archive/refs/tags/{TEMPLATES_VERSION}.tar.gz"
BASE = "http://control:3000"
# Each control request, by the end of the URL it matched at.
CONTROLS = {"stack-up": "/healthz", "owner-reads": "/api/missions/{mission}", "bob-signed-in": "/api/missions", "cockpit-page": "/"}


# A server that leaks everything the MAGI templates look for: each template must match it, or it
# is blind. Run from the control-plane image (it has node), on the stack's network as "control".
PLANTED = r"""
const http = require("node:http");
const marker = process.env.MARKER;
const leak = [
  marker, "[core]", "MONGODB_URI=x", '"workspaces"', '"lockfileVersion"', '"sources"',
  "import { createApp }", "TypeError: x\n    at f (/app/packages/x.js:1:1)",
].join("\n");
http.createServer((req, res) => {
  res.setHeader("X-Powered-By", "Planted");
  if (req.url === "/") return res.end('<div id="root"></div><script src="/assets/a.js"></script>');
  res.end(leak);
}).listen(3000);
"""

def community_templates():
    """The pinned community templates, downloaded once and checked against their digest."""
    cache = os.path.join(os.path.expanduser("~"), ".cache", "magi-nuclei", TEMPLATES_VERSION)
    if os.path.isdir(cache):
        return cache
    with tempfile.TemporaryDirectory() as tmp:
        archive = os.path.join(tmp, "t.tar.gz")
        with urllib.request.urlopen(TEMPLATES_URL, timeout=120) as r, open(archive, "wb") as f:
            shutil.copyfileobj(r, f)
        digest = hashlib.sha256(open(archive, "rb").read()).hexdigest()
        if digest != TEMPLATES_SHA256:
            raise RuntimeError(f"community templates {TEMPLATES_VERSION}: digest {digest}, expected {TEMPLATES_SHA256}")
        with tarfile.open(archive) as t:
            t.extractall(tmp, filter="data")
        top = next(d for d in os.listdir(tmp) if d.startswith("nuclei-templates"))
        os.makedirs(os.path.dirname(cache), exist_ok=True)
        shutil.move(os.path.join(tmp, top), cache)
    return cache


class Stack:
    def __init__(self, image, out, keep):
        self.image, self.out, self.keep = image, out, keep
        tag = secrets.token_hex(3)
        self.net, self.mongo, self.control = f"magi-stack-{tag}", f"magi-stack-mongo-{tag}", f"magi-stack-control-{tag}"
        self.alice, self.bob = secrets.token_hex(24), secrets.token_hex(24)
        self.mission = f"stack-alice-{tag}"
        self.marker = f"ALICE-MARKER-{secrets.token_hex(6)}"

    def docker(self, *args, check=True, timeout=180):
        r = subprocess.run(["docker", *args], capture_output=True, text=True, timeout=timeout)
        if check and r.returncode != 0:
            raise RuntimeError(f"docker {' '.join(args[:3])} failed: {r.stderr.strip()[:800]}")
        return r

    def fetch(self, method, path, token=None, body=None):
        """(status, body) of a request made from inside the control-plane container."""
        script = (
            "const [m,u,t,b]=process.argv.slice(1);"
            "fetch(u,{method:m,headers:{...(t?{authorization:'Bearer '+t}:{}),'content-type':'application/json'},body:b||undefined})"
            ".then(async r=>console.log(JSON.stringify({s:r.status,b:(await r.text()).slice(0,2000)})))"
            ".catch(e=>console.log(JSON.stringify({s:0,b:String(e)})))"
        )
        r = self.docker("exec", self.control, "node", "-e", script, method, f"http://localhost:3000{path}", token or "",
                        json.dumps(body) if body is not None else "", check=False, timeout=30)
        try:
            j = json.loads(r.stdout.strip().splitlines()[-1])
            return j["s"], j["b"]
        except (ValueError, IndexError):
            return 0, r.stderr[-300:]

    def up(self):
        # --internal: no route out, so the dummy Fly token and the timers reach nothing.
        self.docker("network", "create", "--internal", self.net)
        self.docker("run", "-d", "--name", self.mongo, "--network", self.net, MONGO_IMAGE, timeout=300)
        env = {
            "MONGODB_URI": f"mongodb://{self.mongo}:27017/magi_stack",
            "CONTROL_API_KEY": secrets.token_hex(32),
            "MONITOR_SIGNING_KEY": secrets.token_hex(32),
            "APPS_TICKET_KEY": secrets.token_hex(32),
            "APPS_SIGNING_KEY": secrets.token_hex(32),
            "FLY_API_TOKEN_MACHINES": "stack-not-a-token",
            "FLY_MISSIONS_APP_NAME": "magi-stack-missions",
            "AUTH_TEST_USERS": f"{self.alice}=test-alice,{self.bob}=test-bob",
            "PORT": "3000",
        }
        args = ["run", "-d", "--name", self.control, "--network", self.net, "--network-alias", "control"]
        for k, v in env.items():
            args += ["-e", f"{k}={v}"]
        self.docker(*args, self.image, timeout=300)
        deadline = time.time() + 120
        while time.time() < deadline:
            if self.fetch("GET", "/healthz")[0] == 200:
                return
            if self.docker("inspect", "-f", "{{.State.Running}}", self.control, check=False).stdout.strip() != "true":
                raise RuntimeError(f"the control plane stopped:\n{self.docker('logs', self.control, check=False).stderr[-3000:]}")
            time.sleep(2)
        raise RuntimeError("the control plane did not answer /healthz in 120 s")

    def planted(self):
        """The stack's network with the planted server in place of the control plane."""
        self.docker("network", "create", "--internal", self.net)
        self.docker("run", "-d", "--name", self.control, "--network", self.net, "--network-alias", "control",
                    "-e", f"MARKER={self.marker}", "--entrypoint", "node", self.image, "-e", PLANTED, timeout=300)
        time.sleep(2)

    def seed(self):
        s, b = self.fetch("POST", "/api/missions/draft", self.alice, {"missionId": self.mission, "name": self.marker})
        if s != 201:
            raise RuntimeError(f"alice could not create her draft mission: {s} {b[:300]}")

    def down(self):
        if self.keep:
            print(f"[stack] kept: docker rm -f {self.control} {self.mongo}; docker network rm {self.net}")
            return
        self.docker("rm", "-f", self.control, self.mongo, check=False)
        self.docker("network", "rm", self.net, check=False)

    def nuclei(self, name, args, mounts, timeout=1800):
        """One Nuclei run on the stack's network; returns its JSONL results."""
        os.makedirs(self.out, exist_ok=True)
        os.chmod(self.out, 0o777)
        cmd = ["run", "--rm", "--network", self.net, "-v", f"{self.out}:/out"]
        for host, inside in mounts:
            cmd += ["-v", f"{host}:{inside}:ro"]
        variables = {"alice_token": self.alice, "bob_token": self.bob, "alice_mission": self.mission, "alice_marker": self.marker}
        cmd += [NUCLEI_IMAGE, *args, "-duc", "-ni", "-nc", "-silent", "-jsonl", "-o", f"/out/{name}.jsonl", "-se", f"/out/{name}.sarif"]
        for k, v in variables.items():
            cmd += ["-var", f"{k}={v}"]
        r = self.docker(*cmd, check=False, timeout=timeout)
        path = os.path.join(self.out, f"{name}.jsonl")
        results = []
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                results = [json.loads(line) for line in f if line.strip()]
        if r.returncode != 0 and not results:
            print(f"[stack] {name}: nuclei exited {r.returncode}: {r.stderr.strip()[-500:]}")
        return results


def summarize(results):
    by = {}
    for r in results:
        sev = r.get("info", {}).get("severity", "unknown")
        by[sev] = by.get(sev, 0) + 1
    return ", ".join(f"{n} {s}" for s, n in sorted(by.items())) or "none"


def selftest(st):
    """Every MAGI template matches the planted server, or it could not see what it looks for."""
    ids = sorted(f[:-5] for f in os.listdir(os.path.join(MAGI_TEMPLATES, "templates")) if f.endswith(".yaml"))
    try:
        st.planted()
        got = {r.get("template-id") for r in st.nuclei("selftest", ["-u", BASE, "-t", "/magi/templates"], [(MAGI_TEMPLATES, "/magi")])}
    finally:
        st.down()
    blind = [i for i in ids if i not in got]
    print(f"[stack] selftest: {len(ids) - len(blind)} of {len(ids)} templates match the planted server" + (f"; blind: {blind}" if blind else ""))
    return 1 if blind else 0


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", required=True)
    ap.add_argument("--out", default=os.path.join(tempfile.gettempdir(), "magi-stack-out"))
    ap.add_argument("--only", choices=["magi", "community", "dast"])
    ap.add_argument("--verbose", action="store_true")
    ap.add_argument("--keep", action="store_true")
    ap.add_argument("--selftest", action="store_true", help="prove each MAGI template matches a planted leaky server")
    a = ap.parse_args(argv[1:])
    out = os.path.abspath(a.out)
    st = Stack(a.image, out, a.keep)
    if a.selftest:
        return selftest(st)
    status = 0
    try:
        st.up()
        st.seed()
        magi = [(MAGI_TEMPLATES, "/magi")]
        controls = st.nuclei("controls", ["-u", BASE, "-t", "/magi/controls"], magi)
        matched = {r.get("matched-at", "") for r in controls}
        missing = [c for c, suffix in CONTROLS.items()
                   if not any(m.rstrip("/").endswith(suffix.format(mission=st.mission).rstrip("/")) or (suffix == "/" and m.rstrip("/") == BASE)
                              for m in matched)]
        if missing:
            print(f"[stack] unproven: controls that did not match: {missing}")
            return 1
        print(f"[stack] controls: {len(CONTROLS)} of {len(CONTROLS)} matched")

        if a.only in (None, "magi"):
            ours = st.nuclei("magi", ["-u", BASE, "-t", "/magi/templates"], magi)
            print(f"[stack] magi templates: {summarize(ours)}")
            if ours:
                status = 1
            if a.verbose:
                for r in ours:
                    print(f"  {r.get('template-id')} {r.get('matcher-name', '')} {r.get('matched-at')}")

        if a.only in (None, "community"):
            ct = community_templates()
            community = st.nuclei("community", [
                "-u", BASE, "-dut",
                "-t", "/community/http/exposures/", "-t", "/community/http/misconfiguration/",
                "-t", "/community/http/cves/", "-t", "/community/http/vulnerabilities/",
                "-severity", "low,medium,high,critical", "-etags", "dos,intrusive",
            ], [(ct, "/community")])
            print(f"[stack] community templates ({TEMPLATES_VERSION}): {summarize(community)}")
            if a.verbose:
                for r in community:
                    print(f"  {r.get('template-id')} {r.get('info', {}).get('severity')} {r.get('matched-at')}")

        if a.only in (None, "dast"):
            ct = community_templates()
            spec = json.load(open(os.path.join(REPO, "docs", "api", "control-plane.openapi.json"), encoding="utf-8"))
            spec["servers"] = [{"url": BASE}]
            with open(os.path.join(out, "control-plane.openapi.json"), "w", encoding="utf-8") as f:
                json.dump(spec, f)
            dast = st.nuclei("dast", [
                "-im", "openapi", "-l", "/out/control-plane.openapi.json", "-dast", "-t", "/community/dast/",
                # As the owner, on her own mission: deeper than another tenant's 404s (that side
                # is magi-cross-tenant's). The path parameters the OpenAPI routes name:
                "-H", f"Authorization: Bearer {st.alice}",
                "-var", f"id={st.mission}", "-var", "agentId=lead", "-var", "name=dash",
            ], [(ct, "/community")])
            print(f"[stack] DAST over the OpenAPI routes: {summarize(dast)}")
            if a.verbose:
                for r in dast:
                    print(f"  {r.get('template-id')} {r.get('info', {}).get('severity')} {r.get('matched-at')}")
    finally:
        st.down()
    return status


if __name__ == "__main__":
    sys.exit(main(sys.argv))
