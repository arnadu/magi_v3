#!/usr/bin/env python3
"""The attack sandbox (security assurance plan, step 4): the shipped mission image, started as
production starts it, attacked from inside as its agent users.

Each cell is an attack with a verdict computed by code, paired with a control: the same probe
aimed where it is allowed, which must succeed. A cell whose control fails proves nothing (the
probe cannot see success) and is reported as such, never as held.

Usage: sandbox.py --image <image> [--report <file.json>] [--sarif <file.sarif>] [--verbose] [--keep]

What it prints is counts only, unless --verbose: in CI the log is public, and a broken cell is an
unfixed vulnerability. The per-cell results go to --report and, for code scanning (maintainers
only), --sarif.
Needs docker. Starts a private network, a MongoDB container and the mission image (with
NET_ADMIN, FLY_APP_NAME set so the daemon behaves as on Fly: firewall on, monitor token
required), waits for the daemon, runs the cells, and removes everything unless --keep.
No model is ever called: no agent is sent a message.
"""
import argparse
import json
import os
import secrets
import subprocess
import sys
import time

MISSION = "sandbox"
SHARED = f"/missions/missions/{MISSION}/shared"
PRIVATE = f"/missions/missions/{MISSION}/jobs-private"
MONGO_IMAGE = "mongo:7.0.14"
HERE = os.path.dirname(os.path.abspath(__file__))


def workdir(agent):
    return f"/missions/home/{agent}/missions/{MISSION}"


class Sandbox:
    def __init__(self, image, keep):
        self.image = image
        self.keep = keep
        tag = secrets.token_hex(3)
        self.net = f"magi-sandbox-{tag}"
        self.mongo = f"magi-sandbox-mongo-{tag}"
        self.mission = f"magi-sandbox-mission-{tag}"
        self.monitor_token = secrets.token_hex(32)
        self.canary = f"SANDBOX-CANARY-{secrets.token_hex(8)}"

    def docker(self, *args, check=True, timeout=120, input=None):
        r = subprocess.run(["docker", *args], capture_output=True, text=True, timeout=timeout, input=input)
        if check and r.returncode != 0:
            raise RuntimeError(f"docker {' '.join(args[:3])} failed: {r.stderr.strip()[:500]}")
        return r

    def run(self, user, script, timeout=30):
        """A shell command inside the mission container as `user`: (exit code, stdout+stderr)."""
        try:
            r = self.docker("exec", "-u", user, self.mission, "bash", "-c", script, check=False, timeout=timeout)
        except subprocess.TimeoutExpired:
            return 124, "(timed out)"
        return r.returncode, (r.stdout + r.stderr).strip()

    def up(self):
        self.docker("network", "create", self.net)
        self.docker("run", "-d", "--name", self.mongo, "--network", self.net, MONGO_IMAGE, timeout=300)
        self.docker(
            "run", "-d", "--name", self.mission, "--network", self.net, "--hostname", "mission",
            "--cap-add", "NET_ADMIN",
            "-e", f"MONGODB_URI=mongodb://{self.mongo}:27017/magi_sandbox",
            "-e", "TEAM_CONFIG=/app/config/teams/test/sandbox.yaml",
            "-e", "AGENT_WORKDIR=/missions", "-e", "MONITOR_PORT=4000", "-e", "TOOL_PORT=4001",
            "-e", "FLY_APP_NAME=magi-sandbox",
            "-e", f"MONITOR_TOKEN={self.monitor_token}",
            "-e", "ANTHROPIC_API_KEY=sk-ant-sandbox-not-a-key",
            "-e", f"SANDBOX_CANARY={self.canary}",
            self.image, timeout=300,
        )
        deadline = time.time() + 240
        while time.time() < deadline:
            logs = self.docker("logs", self.mission, check=False).stdout
            if "Entering orchestration loop" in logs:
                return
            if self.docker("inspect", "-f", "{{.State.Running}}", self.mission, check=False).stdout.strip() != "true":
                raise RuntimeError(f"the mission container stopped while booting:\n{logs[-3000:]}")
            time.sleep(3)
        raise RuntimeError("the daemon did not reach its orchestration loop in 240 s")

    def down(self):
        if self.keep:
            print(f"[sandbox] kept: docker rm -f {self.mission} {self.mongo}; docker network rm {self.net}")
            return
        self.docker("rm", "-f", self.mission, self.mongo, check=False)
        self.docker("network", "rm", self.net, check=False)

    def world(self):
        """Each agent's private canary file; a probe script for HTTP from inside."""
        for agent in ("alice", "bob"):
            rc, out = self.run(agent, f"echo {self.canary}-{agent} > {workdir(agent)}/canary.txt && chmod 600 {workdir(agent)}/canary.txt")
            if rc != 0:
                raise RuntimeError(f"could not write {agent}'s canary: {out}")
        with open(os.path.join(HERE, "probe.py"), encoding="utf-8") as f:
            self.docker("exec", "-i", "-u", "root", self.mission, "bash", "-c", "cat > /tmp/probe.py && chmod 755 /tmp/probe.py", input=f.read())


