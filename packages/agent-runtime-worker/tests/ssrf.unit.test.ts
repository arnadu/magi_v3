/**
 * ssrf.ts — address classification and vetted resolution (audit 2026-10:
 * S1, S3, B1, B1b). DNS is mocked; everything else is pure.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:dns/promises", () => ({
	default: { lookup: vi.fn() },
}));

import dns from "node:dns/promises";
import {
	ipv6Groups,
	isPrivateAddress,
	isPrivateHost,
	resolvePinned,
	resolveVetted,
	SsrfBlockedError,
} from "../src/ssrf.js";

const lookup = vi.mocked(dns.lookup);

beforeEach(() => {
	vi.resetAllMocks();
});

describe("isPrivateAddress", () => {
	it("blocks the classic IPv4 ranges and the ones the regex missed", () => {
		for (const ip of [
			"127.0.0.1",
			"127.9.9.9",
			"10.0.0.5",
			"172.16.0.1",
			"172.31.255.255",
			"192.168.1.1",
			"169.254.169.254",
			"0.0.0.0",
			"0.1.2.3",
			"100.64.0.1",
			"100.127.255.255",
			"224.0.0.1",
			"255.255.255.255",
			"198.18.0.1",
		])
			expect(isPrivateAddress(ip), ip).toBe(true);
		for (const ip of [
			"8.8.8.8",
			"1.1.1.1",
			"172.32.0.1",
			"100.128.0.1",
			"93.184.216.34",
		])
			expect(isPrivateAddress(ip), ip).toBe(false);
	});

	it("blocks IPv6 loopback, unspecified, link-local, ULA (Fly 6PN) and multicast", () => {
		for (const ip of [
			"::1",
			"[::1]",
			"::",
			"fe80::1",
			"fe80::1%eth0",
			"fc00::1",
			"fdaa:70:8148:a7b:88a:ee14:5fb1:2",
			"ff02::1",
			"2001:db8::1",
		])
			expect(isPrivateAddress(ip), ip).toBe(true);
		expect(isPrivateAddress("2606:4700:4700::1111")).toBe(false);
		expect(isPrivateAddress("2a00:1450:4001:80e::200e")).toBe(false);
	});

	it("sees the IPv4 address embedded in mapped, NAT64 and 6to4 forms", () => {
		for (const ip of [
			"::ffff:127.0.0.1",
			"[::ffff:127.0.0.1]",
			"::ffff:7f00:1",
			"::ffff:a9fe:a9fe",
			"::ffff:10.0.0.5",
			"64:ff9b::7f00:1",
			"64:ff9b::127.0.0.1",
			"64:ff9b:1::a9fe:a9fe",
			"2002:7f00:1::",
			"2002:c0a8:101::1",
			"::127.0.0.1",
		])
			expect(isPrivateAddress(ip), ip).toBe(true);
		expect(isPrivateAddress("::ffff:8.8.8.8")).toBe(false);
		expect(isPrivateAddress("64:ff9b::808:808")).toBe(false);
		expect(isPrivateAddress("2002:808:808::")).toBe(false);
	});

	it("treats a malformed literal as private", () => {
		expect(isPrivateAddress("::ffff:999.1.1.1")).toBe(true);
		expect(isPrivateAddress("1:2:3")).toBe(true);
		expect(ipv6Groups("::1::2")).toBeNull();
	});
});

describe("resolveVetted / resolvePinned", () => {
	it("passes a public literal through without DNS", async () => {
		expect(await resolvePinned("93.184.216.34")).toEqual({
			address: "93.184.216.34",
			family: 4,
		});
		expect(await resolvePinned("[2606:4700::1111]")).toEqual({
			address: "2606:4700::1111",
			family: 6,
		});
		expect(lookup).not.toHaveBeenCalled();
	});

	it("refuses private literals, decimal/hex spellings via the URL parser, and internal names", async () => {
		for (const h of [
			"127.0.0.1",
			"[::ffff:7f00:1]",
			"localhost",
			"localhost.",
			"LOCALHOST",
			"db.internal",
			"magi-missions-dev.internal",
			"printer.local",
			"x.home.arpa",
		]) {
			await expect(resolvePinned(h), h).rejects.toBeInstanceOf(
				SsrfBlockedError,
			);
		}
		// The URL parser canonicalises exotic IPv4 spellings before we see them.
		expect(new URL("http://0x7f.1/").hostname).toBe("127.0.0.1");
		expect(new URL("http://2130706433/").hostname).toBe("127.0.0.1");
		expect(lookup).not.toHaveBeenCalled();
	});

	it("checks every DNS answer and refuses when any one is private", async () => {
		lookup.mockResolvedValueOnce([
			{ address: "93.184.216.34", family: 4 },
			{ address: "10.0.0.9", family: 4 },
		] as never);
		await expect(resolvePinned("mixed.example")).rejects.toThrow(/10\.0\.0\.9/);
		lookup.mockResolvedValueOnce([
			{ address: "93.184.216.34", family: 4 },
			{ address: "2606:4700::1111", family: 6 },
		] as never);
		expect(await resolveVetted("ok.example")).toEqual([
			{ address: "93.184.216.34", family: 4 },
			{ address: "2606:4700::1111", family: 6 },
		]);
		expect(lookup).toHaveBeenCalledWith("ok.example", { all: true });
	});

	it("fails closed on a DNS error or an empty answer", async () => {
		lookup.mockRejectedValueOnce(new Error("ENOTFOUND"));
		await expect(resolvePinned("down.example")).rejects.toThrow(
			/DNS lookup failed/,
		);
		lookup.mockResolvedValueOnce([] as never);
		await expect(resolvePinned("empty.example")).rejects.toThrow(
			/no DNS answers/,
		);
		expect(await isPrivateHost("down.example")).toBe(true);
	});

	it("honours allowedHosts for test infrastructure only", async () => {
		expect(await resolvePinned("127.0.0.1", ["127.0.0.1"])).toEqual({
			address: "127.0.0.1",
			family: 4,
		});
		await expect(
			resolvePinned("127.0.0.2", ["127.0.0.1"]),
		).rejects.toBeInstanceOf(SsrfBlockedError);
		lookup.mockResolvedValueOnce([
			{ address: "127.0.0.1", family: 4 },
		] as never);
		expect(await isPrivateHost("local.test", ["127.0.0.1"])).toBe(false);
	});
});
