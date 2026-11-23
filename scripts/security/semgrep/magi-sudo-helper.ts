import { execFile, execFileSync, spawn, execSync } from "node:child_process";
declare const linuxUser: string, MAGI_APP: string, MAGI_NET: string, nodeExe: string, toolExecutor: string, script: string;

// ok: magi-sudo-helper
spawn("sudo", ["-u", linuxUser, "/usr/local/bin/magi-job", script]);
// ok: magi-sudo-helper
execFile("sudo", ["-n", MAGI_NET, "init"], {}, () => {});
// ok: magi-sudo-helper
spawn("sudo", ["-n", "-u", linuxUser, MAGI_APP, "python3"], {});
// ok: magi-sudo-helper
execFileSync("sudo", ["/usr/local/sbin/magi-net", "init"]);
// ok: magi-sudo-helper
execFile("sudo", ["-u", linuxUser, nodeExe, toolExecutor], {}, () => {});

// ruleid: magi-sudo-helper
spawn("sudo", ["-u", linuxUser, script]);
// ruleid: magi-sudo-helper
execFileSync("sudo", ["-u", linuxUser, "/bin/bash", "-c", script]);
// ruleid: magi-sudo-helper
execFile("sudo", ["/usr/local/bin/other-tool"], {}, () => {});