def http(sb, user, method, path, port=4000, token=None, body=None):
    """(status, body) of a request from inside the machine, on loopback."""
    args = [method, f"http://127.0.0.1:{port}{path}"]
    if token:
        args += ["--header", f"x-monitor-token: {token}"]
    if body is not None:
        args += ["--body", json.dumps(body)]
    quoted = " ".join("'" + a.replace("'", "'\\''") + "'" for a in args)
    rc, out = sb.run(user, f"python3 -I /tmp/probe.py {quoted}")
    try:
        r = json.loads(out.splitlines()[-1])
        return r["status"], r["body"]
    except (ValueError, IndexError, KeyError):
        return 0, out[-300:]


# Each cell: (id, invariant, attacker, what, attack() -> (held, evidence), control() -> (works, evidence))
CELLS = []


def cell(cid, invariant, attacker, what):
    def wrap(fn):
        CELLS.append((cid, invariant, attacker, what, fn))
        return fn
    return wrap


@cell("OS-1", "sec.least-privilege", "alice", "read bob's private file")
def _(sb):
    rc, out = sb.run("alice", f"cat {workdir('bob')}/canary.txt")
    held = rc != 0 and sb.canary not in out
    crc, cout = sb.run("bob", f"cat {workdir('bob')}/canary.txt")
    return held, f"alice: rc {rc}", crc == 0 and sb.canary in cout, f"bob: rc {crc}"


@cell("OS-2", "sec.least-privilege", "alice", "write into bob's workdir")
def _(sb):
    rc, _ = sb.run("alice", f"echo x > {workdir('bob')}/planted.txt")
    crc, _ = sb.run("bob", f"echo x > {workdir('bob')}/own.txt")
    return rc != 0, f"alice: rc {rc}", crc == 0, f"bob: rc {crc}"


@cell("OS-3", "sec.no-secrets-to-agents", "alice", "read the daemon's environment (its secrets)")
def _(sb):
    # The image has no procps: find the daemon by its command line.
    rc, pid = sb.run("root", "for p in /proc/[0-9]*; do tr '\\0' ' ' < $p/cmdline 2>/dev/null | grep -q 'dist/daemon.js' && echo ${p#/proc/}; done | sort -n | head -1")
    rc1, out = sb.run("alice", f"tr '\\0' '\\n' < /proc/{pid.strip()}/environ")
    crc, cout = sb.run("magi-operator", f"tr '\\0' '\\n' < /proc/{pid.strip()}/environ")
    return sb.canary not in out, f"alice: rc {rc1}", sb.canary in cout, f"daemon user: rc {crc}"


@cell("OS-4", "sec.least-privilege", "alice", "read the daemon's private job state")
def _(sb):
    rc, _ = sb.run("alice", f"ls {PRIVATE}")
    crc, _ = sb.run("magi-operator", f"ls {PRIVATE}")
    return rc != 0, f"alice: rc {rc}", crc == 0, f"daemon user: rc {crc}"


