/**
 * fly-machines.ts — provisionMission()/provisionLocal() config-payload shape
 * (ADR-0021).
 *
 * Pins the post-migration target behavior: machine creation carries no
 * team-config payload of any kind (no TEAM_CONFIG/TEAM_CONFIG_YAML env var,
 * no teamConfigName parameter) — the daemon reads its structured config
 * directly from `missions` at boot via MISSION_ID. This is new coverage:
 * fly-machines.ts had zero prior tests. No real Fly API calls — global fetch
 * is mocked.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { provisionLocal, provisionMission } from "../src/fly-machines.js";

describe("provisionMission (ADR-0021: no config payload)", () => {
	const ORIGINAL_ENV = { ...process.env };
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		process.env.FLY_MISSIONS_APP_NAME = "magi-missions-test";
		process.env.FLY_API_TOKEN_MACHINES = "test-token";
		process.env.MONGODB_URI = "mongodb://test";
		process.env.ANTHROPIC_API_KEY = "test-anthropic-key";

		fetchMock = vi.fn(async (url: string) => {
			if (url.includes("/volumes")) {
				return new Response(JSON.stringify({ id: "vol_123" }), {
					status: 200,
				});
			}
			if (url.includes("/machines")) {
				return new Response(
					JSON.stringify({ id: "machine_abc", private_ip: "fdaa::1" }),
					{ status: 200 },
				);
			}
			throw new Error(`Unexpected fetch: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => {
		process.env = { ...ORIGINAL_ENV };
		vi.unstubAllGlobals();
	});

	it("creates a volume then a machine, returning the handle", async () => {
		const handle = await provisionMission("mission-1");
		expect(handle).toEqual({
			machineId: "machine_abc",
			privateIp: "fdaa::1",
			volumeId: "vol_123",
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("skips volume creation when existingVolumeId is provided", async () => {
		const handle = await provisionMission("mission-1", {
			existingVolumeId: "vol_existing",
		});
		expect(handle.volumeId).toBe("vol_existing");
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0][0]).toContain("/machines");
	});

	it("machine env carries MISSION_ID but no team-config payload of any kind", async () => {
		await provisionMission("mission-1");

		const machineCall = fetchMock.mock.calls.find((c) =>
			(c[0] as string).includes("/machines"),
		);
		expect(machineCall).toBeDefined();
		const body = JSON.parse((machineCall?.[1] as RequestInit).body as string);
		const env = body.config.env as Record<string, string>;

		expect(env.MISSION_ID).toBe("mission-1");
		expect(env).not.toHaveProperty("TEAM_CONFIG");
		expect(env).not.toHaveProperty("TEAM_CONFIG_YAML");
		expect(body).not.toHaveProperty("teamConfigName");
		// No env key holds a serialized team-config payload.
		for (const [key, value] of Object.entries(env)) {
			expect(key.toLowerCase()).not.toContain("teamfiles");
			expect(typeof value).toBe("string");
		}
	});

	it("machine env includes runtime secrets and the monitor/tool ports", async () => {
		await provisionMission("mission-1");
		const machineCall = fetchMock.mock.calls.find((c) =>
			(c[0] as string).includes("/machines"),
		);
		const body = JSON.parse((machineCall?.[1] as RequestInit).body as string);
		const env = body.config.env as Record<string, string>;

		expect(env.MONITOR_PORT).toBe("4000");
		expect(env.TOOL_PORT).toBe("4001");
		expect(env.ANTHROPIC_API_KEY).toBe("test-anthropic-key");
		expect(env.MONGODB_URI).toBe("mongodb://test");
	});
});

describe("provisionLocal (ADR-0021: no team.yaml written)", () => {
	let localDir: string;
	const ORIGINAL_ENV = { ...process.env };

	beforeEach(() => {
		localDir = mkdtempSync(join(tmpdir(), "magi-local-provision-test-"));
		process.env.LOCAL_MISSIONS_DIR = localDir;
	});

	afterEach(() => {
		rmSync(localDir, { recursive: true, force: true });
		process.env = { ...ORIGINAL_ENV };
	});

	it("writes teamFiles to disk but no config/team.yaml file", () => {
		const handle = provisionLocal("mission-local-1", {
			teamFiles: [{ path: "skills/foo/SKILL.md", content: "# Foo" }],
		});

		expect(handle.privateIp).toBe("127.0.0.1");
		const missionDir = join(localDir, "mission-local-1");
		const written = readFileSync(
			join(missionDir, "team", "skills", "foo", "SKILL.md"),
			"utf-8",
		);
		expect(written).toBe("# Foo");

		expect(() =>
			readFileSync(join(missionDir, "team.yaml"), "utf-8"),
		).toThrow();
	});

	it("works with no teamFiles at all", () => {
		const handle = provisionLocal("mission-local-2", {});
		expect(handle.machineId).toBe("local-mission-local-2");
	});
});
