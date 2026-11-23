import { execFile, execFileSync, spawn, execSync } from "node:child_process";
declare const linuxUser: string, MAGI_APP: string, MAGI_NET: string, nodeExe: string, toolExecutor: string, script: string;

// ruleid: magi-sudo-in-shell-string
execSync("sudo -u " + linuxUser + " ls");
// ruleid: magi-sudo-in-shell-string
execSync(`sudo -u ${linuxUser} ls`);
// ok: magi-sudo-in-shell-string
execSync("pseudocode is fine");