@cell("SUDO-1", "sec.least-privilege", "alice", "sudo to root, to bob, or to the firewall helper")
def _(sb):
    results = [sb.run("alice", c)[0] for c in ("sudo -n true", "sudo -n -u bob true", "sudo -n /usr/local/sbin/magi-net init")]
    crc, _ = sb.run("magi-operator", "sudo -n -u alice /usr/local/bin/magi-node -e 0")
    return all(r != 0 for r in results), f"alice: rcs {results}", crc == 0, f"daemon to alice: rc {crc}"


def job_cell(sb, author, claims, cid):
    """`author` asks for a job running as `claims`; returns the uid names its marker files got."""
    marker_dir = f"{SHARED}/markers"
    sb.run("root", f"mkdir -p {marker_dir} && chmod 1777 {marker_dir}")
    script = f"{workdir(author)}/{cid}.sh"
    sb.run(author, f"printf '#!/bin/bash\\ntouch {marker_dir}/{cid}-$(id -un)\\n' > {script} && chmod 700 {script}")
    spec = {"id": cid, "agentId": claims, "scriptPath": script, "args": []}
    sb.run(author, f"cat > {SHARED}/jobs/pending/{cid}.json <<'EOF'\n{json.dumps(spec)}\nEOF")
    # The job runner polls every 60 s.
    deadline = time.time() + 75
    while time.time() < deadline:
        rc, out = sb.run("root", f"ls {marker_dir} | grep '^{cid}-' || true")
        if out.strip():
            return out.split()
        time.sleep(3)
    return []


@cell("JOB-1", "sec.least-privilege", "alice", "submit a job claiming to be bob")
def _(sb):
    spoof = job_cell(sb, "alice", "bob", "spoof-bob")
    honest = job_cell(sb, "alice", "alice", "honest-alice")
    return "spoof-bob-bob" not in spoof, f"spoof markers: {spoof or 'none'}", honest == ["honest-alice-alice"], f"honest markers: {honest}"


@cell("JOB-2", "sec.contained-paths", "alice", "plant a job request as a symlink to bob's file")
def _(sb):
    rc, _ = sb.run("alice", f"ln -sf {workdir('bob')}/canary.txt {SHARED}/jobs/pending/link-bob.json")
    deadline = time.time() + 75  # the job runner polls every 60 s
    refused = False
    while time.time() < deadline and not refused:
        logs = sb.docker("logs", sb.mission, check=False)
        text = logs.stdout + logs.stderr
        refused = any("link-bob" in line and "symlink" in line for line in text.splitlines())
        time.sleep(3)
    return refused, "refused as a symlink" if refused else "no refusal logged", rc == 0, f"plant written: rc {rc}"


@cell("MON-1", "sec.authenticated", "alice", "every monitor route without the token")
def _(sb):
    spec = json.load(open(os.path.join(HERE, "..", "..", "..", "docs", "api", "monitor.openapi.json"), encoding="utf-8"))
    open_routes = []
    for path, item in spec["paths"].items():
        for method, op in item.items():
            if op.get("x-magi-auth") != "monitor":
                continue
            concrete = path.replace("{agent}", "alice").replace("{session}", "1").replace("{app}", "dash")
            concrete = concrete.replace("{action}", "stop").replace("{schedule}", "x").replace("{workdir}", "alice")
            status, _ = http(sb, "alice", method.upper(), concrete)
            if status != 401:
                open_routes.append(f"{method.upper()} {path}: {status}")
    cstatus, _ = http(sb, "alice", "GET", "/status", token=sb.monitor_token)
    return not open_routes, f"not 401: {open_routes or 'none'}", cstatus == 200, f"with the token: {cstatus}"


@cell("MON-2", "sec.contained-paths", "alice", "read bob's file through the monitor, by path and by a symlink in shared/")
def _(sb):
    sb.run("alice", f"ln -sf {workdir('bob')}/canary.txt {SHARED}/to-bob.txt")
    a, abody = http(sb, "alice", "GET", "/files/shared?path=to-bob.txt", token=sb.monitor_token)
    b, bbody = http(sb, "alice", "GET", "/files/shared?path=../../../home/bob/missions/sandbox/canary.txt", token=sb.monitor_token)
    held = sb.canary not in abody and sb.canary not in bbody
    sb.run("alice", f"echo visible > {SHARED}/plain.txt")
    c, cbody = http(sb, "alice", "GET", "/files/shared?path=plain.txt", token=sb.monitor_token)
    return held, f"symlink {a}, traversal {b}", c == 200 and "visible" in cbody, f"plain file {c}"


