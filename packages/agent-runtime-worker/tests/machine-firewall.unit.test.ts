import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { initMachineFirewall } from "../src/machine-firewall.js";

const recorder = () => ({ record: vi.fn(async () => {}) });

describe("initMachineFirewall", () => {
	it("does nothing locally, and refuses to open app ports", async () => {
		const run = vi.fn(async () => {});
		const fw = await initMachineFirewall({
			missionId: "m1",
			onFly: false,
			anomalyRecorder: recorder(),
			run,
		});
		expect(fw.state).toEqual({ kind: "off-local" });
		expect(run).not.toHaveBeenCalled();
		await expect(fw.allow(20001, 60001)).rejects.toThrow(/off-local/);
	});

	it("runs init on Fly, then allow and revoke through the helper", async () => {
		const run = vi.fn(async (_args: readonly string[]) => {});
		const fw = await initMachineFirewall({
			missionId: "m1",
			onFly: true,
			anomalyRecorder: recorder(),
			run,
		});
		expect(fw.state).toEqual({ kind: "on" });
		await fw.allow(20001, 60001);
		await fw.revoke(20001);
		expect(run.mock.calls.map((c) => c[0])).toEqual([
			["init"],
			["allow", "20001", "60001"],
			["revoke", "20001"],
		]);
	});

	it("records a hard anomaly when init fails, and keeps app ports shut", async () => {
		const anomalyRecorder = recorder();
		const fw = await initMachineFirewall({
			missionId: "m1",
			onFly: true,
			anomalyRecorder,
			run: async () => {
				throw new Error("nft: Operation not permitted");
			},
		});
		expect(fw.state).toEqual({
			kind: "failed",
			reason: "nft: Operation not permitted",
		});
		expect(anomalyRecorder.record).toHaveBeenCalledWith(
			expect.objectContaining({
				missionId: "m1",
				category: "firewall-failure",
				severity: "hard",
			}),
		);
		await expect(fw.allow(20001, 60001)).rejects.toThrow(/failed/);
	});
});

describe("magi-net's ruleset", () => {
	it("names no protocol or service that needs /etc/protocols or /etc/services (absent from the image)", () => {
		const helper = readFileSync(
			fileURLToPath(new URL("../scripts/magi-net", import.meta.url)),
			"utf8",
		);
		const ruleset = helper.slice(
			helper.indexOf("nft -f - <<EOF"),
			helper.indexOf("\nEOF\n"),
		);
		expect(ruleset).toContain("meta l4proto { 1, 58 } accept");
		expect(ruleset).not.toMatch(
			/l4proto[^\n]*[a-z]-?icmp|dport[^\n]*\b(ssh|http|https)\b/,
		);
	});
});

describe("magi-net (the root helper) refuses bad arguments before touching the firewall", () => {
	const helper = fileURLToPath(new URL("../scripts/magi-net", import.meta.url));
	const run = (...args: string[]) =>
		spawnSync("sh", [helper, ...args], { encoding: "utf8" });

	it.each([
		[[], /usage/],
		[["flush"], /usage/],
		[["init", "extra"], /usage: magi-net init/],
		[["allow", "20001"], /usage: magi-net allow/],
		[["allow", "80", "60001"], /outside 20000-20099/],
		[["allow", "20100", "60001"], /outside 20000-20099/],
		[["allow", "2000a", "60001"], /port must be a number/],
		[["allow", "20001", "0"], /uid 0 is refused/],
		[["allow", "20001", "6000;1"], /uid must be a number/],
		[["allow", "20001", "4242424242"], /has no user/],
		[["revoke", "19999"], /outside 20000-20099/],
		[["revoke", "20001", "60001"], /usage: magi-net revoke/],
	])("%j", (args, message) => {
		const r = run(...args);
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(message);
	});
});