@cell("TOOL-1", "sec.authenticated", "alice", "call the Tool API without a job token")
def _(sb):
    a, _ = http(sb, "alice", "POST", "/tools/post-message", port=4001, body={"to": ["user"], "subject": "x", "body": "x"})
    return a == 401, f"status {a}", True, "(no token to hold outside a job)"


@cell("NET-1", "sec.served-apart", "another machine", "reach a server an agent started on all interfaces")
def _(sb):
    sb.run("alice", "nohup python3 -m http.server 8888 --bind 0.0.0.0 >/dev/null 2>&1 &", timeout=10)
    time.sleep(2)
    probe = "timeout 4 bash -c 'echo > /dev/tcp/mission/{port}' && echo open || echo closed"
    out = sb.docker("exec", sb.mongo, "bash", "-c", probe.format(port=8888), check=False).stdout.strip()
    inside = sb.run("alice", "timeout 4 bash -c 'echo > /dev/tcp/127.0.0.1/8888' && echo open || echo closed")[1]
    monitor = sb.docker("exec", sb.mongo, "bash", "-c", probe.format(port=4000), check=False).stdout.strip()
    return out == "closed", f"8888 from outside: {out}", inside == "open" and monitor == "open", f"8888 inside: {inside}, 4000 from outside: {monitor}"


def write_sarif(path, results):
    """Every cell that did not hold, as a code-scanning result (visible to maintainers only)."""
    rules, findings = [], []
    for r in results:
        if r["verdict"] == "held":
            continue
        rules.append({"id": r["id"], "shortDescription": {"text": f"{r['attacker']}: {r['attack']}"},
                      "properties": {"tags": [r["invariant"]]}})
        findings.append({
            "ruleId": r["id"],
            "level": "error" if r["verdict"] == "BROKEN" else "warning",
            "message": {"text": f"{r['verdict']}: {r['attack']} ({r['invariant']}). {r['evidence']}. Control: {r['control']}"},
            "locations": [{"physicalLocation": {"artifactLocation": {"uri": "scripts/security/sandbox/sandbox.py"},
                                                "region": {"startLine": 1}}}],
        })
    doc = {"version": "2.1.0", "$schema": "https://json.schemastore.org/sarif-2.1.0.json",
           "runs": [{"tool": {"driver": {"name": "magi-attack-sandbox", "rules": rules}}, "results": findings}]}
    with open(path, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=1)


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", required=True)
    ap.add_argument("--report")
    ap.add_argument("--sarif")
    ap.add_argument("--verbose", action="store_true")
    ap.add_argument("--keep", action="store_true")
    a = ap.parse_args(argv[1:])
    sb = Sandbox(a.image, a.keep)
    results = []
    try:
        sb.up()
        sb.world()
        for cid, invariant, attacker, what, fn in CELLS:
            try:
                held, evidence, control_ok, control_evidence = fn(sb)
            except Exception as e:  # a cell that crashes is reported, never skipped
                held, evidence, control_ok, control_evidence = False, f"error: {e}", False, ""
            verdict = "held" if held and control_ok else ("BROKEN" if not held else "unproven")
            results.append({"id": cid, "invariant": invariant, "attacker": attacker, "attack": what,
                            "verdict": verdict, "evidence": evidence, "control": control_evidence})
            if a.verbose:
                print(f"[sandbox] {cid:7} {verdict:8} {what} — {evidence}; control: {control_evidence}")
    finally:
        sb.down()
    if a.report:
        with open(a.report, "w", encoding="utf-8") as f:
            json.dump(results, f, indent=1)
    if a.sarif:
        write_sarif(a.sarif, results)
    bad = [r for r in results if r["verdict"] != "held"]
    print(f"[sandbox] {len(results) - len(bad)} of {len(results)} cells held with a working control")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
